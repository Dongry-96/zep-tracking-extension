const SHEETS = {
  presence: {
    name: "Presence",
    headers: ["userId", "nickname", "status", "lastEnterAt", "lastExitAt", "lastEventAt"],
  },
  mappings: {
    name: "Mappings",
    headers: ["realName", "userId", "nickname"],
  },
  events: {
    name: "Events",
    headers: ["receivedAt", "zepDate", "eventType", "userId", "nickname", "mapHashId", "rawJson"],
  },
  diagnostics: {
    name: "Diagnostics",
    headers: ["receivedAt", "stage", "message", "rawBody"],
  },
};

const CACHE_KEYS = {
  status: "status:v2",
  logs: "logs:v2",
};
const CACHE_TTL_SECONDS = 3;
const LOG_DAYS = 7;
const EVENT_TAIL_ROWS = 1000;
const SHEETS_READY_KEY = "sheetsReady";

function doGet(e) {
  try {
    const action = getParam_(e, "action");
    if (!action || action === "ping") {
      return success_();
    }

    ensureSheetsReady_();

    if (action === "status") {
      return json_(getCachedPayload_(CACHE_KEYS.status, CACHE_TTL_SECONDS, getStatus_));
    }

    if (action === "logs") {
      return json_(getCachedPayload_(CACHE_KEYS.logs, CACHE_TTL_SECONDS, getLogs_));
    }

    return json_({ ok: false, error: "unknown_action" });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    ensureSheetsReady_();

    const body = parseBody_(e);
    const action = getParam_(e, "action") || "";
    appendDiagnostic_("post_received", "action=" + action, getRawBody_(e));

    if (action) {
      return json_({ ok: false, error: "unknown_action" });
    }

    saveZepWebhook_(e, body);
    clearResponseCache_();
    return success_();
  } catch (err) {
    try {
      appendDiagnostic_("post_error", String(err && err.stack ? err.stack : err), getRawBody_(e));
    } catch (logErr) {
      console.error(logErr);
    }

    if (getParam_(e, "action")) {
      return json_({ ok: false, error: String(err && err.message ? err.message : err) });
    }

    // ZEP only needs a successful plain-text response to complete the webhook connection.
    console.error(err);
    return success_();
  } finally {
    lock.releaseLock();
  }
}

function saveZepWebhook_(e, body) {
  const payload = normalizeZepPayload_(body);
  const eventType = String(payload.eventType || payload.type || "").toLowerCase();
  const userId = String(payload.userId || payload.userID || "").trim();
  const nickname = String(payload.nickname || payload.name || "").trim();
  const zepDate = toDateOrText_(payload.date);
  const mapHashId = String(payload.map_hashID || payload.mapHashId || "").trim();
  const now = new Date();

  if (!userId) throw new Error("userId is required in ZEP webhook payload.");

  const eventsSheet = getSheet_(SHEETS.events.name);
  eventsSheet.appendRow([now, zepDate || "", eventType, userId, nickname, mapHashId, JSON.stringify(payload)]);

  const status = eventType === "enter" ? "Online" : eventType === "exit" ? "Offline" : "Unknown";
  upsertPresence_(userId, nickname, status, zepDate || now);
  ensureMappingPlaceholder_(userId, nickname);
  appendDiagnostic_("webhook_saved", userId + " " + status, JSON.stringify(payload));
}

function ensureMappingPlaceholder_(userId, nickname) {
  const sheet = getSheet_(SHEETS.mappings.name);
  const rows = getRows_(sheet);
  const idx = rows.findIndex(row => row.userId === userId);

  if (idx === -1) {
    sheet.appendRow(["", userId, nickname]);
    return;
  }

  const row = rows[idx];
  if (nickname && row.nickname !== nickname) {
    sheet.getRange(idx + 2, 3).setValue(nickname);
  }
}

function normalizeZepPayload_(body) {
  if (body && body.body && typeof body.body === "object") return body.body;
  return body || {};
}

function upsertPresence_(userId, nickname, status, eventAt) {
  const sheet = getSheet_(SHEETS.presence.name);
  const rows = getRows_(sheet);
  const idx = rows.findIndex(row => row.userId === userId);
  const lastEnterAt = status === "Online" ? eventAt : "";
  const lastExitAt = status === "Offline" ? eventAt : "";

  if (idx === -1) {
    sheet.appendRow([
      userId,
      nickname,
      status,
      lastEnterAt,
      lastExitAt,
      eventAt,
    ]);
    return;
  }

  const rowNumber = idx + 2;
  const current = rows[idx];
  sheet.getRange(rowNumber, 2, 1, 5).setValues([[
    nickname || current.nickname,
    status,
    status === "Online" ? eventAt : current.lastEnterAt,
    status === "Offline" ? eventAt : current.lastExitAt,
    eventAt,
  ]]);
}

function getStatus_() {
  const presence = getPresence_();
  const mappings = getMappings_();
  const completedMappings = mappings.filter(row => row.realName && row.userId);
  const needsMapping = mappings
    .filter(row => !row.realName && row.userId)
    .map(row => ({
      realName: "",
      userId: row.userId,
      nickname: row.nickname,
      status: "NeedsMapping",
    }));
  const realNameByNickname = getRealNameByNickname_(mappings);
  const mappedByUserId = new Map(completedMappings.map(mapping => [mapping.userId, mapping]));
  const knownUserIds = new Set(mappings.filter(mapping => mapping.userId).map(mapping => mapping.userId));
  const presenceByUserId = new Map(presence.map(item => [item.userId, item]));

  const online = [];
  const offline = [];
  const noStatus = [];

  completedMappings.forEach(mapping => {
    const item = presenceByUserId.get(mapping.userId);
    if (!item) {
      noStatus.push({
        realName: mapping.realName,
        userId: mapping.userId,
        nickname: mapping.nickname,
        status: "NoStatus",
      });
      return;
    }

    const result = {
      realName: mapping.realName,
      userId: mapping.userId,
      nickname: item.nickname || mapping.nickname,
      status: item.status,
      lastEnterAt: item.lastEnterAt,
      lastExitAt: item.lastExitAt,
      lastEventAt: item.lastEventAt,
    };

    if (item.status === "Online") online.push(result);
    else offline.push(result);
  });

  const unmatched = presence
    .filter(item => !knownUserIds.has(item.userId))
    .map(item => ({
      userId: item.userId,
      nickname: item.nickname || "unknown",
      displayName: item.nickname || item.userId,
      status: item.status,
      lastEnterAt: item.lastEnterAt,
      lastExitAt: item.lastExitAt,
      lastEventAt: item.lastEventAt,
    }));

  return {
    ok: true,
    generatedAt: new Date(),
    counts: {
      mapped: completedMappings.length,
      online: online.length,
      offline: offline.length,
      needsMapping: needsMapping.length,
      noStatus: noStatus.length,
      unmatched: unmatched.length,
    },
    online,
    offline,
    needsMapping,
    noStatus,
    unmatched,
  };
}

function getLogs_() {
  const mappings = getMappings_();
  const completedMappings = mappings.filter(row => row.realName && row.userId);
  const mappedByUserId = new Map(completedMappings.map(mapping => [mapping.userId, mapping]));
  const realNameByNickname = getRealNameByNickname_(mappings);
  const recentEvents = getRecentEventsForDays_(LOG_DAYS).map(event => {
    const mapping = mappedByUserId.get(event.userId);
    const nickname = String(event.nickname || "").trim();
    const realName = mapping ? mapping.realName : realNameByNickname.get(nickname) || "";
    return {
      ...event,
      realName,
    };
  });

  return {
    ok: true,
    generatedAt: new Date(),
    recentEvents,
  };
}

function getPresence_() {
  return getRows_(getSheet_(SHEETS.presence.name)).map(normalizePresenceRow_);
}

function normalizePresenceRow_(row) {
  if (isPresenceStatus_(row.status)) return row;

  if (isPresenceStatus_(row.lastEnterAt)) {
    const status = normalizePresenceStatus_(row.lastEnterAt);
    return {
      ...row,
      nickname: row.nickname || row.status,
      status,
      lastEnterAt: status === "Online" ? row.lastExitAt : "",
      lastExitAt: status === "Offline" ? row.lastExitAt : row.lastEventAt,
      lastEventAt: status === "Online" ? row.lastExitAt : row.lastEventAt,
    };
  }

  return row;
}

function getMappings_() {
  return getRows_(getSheet_(SHEETS.mappings.name));
}

function getRealNameByNickname_(mappings) {
  const byNickname = new Map();

  mappings.forEach(row => {
    const realName = String(row.realName || "").trim();
    const nickname = String(row.nickname || "").trim();
    if (realName && nickname && !byNickname.has(nickname)) {
      byNickname.set(nickname, realName);
    }
  });

  return byNickname;
}

function getRecentEventsForDays_(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  return getEventRowsForDaysFromTail_(cutoff, EVENT_TAIL_ROWS)
    .filter(row => {
      const eventDate = getEventDate_(row);
      return eventDate && eventDate >= cutoff;
    })
    .reverse();
}

function getEventRowsForDaysFromTail_(cutoff, tailRows) {
  const sheet = getSheet_(SHEETS.events.name);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const rows = [];
  let endRow = lastRow;

  while (endRow >= 2) {
    const startRow = Math.max(2, endRow - tailRows + 1);
    const chunk = sheet.getRange(startRow, 1, endRow - startRow + 1, 6).getValues().map(values => ({
      receivedAt: values[0],
      zepDate: values[1],
      eventType: values[2],
      userId: values[3],
      nickname: values[4],
      mapHashId: values[5],
    }));

    rows.unshift.apply(rows, chunk);

    const oldestEventDate = chunk.length > 0 ? getEventDate_(chunk[0]) : null;
    if (startRow === 2 || !oldestEventDate || oldestEventDate < cutoff) break;
    endRow = startRow - 1;
  }

  return rows;
}

function getEventDate_(event) {
  const value = event.zepDate || event.receivedAt;
  if (!value) return null;
  if (value instanceof Date && !isNaN(value.getTime())) return value;

  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function appendDiagnostic_(stage, message, rawBody) {
  const sheet = getSheet_(SHEETS.diagnostics.name);
  sheet.appendRow([new Date(), stage, message, rawBody || ""]);
}

function getCachedPayload_(key, ttlSeconds, producer) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(key);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (err) {
      cache.remove(key);
    }
  }

  const payload = producer();
  try {
    cache.put(key, JSON.stringify(payload), ttlSeconds);
  } catch (err) {
    console.error(err);
  }
  return payload;
}

function clearResponseCache_() {
  CacheService.getScriptCache().removeAll([CACHE_KEYS.status, CACHE_KEYS.logs]);
}

function ensureSheetsReady_() {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(SHEETS_READY_KEY) === "true") return;

  ensureSheets_();
  properties.setProperty(SHEETS_READY_KEY, "true");
}

function ensureSheets_() {
  Object.keys(SHEETS).forEach(key => {
    const config = SHEETS[key];
    let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(config.name);
    if (!sheet) {
      sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(config.name);
    }

    const firstRow = sheet.getRange(1, 1, 1, config.headers.length).getValues()[0];
    const needsHeader = firstRow.some((cell, index) => cell !== config.headers[index]);
    if (needsHeader) {
      sheet.getRange(1, 1, 1, config.headers.length).setValues([config.headers]);
      sheet.setFrozenRows(1);
    }
  });

}

function isPresenceStatus_(value) {
  const normalized = normalizePresenceStatus_(value);
  return normalized === "Online" || normalized === "Offline" || normalized === "Unknown";
}

function normalizePresenceStatus_(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "online" || normalized === "enter") return "Online";
  if (normalized === "offline" || normalized === "exit") return "Offline";
  if (normalized === "unknown") return "Unknown";
  return String(value || "").trim();
}

function getSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error("Missing sheet: " + name);
  return sheet;
}

function getRows_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2) return [];

  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  return sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues().map(values => {
    const row = {};
    headers.forEach((header, index) => {
      if (header) row[header] = values[index];
    });
    return row;
  });
}

function parseBody_(e) {
  const content = getRawBody_(e);
  if (!content) return {};

  try {
    return JSON.parse(content);
  } catch (err) {
    const params = {};
    content.split("&").forEach(pair => {
      const parts = pair.split("=");
      if (parts[0]) params[decodeURIComponent(parts[0])] = decodeURIComponent(parts.slice(1).join("=") || "");
    });
    return params;
  }
}

function getRawBody_(e) {
  return e && e.postData && e.postData.contents ? e.postData.contents : "";
}

function getParam_(e, name) {
  return e && e.parameter ? e.parameter[name] : "";
}


function toDateOrText_(value) {
  if (!value) return "";
  const date = new Date(value);
  return isNaN(date.getTime()) ? String(value) : date;
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function success_() {
  return HtmlService.createHtmlOutput("success");
}
