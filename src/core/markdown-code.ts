/**
 * Strip fenced code blocks (```...```) and inline code (`...`) from markdown,
 * replacing them with whitespace of equivalent length. Preserves byte offsets
 * for callers that care about positions.
 */
export function stripCodeBlocks(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (content.startsWith('```', i)) {
      const end = content.indexOf('```', i + 3);
      if (end === -1) { out += ' '.repeat(content.length - i); break; }
      out += ' '.repeat(end + 3 - i);
      i = end + 3;
      continue;
    }
    if (content[i] === '`') {
      const end = content.indexOf('`', i + 1);
      if (end === -1 || content.slice(i + 1, end).includes('\n')) {
        out += content[i];
        i++;
        continue;
      }
      out += ' '.repeat(end + 1 - i);
      i = end + 1;
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}
