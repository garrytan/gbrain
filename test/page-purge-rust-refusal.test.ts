/**
 * A page purge on a Rust brain refuses before it writes anything, while a stop is listed; the retention purge has none.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: delete_page --purge and the retention purge on a Rust brain stop at the pre-write check
 *    (persistence/purge-path-members.ts) with the typed `engine_capability_missing` refusal that names the first listed
 *    stop and its owner lane, while the page, its versions, aliases and links, the derived page's label, the purge
 *    tombstones, the origin parks and the journal read exactly as they did before. The refusal is raised with no member
 *    that writes having been called.
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
import { purgePathStops } from '../src/core/persistence/purge-path-members.ts';
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

  rustRun('delete_page --purge names the first stop and its owner and leaves every read as it was', async () => {
    const engine = brain!.engine as unknown as BrainEngine;
    const ctx = localCtx(engine);
    const put = (slug: string, content: string) => operationsByName.put_page!.handler(ctx, { slug, content, request_id: randomUUID() });
    await put('notes/keeper', page('keeper', [], 'Keeper notes about the harbor.'));
    await put('notes/doomed', page('doomed', ['aliases: [Doomed Alias]', 'visibility: private'], 'First draft about the harbor.'));
    await put('notes/doomed-digest', page('doomed digest', ['derived_from: notes/doomed.md'], 'A digest of the doomed page.'));
    await engine.createVersion('notes/doomed', { sourceId: SRC });
    await engine.addLink('notes/doomed', 'notes/keeper', 'the doomed page cites the keeper', 'mentions');
    await engine.addLink('notes/keeper', 'notes/doomed', 'the keeper cites the doomed page', 'mentions');
    const slugs = ['notes/doomed', 'notes/doomed-digest', 'notes/keeper'];
    const ids = [Number((await engine.getPage('notes/doomed', { sourceId: SRC }) as unknown as R).id), Number((await engine.getPage('notes/doomed-digest', { sourceId: SRC }) as unknown as R).id)];
    // Stop the resident consumer the setup writes started, so no background compaction moves a counter during the case.
    await disposePersistenceConsumer(engine);
    const before = await readsOf(engine, slugs, ids);
    expect((before['notes/doomed'] as R).page).toMatchObject({ deleted: false });
    expect((before['notes/doomed'] as R).versions).toBe(1);

    const [first] = await purgePathStops(engine);
    expect(first).toBeDefined();
    const calls: string[] = [];
    const snapshot = await engine.readPageSnapshot('notes/doomed', { sourceId: SRC });
    const refusal = await operationsByName.delete_page!.handler({ ...ctx, engine: recording(engine, calls) } as OperationContext,
      { slug: 'notes/doomed', purge: true, request_id: randomUUID(), expected_revision: snapshot?.revision }).then(() => null, (error: unknown) => error as { code?: string; message?: string; detail?: string });

    expect(refusal?.code).toBe('engine_capability_missing');
    const text = `${refusal?.message ?? ''} ${refusal?.detail ?? ''}`;
    expect(text).toContain(first!.name);
    expect(text).toContain(first!.owner);
    expect(text).toContain('nothing ran');
    expect(text).toContain('written=nothing');
    expect(calls.filter(call => WRITES.includes(call))).toEqual([]);
    expect(await readsOf(engine, slugs, ids)).toEqual(before);
  }, 120_000);

  rustRun('the retention purge passes the check on a Rust brain and removes the expired tombstone, nothing else', async () => {
    const engine = brain!.engine as unknown as BrainEngine;
    const ctx = localCtx(engine);
    await operationsByName.put_page!.handler(ctx, { slug: 'notes/expired', content: page('expired', [], 'Gone soon.'), request_id: randomUUID() });
    await operationsByName.put_page!.handler(ctx, { slug: 'notes/kept', content: page('kept', [], 'Still here.'), request_id: randomUUID() });
    const snapshot = await engine.readPageSnapshot('notes/expired', { sourceId: SRC });
    await operationsByName.delete_page!.handler(ctx, { slug: 'notes/expired', request_id: randomUUID(), expected_revision: snapshot?.revision });
    await disposePersistenceConsumer(engine);
    const ids = ['notes/expired', 'notes/kept'].map(async slug => Number((await engine.getPage(slug, { sourceId: SRC, includeDeleted: true }) as unknown as R).id));
    const [, keptId] = await Promise.all(ids);
    // The kept page reads as before; the journal's byte counters move, since the expiry redacts the expired page's rows.
    const before = (await readsOf(engine, ['notes/kept'], [keptId!]))['notes/kept'];
    expect(await purgePathStops(engine, 'retention')).toEqual([]);

    const result = await purgeDeletedPagesCoordinated(engine, 0);
    await disposePersistenceConsumer(engine);
    expect(result.slugs).toContain('notes/expired');
    expect(await engine.getPage('notes/expired', { sourceId: SRC, includeDeleted: true })).toBeNull();
    expect((await readsOf(engine, ['notes/kept'], [keptId!]))['notes/kept']).toEqual(before);
  }, 120_000);

  test('the retention purge has no stop on a Rust brain', async () => {
    expect(await purgePathStops({ kind: 'rust' }, 'retention')).toEqual([]);
  });
});
