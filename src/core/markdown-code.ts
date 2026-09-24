/**
 * Strip fenced code blocks (```...```) and inline code (`...`) from markdown,
 * replacing them with whitespace of equivalent length. Preserves byte offsets
 * for callers that care about positions.
 */
export function stripCodeBlocks(content: string): string {
  let fence: string | undefined;
  return content.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return ' '.repeat(line.length);
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      return ' '.repeat(line.length);
    }
    return stripInlineCode(line);
  }).join('\n');
}

function stripInlineCode(content: string): string {
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
