# LeetCode DOM Skill

## Page Detection
- Problem pages match: https://leetcode.com/problems/*
- Extract problem slug from URL: window.location.pathname.split('/')[2]
- Extract problem number from title or DOM

## DOM Selectors (may change — prefer data attributes over class names)

### Problem Info
- Title: document.querySelector('[data-cy="question-title"]')?.innerText
  - Fallback: document.querySelector('.text-title-large')?.innerText
- Difficulty: document.querySelector('[class*="text-difficulty"]')?.innerText
  - Or look for elements containing exactly 'Easy', 'Medium', 'Hard'
- Problem number: parse from title text (e.g. "1. Two Sum" → 1)
- Description: document.querySelector('.elfjS')?.innerText
  - Fallback: document.querySelector('[data-track-load="description_content"]')?.innerText
- Topic tags: document.querySelectorAll('[href*="/tag/"]') → map to innerText
- Username: document.querySelector('[href*="/u/"]')?.innerText or nav profile link

### Code Editor (Monaco)
- Primary: window.monaco?.editor?.getModels()[0]?.getValue()
- Monaco may not load immediately — use retry loop:
```javascript
  function getCode(retries = 10) {
    const code = window.monaco?.editor?.getModels()[0]?.getValue();
    if (code !== undefined) return code;
    if (retries > 0) setTimeout(() => getCode(retries - 1), 500);
  }
```
- Selected language: document.querySelector('.ant-select-selection-item')?.innerText?.trim()
  - Fallback: look for language dropdown near the editor

### Test Cases (public examples)
- Example inputs rendered in the description — parse from description text
- Or: document.querySelectorAll('[class*="example"]')

### Submission Results (MutationObserver)
- Watch for submission result panel appearing in DOM
- Wrong answer shows: input, expected output, actual output
- Selectors for result panel change frequently — target by text content:
```javascript
  const observer = new MutationObserver(() => {
    const result = document.querySelector('[data-e2e-locator="submission-result"]');
    if (result) {
      const status = result.innerText;
      // look for input/expected/output nearby
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
```

## Known Fragilities
- LeetCode frequently updates class names — never rely solely on class selectors
- Monaco editor loads asynchronously — always use retry logic
- Submission result panel is dynamically injected — requires MutationObserver
- Some selectors differ between LeetCode's old and new UI versions
- Always add null checks: element?.innerText rather than element.innerText

## Sending Context to Side Panel
```javascript
// content.js collects context and sends to side panel via runtime message
function collectContext() {
  return {
    title: getTitle(),
    number: getNumber(),
    difficulty: getDifficulty(),
    tags: getTags(),
    description: getDescription(),
    code: getCode(),
    language: getLanguage(),
    slug: getSlug(),
    failureInfo: getFailureInfo()
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CONTEXT') {
    sendResponse(collectContext());
    return true;
  }
});
```