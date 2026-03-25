// sidepanel.js — all chat logic, fetch calls, history management

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'https://5y6thwif3uawisncrkvzphmvie0tanli.lambda-url.us-east-1.on.aws/';

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
// State
// ---------------------------------------------------------------------------

/** Per-tab state: Map<tabId, { history: [], slug: string|null, domSnapshot: DocumentFragment|null, hintLevel: number }> */
const tabHistories = new Map();
let activeTabId = null;

function getTabState(tabId) {
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
        chrome.tabs.sendMessage(tabId, { type: 'GET_CONTEXT' }, resolve);
      });

      if (!context || !context.slug) return;

      const state = getTabState(activeTabId);
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
        chrome.tabs.sendMessage(tabId, { type: 'GET_BASE_CONTEXT' }, resolve);
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

async function getFailureInfo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        // 1. Find an element whose text is exactly "Wrong Answer".
        //    Try the stable data attribute first, then fall back to a full-DOM text search
        //    (LeetCode often strips data-e2e-locator from production builds).
        let resultEl = document.querySelector('[data-e2e-locator="submission-result"]');
        if (!resultEl?.innerText?.includes('Wrong Answer')) {
          resultEl = null;
          for (const el of document.querySelectorAll('span, div, p, h4, h5')) {
            if (el.innerText?.trim() === 'Wrong Answer') {
              resultEl = el;
              break;
            }
          }
        }

        if (!resultEl) return null;

        // 2. Walk up the tree until we find a container that holds the detail sections
        //    (input / expected / actual).  Stop after 15 levels or when we have enough text.
        let container = resultEl.parentElement;
        for (let i = 0; i < 15 && container; i++) {
          const t = container.innerText ?? '';
          if ((t.includes('Input') || t.includes('input')) &&
              (t.includes('Expected') || t.includes('Output'))) break;
          container = container.parentElement;
        }
        const containerEl = container ?? resultEl;

        // 3. Scan children for labelled sections — try several label variants
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

        return { status: 'Wrong Answer', ...details };
      },
    });
    return results?.[0]?.result ?? null;
  } catch (err) {
    console.log('[LeetCoach] getFailureInfo error:', err);
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
    const failureInfo = await getFailureInfo(activeTab.id);
    if (context) {
      context.code = code;
      context.failureInfo = failureInfo;
    } else {
      context = { code, failureInfo };
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
    failureInfo: context?.failureInfo  ?? null,
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
    name:        context?.title       ?? null,
    number:      context?.number      ?? null,
    difficulty:  context?.difficulty  ?? null,
    tags:        context?.tags        ?? [],
    description: context?.description ?? null,
    slug:        context?.slug        ?? null,
  };
  const code     = context?.code     ?? '';
  const language = context?.language ?? null;

  if (mode === 'hint')    return { mode, problem, code, language, hintLevel };
  if (mode === 'dsa')     return { mode, problem, code, language };
  if (mode === 'analyze') return { mode, problem, code, language, history: historySlice, failureInfo: context?.failureInfo ?? null };
  return { mode, problem, code, language, history: historySlice }; // chat
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
    const failureInfo = await getFailureInfo(activeTab.id);
    if (context) {
      context.code = code;
      context.failureInfo = failureInfo;
    } else {
      context = { code, failureInfo };
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
