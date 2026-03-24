// background.js - side panel lifecycle only, no DOM access

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;

  const isProblem = tab.url.includes('leetcode.com/problems/');

  await chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel.html',
    enabled: isProblem
  });

  if (isProblem && info.status === 'complete') {
    await chrome.sidePanel.open({ tabId });
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'open-side-panel' && tab?.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});
