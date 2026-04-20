// scraper.js - Functions injected into the LeetCode page (MAIN world)

export async function getMonacoCode(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        // Monaco editor (legacy LeetCode)
        const models = window.monaco?.editor?.getModels() ?? [];
        const editors = window.monaco?.editor?.getEditors() ?? [];
        let monacoCode = '';
        for (const m of models) {
          const v = m.getValue();
          if (v) { monacoCode = v; break; }
        }
        if (!monacoCode) monacoCode = editors[0]?.getValue() ?? '';
        if (monacoCode) return monacoCode;

        // CodeMirror 6 (current LeetCode editor)
        const cmEditor = document.querySelector('.cm-editor');
        if (cmEditor) {
          // CM6 stores the EditorView on the element via an internal key
          const viewKey = Object.keys(cmEditor).find(
            (k) => cmEditor[k]?.state?.doc != null
          );
          if (viewKey) return cmEditor[viewKey].state.doc.toString();

          // Fallback: read line elements from the DOM
          const lines = cmEditor.querySelectorAll('.cm-line');
          if (lines.length) return Array.from(lines).map((l) => l.innerText).join('\n');
        }

        return '';
      },
    });
    return results?.[0]?.result ?? '';
  } catch (_err) {
    return '';
  }
}

export async function getSubmissionResult(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const TERMINAL = new Set([
          'Wrong Answer', 'Runtime Error', 'Time Limit Exceeded',
          'Memory Limit Exceeded', 'Compile Error', 'Output Limit Exceeded',
        ]);

        // Find the result element — try stable attribute first, then text search
        let resultEl = document.querySelector('[data-e2e-locator="submission-result"]');
        if (!resultEl || !TERMINAL.has(resultEl.innerText?.trim())) {
          resultEl = null;
          for (const el of document.querySelectorAll('span, div, p, h4, h5')) {
            if (el.children.length <= 1 && TERMINAL.has(el.innerText?.trim())) {
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
            if (details.input !== null && details.expected !== null && details.actual !== null) break;
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
  } catch (_err) {
    return null;
  }
}
