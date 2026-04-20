// index.js - Main orchestrator and entry point

import { 
  getTabState, setActiveTabId, activeTabId, coachingMode, setCoachingMode, 
  setWeeklyRequestsUsed, getThisMonday, CLEAR_PHRASES, deleteTabState
} from './state.js';
import { 
  initDOMElements, updateUsageIndicator, updateHeader, scrollToBottom, 
  setInputEnabled, syncHintBadge, syncCoachingToggle, removeEmptyState, 
  addEmptyState, createMessageBubble, appendMessage,
  chatEl, inputEl, modeBtnHint, modeBtnAnalyze, modeBtnDsa, coachingToggleEl
} from './ui.js';
import { fetchUsageFromServer, streamResponse } from './api.js';
import { getMonacoCode, getSubmissionResult } from './scraper.js';

document.addEventListener('DOMContentLoaded', () => {
  initDOMElements();
  initPanel();
  loadUsageCount();
  setupNavigationDetection();
  syncCoachingToggle();

  modeBtnHint.addEventListener('click', () => handleModeRequest('hint'));
  modeBtnAnalyze.addEventListener('click', () => handleModeRequest('analyze'));
  modeBtnDsa.addEventListener('click', () => handleModeRequest('dsa'));

  coachingToggleEl.addEventListener('click', async () => {
    const newMode = coachingMode === 'learn' ? 'practice' : 'learn';
    setCoachingMode(newMode);
    await chrome.storage.local.set({ coachingMode: newMode });
    syncCoachingToggle();
  });

  chrome.storage.local.get('coachingMode').then(data => {
    setCoachingMode(data.coachingMode ?? 'learn');
    syncCoachingToggle();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });
});

async function initPanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    setActiveTabId(tab.id);

    const context = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'GET_BASE_CONTEXT' }, (res) => {
        if (chrome.runtime.lastError) { /* content.js not ready */ }
        resolve(res ?? null);
      });
    });

    if (!context || !context.slug) return;

    const state = getTabState(activeTabId);
    state.slug = context.slug;
    state.baseContext = context;
    updateHeader(context);
    removeEmptyState();
    if (context.userId) fetchUsageFromServer(context.userId);
  } catch (_err) { /* Not on a problem page */ }
}

async function loadUsageCount() {
  const data = await chrome.storage.local.get(['weeklyRequests', 'weekStartDate']);
  const currentMonday = getThisMonday();
  if (data.weekStartDate !== currentMonday) {
    setWeeklyRequestsUsed(0);
    await chrome.storage.local.set({ weeklyRequests: 0, weekStartDate: currentMonday });
  } else {
    setWeeklyRequestsUsed(data.weeklyRequests ?? 0);
  }
  updateUsageIndicator();
}

function setupNavigationDetection() {
  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== 'complete') return;
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!activeTab || activeTab.id !== tabId) return;
    } catch (_err) { return; }

    try {
      const context = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'GET_BASE_CONTEXT' }, (res) => {
          if (chrome.runtime.lastError) { /* content.js not injected */ }
          resolve(res ?? null);
        });
      });
      if (!context || !context.slug) return;

      const state = getTabState(tabId);
      if (context.slug !== state.slug) {
        state.slug = context.slug;
        state.history = [];
        state.domSnapshot = null;
        state.hintLevel = 1;
        state.baseContext = context;
        chatEl.replaceChildren();
        updateHeader(context);
        syncHintBadge();
      }
    } catch (_err) { /* content.js not injected */ }
  });

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    if (activeTabId !== null && activeTabId !== tabId) {
      const frag = document.createDocumentFragment();
      while (chatEl.firstChild) frag.appendChild(chatEl.firstChild);
      getTabState(activeTabId).domSnapshot = frag;
    }

    setActiveTabId(tabId);
    const state = getTabState(tabId);
    chatEl.replaceChildren();
    if (state.domSnapshot) chatEl.appendChild(state.domSnapshot);
    syncHintBadge();

    if (state.baseContext) {
      updateHeader(state.baseContext);
      if (!state.domSnapshot) removeEmptyState();
    } else {
      try {
        const context = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { type: 'GET_BASE_CONTEXT' }, (res) => {
            if (chrome.runtime.lastError) { resolve(null); return; }
            resolve(res ?? null);
          });
        });
        if (context && context.slug) {
          state.baseContext = context;
          updateHeader(context);
          if (!state.domSnapshot) removeEmptyState();
        }
      } catch (_err) { /* Not a LeetCode page */ }
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    deleteTabState(tabId);
  });
}

async function fetchContext() {
  let context = null;
  try {
    const tabId = activeTabId;
    if (tabId) {
      const state = getTabState(tabId);
      if (state.baseContext) {
        context = { ...state.baseContext };
      } else {
        context = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { type: 'GET_BASE_CONTEXT' }, (res) => {
            if (chrome.runtime.lastError) { resolve(null); return; }
            resolve(res ?? null);
          });
        });
        if (context) state.baseContext = context;
      }
      const [code, submissionResult] = await Promise.all([getMonacoCode(tabId), getSubmissionResult(tabId)]);
      if (context) {
        context.code = code;
        context.submissionResult = submissionResult;
      } else {
        context = { code, submissionResult };
      }
    }
  } catch (_err) { /* content.js not available */ }
  return context;
}

async function sendMessage(userText) {
  userText = (userText ?? '').trim();
  if (!userText) return;

  if (CLEAR_PHRASES.has(userText.toLowerCase())) {
    const state = getTabState(activeTabId);
    state.history = [];
    state.domSnapshot = null;
    state.hintLevel = 1;
    chatEl.replaceChildren();
    addEmptyState('Ask a question or use the buttons below.');
    syncHintBadge();
    inputEl.focus();
    return;
  }

  setInputEnabled(false);
  inputEl.value = '';
  inputEl.style.height = 'auto';

  removeEmptyState();
  appendMessage('user', userText);

  const context = await fetchContext();
  const assistantBubble = createMessageBubble('assistant');
  assistantBubble.innerHTML = '<i class="gg-spinner"></i>';
  chatEl.appendChild(assistantBubble);
  scrollToBottom();

  const body = {
    mode: 'chat',
    message: userText,
    problem: {
      difficulty: context?.difficulty ?? null,
      tags: context?.tags ?? [],
      description: context?.description ?? null,
    },
    code: context?.code ?? '',
    language: context?.language ?? null,
    history: getTabState(activeTabId).history.slice(-10),
    submissionResult: context?.submissionResult ?? null,
    userId: context?.userId ?? null,
    coachingMode,
  };

  await streamResponse(body, assistantBubble, (assistantText) => {
    const hist = getTabState(activeTabId).history;
    hist.push(
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantText },
    );
    if (hist.length > 20) hist.splice(0, 2);
  });

  setInputEnabled(true);
  inputEl.focus();
}

async function handleModeRequest(mode) {
  setInputEnabled(false);
  removeEmptyState();

  const context = await fetchContext();

  if (!context?.code && mode === 'analyze') {
    const el = createMessageBubble('assistant');
    el.textContent = "No code detected in the editor. Write some code first, then try again.";
    chatEl.appendChild(el);
    scrollToBottom();
    setInputEnabled(true);
    inputEl.focus();
    return;
  }

  const labels = { hint: '[ Hint ]', analyze: '[ Analyze Code ]', dsa: '[ DSA Tips ]' };
  appendMessage('user', labels[mode]);

  const assistantBubble = createMessageBubble('assistant');
  assistantBubble.innerHTML = '<i class="gg-spinner"></i>';
  chatEl.appendChild(assistantBubble);
  scrollToBottom();

  const state = getTabState(activeTabId);
  const hintLevel = state.hintLevel;

  const body = {
    mode,
    problem: {
      difficulty: context?.difficulty ?? null,
      tags: context?.tags ?? [],
      description: context?.description ?? null,
    },
    code: context?.code ?? '',
    language: context?.language ?? null,
    submissionResult: context?.submissionResult ?? null,
    userId: context?.userId ?? null,
    coachingMode,
  };
  if (mode === 'hint') body.hintLevel = hintLevel;

  await streamResponse(body, assistantBubble, (assistantText) => {
    if (mode === 'hint' && hintLevel < 3) {
      state.hintLevel++;
      syncHintBadge();
    }
    state.history.push(
      { role: 'user', content: labels[mode] },
      { role: 'assistant', content: assistantText },
    );
    if (state.history.length > 20) state.history.splice(0, 2);
  });

  setInputEnabled(true);
  inputEl.focus();
}
