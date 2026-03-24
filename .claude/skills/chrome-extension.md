# Chrome Extension (Manifest V3) Skill

## Key Patterns
- Always use Manifest V3 (manifest_version: 3)
- Background scripts are service workers — they can go inactive, never store state in variables
- Use chrome.storage.session for temporary state within a session
- Use chrome.runtime.onMessage for all cross-context communication
- content.js, background.js, and sidepanel.js are completely isolated contexts

## Manifest Permissions Needed
- "sidePanel" — side panel API
- "tabs" — read tab URLs in background.js
- "activeTab" — access current tab
- "scripting" — inject scripts dynamically if needed
- host_permissions: ["https://leetcode.com/*"]

## Side Panel Behavior
```javascript
// background.js — auto-open on problem pages, disable elsewhere
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

// Handle keyboard shortcut
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'open-side-panel') {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});
```

## Message Passing Pattern
```javascript
// sidepanel.js requests context from content.js via background
async function getContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' }, resolve);
  });
}

// content.js responds
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CONTEXT') {
    sendResponse(collectContext());
    return true; // REQUIRED for async
  }
});
```

## Common Pitfalls
- Always return true from onMessage listeners that respond asynchronously
- Service worker goes inactive — don't rely on in-memory state in background.js
- Monaco loads asynchronously — always retry with setTimeout
- LeetCode class names change — use data attributes when possible
- NEVER use document in background.js — it has no DOM
- sidepanel.js can use chrome.tabs API but needs "tabs" permission
- content.js cannot directly open the side panel — route through background.js