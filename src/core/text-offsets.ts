export function scalarLength(text: string): number {
  return Array.from(text).length;
}

export function sliceScalars(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join('');
}

export function truncateUtf8ByScalars(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;

  let low = 0;
  let high = scalarLength(text);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(sliceScalars(text, 0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return sliceScalars(text, 0, low);
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}
