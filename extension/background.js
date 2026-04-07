// background.js - side panel lifecycle only, no DOM access

// Global default: panel disabled for all tabs unless explicitly enabled per-tab.
chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: false });

// Open panel when user clicks the extension icon (requires user gesture).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;

  let isProblem = false;
  try {
    const u = new URL(tab.url);
    isProblem = u.hostname === 'leetcode.com' && u.pathname.startsWith('/problems/');
  } catch (_e) { /* invalid URL — leave isProblem false */ }

  await chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel.html',
    enabled: isProblem
  });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'open-side-panel' || !tab?.id) return;
  let onProblem = false;
  try {
    const u = new URL(tab.url);
    onProblem = u.hostname === 'leetcode.com' && u.pathname.startsWith('/problems/');
  } catch (_e) {}
  if (!onProblem) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});
