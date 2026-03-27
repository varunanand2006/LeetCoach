// content.js - DOM reading only, no UI rendering, no fetch calls

// ---------------------------------------------------------------------------
// Problem context readers
// ---------------------------------------------------------------------------

function getSlug() {
  // e.g. /problems/two-sum/ → "two-sum"
  return window.location.pathname.split('/')[2] ?? null;
}

function getRawTitle() {
  // 1. Stable data attribute (most reliable)
  const byCy = document.querySelector('[data-cy="question-title"]')?.innerText?.trim();
  if (byCy) return byCy;

  // 2. Known class name (may change with LeetCode UI updates)
  const byClass = document.querySelector('.text-title-large')?.innerText?.trim();
  if (byClass) return byClass;

  // 3. document.title — always "1. Two Sum - LeetCode" or "Two Sum - LeetCode"
  const fromPageTitle = document.title.replace(/\s*[-–|]\s*LeetCode.*$/i, '').trim();
  if (fromPageTitle) return fromPageTitle;

  return null;
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

function getUsername() {
  return Array.from(document.querySelectorAll('a[href*="/u/"]'))[0]?.href?.split('/u/')[1]?.split('/')[0] ?? null;
}

// ---------------------------------------------------------------------------
// Context collector
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
    userId:      getUsername(),
  };
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_BASE_CONTEXT') {
    sendResponse(collectBaseContext());
  }
});
