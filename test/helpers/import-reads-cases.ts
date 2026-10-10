/** Shared cases for the managed import's batched reads (GBRA-75 wave 10): PGLite unit test and Postgres E2E. */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { pageSnapshotKey } from '../../src/core/page-snapshot-batch.ts';
import { overlayCanonicalBodies } from '../../src/core/page-state/snapshot.ts';
import { importGroupReads, readImportSnapshots } from '../../src/core/persistence/import-reads.ts';
import { FENCE, PURGED, REFS, seed, seedPurged } from './page-snapshot-batch-cases.ts';

const PURGED_REFS = ['people/carol-example', 'people/dave-example', 'notes/plain-example', 'notes/missing-example'].map(slug => ({ slug, sourceId: PURGED }));
const single = (engine: BrainEngine, ref: { slug: string; sourceId: string }) => engine.readPageSnapshot(ref.slug, { sourceId: ref.sourceId, includeDeleted: true });

/** Each batched snapshot is the `{ sourceId, includeDeleted: true }` read: soft-deleted and missing pages, withdrawals and purge markers included. */
export async function importSnapshotsMatchSingleReads(engine: BrainEngine) {
  await seed(engine);
  await seedPurged(engine);
  const refs = [...REFS, ...PURGED_REFS];
  const batched = await readImportSnapshots(engine, refs);
  for (const ref of refs) {
    const one = await single(engine, ref);
    const many = batched.get(pageSnapshotKey(ref.sourceId, ref.slug)) ?? null;
    expect(many).toEqual(one);
    expect(many?.withdrawals ?? null).toEqual(one?.withdrawals ?? null);
    expect(many?.globalPurges ?? null).toEqual(one?.globalPurges ?? null);
  }
  expect(batched.get(pageSnapshotKey('default', 'notes/deleted-example'))?.page.deleted_at).toBeTruthy();
  expect(batched.has(pageSnapshotKey('default', 'notes/missing-example'))).toBe(false);
  expect(batched.has(pageSnapshotKey(PURGED, 'notes/missing-example'))).toBe(false);
  expect(batched.get(pageSnapshotKey(PURGED, 'people/dave-example'))?.globalPurges?.count).toBe(1);
  expect((await readImportSnapshots(engine, [])).size).toBe(0);
}

/** An incoming file that carries purged claims drops those rows through the batched snapshot exactly as through the single read. */
export async function importSnapshotsDropPurgedIncomingRows(engine: BrainEngine) {
  await seedPurged(engine);
  const incoming = `Incoming.\n\n${FENCE}`;
  const batched = await readImportSnapshots(engine, PURGED_REFS);
  const query = engine.executeRaw.bind(engine);
  const overlay = (snapshot: NonNullable<Awaited<ReturnType<typeof single>>>) =>
    overlayCanonicalBodies(query, incoming, '', snapshot.withdrawals, { sourceId: PURGED, marker: snapshot.globalPurges });
  for (const slug of ['people/carol-example', 'people/dave-example']) {
    const one = (await single(engine, { slug, sourceId: PURGED }))!;
    const many = batched.get(pageSnapshotKey(PURGED, slug))!;
    const viaSingle = await overlay(one);
    expect(await overlay(many)).toEqual(viaSingle);
    expect(viaSingle.compiled_truth).not.toContain('Ships  Weekly');
    expect(viaSingle.compiled_truth.includes('Hires slowly')).toBe(slug === 'people/dave-example');
  }
}

const DUP = 'import-reads-dup-example';
async function seedDuplicates(engine: BrainEngine): Promise<Record<string, string>> {
  if (!(await engine.executeRaw('SELECT 1 FROM sources WHERE id=$1', [DUP])).length) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [DUP]);
    const put = (slug: string, hash: string, frontmatter: Record<string, unknown> = {}, sourceId = DUP) =>
      engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Body of ${slug}.`, timeline: '', frontmatter, content_hash: hash }, { sourceId });
    await put('notes/a-example', 'hash-shared');
    await put('notes/b-example', 'hash-shared', { id: 'fm-b' });
    await put('notes/c-example', 'hash-c', { id: 'fm-c' });
    await put('notes/d-example', 'hash-d', { id: 'q"u,o{t}e\\s' });
    await put('notes/gone-example', 'hash-gone', { id: 'fm-gone' });
    await engine.softDeletePage('notes/gone-example', { sourceId: DUP });
    await put('notes/z-example', 'hash-shared', { id: 'fm-b' }, 'default');
  }
  const rows = await engine.executeRaw<{ slug: string; content_hash: string }>('SELECT slug, content_hash FROM pages WHERE source_id=$1', [DUP]);
  return Object.fromEntries(rows.map(row => [row.slug, row.content_hash]));
}

/** `findDuplicatePages` answers entry i exactly as `findDuplicatePage(inputs[i])`. */
export async function findDuplicatePagesMatchesSingle(engine: BrainEngine) {
  const hash = await seedDuplicates(engine);
  const shared = hash['notes/a-example']!;
  const inputs = [
    { hash: shared },
    { hash: shared, frontmatterId: 'fm-b' },
    { hash: shared, excludeSlug: 'notes/a-example' },
    { hash: shared, excludeSlug: 'notes/b-example', frontmatterId: 'fm-b' },
    { hash: 'no-such-hash', frontmatterId: 'fm-c' },
    { hash: 'no-such-hash', frontmatterId: 'fm-c', excludeSlug: 'notes/c-example' },
    { hash: 'no-such-hash', frontmatterId: null },
    { hash: hash['notes/gone-example']!, frontmatterId: 'fm-gone' },
    { hash: 'no-such-hash', frontmatterId: 'q"u,o{t}e\\s' },
    { hash: hash['notes/c-example']!, frontmatterId: 'fm-b', excludeSlug: '' },
  ];
  const batched = await engine.findDuplicatePages!(DUP, inputs);
  const singles = await Promise.all(inputs.map(input => engine.findDuplicatePage!(DUP, input)));
  expect(batched).toEqual(singles);
  expect(batched.map(found => found?.slug ?? null)).toEqual(['notes/a-example', 'notes/b-example', 'notes/b-example', 'notes/a-example',
    'notes/c-example', null, null, null, 'notes/d-example', 'notes/b-example']);
  expect(await engine.findDuplicatePages!(DUP, [])).toEqual([]);
}

/** A counting view of an engine, for the coalescing cases. */
function counting(engine: BrainEngine, overrides: { findDuplicatePages?: BrainEngine['findDuplicatePages']; readPageSnapshotsBatch?: BrainEngine['readPageSnapshotsBatch'] } = {}) {
  const calls = { batchSnapshots: 0, snapshots: 0, batchDuplicates: 0, duplicates: 0 };
  const view = new Proxy(engine, { get(target, key) {
    if (key === 'readPageSnapshotsBatch') return (...args: Parameters<BrainEngine['readPageSnapshotsBatch']>) => { calls.batchSnapshots++; return (overrides.readPageSnapshotsBatch ?? target.readPageSnapshotsBatch.bind(target))(...args); };
    if (key === 'readPageSnapshot') return (...args: Parameters<BrainEngine['readPageSnapshot']>) => { calls.snapshots++; return target.readPageSnapshot(...args); };
    if (key === 'findDuplicatePages') return (...args: Parameters<NonNullable<BrainEngine['findDuplicatePages']>>) => { calls.batchDuplicates++; return (overrides.findDuplicatePages ?? target.findDuplicatePages!.bind(target))(...args); };
    if (key === 'findDuplicatePage') return (...args: Parameters<NonNullable<BrainEngine['findDuplicatePage']>>) => { calls.duplicates++; return target.findDuplicatePage!(...args); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { view, calls };
}

/** A group's members get their single-read answers from one snapshot batch and one duplicate statement; a failed batch falls back to each member's own read. */
export async function importGroupReadsCoalesce(engine: BrainEngine) {
  const hash = await seedDuplicates(engine);
  const rows = ['notes/a-example', 'notes/c-example', 'notes/missing-example'].map(slug => ({ slug, source_id: DUP }));
  const inputs = [{ hash: hash['notes/a-example']!, excludeSlug: 'notes/a-example' }, { hash: 'no-such-hash', frontmatterId: 'fm-c' }, { hash: 'no-such-hash', excludeSlug: 'notes/missing-example' }];
  const expected = await Promise.all(inputs.map(input => engine.findDuplicatePage!(DUP, input)));
  const expectedSnapshots = await Promise.all(rows.map(row => single(engine, { slug: row.slug, sourceId: DUP })));

  const { view, calls } = counting(engine);
  const reads = importGroupReads(view, rows);
  const opts = { sourceId: DUP, includeDeleted: true };
  expect(await Promise.all(rows.map(row => reads.snapshot(row.slug, opts)))).toEqual(expectedSnapshots);
  expect(await Promise.all(inputs.map(input => reads.findDuplicate(DUP, input)))).toEqual(expected);
  expect(calls).toEqual({ batchSnapshots: 1, snapshots: 0, batchDuplicates: 1, duplicates: 0 });
  expect(reads.snapshot('notes/a-example', opts)).toBeUndefined();
  expect(reads.snapshot('notes/c-example', { sourceId: DUP })).toBeUndefined();
  expect(reads.snapshot('notes/c-example', { sourceId: DUP, includeDeleted: true, resolveAlias: true })).toBeUndefined();

  const failing = counting(engine, { findDuplicatePages: async () => { throw new Error('batch failed'); }, readPageSnapshotsBatch: async () => { throw new Error('batch failed'); } });
  const fallback = importGroupReads(failing.view, rows);
  expect(await Promise.all(rows.map(row => fallback.snapshot(row.slug, opts)))).toEqual(expectedSnapshots);
  expect(await Promise.all(inputs.map(input => fallback.findDuplicate(DUP, input)))).toEqual(expected);
  expect(failing.calls).toEqual({ batchSnapshots: 1, snapshots: 3, batchDuplicates: 1, duplicates: 3 });

  const partial = counting(engine);
  const late = importGroupReads(partial.view, rows);
  expect(await late.findDuplicate(DUP, inputs[1]!)).toEqual(expected[1]!);
  expect(partial.calls.duplicates).toBe(1);
}
