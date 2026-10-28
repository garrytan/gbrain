/**
 * GBRA-217: a page write carries an optional human reason.
 *
 * 1. Protects: the reason given for a write is stored on the snapshot that write archived and read back by get_versions
 *    as `replaced_because`; each write result says where it was recorded (`reason_recorded`). On a repo-less brain (the
 *    default keyless install) the database is the record: `git: 'no_repository'`, never a refusal.
 * 2. Fails when: a reason is lost or lands on the wrong snapshot, a refused reason (too long, a secret) is stored in any
 *    journal row, the replay identity ignores the reason, or a remote reader is shown a reason whose successor snapshot
 *    is private or was pruned.
 * 3. No new seam: the real put_page / edit_page / revert_version / put_pages / get_versions handlers over PGLite, and over Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';
import { canonicalChangeReason, CHANGE_REASON_MAX } from '../src/core/persistence/change-reason.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

let engine: BrainEngine;
let SLUG = '';
let run = 0;

function ctx(remote = false): OperationContext {
  return { engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default' } as OperationContext;
}
const call = (name: string, params: Record<string, unknown>, remote = false) =>
  operationsByName[name]!.handler(ctx(remote), params) as Promise<Record<string, unknown>>;
const page = (body: string, extra = '') => `---\ntitle: Policy\ntype: note\n${extra}---\n\n${body}\n`;
const outcomeOf = (result: Record<string, unknown>) => (result.outcome ?? result) as Record<string, unknown>;
async function revision(slug?: string): Promise<string> {
  return String((await call('get_page', { slug: slug ?? SLUG, include_content: true })).revision);
}
async function versions(remote = false, slug?: string): Promise<Array<Record<string, unknown>>> {
  return await call('get_versions', { slug: slug ?? SLUG }, remote) as unknown as Array<Record<string, unknown>>;
}
async function journalHolds(text: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests WHERE intent::text LIKE $1 OR outcome::text LIKE $1`, [`%${text}%`]);
  const effects = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects WHERE data::text LIKE $1`, [`%${text}%`]);
  return rows[0]!.n + effects[0]!.n > 0;
}

for (const backend of testBackends()) describe(`[${backend}] page change reasons on a repo-less brain`, () => {
  let close: () => Promise<void>;
  beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(backend === 'postgres' ? requirePostgresTestDatabase() : undefined)); }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await close(); });
  beforeEach(() => { SLUG = `policies/policy-4a-example-${++run}`; });

  test('a reason lands on the snapshot its write archived; creation and a reasonless write are reported', async () => {
    const created = outcomeOf(await call('put_page', { slug: SLUG, content: page('Edition one.'), reason: 'First edition from the board.', wait_ms: 30_000 }));
    expect(created.reason_recorded).toEqual({ reason: 'First edition from the board.', version: false, version_why: 'page_created', git: 'no_repository' });

    const second = outcomeOf(await call('put_page', { slug: SLUG, content: page('Edition two.'), expected_revision: await revision(), reason: 'Client asked for\nthe 30-day window.', wait_ms: 30_000 }));
    expect(second.reason_recorded).toEqual({ reason: 'Client asked for the 30-day window.', version: true, git: 'no_repository' });

    await call('put_page', { slug: SLUG, content: page('Edition three.'), expected_revision: await revision(), wait_ms: 30_000 });
    const rows = await versions();
    expect(rows.map(row => row.replaced_because)).toEqual([null, 'Client asked for the 30-day window.']);
    const bodies = await call('get_versions', { slug: SLUG, include_body: true }) as unknown as Array<Record<string, unknown>>;
    expect(bodies.map(row => [row.compiled_truth, row.replaced_because])).toEqual([
      [expect.stringContaining('Edition two.'), null], [expect.stringContaining('Edition one.'), 'Client asked for the 30-day window.']]);
  });

  test('edit_page and revert_version carry their reasons', async () => {
    await call('put_page', { slug: SLUG, content: page('Refunds within 14 days.'), wait_ms: 30_000 });
    const edited = outcomeOf(await call('edit_page', { slug: SLUG, expected_revision: await revision(), edits: [{ old_text: '14 days', new_text: '30 days' }], reason: 'Policy update after review.' }));
    expect(edited.reason_recorded).toMatchObject({ reason: 'Policy update after review.', version: true, git: 'no_repository' });
    const [first] = await versions();
    const reverted = outcomeOf(await call('revert_version', { slug: SLUG, version_id: first!.id, expected_revision: await revision(), reason: 'Review was withdrawn.', wait_ms: 30_000 }));
    expect(reverted.reason_recorded).toMatchObject({ reason: 'Review was withdrawn.', version: true });
    expect((await versions()).map(row => row.replaced_because)).toEqual(['Review was withdrawn.', 'Policy update after review.']);
  });

  test('refused reasons write nothing and are kept in no journal row', async () => {
    const tooLong = 'é'.repeat(CHANGE_REASON_MAX + 1);
    const long = await call('put_page', { slug: SLUG, content: page('x'), reason: tooLong }).then(() => null, e => e);
    expect(long).toBeInstanceOf(OperationError);
    expect((long as OperationError).toJSON()).toMatchObject({ error: 'invalid_params', code: 'change_reason_rejected', reason: 'reason_too_long' });
    expect(JSON.stringify((long as OperationError).toJSON())).not.toContain('éééé');

    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const leaked = await call('put_page', { slug: SLUG, content: page('x'), reason: `rotated token ${secret}` }).then(() => null, e => e);
    expect((leaked as OperationError).toJSON()).toMatchObject({ code: 'change_reason_rejected', reason: 'reason_contains_secret' });
    expect(JSON.stringify((leaked as OperationError).toJSON())).not.toContain(secret);
    expect(await journalHolds(secret)).toBe(false);
    expect(await journalHolds('éééé')).toBe(false);
    expect((await engine.executeRaw('SELECT 1 FROM pages WHERE slug = $1', [SLUG])).length).toBe(0);

    const batch = await call('put_pages', { request_id: crypto.randomUUID(), pages: [
      { slug: `notes/a-example-${run}`, content: page('a'), reason: 'fine' }, { slug: `notes/b-example-${run}`, content: page('b'), reason: `token ${secret}` }] }).then(() => null, e => e);
    expect((batch as OperationError).message).toContain(`pages[1] (notes/b-example-${run})`);
    expect((await engine.executeRaw('SELECT 1 FROM pages WHERE slug LIKE $1', [`notes/%-example-${run}`])).length).toBe(0);
    expect(await journalHolds(secret)).toBe(false);
  });

  test('a reason passed to a page operation that takes none is dropped before the journal', async () => {
    await call('put_page', { slug: SLUG, content: page('Edition one.'), wait_ms: 30_000 });
    const marker = `stray-reason-marker-${run}`;
    await call('add_tag', { slug: SLUG, tag: `tag-example-${run}`, reason: `${marker} on a tag`, expected_revision: await revision(), wait_ms: 30_000 });
    await call('delete_page', { slug: SLUG, reason: `${marker} on a delete`, expected_revision: await revision(), wait_ms: 30_000 });
    await call('restore_page', { slug: SLUG, reason: `${marker} on a restore`, expected_revision: String((await call('get_page', { slug: SLUG, include_deleted: true })).revision), wait_ms: 30_000 });
    expect(await journalHolds(marker)).toBe(false);
  });

  test('a page purge leaves the page\'s reasons in no receipt, intent or effect, and its receipt checks both stores', async () => {
    const marker = `purged-reason-marker-${run}`;
    await call('put_page', { slug: SLUG, content: page('Edition one.'), reason: `${marker} at creation`, wait_ms: 30_000 });
    await call('put_page', { slug: SLUG, content: page('Edition two.'), expected_revision: await revision(), reason: `${marker} on the second edition`, wait_ms: 30_000 });
    await call('put_page', { slug: SLUG, content: page('Edition three.'), expected_revision: await revision(), wait_ms: 30_000 });
    await engine.executeRaw(`UPDATE persistence_requests SET intent = NULL, compacted = true WHERE slug = $1 AND state = 'committed'`, [SLUG]);
    expect(await journalHolds(marker)).toBe(true);
    const done = await call('delete_page', { slug: SLUG, purge: true, expected_revision: await revision(), wait_ms: 30_000 });
    expect(await journalHolds(marker)).toBe(false);
    const stores = (done.receipt as { stores: Array<{ store: string; status: string }> }).stores;
    expect(stores.filter(s => s.store === 'persistence_requests' || s.store === 'persistence_effects').map(s => s.status)).not.toContain('incomplete');
    expect(stores.map(s => s.store)).toEqual(expect.arrayContaining(['persistence_requests', 'persistence_effects']));
    // The receipt's check finds a reason still in one of the slug's receipts.
    await call('put_page', { slug: SLUG, content: page('A new page.'), reason: `${marker} again`, wait_ms: 30_000 });
    await engine.executeRaw(`UPDATE persistence_requests SET intent = NULL, compacted = true WHERE slug = $1 AND state = 'committed'`, [SLUG]);
    const { verifyPagePurge } = await import('../src/core/facts/purge-verify.ts');
    const recheck = await verifyPagePurge(engine, { sourceId: 'default', slug: SLUG, requestId: crypto.randomUUID(), removed: {}, blobsRemaining: [],
      context: { needles: [], reasons: [`${marker} again`], factIds: [], pageId: 0, paths: [], segmentShas: [] } }) as { stores: Array<{ store: string; status: string }> };
    expect(recheck.stores.find(s => s.store === 'persistence_requests')).toMatchObject({ status: 'incomplete' });
  });

  test('the canonical reason joins replay identity', async () => {
    const request_id = crypto.randomUUID();
    await call('put_page', { slug: SLUG, content: page('one'), reason: 'same  reason', request_id, wait_ms: 30_000 });
    await call('put_page', { slug: SLUG, content: page('one'), reason: 'same reason', request_id, wait_ms: 30_000 });
    const conflict = await call('put_page', { slug: SLUG, content: page('one'), reason: 'another reason', request_id, wait_ms: 30_000 }).then(() => null, e => e);
    expect(conflict).toBeInstanceOf(OperationError);
  });

  test('put_pages items carry their own reasons; equal repeats coalesce and different ones conflict', async () => {
    await call('put_pages', { request_id: crypto.randomUUID(), wait_ms: 30_000, pages: [{ slug: `notes/a-example-${run}`, content: page('a1') }, { slug: `notes/b-example-${run}`, content: page('b1') }] });
    const a = await revision(`notes/a-example-${run}`), b = await revision(`notes/b-example-${run}`);
    const result = await call('put_pages', { request_id: crypto.randomUUID(), wait_ms: 30_000, pages: [
      { slug: `notes/a-example-${run}`, content: page('a2'), expected_revision: a, reason: 'reason a' },
      { slug: `notes/b-example-${run}`, content: page('b2'), expected_revision: b, reason: 'reason b' },
      { slug: `notes/b-example-${run}`, content: page('b2'), expected_revision: b, reason: 'reason  b' }] });
    const entries = result.pages as Array<Record<string, unknown>>;
    expect(entries[0]!.reason_recorded).toMatchObject({ reason: 'reason a', version: true });
    expect((await versions(false, `notes/b-example-${run}`))[0]!.replaced_because).toBe('reason b');
    const differ = await call('put_pages', { request_id: crypto.randomUUID(), wait_ms: 30_000, pages: [
      { slug: `notes/c-example-${run}`, content: page('c'), reason: 'one' }, { slug: `notes/c-example-${run}`, content: page('c'), reason: 'two' }] });
    expect((differ.pages as Array<Record<string, unknown>>).map(entry => entry.state)).toEqual(['refused', 'refused']);
  });

  test('a remote reader sees a reason only when the successor is world-visible and was not pruned', async () => {
    await call('put_page', { slug: SLUG, content: page('world one'), wait_ms: 30_000 });
    await call('put_page', { slug: SLUG, content: page('private draft', 'visibility: private\n'), expected_revision: await revision(), reason: 'private-time reason', wait_ms: 30_000 });
    await call('put_page', { slug: SLUG, content: page('world two'), expected_revision: await revision(), reason: 'published again', wait_ms: 30_000 });
    expect((await versions()).map(row => row.replaced_because)).toEqual(['published again', 'private-time reason']);
    const remote = await versions(true);
    expect(remote.map(row => row.replaced_because)).toEqual([null]);
    expect(JSON.stringify(remote)).not.toContain('private-time reason');

    await call('put_page', { slug: SLUG, content: page('world three'), expected_revision: await revision(), reason: 'third edition', wait_ms: 30_000 });
    expect((await versions(true))[0]!.replaced_because).toBe('third edition');
    await engine.executeRaw("UPDATE page_versions SET successor_pruned = true WHERE change_reason = 'third edition'");
    expect((await versions(true))[0]!.replaced_because).toBeNull();
    expect((await versions(false))[0]!.replaced_because).toBe('third edition');
  });

  test('a real prune marks the survivor: a pruned private successor withholds the world predecessor\'s reason remotely', async () => {
    const big = 'x'.repeat(1024 ** 2 + 16);
    const write = async (body: string, visibility?: string) => {
      await engine.putPage(SLUG, { type: 'note', title: 'Policy', compiled_truth: body, frontmatter: visibility ? { visibility } : {} });
      await engine.createVersion(SLUG, { sourceId: 'default' });
    };
    await write('small world edition');
    await engine.executeRaw("UPDATE page_versions SET change_reason = 'made it private' WHERE id = (SELECT max(pv.id) FROM page_versions pv JOIN pages p ON p.id = pv.page_id WHERE p.slug = $1)", [SLUG]);
    await write(big, 'private');
    for (let i = 0; i < 5; i++) await write(big + i);
    const kept = await engine.executeRaw<{ visibility: string | null; successor_pruned: boolean | null; change_reason: string | null }>(
      `SELECT pv.frontmatter->>'visibility' AS visibility, pv.successor_pruned, pv.change_reason FROM page_versions pv JOIN pages p ON p.id = pv.page_id WHERE p.slug = $1 ORDER BY pv.id`, [SLUG]);
    expect(kept.map(row => row.visibility)).toEqual([null, null, null, null, null, null]);
    expect(kept[0]).toMatchObject({ successor_pruned: true, change_reason: 'made it private' });
    const [gap] = await engine.executeRaw<{ gap: unknown }>('SELECT version_history_gap_at AS gap FROM pages WHERE slug = $1', [SLUG]);
    expect(gap!.gap).not.toBeNull();
    expect((await versions(false)).at(-1)!.replaced_because).toBe('made it private');
    expect((await versions(true)).at(-1)!.replaced_because).toBeNull();
  }, 60_000);

  test('canonicaliser bounds', () => {
    expect(canonicalChangeReason('  a\tb\r\nc\u0007  d ')).toBe('a b c d');
    expect(canonicalChangeReason(' \n ')).toBeNull();
  });
});
