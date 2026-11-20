/**
 * The Rust engine on the real store (docs/designs/RUST_ENGINE.md, "PR sequence" steps 10-12): the engine opens the
 * brain directory through the napi addon, serves the members rust/README.md ("The brain store") lists, and maps the
 * store's error codes to the typed errors PGLite callers already catch.
 *
 * The addon tests need the file `bun run rust:build` writes (rust/target/addon) and skip without it;
 * GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error (the Rust CI job sets it). The last describe needs
 * no addon.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, RustEngine } from '../src/core/rust-engine.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { servedCapabilities } from '../src/core/rust-engine/store-capabilities.ts';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';
import { toGetPage, toListPage } from '../src/core/rust-engine/store-codec.ts';
import { PageRevisionConflictError } from '../src/core/page-state/types.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { ENGINE_CAPABILITIES } from '../src/core/engine-capabilities.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let addon: RustAddon | undefined;
const dirs: string[] = [];
const engines: RustEngine[] = [];

async function newEngine(dir?: string): Promise<{ engine: RustEngine; dir: string }> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const path = dir ?? mkdtempSync(join(tmpdir(), 'gbrain-rust-store-'));
  if (!dir) dirs.push(path);
  const engine = openRustEngine({ addon, databasePath: path });
  engines.push(engine);
  return { engine, dir: path };
}

async function open(dir?: string): Promise<{ engine: RustEngine; dir: string }> {
  const made = await newEngine(dir);
  await made.engine.connect({ engine: 'pglite', database_path: made.dir } as never);
  return made;
}

async function code(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return (error as OperationError).code ?? (error as Error).name;
  }
  return undefined;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const page = { type: 'note', title: 'A', compiled_truth: 'Body.', timeline: '' } as const;

describe('Rust engine on the store', () => {
  withAddon('opens a brain, serves a page and config, closes, and finds both after reopening', async () => {
    const first = await open();
    await first.engine.putPage('notes/a', page);
    await first.engine.setConfig('k', 'v');
    expect((await first.engine.getPage('notes/a'))?.title).toBe('A');
    await first.engine.disconnect();
    const second = await open(first.dir);
    expect((await second.engine.getPage('notes/a'))?.compiled_truth).toBe('Body.');
    expect(await second.engine.getConfig('k')).toBe('v');
  });

  withAddon('a second engine on an open brain directory becomes a client of the first, and opens the store once the first closes', async () => {
    const first = await open();
    await first.engine.putPage('notes/a', page);
    expect(first.engine.ownerRole).toBe('owner');
    // Connect elects an owner: the first engine holds the brain, so the second never opens the store and asks the first.
    const second = await open(first.dir);
    expect(second.engine.ownerRole).toBe('client');
    expect((await second.engine.getPage('notes/a'))?.title).toBe('A');
    await second.engine.disconnect();
    await first.engine.disconnect();
    await second.engine.connect({ engine: 'pglite', database_path: first.dir } as never);
    expect(second.engine.ownerRole).toBe('owner');
    expect((await second.engine.getPage('notes/a'))?.compiled_truth).toBe('Body.');
  });

  withAddon('a served member on a closed engine refuses engine_closed', async () => {
    const made = await newEngine();
    expect(await code(() => made.engine.getPage('notes/a'))).toBe('engine_closed');
    await made.engine.connect({ engine: 'pglite', database_path: made.dir } as never);
    await made.engine.disconnect();
    expect(await code(() => made.engine.getPage('notes/a'))).toBe('engine_closed');
  });

  withAddon('pages stay in their source: the same slug in two sources is two pages', async () => {
    const { engine } = await open();
    await engine.openStore('test').brain.upsertSource({ id: 'other', name: 'other', config: {} });
    await engine.putPage('notes/a', page);
    await engine.putPage('notes/a', { ...page, title: 'Other' }, { sourceId: 'other' });
    expect((await engine.getPage('notes/a'))?.title).toBe('A');
    expect((await engine.getPage('notes/a', { sourceId: 'other' }))?.title).toBe('Other');
    expect((await engine.listAllSources()).map((s) => s.id).sort()).toEqual(['default', 'other']);
  });

  withAddon('a stale expectedRevision refuses with PageRevisionConflictError carrying the current revision', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    const first = (await engine.readPageSnapshot('notes/a'))!.revision;
    await engine.putPage('notes/a', { ...page, compiled_truth: 'Two.' }, { expectedRevision: first });
    try {
      await engine.putPage('notes/a', { ...page, compiled_truth: 'Three.' }, { expectedRevision: first });
      throw new Error('expected a revision conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(PageRevisionConflictError);
      expect((error as PageRevisionConflictError).expectedRevision).toBe(first);
      expect((error as PageRevisionConflictError).currentRevision).toBe((await engine.readPageSnapshot('notes/a'))!.revision);
      expect((error as PageRevisionConflictError).currentRevision).not.toBe(first);
    }
    expect((await engine.getPage('notes/a'))?.compiled_truth).toBe('Two.');
  });

  withAddon('an option the store does not keep refuses engine_capability_missing instead of being dropped', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    // The store does not evaluate the trust floor getSalienceScores reads.
    const refused = await code(() => engine.getSalienceScores([{ slug: 'notes/a', source_id: 'default' }], { minTrust: 'agent_written' }));
    expect(refused).toBe('engine_capability_missing');
    expect(await code(() => engine.getChunks('notes/a', { notAStoreOption: true } as never))).toBe('engine_capability_missing');
  });

  withAddon('excludePrivate on the salience and anomaly reads hides a private page the plain read returns', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    for (const slug of ['notes/secret', 'notes/readers', 'atoms/bare']) {
      const frontmatter = slug === 'notes/secret' ? { visibility: 'private' } : slug === 'notes/readers' ? { readable_by: ['alice-example'] } : {};
      await engine.putPage(slug, { ...page, type: (slug.startsWith('atoms/') ? 'atom' : 'note') as never, frontmatter });
      await engine.addTag(slug, 'hidden-only');
    }
    await engine.setEmotionalWeightBatch([{ slug: 'notes/secret', source_id: 'default', weight: 1 }]);
    const slugs = (rows: Array<{ slug: string }>) => rows.map((r) => r.slug).sort();
    expect((await engine.getRecentSalience({ days: 7 }))[0]!.slug).toBe('notes/secret');
    expect(slugs(await engine.getRecentSalience({ days: 7, excludePrivate: true }))).toEqual(['notes/a']);
    const refs = ['notes/a', 'notes/secret', 'notes/readers', 'atoms/bare'].map((slug) => ({ slug, source_id: 'default' }));
    expect((await engine.getSalienceScores(refs, {})).get('default::notes/secret')).toBe(5);
    expect([...(await engine.getSalienceScores(refs, { excludePrivate: true })).keys()]).toEqual(['default::notes/a']);
    const today = new Date((await engine.getPage('notes/secret'))!.updated_at).toISOString().slice(0, 10);
    const tag = async (excludePrivate: boolean) =>
      (await engine.findAnomalies({ since: today, lookback_days: 1, excludePrivate })).find((r) => r.cohort_value === 'hidden-only');
    expect((await tag(false))?.page_slugs.sort()).toEqual(['atoms/bare', 'notes/readers', 'notes/secret']);
    expect(await tag(true)).toBeUndefined();
  });

  withAddon('excludePrivate refuses for a caller whose member identity changes the page policy PGLite renders', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    const asMember = <T>(fn: () => Promise<T>) => withCallerAccess({ identity: ['member:alice-example'] }, fn);
    const refs = [{ slug: 'notes/a', source_id: 'default' }];
    expect(await code(() => asMember(() => engine.getRecentSalience({ days: 7, excludePrivate: true })))).toBe('engine_capability_missing');
    expect(await code(() => asMember(() => engine.getSalienceScores(refs, { excludePrivate: true })))).toBe('engine_capability_missing');
    expect(await code(() => asMember(() => engine.findAnomalies({ since: '2026-01-02', excludePrivate: true })))).toBe('engine_capability_missing');
    // Without excludePrivate the caller's record does not matter: the read applies no page policy.
    expect(await code(() => asMember(() => engine.getRecentSalience({ days: 7 })))).toBeUndefined();
  });

  withAddon('a chunk vector of the wrong width is refused, and writes nothing', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    const before = await engine.getChunks('notes/a');
    const chunk = { chunk_index: 0, chunk_text: 'Replaced.', chunk_source: 'compiled_truth', embedding: new Float32Array(4) } as never;
    expect(await code(() => engine.upsertChunks('notes/a', [chunk]))).toBe('invalid_argument');
    expect(await engine.getChunks('notes/a')).toEqual(before);
  });

  withAddon('a chunk that carries an image vector refuses chunks, and writes nothing', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    const before = await engine.getChunks('notes/a');
    const chunk = { chunk_index: 0, chunk_text: 'Replaced.', chunk_source: 'compiled_truth', embedding_image: new Float32Array(4) } as never;
    expect(await code(() => engine.upsertChunks('notes/a', [chunk]))).toBe('engine_capability_missing');
    expect(await engine.getChunks('notes/a')).toEqual(before);
  });

  withAddon('getStats and getHealth refuse a brain whose config selects another embedding column', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    expect((await engine.getStats()).page_count).toBe(1);
    await engine.setConfig('search_embedding_column', 'embedding_other');
    expect(await code(() => engine.getStats())).toBe('engine_capability_missing');
    expect(await code(() => engine.getHealth())).toBe('engine_capability_missing');
    await engine.unsetConfig('search_embedding_column');
    expect((await engine.getHealth()).page_count).toBe(1);
  });

  withAddon('raw data and files cross the binding as PGLite returns them', async () => {
    const { engine } = await open();
    const created = await engine.putPage('notes/a', page);
    // A missing page throws PGLite's plain Error, not a typed one.
    const missing = await engine.putRawData('notes/none', 's', {}).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(Error);
    expect((missing as Error).message).toBe('putRawData failed: page "notes/none" not found');
    expect((missing as { code?: unknown }).code).toBeUndefined();
    // JSON.stringify drops undefined members and calls toJSON, as PGLite's binding does.
    await engine.putRawData('notes/a', 's', { keep: 1, drop: undefined, at: new Date(0) });
    const [row] = await engine.getRawData('notes/a');
    expect(row!.data).toEqual({ keep: 1, at: '1970-01-01T00:00:00.000Z' });
    expect(row!.fetched_at).toBeInstanceOf(Date);
    expect(await code(() => engine.getRawData('notes/a', undefined, { excludePrivate: true }))).toBe('engine_capability_missing');
    // A size past 2^31 crosses N-API as a double and comes back whole.
    const spec = { page_id: created.id, filename: 'a.png', storage_path: 'f/a.png', content_hash: 'h', size_bytes: 5_000_000_000 };
    expect((await engine.upsertFile(spec)).created).toBe(true);
    const [file] = await engine.listFilesForPage(created.id);
    expect(file!.size_bytes).toBe(5_000_000_000);
    expect(file!.metadata).toEqual({});
    expect(file!.created_at).toBeInstanceOf(Date);
    expect((await engine.getFile('default', 'f/a.png'))?.page_id).toBe(created.id);
  });

  withAddon('a brain on a partial capability set reports exactly what the store serves', async () => {
    const { engine } = await open();
    expect([...engine.capabilities].sort()).toEqual([...servedCapabilities()].sort());
  });
});

describe('Rust store members', () => {
  test('every served member is a row of the member table, and a served capability needs all of its members', () => {
    for (const member of Object.keys(STORE_MEMBERS)) {
      expect(Object.hasOwn(RUST_ENGINE_MEMBERS, member)).toBe(true);
    }
    const members = RUST_ENGINE_MEMBERS as Record<string, string>;
    for (const capability of servedCapabilities()) {
      expect((ENGINE_CAPABILITIES as readonly string[]).includes(capability)).toBe(true);
      const needed = Object.keys(members).filter((m) => members[m] === capability);
      expect(needed.length).toBeGreaterThan(0);
      for (const member of needed) expect(Object.hasOwn(STORE_MEMBERS, member)).toBe(true);
    }
  });

  test("revertToVersion turns the store's page_body_segmented refusal into PGLite's segmentedRevertRefusal", async () => {
    const refusal = Object.assign(new Error('segmented'), { code: 'page_body_segmented' });
    const brain = { revertToVersion: async () => { throw refusal; } };
    const revert = STORE_MEMBERS.revertToVersion as (brain: unknown, slug: string, versionId: number) => Promise<void>;
    const error = await revert(brain, 'notes/a', 7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('page_body_segmented');
    expect((error as Error).message).toBe('Page notes/a or its version 7 is stored in segments, so revert_version cannot restore it yet; nothing was changed.');
  });
});

describe('Rust store page codec', () => {
  const stored = {
    id: 1, slug: 'big', source_id: 'default', type: 'note', page_kind: 'markdown', title: 'Big', frontmatter: {},
    compiled_truth: null, timeline: null, content_hash: null, created_at: '2026-01-01T00:00:00.000000Z',
    updated_at: '2026-01-01T00:00:00.000000Z', updated_at_iso: '2026-01-01T00:00:00.000000Z',
  };

  test('a segmented shell page keeps a null content_hash and guards its body like PGLite rowToPage', () => {
    for (const page of [toGetPage(stored), toListPage(stored)] as Record<string, unknown>[]) {
      expect(page.content_hash).toBeNull();
      expect(Object.keys(page)).toContain('compiled_truth');
      expect(() => page.compiled_truth).toThrow(expect.objectContaining({ code: 'page_body_segmented' }));
      expect(() => page.timeline).toThrow(expect.objectContaining({ code: 'page_body_segmented' }));
    }
  });

  test('an inline page reads its body and content_hash unchanged', () => {
    const page = toGetPage({ ...stored, compiled_truth: 'body', timeline: '', content_hash: 'abc' }) as Record<string, unknown>;
    expect(page.compiled_truth).toBe('body');
    expect(page.timeline).toBe('');
    expect(page.content_hash).toBe('abc');
  });
});
