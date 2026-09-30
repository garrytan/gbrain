/**
 * Ported from garrytan/gbrain#5469 by @tarush1989.
 * Structural pin: every coordinated prepare path that applies a prepared content
 * import must also run that import's pre-publication `validate` (the fact-withdrawal
 * race check), and the coordinator must run `validate` before any file publication.
 * The managed-import and put_page paths are proven behaviorally in
 * persistence-file-import.test.ts and withdrawal-publication-file.test.ts; sync,
 * connector and reconcile fixtures are heavy, so their wiring is pinned here.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// test-reads-source-ok[structural]: pin on coordinated prepare wiring; sync, connector and reconcile fixtures are too heavy to drive each path behaviorally.
const source = (path: string) => readFileSync(join(import.meta.dir, '../src/core/persistence', path), 'utf8').replace(/\s+/g, ' ');
const count = (text: string, needle: string) => text.split(needle).length - 1;

test.each([
  ['import-prepare.ts', 1],
  ['connector-sync.ts', 1],
  ['sync-prepare.ts', 2],
  ['reconcile-prepare.ts', 1],
  ['page-prepare.ts', 1],
] as const)('%s validates every prepared content import it applies', (file, applied) => {
  const text = source(file);
  expect(count(text, 'await ready.apply(tx)') + count(text, 'await applied.apply(tx)')).toBe(applied);
  expect(count(text, 'await ready.validate(tx)') + count(text, 'validate: ready.validate')).toBe(applied);
});

test('a managed rename validates the import it re-prepares at the new slug before applying it', () => {
  const text = source('sync-prepare.ts');
  const validated = text.indexOf('await movedImport.validate(tx); applied = movedImport;');
  expect(validated).toBeGreaterThan(0);
  expect(validated).toBeLessThan(text.indexOf('await applied.apply(tx)'));
});

test('the coordinator validates prepared mutations before publication boundaries and file writes', () => {
  const text = source('coordinator.ts');
  const validate = text.indexOf('await prepared.validate?.(tx)');
  expect(validate).toBeGreaterThan(0);
  expect(validate).toBeLessThan(text.indexOf("hooks.boundary?.('before_publication', row)"));
  expect(validate).toBeLessThan(text.indexOf("hooks.fileBoundary?.('before_file', row, index)"));
});
