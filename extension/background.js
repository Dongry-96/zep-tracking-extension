const SIDE_PANEL_PATH = "popup.html";

async function enableSidePanel(tabId) {
  if (!Number.isInteger(tabId)) return;

  await chrome.sidePanel.setOptions({
    tabId,
    path: SIDE_PANEL_PATH,
    enabled: true,
  }).catch(error => console.error(error));
}

async function configureSidePanel() {
  await chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(error => console.error(error));

  const tabs = await chrome.tabs.query({ active: true }).catch(() => []);
  await Promise.all(tabs.map(tab => enableSidePanel(tab.id)));
}

configureSidePanel();

chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);
chrome.tabs.onActivated.addListener(({ tabId }) => enableSidePanel(tabId));
chrome.tabs.onCreated.addListener(tab => enableSidePanel(tab.id));
chrome.tabs.onUpdated.addListener(tabId => enableSidePanel(tabId));
