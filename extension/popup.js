const DEFAULT_POLL_SECONDS = 5;
const STATUS_CACHE_KEY = "lastStatus";

const state = {
  scriptUrl: "",
  pollSeconds: DEFAULT_POLL_SECONDS,
  status: null,
  logs: [],
  logsLoaded: false,
  logsLoading: false,
  timer: null,
  selectedStatus: "offline",
  peopleSearch: "",
  logSearch: "",
};

const els = {
  openSettings: document.querySelector("#openSettings"),
  message: document.querySelector("#message"),
  lastUpdated: document.querySelector("#lastUpdated"),
  offlineCount: document.querySelector("#offlineCount"),
  onlineCount: document.querySelector("#onlineCount"),
  peopleSearch: document.querySelector("#peopleSearch"),
  logSearch: document.querySelector("#logSearch"),
  peopleListTitle: document.querySelector("#peopleListTitle"),
  peopleList: document.querySelector("#peopleList"),
  recentEventsList: document.querySelector("#recentEventsList"),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const settings = await chrome.storage.local.get(["scriptUrl", "pollSeconds", STATUS_CACHE_KEY]);
  state.scriptUrl = settings.scriptUrl || "";
  state.pollSeconds = Number(settings.pollSeconds || DEFAULT_POLL_SECONDS);

  bindEvents();

  if (!state.scriptUrl) {
    showMessage("설정에서 Worker URL을 저장해주세요.", true);
    return;
  }

  if (settings[STATUS_CACHE_KEY]) {
    state.status = settings[STATUS_CACHE_KEY];
    renderStatus(state.status);
  }

  refreshStatus();
  startPolling();
}

function bindEvents() {
  els.openSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());

  document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });

  document.querySelectorAll(".stat-card").forEach(button => {
    button.addEventListener("click", () => selectPeopleStatus(button.dataset.status));
  });

  els.peopleSearch.addEventListener("input", () => {
    state.peopleSearch = els.peopleSearch.value.trim();
    if (state.status) {
      renderSelectedPeople(state.status);
    }
  });

  els.logSearch.addEventListener("input", () => {
    state.logSearch = els.logSearch.value.trim();
    if (state.logsLoaded) {
      renderRecentEvents(state.logs);
    }
  });
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });

  document.querySelectorAll(".tab-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === `${name}Tab`);
  });

  if (name === "logs") {
    loadLogs();
  }
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(refreshStatus, state.pollSeconds * 1000);
}

async function refreshStatus() {
  clearMessage();

  if (!state.scriptUrl) {
    showMessage("설정에서 Worker URL을 저장해주세요.", true);
    return;
  }

  try {
    const data = await apiGet("status");
    if (!data.ok) throw new Error(data.error || "상태 조회 실패");
    state.status = data;
    await chrome.storage.local.set({ [STATUS_CACHE_KEY]: data });
    renderStatus(data);
    if (!state.logsLoaded || isLogsTabActive()) {
      loadLogs({ silent: true });
    }
  } catch (err) {
    showMessage(err.message, true);
  }
}

async function loadLogs(options = {}) {
  if (state.logsLoading || !state.scriptUrl) return;

  state.logsLoading = true;
  if (!options.silent && !state.logsLoaded) {
    els.recentEventsList.replaceChildren();
    els.recentEventsList.appendChild(empty("최근 로그 불러오는 중입니다."));
  }

  try {
    const data = await apiGet("logs");
    if (!data.ok) throw new Error(data.error || "로그 조회 실패");
    state.logs = data.recentEvents || [];
    state.logsLoaded = true;
    if (isLogsTabActive()) {
      renderRecentEvents(state.logs);
    }
  } catch (err) {
    if (!options.silent) {
      showMessage(err.message, true);
    }
  } finally {
    state.logsLoading = false;
  }
}

function renderStatus(data) {
  els.offlineCount.textContent = data.counts.offline;
  els.onlineCount.textContent = data.counts.online;
  els.lastUpdated.textContent = `마지막 갱신 ${formatTime(new Date(data.generatedAt || Date.now()))}`;

  renderSelectedPeople(data);
}

function isLogsTabActive() {
  return document.querySelector("#logsTab").classList.contains("active");
}

function selectPeopleStatus(status) {
  state.selectedStatus = status === "online" ? "online" : "offline";

  if (state.status) {
    renderSelectedPeople(state.status);
  }
}

function renderSelectedPeople(data) {
  const isOnline = state.selectedStatus === "online";
  const people = isOnline ? data.online : data.offline;
  const filteredPeople = filterPeople(people, state.peopleSearch);
  const emptyText = state.peopleSearch
    ? "검색 결과가 없습니다."
    : isOnline
      ? "접속 중인 인원이 없습니다."
      : "미접속자가 없습니다.";

  els.peopleListTitle.textContent = isOnline ? "접속중 인원" : "미접속자";
  document.querySelectorAll(".stat-card").forEach(button => {
    button.classList.toggle("active", button.dataset.status === state.selectedStatus);
  });

  renderPeople(
    els.peopleList,
    sortByName(filteredPeople),
    emptyText,
  );
}

function renderPeople(container, people, emptyText) {
  container.replaceChildren();

  if (!people || people.length === 0) {
    container.appendChild(empty(emptyText));
    return;
  }

  people.forEach(person => {
    const item = document.createElement("article");
    item.className = "person-row";
    item.innerHTML = `
      <div>
        <strong></strong>
        <span></span>
      </div>
      <small></small>
    `;
    item.querySelector("strong").textContent = person.realName || person.nickname || person.userId;
    item.querySelector("span").textContent = person.nickname ? `${person.nickname} · ${person.userId}` : person.userId || "";
    item.querySelector("small").textContent = lastEventText(person);
    container.appendChild(item);
  });
}

function renderRecentEvents(events) {
  els.recentEventsList.replaceChildren();

  if (state.logSearch) {
    renderGroupedLogEvents(events);
    return;
  }

  if (!events || events.length === 0) {
    els.recentEventsList.appendChild(empty("최근 접속 로그가 없습니다."));
    return;
  }

  events.forEach(event => {
    const row = document.createElement("article");
    row.className = "log-row";

    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${event.realName || "실명 미지정"} · ${eventLabel(event.eventType)}`;
    const meta = document.createElement("span");
    meta.textContent = `${event.userId || ""} · ${formatDate(event.zepDate || event.receivedAt)}`;
    info.append(title, meta);

    row.append(info);
    els.recentEventsList.appendChild(row);
  });
}

function renderGroupedLogEvents(events) {
  const filteredEvents = filterEvents(events, state.logSearch);
  const groups = groupEventsByDate(filteredEvents);

  if (groups.length === 0) {
    els.recentEventsList.appendChild(empty("최근 일주일 내 검색 결과가 없습니다."));
    return;
  }

  groups.forEach(group => {
    const row = document.createElement("article");
    row.className = "log-group-row";

    const title = document.createElement("strong");
    title.textContent = group.label;
    row.appendChild(title);

    group.sessions.forEach(session => {
      const line = document.createElement("span");
      line.textContent = `${session.name} · 입실 ${session.enter || "-"} - 퇴실 ${session.exit || "-"}`;
      row.appendChild(line);
    });

    els.recentEventsList.appendChild(row);
  });
}

async function apiGet(action, params = {}) {
  const url = new URL(state.scriptUrl);
  url.searchParams.set("action", action);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function empty(text) {
  const element = document.createElement("p");
  element.className = "empty";
  element.textContent = text;
  return element;
}

function lastEventText(person) {
  if (person.status === "Online" && person.lastEnterAt) return `접속 ${formatDate(person.lastEnterAt)}`;
  if (person.status === "Offline" && person.lastExitAt) return `퇴실 ${formatDate(person.lastExitAt)}`;
  if (person.lastEventAt) return `이벤트 ${formatDate(person.lastEventAt)}`;
  return "";
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatLogDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit", weekday: "short" });
}

function formatLogTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function formatTime(date) {
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function eventLabel(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "enter" || normalized === "online") return "입실";
  if (normalized === "exit" || normalized === "offline") return "퇴실";
  if (normalized === "nostatus") return "상태 없음";
  return value || "";
}

function sortByName(items) {
  return [...(items || [])].sort((a, b) => String(a.realName || "").localeCompare(String(b.realName || ""), "ko"));
}

function filterPeople(people, keyword) {
  const query = String(keyword || "").toLowerCase();
  if (!query) return people || [];

  return (people || []).filter(person => {
    const target = [
      person.realName,
      person.nickname,
      person.userId,
    ].join(" ").toLowerCase();
    return target.includes(query);
  });
}

function filterEvents(events, keyword) {
  const query = String(keyword || "").toLowerCase();
  if (!query) return events || [];

  return (events || []).filter(event => {
    const target = [
      event.realName,
      event.nickname,
      event.userId,
    ].join(" ").toLowerCase();
    return target.includes(query);
  });
}

function groupEventsByDate(events) {
  const groupsByDate = new Map();
  const openSessionsByUser = new Map();
  const sortedEvents = [...(events || [])]
    .map(event => ({
      ...event,
      eventAt: event.zepDate || event.receivedAt,
      eventDate: new Date(event.zepDate || event.receivedAt),
    }))
    .filter(event => !Number.isNaN(event.eventDate.getTime()))
    .sort((a, b) => a.eventDate - b.eventDate);

  sortedEvents.forEach(event => {
    const dateKey = event.eventDate.toLocaleDateString("sv-SE");
    const label = formatLogDate(event.eventAt);
    const group = groupsByDate.get(dateKey) || { key: dateKey, label, sessions: [] };
    const sessionKey = `${dateKey}:${event.userId || event.nickname || "unknown"}`;
    const type = String(event.eventType || "").toLowerCase();
    const name = event.realName || event.nickname || event.userId || "실명 미지정";

    if (type === "enter" || type === "online") {
      const session = {
        name,
        enter: formatLogTime(event.eventAt),
        exit: "",
      };
      openSessionsByUser.set(sessionKey, session);
      group.sessions.push(session);
    } else if (type === "exit" || type === "offline") {
      const openSession = openSessionsByUser.get(sessionKey);
      if (openSession && !openSession.exit) {
        openSession.exit = formatLogTime(event.eventAt);
        openSessionsByUser.delete(sessionKey);
      } else {
        group.sessions.push({
          name,
          enter: "",
          exit: formatLogTime(event.eventAt),
        });
      }
    }

    groupsByDate.set(dateKey, group);
  });

  return [...groupsByDate.values()]
    .map(group => ({
      ...group,
      sessions: group.sessions.length > 0
        ? group.sessions
        : [{ name: "실명 미지정", enter: "", exit: "" }],
    }))
    .sort((a, b) => b.key.localeCompare(a.key));
}


function showMessage(text, isError) {
  els.message.hidden = false;
  els.message.textContent = text;
  els.message.classList.toggle("error", Boolean(isError));
}

function clearMessage() {
  els.message.hidden = true;
  els.message.textContent = "";
  els.message.classList.remove("error");
}
