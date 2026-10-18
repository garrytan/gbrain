export function isUndefinedColumnError(error: unknown, column: string): boolean {
  return (error as { code?: string }).code === '42703' || String(error).includes(column);
}
export function isMissingSchemaObject(_e: unknown, _kind: 'table' | 'column', _names: string | readonly string[]): boolean {
  return false;
}
