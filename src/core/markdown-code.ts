/**
 * Strip fenced code blocks (```...```) and inline code (`...`) from markdown,
 * replacing non-newline characters with spaces. Preserves CR/LF characters
 * and UTF-16 code-unit offsets for callers that care about positions.
 */
export function stripCodeBlocks(content: string, opts: { onHtmlComment?: (start: number, end: number) => void } = {}): string {
  let fence: string | undefined;
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (i === 0 || content[i - 1] === '\n') {
      const newline = content.indexOf('\n', i);
      const end = newline === -1 ? content.length : newline + 1;
      const line = content.slice(i, end);
      const marker = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line);
      if (fence || (marker && (marker[1][0] === '~' || !marker[2].includes('`')))) {
        if (!fence) fence = marker![1];
        else if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
        out += line.replace(/[^\r\n]/g, ' ');
        i = end;
        continue;
      }
    }
    if (opts.onHtmlComment && content.startsWith('<!--', i)) {
      const close = content.indexOf('-->', i + 4);
      const end = close === -1 ? content.length : close + 3;
      opts.onHtmlComment(i, end);
      out += content.slice(i, end).replace(/[^\r\n]/g, ' ');
      i = end;
      continue;
    }
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
