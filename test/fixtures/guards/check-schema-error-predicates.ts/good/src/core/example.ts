import { isMissingSchemaObject } from './utils.ts';

// isUndefinedColumnError in a comment is not a call.
export function degraded(e: unknown): boolean {
  return isMissingSchemaObject(e, 'column', ['example_column']) || isMissingSchemaObject(e, 'table', 'example_table');
}
