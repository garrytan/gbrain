/**
 * Strip fenced code blocks (```...```) and inline code (`...`) from markdown,
 * replacing non-newline characters with spaces. Preserves CR/LF characters
 * and UTF-16 code-unit offsets for callers that care about positions.
 */
export function stripCodeBlocks(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (content.startsWith('```', i)) {
      const end = content.indexOf('```', i + 3);
      const afterFence = end === -1 ? content.length : end + 3;
      out += content.slice(i, afterFence).replace(/[^\r\n]/g, ' ');
      i = afterFence;
      continue;
    }
    if (content[i] === '`') {
      const end = content.indexOf('`', i + 1);
      if (end === -1 || content.slice(i + 1, end).includes('\n')) {
        out += content[i];
        i++;
        continue;
      }
      out += content.slice(i, end + 1).replace(/[^\r\n]/g, ' ');
      i = end + 1;
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}
