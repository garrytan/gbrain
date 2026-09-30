/**
 * #5752: connector render boundary for text that reaches a request intent's
 * jsonb or a page row. Prose (bodies, subjects, titles, descriptions) is
 * sanitized at render time with `sanitizeForJsonb`, so the stored page and a
 * fresh render of the same upstream item stay equal across runs (the no-op
 * screen and content hashes compare sanitized text). Identity fields (paths,
 * item ids, accounts) are never rewritten: a NUL or lone surrogate there is
 * refused with the item-scoped code `invalid_connector_text`, which the
 * connector item-hold helper counts and eventually holds.
 */
import { OperationError } from '../ops/contract.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';

export function invalidConnectorText(field: string): OperationError {
  const error = new OperationError('invalid_connector_text',
    `The connector item's ${field} contains a NUL or an unpaired UTF-16 surrogate, so it cannot be stored.`,
    'The item is counted toward a hold; after it is held, re-attempt it with gbrain sources retry-held <source> once the provider data is fixed.',
    'docs/guides/write-refusals.md#invalid-connector-text');
  error.writeError = 'invalid_connector_text';
  return error;
}

const cleanIdentity = (value: string) => value.isWellFormed() && !value.includes('\0');

/**
 * Checks every identity field, then sanitizes the rendered markdown. Because
 * the identity values were proven clean first, sanitizing the whole document
 * changes prose only.
 */
export function connectorRender(markdown: string, identity: Record<string, string | readonly string[] | null | undefined>): string {
  for (const [field, value] of Object.entries(identity)) {
    for (const item of value == null ? [] : typeof value === 'string' ? [value] : value) {
      if (!cleanIdentity(item)) throw invalidConnectorText(field);
    }
  }
  return sanitizeForJsonb(markdown);
}
