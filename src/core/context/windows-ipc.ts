/** Pure prefix normalization; the native claim applies Windows Unicode casing. */
export function windowsPipeName(path: string): string {
  if (!/^[\\/]{2}[.?][\\/]pipe[\\/][^\\/]/i.test(path) || path.includes('\0')) {
    throw new TypeError('Expected a Windows named-pipe address');
  }
  return `\\\\.\\pipe\\${path.slice(9)}`;
}
