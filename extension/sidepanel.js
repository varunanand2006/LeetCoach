// sidepanel.js — all chat logic, fetch calls, history management

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'https://5y6thwif3uawisncrkvzphmvie0tanli.lambda-url.us-east-1.on.aws/';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Array of { role: 'user'|'assistant', content: string } */
let conversationHistory = [];

/** Slug of the current problem — used to detect navigation between problems */
let currentSlug = null;

// ---------------------------------------------------------------------------
// DOM references (set after DOMContentLoaded)
// ---------------------------------------------------------------------------

let chatEl, inputEl, sendEl, clearEl, problemNameEl, difficultyBadgeEl;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  chatEl          = document.getElementById('chat');
  inputEl         = document.getElementById('input');
  sendEl          = document.getElementById('send');
  clearEl         = document.getElementById('clear-btn');
  problemNameEl   = document.getElementById('problem-name');
  difficultyBadgeEl = document.getElementById('difficulty-badge');

  initPanel();
  setupNavigationDetection();

  sendEl.addEventListener('click', () => {
    const text = inputEl.value;
    sendMessage(text);
  });

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

  clearEl.addEventListener('click', () => clearChat());
});

// ---------------------------------------------------------------------------
// initPanel
// ---------------------------------------------------------------------------

async function initPanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const context = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' }, resolve);
    });

    if (!context || !context.slug) {
      // Not on a problem page — leave default empty-state text
      return;
    }

    currentSlug = context.slug;
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
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab || activeTab.id !== tabId) return;
    } catch (_err) {
      return;
    }

    try {
      const context = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'GET_CONTEXT' }, resolve);
      });

      if (!context || !context.slug) return;

      if (context.slug !== currentSlug) {
        // User navigated to a different problem
        currentSlug = context.slug;
        conversationHistory = [];
        chatEl.innerHTML = '';
        updateHeader(context);
      }
    } catch (_err) {
      // content.js not injected on this page — nothing to do
    }
  });
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

  // Get fresh context
  let context = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      context = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' }, resolve);
      });
    }
  } catch (_err) {
    // content.js unavailable — proceed with null context
  }

  // Append user bubble
  removeEmptyState();
  appendMessage('user', userText);

  // Create assistant bubble early so text streams in
  const assistantBubble = createMessageBubble('assistant');
  chatEl.appendChild(assistantBubble);
  scrollToBottom();

  // Trim history before sending
  const historySlice = conversationHistory.slice(-10);

  // Build request body
  const body = {
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
      assistantBubble.textContent = assistantText;
      scrollToBottom();
    }

    // Flush any remaining bytes
    const tail = decoder.decode();
    if (tail) {
      assistantText += tail;
      assistantBubble.textContent = assistantText;
      scrollToBottom();
    }

    // Commit both turns to history
    conversationHistory.push(
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
  conversationHistory = [];
  chatEl.innerHTML = '';
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
  const name = context?.title ?? '';
  problemNameEl.textContent = name;

  const difficulty = (context?.difficulty ?? '').trim();
  const key = difficulty.toLowerCase(); // 'easy' | 'medium' | 'hard'

  difficultyBadgeEl.textContent = difficulty;
  difficultyBadgeEl.className   = ''; // reset classes
  if (key === 'easy' || key === 'medium' || key === 'hard') {
    difficultyBadgeEl.classList.add(key);
  } else {
    // Unknown difficulty — hide badge
    difficultyBadgeEl.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setInputEnabled(enabled) {
  inputEl.disabled = !enabled;
  sendEl.disabled  = !enabled;
}

function removeEmptyState() {
  const el = document.getElementById('empty-state');
  if (el) el.remove();
}
