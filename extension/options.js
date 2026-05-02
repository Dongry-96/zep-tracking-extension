const DEFAULT_POLL_SECONDS = 5;

const scriptUrlInput = document.querySelector("#scriptUrl");
const sheetUrlInput = document.querySelector("#sheetUrl");
const pollSecondsInput = document.querySelector("#pollSeconds");
const saveButton = document.querySelector("#saveButton");
const openSheetButton = document.querySelector("#openSheetButton");
const statusMessage = document.querySelector("#statusMessage");

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await chrome.storage.local.get(["scriptUrl", "sheetUrl", "pollSeconds"]);
  scriptUrlInput.value = settings.scriptUrl || "";
  sheetUrlInput.value = settings.sheetUrl || "";
  pollSecondsInput.value = settings.pollSeconds || DEFAULT_POLL_SECONDS;
});

saveButton.addEventListener("click", async () => {
  const scriptUrl = scriptUrlInput.value.trim();
  const sheetUrl = sheetUrlInput.value.trim();
  const pollSeconds = Math.max(3, Number(pollSecondsInput.value || DEFAULT_POLL_SECONDS));

  if (!scriptUrl) {
    setMessage("Worker URL을 입력해주세요.", true);
    return;
  }

  await chrome.storage.local.set({ scriptUrl, sheetUrl, pollSeconds });
  setMessage("저장했습니다.", false);
});

openSheetButton.addEventListener("click", () => {
  const sheetUrl = sheetUrlInput.value.trim();
  if (!sheetUrl) {
    setMessage("Google Sheet URL을 입력해주세요.", true);
    return;
  }

  try {
    const url = new URL(sheetUrl);
    if (url.protocol !== "https:") throw new Error("invalid");
    window.open(url.toString(), "_blank", "noopener");
  } catch (err) {
    setMessage("올바른 Google Sheet URL을 입력해주세요.", true);
  }
});

function setMessage(message, isError) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", Boolean(isError));
}
