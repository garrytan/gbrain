/**
 * Wave B PR 3 (N5): append_page is a page write like edit_page wherever an operation list means "an agent's page write".
 *
 * 1. Protects: the lists that attribute, tier, chronicle, group-publish and backstop a page write name append_page
 *    beside edit_page; the two lists it stays out of say why below.
 * 2. Fails when: a list is extended for edit_page without append_page, or append_page is added to a list it must not join.
 * 3. Pure (source text and exported predicates); no database.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { singleWrite } from '../src/core/persistence/group-publish.ts';
import { pageNoopAdvisories } from '../src/core/persistence/page-advisories.ts';
import { queuesMentionLinks } from '../src/core/persistence/effect-journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';

/** The operation list that starts at `anchor` in `file`: from the anchor through the bracket that closes after 'edit_page'. */
function list(file: string, anchor: string): string {
  const source = readFileSync(join(import.meta.dir, '..', file), 'utf8');
  const at = source.indexOf(anchor);
  expect(at).toBeGreaterThanOrEqual(0);
  const edit = source.indexOf("'edit_page'", at);
  return source.slice(at, source.slice(edit).search(/[)\]]/) + edit);
}

describe('append_page in operation lists', () => {
  test.each([
    ['src/core/repair/attribution-backfill.ts', 'const MUTATED_PAGE'],
    ['src/core/trust/backfill.ts', "${r}.intent IS NOT NULL AND ${kind} IS NULL AND"],
    ['src/core/write-gate-scan.ts', "WHEN ${pr}.operation IN ("],
    ['src/core/chronicle/ledger.ts', 'const DECIDING_OPERATIONS'],
  ])('%s names append_page beside edit_page', (file, anchor) => {
    const ops = list(file, anchor);
    expect(ops).toContain("'edit_page'");
    expect(ops).toContain("'append_page'");
  });

  test('an append publishes as a single write and offers the facts backstop as edit_page does', () => {
    for (const operation of ['edit_page', 'append_page']) {
      expect(singleWrite({ operation, intent: {} } as Pick<WriteRequest, 'operation' | 'intent'>)).toBe(true);
      expect(pageNoopAdvisories({ operation, authority: { remote: false } } as unknown as WriteRequest)).toHaveProperty('facts_backstop');
    }
  });

  test('append_page stays out of the owner-edit and remote-mention lists', () => {
    // Owner edits can release a purge redaction: an append cannot write facts or takes (fence markers are refused).
    expect(list('src/core/belief/ledger.ts', 'const OWNER_EDIT_OPERATIONS')).not.toContain("'append_page'");
    // A remote mention links effect re-reads the whole page; an append's links follow the incremental derivation instead.
    const remote = { remote: true, autoLinkTrusted: false } as WriteRequest['authority'];
    expect(queuesMentionLinks({ operation: 'edit_page', authority: remote })).toBe(true);
    expect(queuesMentionLinks({ operation: 'append_page', authority: remote })).toBe(false);
  });
});
