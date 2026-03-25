// background.js - side panel lifecycle only, no DOM access

// Global default: panel disabled for all tabs unless explicitly enabled per-tab.
chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: false });

// Open panel when user clicks the extension icon (requires user gesture).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;

  const isProblem = tab.url.includes('leetcode.com/problems/');

  await chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel.html',
    enabled: isProblem
  });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'open-side-panel' || !tab?.id) return;
  if (!tab.url?.includes('leetcode.com/problems/')) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});
