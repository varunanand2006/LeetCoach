// sidepanel.js — all chat logic, fetch calls, history management

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'https://5y6thwif3uawisncrkvzphmvie0tanli.lambda-url.us-east-1.on.aws/';
const WEEKLY_LIMIT = 100;

const LANG_MAP = {
  // Python
  'python': 'python', 'python3': 'python',
  // JavaScript / TypeScript
  'javascript': 'javascript', 'js': 'javascript',
  'typescript': 'typescript', 'ts': 'typescript',
  // C family
  'cpp': 'cpp', 'c++': 'cpp',
  'c': 'c',
  'csharp': 'csharp', 'c#': 'csharp',
  // JVM
  'java': 'java',
  'kotlin': 'kotlin',
  'scala': 'scala',
  // Systems
  'go': 'go', 'golang': 'go',
  'rust': 'rust',
  'swift': 'swift',
  // Scripting
  'ruby': 'ruby',
  'php': 'php',
  'bash': 'bash', 'shell': 'bash',
  // Other LeetCode languages
  'dart': 'dart',
  'erlang': 'erlang',
  'elixir': 'elixir',
  'racket': 'scheme',
};

// ---------------------------------------------------------------------------
// Usage tracking (local, chrome.storage.local)
// ---------------------------------------------------------------------------

function getThisMonday() {
  const d = new Date();
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const dd = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

let weeklyRequestsUsed = 0;

async function loadUsageCount() {
  const data = await chrome.storage.local.get(['weeklyRequests', 'weekStartDate']);
  const currentMonday = getThisMonday();
  if (data.weekStartDate !== currentMonday) {
    weeklyRequestsUsed = 0;
    await chrome.storage.local.set({ weeklyRequests: 0, weekStartDate: currentMonday });
  } else {
    weeklyRequestsUsed = data.weeklyRequests ?? 0;
  }
  updateUsageIndicator();
}

async function fetchUsageFromServer(userId) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'usage', userId }),
    });
    if (!response.ok) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const data = JSON.parse(text);
    if (typeof data.weeklyRequests === 'number') {
      const currentMonday = getThisMonday();
      weeklyRequestsUsed = data.weekStartDate === currentMonday ? data.weeklyRequests : 0;
      await chrome.storage.local.set({ weeklyRequests: weeklyRequestsUsed, weekStartDate: currentMonday });
      updateUsageIndicator();
    }
  } catch (_e) { /* fail silently — local count remains */ }
}

function updateUsageIndicator() {
  const el = document.getElementById('usage-indicator');
  if (!el) return;
  const remaining = Math.max(0, WEEKLY_LIMIT - weeklyRequestsUsed);
  el.dataset.tooltip = `${remaining} prompts left`;
}

async function incrementUsage() {
  weeklyRequestsUsed++;
  await chrome.storage.local.set({ weeklyRequests: weeklyRequestsUsed, weekStartDate: getThisMonday() });
  updateUsageIndicator();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Per-tab state: Map<tabId, { history: [], slug: string|null, domSnapshot: DocumentFragment|null, hintLevel: number }> */
const tabHistories = new Map();
let activeTabId = null;

function getTabState(tabId) {
  if (!tabId) return { history: [], slug: null, domSnapshot: null, hintLevel: 1 };
  if (!tabHistories.has(tabId)) {
    tabHistories.set(tabId, { history: [], slug: null, domSnapshot: null, hintLevel: 1 });
  }
  return tabHistories.get(tabId);
}

// ---------------------------------------------------------------------------
// DOM references (set after DOMContentLoaded)
// ---------------------------------------------------------------------------

let chatEl, inputEl, problemNameEl;
let modeBtnHint, modeBtnAnalyze, modeBtnDsa, hintLevelBadgeEl;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  chatEl          = document.getElementById('chat');
  inputEl         = document.getElementById('input');
  problemNameEl   = document.getElementById('problem-name');
  modeBtnHint     = document.getElementById('btn-hint');
  modeBtnAnalyze  = document.getElementById('btn-analyze');
  modeBtnDsa      = document.getElementById('btn-dsa');
  hintLevelBadgeEl = document.getElementById('hint-level-badge');

  initPanel();
  loadUsageCount();
  setupNavigationDetection();

  modeBtnHint.addEventListener('click', () => handleModeRequest('hint'));
  modeBtnAnalyze.addEventListener('click', () => handleModeRequest('analyze'));
  modeBtnDsa.addEventListener('click', () => handleModeRequest('dsa'));

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = inputEl.value;
      sendMessage(text);
    }
  });

  // Auto-grow textarea as user types
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

});

// ---------------------------------------------------------------------------
// initPanel
// ---------------------------------------------------------------------------

async function initPanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    activeTabId = tab.id;

    const context = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'GET_BASE_CONTEXT' }, (res) => {
        if (chrome.runtime.lastError) { /* content.js not ready yet */ }
        resolve(res ?? null);
      });
    });

    if (!context || !context.slug) {
      // Not on a problem page — leave default empty-state text
      return;
    }

    getTabState(activeTabId).slug = context.slug;
    updateHeader(context);
    removeEmptyState();
    if (context.userId) fetchUsageFromServer(context.userId);
  } catch (_err) {
    // content.js not available — leave default empty-state message
  }
}

// ---------------------------------------------------------------------------
// Navigation detection
// ---------------------------------------------------------------------------

function setupNavigationDetection() {
  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== 'complete') return;

    // Only act on the currently active tab
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!activeTab || activeTab.id !== tabId) return;
    } catch (_err) {
      return;
    }

    try {
      const context = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'GET_BASE_CONTEXT' }, (res) => {
          if (chrome.runtime.lastError) { /* content.js not injected — ignore */ }
          resolve(res ?? null);
        });
      });

      if (!context || !context.slug) return;

      const state = getTabState(tabId);
      if (context.slug !== state.slug) {
        // User navigated to a different problem
        state.slug = context.slug;
        state.history = [];
        state.domSnapshot = null;
        state.hintLevel = 1;
        chatEl.innerHTML = '';
        updateHeader(context);
        syncHintBadge();
      }
    } catch (_err) {
      // content.js not injected on this page — nothing to do
    }
  });

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    // Snapshot outgoing tab DOM — move nodes into a fragment (no serialization)
    if (activeTabId !== null && activeTabId !== tabId) {
      const frag = document.createDocumentFragment();
      while (chatEl.firstChild) frag.appendChild(chatEl.firstChild);
      getTabState(activeTabId).domSnapshot = frag;
    }

    activeTabId = tabId;

    // Restore incoming tab DOM
    const state = getTabState(tabId);
    while (chatEl.firstChild) chatEl.removeChild(chatEl.firstChild);
    if (state.domSnapshot) chatEl.appendChild(state.domSnapshot);
    syncHintBadge();

    // Refresh header
    try {
      const context = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'GET_BASE_CONTEXT' }, (res) => {
          if (chrome.runtime.lastError) { /* content.js not injected — ignore */ }
          resolve(res ?? null);
        });
      });
      if (context && context.slug) {
        updateHeader(context);
        if (!state.domSnapshot) removeEmptyState();
      }
    } catch (_err) {
      // Not a LeetCode page — panel is hidden anyway
    }
  });
}

// ---------------------------------------------------------------------------
// MAIN world readers (must run via executeScript to access page JS / full DOM)
// ---------------------------------------------------------------------------

async function getMonacoCode(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const models = window.monaco?.editor?.getModels() ?? [];
        const editors = window.monaco?.editor?.getEditors() ?? [];
        return models[0]?.getValue() ?? editors[0]?.getValue() ?? '';
      },
    });
    return results?.[0]?.result ?? '';
  } catch (err) {
    console.log('[LeetCoach] getMonacoCode error:', err);
    return '';
  }
}

async function getSubmissionResult(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const TERMINAL = [
          'Wrong Answer', 'Runtime Error', 'Time Limit Exceeded',
          'Memory Limit Exceeded', 'Compile Error', 'Output Limit Exceeded',
        ];

        // Find the result element — try stable attribute first, then text search
        let resultEl = document.querySelector('[data-e2e-locator="submission-result"]');
        if (!resultEl || !TERMINAL.includes(resultEl.innerText?.trim())) {
          resultEl = null;
          for (const el of document.querySelectorAll('span, div, p, h4, h5')) {
            if (el.children.length <= 1 && TERMINAL.includes(el.innerText?.trim())) {
              resultEl = el;
              break;
            }
          }
        }
        if (!resultEl) return null;

        const status = resultEl.innerText.trim();

        // Walk up to find a container with the relevant detail sections
        let container = resultEl.parentElement;
        for (let i = 0; i < 15 && container; i++) {
          const t = container.innerText ?? '';
          if (t.includes('Input') || t.includes('Error') || t.length > 150) break;
          container = container.parentElement;
        }
        const containerEl = container ?? resultEl;

        if (status === 'Wrong Answer') {
          const details = { input: null, expected: null, actual: null };
          for (const el of containerEl.querySelectorAll('*')) {
            if (el.children.length > 3) continue;
            const text = el.innerText?.trim();
            if (!text) continue;
            if (text === 'Input') {
              details.input = el.nextElementSibling?.innerText?.trim() ?? null;
            } else if (text === 'Expected Output' || text === 'Expected' || text === 'Expected:') {
              details.expected = el.nextElementSibling?.innerText?.trim() ?? null;
            } else if (text === 'Output' || text === 'Stdout' || text === 'Actual Output' || text === 'Your Output') {
              details.actual = el.nextElementSibling?.innerText?.trim() ?? null;
            }
          }
          return { status, ...details };
        }

        if (status === 'Runtime Error' || status === 'Compile Error') {
          const errorEl =
            containerEl.querySelector('pre') ??
            containerEl.querySelector('code') ??
            containerEl.querySelector('[class*="error"]');
          return { status, message: errorEl?.innerText?.trim() ?? null };
        }

        if (status === 'Time Limit Exceeded' || status === 'Memory Limit Exceeded' || status === 'Output Limit Exceeded') {
          let input = null;
          for (const el of containerEl.querySelectorAll('*')) {
            if (el.children.length > 3) continue;
            if (el.innerText?.trim() === 'Input') {
              input = el.nextElementSibling?.innerText?.trim() ?? null;
              break;
            }
          }
          return { status, input };
        }

        return { status };
      },
    });
    return results?.[0]?.result ?? null;
  } catch (err) {
    console.log('[LeetCoach] getSubmissionResult error:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

async function sendMessage(userText) {
  userText = (userText ?? '').trim();
  if (!userText) return;

  // Clear-chat shortcut phrases
  const clearPhrases = ['start over', 'clear chat', 'clear', 'reset'];
  if (clearPhrases.includes(userText.toLowerCase())) {
    clearChat();
    return;
  }

  // Disable input while processing
  setInputEnabled(false);
  inputEl.value = '';
  inputEl.style.height = 'auto';

  // Append user bubble immediately so it appears before any async work
  removeEmptyState();
  appendMessage('user', userText);

  // Get fresh context — base context from content.js, code via scripting (MAIN world)
  let context = null;
  let activeTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = tab ?? null;
    if (tab) {
      context = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'GET_BASE_CONTEXT' }, (res) => {
          if (chrome.runtime.lastError) { /* content.js not ready — that's ok */ }
          resolve(res ?? null);
        });
      });
    }
  } catch (_err) { /* ignore */ }

  // Always attempt to read Monaco code and failure info directly — independent of content.js
  if (activeTab) {
    const code = await getMonacoCode(activeTab.id);
    const submissionResult = await getSubmissionResult(activeTab.id);
    if (context) {
      context.code = code;
      context.submissionResult = submissionResult;
    } else {
      context = { code, submissionResult };
    }
  }

  // Create assistant bubble early so text streams in
  const assistantBubble = createMessageBubble('assistant');
  assistantBubble.innerHTML = '<i class="gg-spinner"></i>';
  chatEl.appendChild(assistantBubble);
  scrollToBottom();

  // Trim history before sending
  const historySlice = getTabState(activeTabId).history.slice(-10);

  // Build request body
  const body = {
    mode:    'chat',
    message: userText,
    problem: {
      name:        context?.title       ?? null,
      number:      context?.number      ?? null,
      difficulty:  context?.difficulty  ?? null,
      tags:        context?.tags        ?? [],
      description: context?.description ?? null,
      slug:        context?.slug        ?? null,
    },
    code:        context?.code        ?? '',
    language:    context?.language    ?? null,
    history:     historySlice,
    submissionResult: context?.submissionResult ?? null,
    userId:      context?.userId      ?? null,
  };

  // Fetch and stream the response
  let assistantText = '';
  try {
    const response = await fetch(API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      assistantText += chunk;
      assistantBubble.innerHTML = renderMarkdown(assistantText);
      scrollToBottom();
    }

    // Flush any remaining bytes
    const tail = decoder.decode();
    if (tail) {
      assistantText += tail;
      assistantBubble.innerHTML = renderMarkdown(assistantText);
      scrollToBottom();
    }

    // Check for rate limit error streamed as JSON
    try {
      const parsed = JSON.parse(assistantText);
      if (parsed.error === 'weekly_limit_reached') {
        assistantBubble.remove();
        showLimitWarning();
        setInputEnabled(true);
        inputEl.focus();
        return;
      }
    } catch (_e) { /* normal text response */ }

    incrementUsage();

    // Commit both turns to history
    getTabState(activeTabId).history.push(
      { role: 'user',      content: userText      },
      { role: 'assistant', content: assistantText },
    );
  } catch (_err) {
    assistantBubble.textContent = 'Error generating response. Please try again.';
    scrollToBottom();
  }

  setInputEnabled(true);
  inputEl.focus();
}

// ---------------------------------------------------------------------------
// showLimitWarning
// ---------------------------------------------------------------------------

function showLimitWarning() {
  const el = document.createElement('div');
  el.classList.add('message', 'warning');
  el.textContent = "You've reached your weekly limit of 100 requests. Your limit resets on Monday!";
  chatEl.appendChild(el);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// clearChat
// ---------------------------------------------------------------------------

function clearChat() {
  const state = getTabState(activeTabId);
  state.history = [];
  state.domSnapshot = null;
  state.hintLevel = 1;
  chatEl.innerHTML = '';
  syncHintBadge();
  inputEl.focus();
}

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

/**
 * Creates a message bubble, appends it to #chat, scrolls to bottom,
 * and returns the element.
 */
function appendMessage(role, text) {
  const el = createMessageBubble(role);
  el.textContent = text;
  chatEl.appendChild(el);
  scrollToBottom();
  return el;
}

// ---------------------------------------------------------------------------
// createMessageBubble
// ---------------------------------------------------------------------------

function createMessageBubble(role) {
  const el = document.createElement('div');
  el.classList.add('message', role);
  return el;
}

// ---------------------------------------------------------------------------
// updateHeader
// ---------------------------------------------------------------------------

function updateHeader(context) {
  const number = context?.number ?? '';
  const name   = context?.title  ?? '';
  problemNameEl.textContent = number ? `${number}. ${name}` : name;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setInputEnabled(enabled) {
  inputEl.disabled        = !enabled;
  modeBtnHint.disabled    = !enabled;
  modeBtnAnalyze.disabled = !enabled;
  modeBtnDsa.disabled     = !enabled;
}

function syncHintBadge() {
  hintLevelBadgeEl.textContent = Math.min(getTabState(activeTabId)?.hintLevel ?? 1, 3);
}

function removeEmptyState() {
  const el = document.getElementById('empty-state');
  if (el) el.remove();
}

// ---------------------------------------------------------------------------
// Mode button requests
// ---------------------------------------------------------------------------

function buildModeBody(mode, context, hintLevel) {
  const historySlice = getTabState(activeTabId).history.slice(-10);
  const problem = {
    difficulty:  context?.difficulty  ?? null,
    tags:        context?.tags        ?? [],
    description: context?.description ?? null,
  };
  const code     = context?.code     ?? '';
  const language = context?.language ?? null;
  const userId   = context?.userId   ?? null;

  const submissionResult = context?.submissionResult ?? null;
  if (mode === 'hint')    return { mode, problem, code, language, hintLevel, submissionResult, userId };
  if (mode === 'dsa')     return { mode, problem, code, language, submissionResult, userId };
  if (mode === 'analyze') return { mode, problem, code, language, submissionResult, userId };
  return { mode, problem, code, language, history: historySlice, submissionResult, userId }; // chat
}

async function handleModeRequest(mode) {
  setInputEnabled(false);
  removeEmptyState();

  let context = null;
  let activeTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = tab ?? null;
    if (tab) {
      context = await new Promise(resolve => chrome.tabs.sendMessage(tab.id, { type: 'GET_BASE_CONTEXT' }, (res) => {
        if (chrome.runtime.lastError) { /* content.js not ready — that's ok */ }
        resolve(res ?? null);
      }));
    }
  } catch (_) {}

  // Always attempt to read Monaco code and failure info directly — independent of content.js
  if (activeTab) {
    const code = await getMonacoCode(activeTab.id);
    const submissionResult = await getSubmissionResult(activeTab.id);
    if (context) {
      context.code = code;
      context.submissionResult = submissionResult;
    } else {
      context = { code, submissionResult };
    }
  }

  const labels = { hint: '[ Hint ]', analyze: '[ Analyze Code ]', dsa: '[ DSA Tips ]' };
  appendMessage('user', labels[mode]);

  const assistantBubble = createMessageBubble('assistant');
  assistantBubble.innerHTML = '<i class="gg-spinner"></i>';
  chatEl.appendChild(assistantBubble);
  scrollToBottom();

  const state = getTabState(activeTabId);
  const hintLevel = state.hintLevel;
  let assistantText = '';

  try {
    const response = await fetch(API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(buildModeBody(mode, context, hintLevel)),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      assistantText += decoder.decode(value, { stream: true });
      assistantBubble.innerHTML = renderMarkdown(assistantText);
      scrollToBottom();
    }
    const tail = decoder.decode();
    if (tail) {
      assistantText += tail;
      assistantBubble.innerHTML = renderMarkdown(assistantText);
      scrollToBottom();
    }

    // Check for rate limit error streamed as JSON
    try {
      const parsed = JSON.parse(assistantText);
      if (parsed.error === 'weekly_limit_reached') {
        assistantBubble.remove();
        showLimitWarning();
        setInputEnabled(true);
        inputEl.focus();
        return;
      }
    } catch (_e) { /* normal text response */ }

    incrementUsage();

    if (mode === 'hint' && hintLevel < 3) {
      state.hintLevel++;
      syncHintBadge();
    }

    state.history.push(
      { role: 'user',      content: labels[mode]    },
      { role: 'assistant', content: assistantText   },
    );
  } catch (_) {
    assistantBubble.textContent = 'Error generating response. Please try again.';
    scrollToBottom();
  }

  setInputEnabled(true);
  inputEl.focus();
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(raw) {
  // Stash fenced code blocks
  const blocks = [];
  let text = raw.replace(/```([\w]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const trimmed = code.trim();
    const prismLang = LANG_MAP[lang.toLowerCase()] || lang;
    const grammar = typeof Prism !== 'undefined' && Prism.languages[prismLang];
    const highlighted = grammar
      ? Prism.highlight(trimmed, grammar, prismLang)
      : escapeHtml(trimmed);
    const attr = lang ? ` data-lang="${lang}"` : '';
    blocks.push(`<pre${attr}><code class="language-${prismLang}">${highlighted}</code></pre>`);
    return `\x02B${blocks.length - 1}\x03`;
  });

  // Stash inline code
  const inlines = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    inlines.push(`<code>${escapeHtml(code)}</code>`);
    return `\x02I${inlines.length - 1}\x03`;
  });

  // Escape remaining HTML
  text = escapeHtml(text);

  // Bold and italic
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // Process line by line
  const lines = text.split('\n');
  const out = [];
  let listType = null;

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const line of lines) {
    if (/^#{1,3} /.test(line)) {
      closeList();
      out.push(`<h4>${line.replace(/^#+\s+/, '')}</h4>`);
    } else if (/^---+$/.test(line)) {
      closeList();
      out.push('<hr>');
    } else if (/^[*-] /.test(line)) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${line.slice(2)}</li>`);
    } else if (/^\d+\. /.test(line)) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${line.replace(/^\d+\.\s+/, '')}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${line}</p>`);
    }
  }
  closeList();

  text = out.join('');
  text = text.replace(/\x02I(\d+)\x03/g, (_, i) => inlines[i]);
  text = text.replace(/\x02B(\d+)\x03/g, (_, i) => blocks[i]);
  return text;
}
