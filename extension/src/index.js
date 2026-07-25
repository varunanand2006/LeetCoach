// index.js - Main orchestrator and entry point

import {
  getTabState, setActiveTabId, activeTabId, coachingMode, setCoachingMode,
  setWeeklyRequestsUsed, getThisMonday, CLEAR_PHRASES, deleteTabState,
  saveProblemState, loadProblemState, clearProblemState,
  diagramArmed, setDiagramArmed, DIAGRAM_COST, MAX_RETAINED_HISTORY
} from './state.js';
import {
  initDOMElements, updateUsageIndicator, updateHeader, scrollToBottom,
  setInputEnabled, syncHintBadge, syncCoachingToggle, removeEmptyState,
  addEmptyState, createMessageBubble, appendMessage, syncDiagramToggle, remainingPrompts,
  setOverflowOpen, isOverflowOpen, syncMenuItems,
  chatEl, inputEl, modeBtnHint, modeBtnAnalyze, modeBtnThird, coachingToggleEl,
  settingsToggleEl, menuDiagramEl, menuReviewEl, menuClearEl, menuResetHintEl
} from './ui.js';
import { fetchUsageFromServer, streamResponse } from './api.js';
import { renderMarkdown } from './markdown.js';
import { renderDiagramsIn } from './diagram.js';
import { getMonacoCode, getSubmissionResult } from './scraper.js';

document.addEventListener('DOMContentLoaded', () => {
  initDOMElements();
  initPanel();
  loadUsageCount();
  setupNavigationDetection();
  syncCoachingToggle();
  syncDiagramToggle();

  modeBtnHint.addEventListener('click', () => handleModeRequest('hint'));
  modeBtnAnalyze.addEventListener('click', () => handleModeRequest('analyze'));
  modeBtnThird.addEventListener('click', () => handleModeRequest(modeBtnThird.dataset.mode));

  coachingToggleEl.addEventListener('click', async () => {
    const next = { learn: 'practice', practice: 'interview', interview: 'learn' };
    const newMode = next[coachingMode] ?? 'learn';
    setCoachingMode(newMode);
    await chrome.storage.local.set({ coachingMode: newMode });
    syncCoachingToggle();
  });

  settingsToggleEl.addEventListener('click', (e) => {
    e.stopPropagation();
    setOverflowOpen(!isOverflowOpen());
  });

  document.addEventListener('click', (e) => {
    if (isOverflowOpen() && !e.target.closest('#settings-menu, #settings-toggle')) {
      setOverflowOpen(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOverflowOpen()) setOverflowOpen(false);
  });

  menuReviewEl.addEventListener('click', () => {
    setOverflowOpen(false);
    handleModeRequest('review');
  });

  menuClearEl.addEventListener('click', () => {
    setOverflowOpen(false);
    clearChat();
  });

  menuResetHintEl.addEventListener('click', () => {
    setOverflowOpen(false);
    const state = getTabState(activeTabId);
    state.hintLevel = 1;
    syncHintBadge();
    saveProblemState(state.slug, state.history, state.hintLevel);
  });

  // Diagram arming is one-shot and deliberately not persisted — it should never
  // survive a panel reload and silently double-charge a later request.
  // The menu stays open on toggle so the check state is visible before dismissing.
  menuDiagramEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!diagramArmed && remainingPrompts() < DIAGRAM_COST) return;
    setDiagramArmed(!diagramArmed);
    syncDiagramToggle();
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

function renderHistoryToDOM(history) {
  chatEl.replaceChildren();
  for (const { role, content } of history) {
    const el = createMessageBubble(role);
    if (role === 'assistant') {
      el.innerHTML = renderMarkdown(content);
    } else {
      el.textContent = content;
    }
    chatEl.appendChild(el);
  }
  // Diagrams are stored as mermaid source in history, so redraw them on restore.
  renderDiagramsIn(chatEl).then(scrollToBottom).catch(() => {});
  scrollToBottom();
}

async function tryRestoreChat(state) {
  const slug = state.slug;
  if (!slug) return;
  if (state.history.length > 0) {
    renderHistoryToDOM(state.history);
    syncHintBadge();
    return;
  }
  const saved = await loadProblemState(slug);
  if (saved && saved.history.length > 0) {
    state.history = saved.history;
    state.hintLevel = saved.hintLevel ?? 1;
    renderHistoryToDOM(state.history);
    syncHintBadge();
  }
}

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
    await tryRestoreChat(state);
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
        await tryRestoreChat(state);
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
      if (!state.domSnapshot) {
        removeEmptyState();
        await tryRestoreChat(state);
      }
    } else {
      try {
        const context = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { type: 'GET_BASE_CONTEXT' }, (res) => {
            if (chrome.runtime.lastError) { resolve(null); return; }
            resolve(res ?? null);
          });
        });
        if (context && context.slug) {
          state.slug = context.slug;
          state.baseContext = context;
          updateHeader(context);
          if (!state.domSnapshot) {
            removeEmptyState();
            await tryRestoreChat(state);
          }
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

/** Reset the conversation for the active tab. Shared by /clear and the ⋯ menu. */
function clearChat() {
  const state = getTabState(activeTabId);
  clearProblemState(state.slug);
  state.history = [];
  state.domSnapshot = null;
  state.hintLevel = 1;
  chatEl.replaceChildren();
  addEmptyState('Ask a question or use the buttons below.');
  syncHintBadge();
  syncMenuItems();
  inputEl.focus();
}

async function sendMessage(userText) {
  userText = (userText ?? '').trim();
  if (!userText) return;

  if (CLEAR_PHRASES.has(userText.toLowerCase())) {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    clearChat();
    return;
  }

  // Consume the one-shot arm up front so a slow request can't be double-fired.
  const wantsDiagram = diagramArmed;
  setDiagramArmed(false);
  syncDiagramToggle();

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
    slug: context?.slug ?? null,
    history: getTabState(activeTabId).history.slice(-10),
    submissionResult: context?.submissionResult ?? null,
    userId: context?.userId ?? null,
    coachingMode,
    wantsDiagram,
  };

  await streamResponse(body, assistantBubble, (assistantText) => {
    const state = getTabState(activeTabId);
    state.history.push(
      { role: 'user', content: userText },
      { role: 'assistant', content: assistantText },
    );
    if (state.history.length > MAX_RETAINED_HISTORY) state.history.splice(0, 2);
    saveProblemState(state.slug, state.history, state.hintLevel);
  });

  setInputEnabled(true);
  inputEl.focus();
}

async function handleModeRequest(mode) {
  // Consume the one-shot arm up front so a slow request can't be double-fired.
  const wantsDiagram = diagramArmed;
  setDiagramArmed(false);
  syncDiagramToggle();

  setInputEnabled(false);
  removeEmptyState();

  const context = await fetchContext();

  if (!context?.code && (mode === 'analyze' || mode === 'optimize' || mode === 'feedback')) {
    const el = createMessageBubble('assistant');
    el.textContent = "No code detected in the editor. Write some code first, then try again.";
    chatEl.appendChild(el);
    scrollToBottom();
    setInputEnabled(true);
    inputEl.focus();
    return;
  }

  const labels = {
    hint: '[ Hint ]',
    analyze: '[ Analyze Code ]',
    dsa: '[ DSA Tips ]',
    optimize: '[ Optimize ]',
    feedback: '[ Feedback ]',
    review: '[ Review Report ]',
  };
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
    // Needed by hint/analyze/optimize — it's how the backend looks up the
    // problem's official hints and constraints.
    slug: context?.slug ?? null,
    submissionResult: context?.submissionResult ?? null,
    userId: context?.userId ?? null,
    coachingMode,
    wantsDiagram,
  };
  if (mode === 'hint') body.hintLevel = hintLevel;
  // The review report is the only button mode that reads the conversation —
  // it summarizes the whole session, so it needs the retained history.
  if (mode === 'review') body.history = state.history.slice(-MAX_RETAINED_HISTORY);

  await streamResponse(body, assistantBubble, (assistantText) => {
    if (mode === 'hint' && hintLevel < 3) {
      state.hintLevel++;
      syncHintBadge();
    }
    state.history.push(
      { role: 'user', content: labels[mode] },
      { role: 'assistant', content: assistantText },
    );
    if (state.history.length > MAX_RETAINED_HISTORY) state.history.splice(0, 2);
    saveProblemState(state.slug, state.history, state.hintLevel);
  });

  setInputEnabled(true);
  inputEl.focus();
}
