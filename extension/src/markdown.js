// markdown.js - Markdown rendering and syntax highlighting

const LANG_MAP = {
  'python3': 'python',
  'js': 'javascript',
  'ts': 'typescript',
  'c++': 'cpp',
  'c#': 'csharp',
  'golang': 'go',
  'shell': 'bash',
  'racket': 'scheme',
};

export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdown(raw) {
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
