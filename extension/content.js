// content.js - DOM reading only, no UI rendering, no fetch calls

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Stores the most recent wrong-answer failure info from a submission. */
let failureInfo = null;

/** Set to true once Monaco editor is confirmed available — skips retry on future calls. */
let monacoInitialized = false;

// ---------------------------------------------------------------------------
// Problem context readers
// ---------------------------------------------------------------------------

function getSlug() {
  // e.g. /problems/two-sum/ → "two-sum"
  return window.location.pathname.split('/')[2] ?? null;
}

function getRawTitle() {
  // Prefer the data-cy attribute; fall back to the large title class
  return (
    document.querySelector('[data-cy="question-title"]')?.innerText?.trim() ??
    document.querySelector('.text-title-large')?.innerText?.trim() ??
    null
  );
}

function getNumber() {
  const raw = getRawTitle();
  if (!raw) return null;
  // Title format: "1. Two Sum"
  const match = raw.match(/^(\d+)\./);
  return match ? parseInt(match[1], 10) : null;
}

function getTitle() {
  const raw = getRawTitle();
  if (!raw) return null;
  // Strip leading "123. " prefix if present
  return raw.replace(/^\d+\.\s*/, '').trim() || null;
}

function getDifficulty() {
  // Target elements whose class contains "text-difficulty-" (e.g. text-difficulty-easy)
  const el = document.querySelector('[class*="text-difficulty-"]');
  if (el) return el.innerText?.trim() ?? null;

  // Fallback: find a span/div whose text is exactly Easy / Medium / Hard
  const candidates = document.querySelectorAll('span, div');
  for (const candidate of candidates) {
    const text = candidate.innerText?.trim();
    if (text === 'Easy' || text === 'Medium' || text === 'Hard') {
      return text;
    }
  }
  return null;
}

function getTags() {
  // Topic tag links contain /tag/ in their href
  const tagEls = document.querySelectorAll('a[href*="/tag/"]');
  if (!tagEls.length) return [];
  return Array.from(tagEls).map((el) => el.innerText?.trim()).filter(Boolean);
}

function getDescription() {
  // Try the stable data-track-load attribute first, then the known class name
  return (
    document.querySelector('[data-track-load="description_content"]')?.innerText?.trim() ??
    document.querySelector('.elfjS')?.innerText?.trim() ??
    null
  );
}

// ---------------------------------------------------------------------------
// Monaco editor — async retry
// ---------------------------------------------------------------------------

/**
 * Attempt to read code from the Monaco editor.
 * Returns a Promise that resolves to the code string (or empty string on failure).
 * Retries up to `maxRetries` times with `delayMs` between each attempt.
 */
function getCodeWithRetry(maxRetries = 10, delayMs = 500) {
  return new Promise((resolve) => {
    // If Monaco was already found in a previous call, skip the retry loop entirely
    if (monacoInitialized) {
      resolve(window.monaco?.editor?.getModels()[0]?.getValue() ?? '');
      return;
    }

    let attempts = 0;

    function attempt() {
      const code = window.monaco?.editor?.getModels()[0]?.getValue();
      if (code !== undefined) {
        monacoInitialized = true;
        resolve(code);
        return;
      }
      attempts++;
      if (attempts < maxRetries) {
        setTimeout(attempt, delayMs);
      } else {
        // Monaco never became available — return empty string as fallback
        resolve('');
      }
    }

    attempt();
  });
}

// ---------------------------------------------------------------------------
// Language dropdown
// ---------------------------------------------------------------------------

function getLanguage() {
  // Ant Design select used by LeetCode's language picker
  return (
    document.querySelector('[data-cy="lang-select"] .ant-select-selection-item')?.innerText?.trim() ??
    document.querySelector('.ant-select-selection-item')?.innerText?.trim() ??
    null
  );
}

// ---------------------------------------------------------------------------
// Submission result watcher (MutationObserver)
// ---------------------------------------------------------------------------

/**
 * Given a container element, scan its children for labelled sections and
 * extract failed input, expected output, and actual output text.
 */
function extractFailureDetails(containerEl) {
  const details = {
    input: null,
    expected: null,
    actual: null,
  };

  if (!containerEl) return details;

  const allEls = containerEl.querySelectorAll('*');
  for (const el of allEls) {
    // Only look at leaf-ish elements to avoid capturing parent text that
    // includes child text
    if (el.children.length > 2) continue;

    const text = el.innerText?.trim();
    if (!text) continue;

    if (text === 'Input') {
      details.input = el.nextElementSibling?.innerText?.trim() ?? null;
    } else if (text === 'Expected Output' || text === 'Expected') {
      details.expected = el.nextElementSibling?.innerText?.trim() ?? null;
    } else if (text === 'Output' || text === 'Stdout') {
      // Guard against re-matching "Expected Output" labels
      details.actual = el.nextElementSibling?.innerText?.trim() ?? null;
    }
  }

  return details;
}

function watchSubmissionResults() {
  const observer = new MutationObserver(() => {
    const resultEl = document.querySelector('[data-e2e-locator="submission-result"]');
    if (!resultEl) return;

    const statusText = resultEl.innerText?.trim() ?? '';

    if (statusText === 'Running' || statusText === 'Pending') {
      // New submission started — clear previous failure info
      failureInfo = null;
      return;
    }

    if (statusText.includes('Wrong Answer')) {
      // Walk up to find the result container that holds input/expected/actual panels
      const container =
        resultEl.closest('[class*="result-container"]') ??
        resultEl.closest('[class*="result"]') ??
        resultEl.parentElement;

      const details = extractFailureDetails(container ?? resultEl);
      failureInfo = {
        status: 'Wrong Answer',
        input: details.input,
        expected: details.expected,
        actual: details.actual,
      };
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Context collectors
// ---------------------------------------------------------------------------

function collectBaseContext() {
  return {
    slug:        getSlug(),
    title:       getTitle(),
    number:      getNumber(),
    difficulty:  getDifficulty(),
    tags:        getTags(),
    description: getDescription(),
    language:    getLanguage(),
    failureInfo,
  };
}

async function collectContext() {
  const code = await getCodeWithRetry();
  return { ...collectBaseContext(), code };
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_CONTEXT') {
    collectContext().then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (message.type === 'GET_BASE_CONTEXT') {
    sendResponse(collectBaseContext());
    // synchronous — no need to return true
  }
});

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

watchSubmissionResults();

// Pre-warm Monaco detection so it's ready before the first GET_CONTEXT message arrives
getCodeWithRetry();
