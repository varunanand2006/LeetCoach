// diagram.js - Lazy Mermaid loading and rendering
//
// Mermaid is ~1MB across 35 vendored chunk files, so it is only imported the
// first time a diagram actually needs to render. The vendored subset covers
// exactly the four diagram types below; anything else was stripped to keep the
// bundle small, so an unsupported type must never reach mermaid.render().

const ALLOWED_TYPES = [
  'flowchart',
  'graph',            // legacy alias mermaid maps onto flowchart
  'sequenceDiagram',
  'stateDiagram-v2',
  'stateDiagram',
  'classDiagram',
];

let mermaidPromise = null;
let idCounter = 0;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('../vendor/mermaid/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        themeVariables: {
          darkMode: true,
          background: '#1a1a1a',
          primaryColor: '#282828',
          primaryTextColor: '#e0e0e0',
          primaryBorderColor: '#ffa116',
          lineColor: '#7a7a7a',
          secondaryColor: '#222222',
          tertiaryColor: '#1e1e1e',
          mainBkg: '#282828',
          nodeBorder: '#ffa116',
          nodeTextColor: '#e0e0e0',
          edgeLabelBackground: '#1a1a1a',
        },
        flowchart: { useMaxWidth: true, htmlLabels: false, curve: 'basis' },
        sequence: { useMaxWidth: true },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/** True if `src` opens with a diagram type present in the vendored subset. */
export function isSupportedDiagram(src) {
  const firstLine = src.trim().split('\n')[0].trim();
  return ALLOWED_TYPES.some((t) => firstLine.startsWith(t));
}

/**
 * Replace a .mermaid-block placeholder with rendered SVG.
 * On any failure the placeholder degrades to the raw source as a code block —
 * never retried, since a retry would silently charge the user another 2 prompts.
 */
async function renderOne(placeholder) {
  const src = placeholder.dataset.src;
  if (!src) return;

  const fail = (note) => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = src;
    pre.appendChild(code);
    const msg = document.createElement('div');
    msg.className = 'diagram-error';
    msg.textContent = note;
    placeholder.replaceChildren(msg, pre);
    placeholder.classList.add('failed');
  };

  if (!isSupportedDiagram(src)) {
    fail("Couldn't render this diagram — unsupported type.");
    return;
  }

  try {
    const mermaid = await loadMermaid();
    const id = `lc-diagram-${idCounter++}`;
    // parse() throws on bad syntax without touching the DOM, so bad output
    // never leaves a half-drawn SVG behind.
    await mermaid.parse(src);
    const { svg } = await mermaid.render(id, src);

    const shell = document.createElement('div');
    shell.className = 'diagram-shell';
    shell.innerHTML = svg;
    shell.title = 'Click to enlarge';
    shell.addEventListener('click', () => openOverlay(svg));

    placeholder.replaceChildren(shell);
    placeholder.classList.add('rendered');
  } catch (err) {
    console.warn('[LeetCoach] mermaid render failed:', err);
    fail("Couldn't render this diagram — showing the source instead.");
  }
}

/** Render every un-rendered placeholder inside `root`. */
export async function renderDiagramsIn(root) {
  const pending = root.querySelectorAll('.mermaid-block:not(.rendered):not(.failed)');
  for (const el of pending) await renderOne(el);
  return pending.length;
}

function openOverlay(svg) {
  const overlay = document.createElement('div');
  overlay.className = 'diagram-overlay';
  overlay.innerHTML = `<div class="diagram-overlay-inner">${svg}</div>`;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}
