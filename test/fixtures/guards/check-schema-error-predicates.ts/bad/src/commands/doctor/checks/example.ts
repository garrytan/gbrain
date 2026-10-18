declare function isUndefinedColumnError(error: unknown, column: string): boolean;

export function degraded(e: unknown): boolean {
  return isUndefinedColumnError(e, 'example_column');
}
