// background.js - side panel lifecycle only, no DOM access

function isLeetCodeProblem(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'leetcode.com' && u.pathname.startsWith('/problems/');
  } catch (_e) {
    return false;
  }
}

// Global default: panel disabled for all tabs unless explicitly enabled per-tab.
chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: false });

// Open panel when user clicks the extension icon (requires user gesture).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;
  await chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel.html',
    enabled: isLeetCodeProblem(tab.url),
  });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'open-side-panel' || !tab?.id) return;
  if (!isLeetCodeProblem(tab.url)) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});
