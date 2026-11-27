/**
 * A page purge on a Rust brain: delete_page --purge runs whole, and the retention purge refuses before it writes anything.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: delete_page --purge has no stop left on a Rust brain (every member of its purge path is served, so
 *    purgePathStops lists nothing): the purge removes the page and leaves the other page as it was. The retention purge
 *    still stops at the pre-write check (persistence/purge-path-members.ts) with the typed `engine_capability_missing`
 *    refusal that names its first listed stop, releaseStaleHolds (persistence/derived-origin-hold.ts, owner lane 4),
 *    while the tombstone, the origin parks and the journal read exactly as they did before. The refusal is raised with no
 *    member that writes having been called.
 *  - Regression: the purge went on past the first raw-SQL site, so a refusal that came later (the generation-ledger
 *    scrub, the receipt reads) could land after the page was already deleted.
 *  - Why existing coverage misses it: test/engine-parity/delete-page.test.ts compares only the page and its digest, and
 *    only the first stop; nothing reads the purge rows, parks and journal on Rust.
 *  - Seam: the delete_page operation handler and purgeDeletedPagesCoordinated on the Rust engine, with a proxy that
 *    records the member calls. Needs the Rust addon: skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { PURGE_PATH, purgeEntryName, purgePathStops } from '../src/core/persistence/purge-path-members.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath, type RustBrainDir } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const SRC = 'default';
type R = Record<string, unknown>;

/** Members whose call is a write on the purge path: none may run before the refusal. */
const WRITES = ['transaction', 'transactionDirect', 'declarePersistence', 'insertWriteRequest', 'putPage', 'softDeletePage', 'deletePage', 'upsertPagePurges',
  'upsertDerivedOriginPark', 'recordOwedPurgeRows', 'deleteOriginHoldRows', 'writePageLabelGuard', 'addPageTagsById', 'replaceDerivedAliases', 'setPageAliases'];

const page = (title: string, frontmatter: string[], body: string) => ['---', `title: ${title}`, 'type: note', ...frontmatter, '---', `# ${title}`, '', body].join('\n');
const localCtx = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: SRC }) as unknown as OperationContext;

function recording(engine: BrainEngine, calls: string[]): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => { calls.push(prop); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    },
  });
}

/** Everything the purge could touch, read through members the Rust engine serves. */
async function readsOf(engine: BrainEngine, slugs: string[], pageIds: number[]): Promise<R> {
  const out: R = {};
  for (const slug of slugs) {
    const found = await engine.getPage(slug, { sourceId: SRC, includeDeleted: true }) as R | null;
    out[slug] = {
      page: found ? { deleted: found.deleted_at != null, title: found.title, frontmatter: found.frontmatter } : null,
      versions: (await engine.getVersions(slug, { sourceId: SRC })).length,
      aliases: (await engine.readPageAliasRows([SRC], [slug])).map(row => row.alias_norm).sort(),
      links: (await engine.getLinks(slug, { sourceId: SRC })).map(link => link.to_slug).sort(),
      backlinks: (await engine.getBacklinks(slug, { sourceId: SRC })).map(link => link.from_slug).sort(),
      tombstones: await engine.countPagePurgeTombstones(SRC, slug),
      requests: (await engine.listRequestsForSlugs(SRC, [slug], 100, '0')).length,
    };
  }
  // Deleting a park or an owed-purge row that is not there removes nothing: a count above zero is a write that ran.
  out.parks = [await engine.deleteOriginHoldRows('derived-origin-park', pageIds), await engine.deleteOriginHoldRows('owed-page-purge', pageIds)];
  // Every counter, terminal_bytes included: each case stops the resident consumer before the first read, so nothing
  // compacts in the background and any counter that moves is a write by the refused purge.
  out.journal = { ceiling: await engine.readJournalCeiling(SRC), counters: await engine.readCounterRows(['brain']) };
  return out;
}

describe('a page purge on a Rust brain refuses before any write', () => {
  let brain: RustBrainDir | undefined;
  beforeAll(async () => { if (existsSync(rustArmAddonPath()) || required) brain = await openRustBrain(); }, 60_000);
  afterAll(async () => {
    if (!brain) return;
    await disposePersistenceConsumer(brain.engine as unknown as BrainEngine).catch(() => undefined);
    await (brain.engine as unknown as BrainEngine).disconnect().catch(() => undefined);
    removeBrainDir(brain.dir);
  });

  rustRun('delete_page --purge has no stop on a Rust brain: it removes the page and leaves the other page as it was', async () => {
    const engine = brain!.engine as unknown as BrainEngine;
    const ctx = localCtx(engine);
    const put = (slug: string, content: string) => operationsByName.put_page!.handler(ctx, { slug, content, request_id: randomUUID() });
    await put('notes/keeper', page('keeper', [], 'Keeper notes about the harbor.'));
    await put('notes/doomed', page('doomed', ['aliases: [Doomed Alias]', 'visibility: private'], 'First draft about the harbor.'));
    await engine.createVersion('notes/doomed', { sourceId: SRC });
    await engine.addLink('notes/doomed', 'notes/keeper', 'the doomed page cites the keeper', 'mentions');
    await engine.addLink('notes/keeper', 'notes/doomed', 'the keeper cites the doomed page', 'mentions');
    const ids = [Number((await engine.getPage('notes/doomed', { sourceId: SRC }) as unknown as R).id)];
    await disposePersistenceConsumer(engine);
    const keeperBefore = (await readsOf(engine, ['notes/keeper'], ids))['notes/keeper'] as R;

    expect(await purgePathStops(engine)).toEqual([]);
    const snapshot = await engine.readPageSnapshot('notes/doomed', { sourceId: SRC });
    await operationsByName.delete_page!.handler(ctx, { slug: 'notes/doomed', purge: true, request_id: randomUUID(), expected_revision: snapshot?.revision });
    await disposePersistenceConsumer(engine);

    const after = await readsOf(engine, ['notes/doomed', 'notes/keeper'], ids);
    expect(after['notes/doomed']).toMatchObject({ page: null, versions: 0, aliases: [], links: [], backlinks: [], tombstones: 1 });
    // The keeper loses only its link to the purged page; its page, versions and aliases read as before.
    expect(after['notes/keeper']).toEqual({ ...keeperBefore, links: [], backlinks: [] });
  }, 120_000);

  rustRun('the retention purge refuses at the same check and leaves the tombstone and the journal as they were', async () => {
    const engine = brain!.engine as unknown as BrainEngine;
    const ctx = localCtx(engine);
    await operationsByName.put_page!.handler(ctx, { slug: 'notes/expired', content: page('expired', [], 'Gone soon.'), request_id: randomUUID() });
    const snapshot = await engine.readPageSnapshot('notes/expired', { sourceId: SRC });
    await operationsByName.delete_page!.handler(ctx, { slug: 'notes/expired', request_id: randomUUID(), expected_revision: snapshot?.revision });
    await disposePersistenceConsumer(engine);
    const id = Number((await engine.getPage('notes/expired', { sourceId: SRC, includeDeleted: true }) as unknown as R).id);
    const before = await readsOf(engine, ['notes/expired'], [id]);
    expect((before['notes/expired'] as R).page).toMatchObject({ deleted: true });

    const [first] = await purgePathStops(engine, 'retention');
    expect(first).toBeDefined();
    const calls: string[] = [];
    const refusal = await purgeDeletedPagesCoordinated(recording(engine, calls), 0).then(() => null, (error: unknown) => error as { code?: string; message?: string; detail?: string });
    expect(refusal?.code).toBe('engine_capability_missing');
    expect(`${refusal?.message} ${refusal?.detail}`).toContain(first!.name);
    expect(`${refusal?.message} ${refusal?.detail}`).toContain(first!.owner);
    expect(calls.filter(call => WRITES.includes(call))).toEqual([]);
    expect(await readsOf(engine, ['notes/expired'], [id])).toEqual(before);
  }, 120_000);

  test('delete_page has no stop on a Rust brain, and the retention purge stops first at the unmanaged expiry reads, owned by lane 4', async () => {
    expect(await purgePathStops({ kind: 'rust' })).toEqual([]);
    const [first] = await purgePathStops({ kind: 'rust' }, 'retention');
    // releaseStaleHolds is served since lane 4's retention-purge-rust (c291d88f9a); the first stop left is purgeExpired's
    // expired-page reads (RETENTION_STOPS in src/core/persistence/purge-path-members.ts).
    expect({ name: first?.name, owner: first?.owner }).toEqual({ name: '<anonymous> (persistence/purge-deleted.ts)', owner: 'lane 4' });
    expect(PURGE_PATH.map(purgeEntryName)).toContain(first!.name);
  });
});
