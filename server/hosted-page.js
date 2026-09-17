// A bounded, forward-only scanner for static native media tags. Each character
// is visited a constant number of times, including in unterminated markup.
function* tags(html) {
  const lower = html.replace(/[A-Z]/g, char => char.toLowerCase());
  let cursor = 0;
  let rawText = null;
  while (cursor < html.length) {
    const start = lower.indexOf(rawText ? `</${rawText}` : '<', cursor);
    if (start < 0) return;
    cursor = start + 1;
    if (!rawText && html.startsWith('!--', cursor)) {
      const end = html.indexOf('-->', cursor + 3);
      if (end < 0) return;
      cursor = end + 3;
      continue;
    }
    const closing = html[cursor] === '/';
    if (closing) cursor++;
    const nameStart = cursor;
    while (cursor < html.length && /[a-z0-9:-]/i.test(html[cursor])) cursor++;
    const name = lower.slice(nameStart, cursor);
    if (rawText && (name !== rawText || !/[\s/>]/.test(html[cursor] || ''))) continue;
    const attributesStart = cursor;
    let quote = null;
    while (cursor < html.length) {
      const char = html[cursor];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      cursor++;
    }
    if (cursor === html.length) return;
    const attributes = html.slice(attributesStart, cursor++);
    if (rawText) { rawText = null; continue; }
    if (!closing && ['script', 'style', 'textarea', 'title'].includes(name)) { rawText = name; continue; }
    yield { name, closing, attributes };
  }
}

function sourceAttribute(attributes) {
  let cursor = 0;
  while (cursor < attributes.length) {
    while (cursor < attributes.length && /[\s/]/.test(attributes[cursor])) cursor++;
    const start = cursor;
    while (cursor < attributes.length && !/[\s=/>]/.test(attributes[cursor])) cursor++;
    const name = attributes.slice(start, cursor).toLowerCase();
    while (cursor < attributes.length && /\s/.test(attributes[cursor])) cursor++;
    let value = '';
    if (attributes[cursor] === '=') {
      cursor++;
      while (cursor < attributes.length && /\s/.test(attributes[cursor])) cursor++;
      const quote = ['"', "'"].includes(attributes[cursor]) ? attributes[cursor++] : null;
      const valueStart = cursor;
      while (cursor < attributes.length && (quote ? attributes[cursor] !== quote : !/\s/.test(attributes[cursor]))) cursor++;
      value = attributes.slice(valueStart, cursor);
      if (quote && cursor < attributes.length) cursor++;
    }
    if (name === 'src') return value;
    if (cursor === start) cursor++;
  }
  return '';
}

export function* nativeMediaSources(html) {
  let inMedia = false;
  for (const { name, closing, attributes } of tags(html)) {
    if (name === 'video' || name === 'audio') inMedia = !closing;
    if (!closing && inMedia && ['video', 'audio', 'source'].includes(name)) yield sourceAttribute(attributes);
  }
}
