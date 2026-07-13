export interface MarkdownTableBlock {
  headers: string[];
  rows: string[][];
  endIndex: number;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === '\\' && trimmed[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parseMarkdownTable(lines: string[], startIndex: number): MarkdownTableBlock | null {
  const headerLine = lines[startIndex];
  const separatorLine = lines[startIndex + 1];
  if (!headerLine?.includes('|') || !separatorLine?.includes('|')) return null;

  const headers = splitTableRow(headerLine);
  const separators = splitTableRow(separatorLine);
  if (headers.length < 2 || separators.length !== headers.length) return null;
  if (!separators.every(cell => /^:?-{3,}:?$/.test(cell))) return null;

  const rows: string[][] = [];
  let endIndex = startIndex + 2;
  while (endIndex < lines.length && lines[endIndex].trim() && lines[endIndex].includes('|')) {
    const cells = splitTableRow(lines[endIndex]);
    rows.push(headers.map((_, index) => cells[index] ?? ''));
    endIndex += 1;
  }
  return { headers, rows, endIndex };
}
