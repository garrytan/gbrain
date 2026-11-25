/**
 * The handover preview reads (src/core/engine-sql/handover-reads.ts) send the statements their callers sent through
 * executeRaw at d195da9b31, copied verbatim. Intended differences: the reader-page list sorts COLLATE "C" and binds its
 * limit; the private-fact count joins by source_markdown_slug (the old join named a page_id column facts lacks).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends exactly this text and these parameters.
 *  - Regression: a member that drops a filter or reorders a parameter would answer differently on a brain the parity
 *    cases do not hold (a deleted page, a revoked token, a locale-ordered cut at the page limit).
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only.
 *  - Seam: a recording executeRaw stand-in; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import * as H from '../src/core/engine-sql/handover-reads.ts';

function recorder() {
  const log: Array<[string, unknown[]]> = [];
  const raw = async (sql: string, params?: unknown[]) => { log.push([sql, params ?? []]); return [] as never; };
  return { log, raw: raw as never };
}

describe('handover preview reads send their callers\' statements', () => {
  test('every member', async () => {
    const r = recorder();
    await H.listHandoverReaderPages(r.raw, ['member:bob-example', 'group:team-a'], 1001);
    await H.listHandoverPrefixPages(r.raw, 'default', 'notes/');
    await H.countMemberPage(r.raw, 'memory/members/bob-example');
    await H.countMemberPageFacts(r.raw, 'memory/members/bob-example');
    await H.countMemberBoundCredentials(r.raw, 'bob-example');
    await H.readLastUndoneHandoverId(r.raw, 'bob-example');
    await H.readHandoverRow(r.raw, 'id', 'h-1');
    await H.readHandoverRow(r.raw, 'plan_hash', 'abc');
    await H.listMemberSourceRows(r.raw, null);
    await H.listMemberSourceRows(r.raw, 'bob-example');
    const cols = 'id, member_id, owner_id, plan_hash, choices, items, commits, state, created_at, undone_at, undo_of';
    expect(r.log).toEqual([
      [`SELECT id, source_id, slug, frontmatter FROM pages WHERE deleted_at IS NULL AND frontmatter ? 'readable_by'
  AND gbrain_access_readers(frontmatter) && $1::text[] ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT $2`, [['member:bob-example', 'group:team-a'], 1001]],
      ['SELECT source_id, slug, frontmatter FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND (slug = $2 OR ($2 LIKE \'%/\' AND left(slug, length($2)) = $2)) LIMIT 5000', ['default', 'notes/']],
      ['SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL AND slug = $1', ['memory/members/bob-example']],
      ['SELECT count(*)::int AS n FROM facts f JOIN pages p ON p.source_id = f.source_id AND p.slug = f.source_markdown_slug WHERE p.deleted_at IS NULL AND p.slug = $1', ['memory/members/bob-example']],
      ['SELECT (SELECT count(*) FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL) + (SELECT count(*) FROM oauth_clients WHERE member_id = $1) AS n', ['bob-example']],
      ["SELECT id FROM access_handovers WHERE member_id = $1 AND state = 'undone' ORDER BY undone_at DESC LIMIT 1", ['bob-example']],
      [`SELECT ${cols} FROM access_handovers WHERE id = $1`, ['h-1']],
      [`SELECT ${cols} FROM access_handovers WHERE plan_hash = $1`, ['abc']],
      ['SELECT member_id, source_id, created_at FROM access_member_sources ORDER BY member_id, source_id', []],
      ['SELECT member_id, source_id, created_at FROM access_member_sources WHERE member_id = $1 ORDER BY member_id, source_id', ['bob-example']],
    ]);
  });
});
