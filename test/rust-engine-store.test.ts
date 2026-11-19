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
import { labelsOf } from '../src/core/rust-engine/store-members/label-line.ts';
import { METADATA_LABELS } from '../src/core/conversation-parser/builtins.ts';
import { toGetPage, toListPage } from '../src/core/rust-engine/store-codec.ts';
import { PageRevisionConflictError } from '../src/core/page-state/types.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { ENGINE_CAPABILITIES } from '../src/core/engine-capabilities.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { audienceMemberIds, boundCredentials, getMember, legacyTokenByName, listMembers, memberByEmail } from '../src/core/access/members.ts';
import { memberIdentityFor, stdioMemberIdentity } from '../src/core/access/caller.ts';

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
    // findOrphanPages takes no trust floor on Rust: no production caller sends one, so it refuses.
    const refused = await code(() => engine.findOrphanPages({ minTrust: 'agent_written' }));
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

  withAddon('excludePrivate refuses for a caller whose folder-rule grants change the page policy PGLite renders', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    // A reader identity alone is served (the callerReaders opt-in); a satisfied folder rule still refuses.
    const asReader = <T>(fn: () => Promise<T>) => withCallerAccess({ identity: ['member:alice-example'] }, fn);
    expect(await code(() => asReader(() => engine.getRecentSalience({ days: 7, excludePrivate: true })))).toBeUndefined();
    const asMember = <T>(fn: () => Promise<T>) =>
      withCallerAccess({ identity: ['member:alice-example'], satisfiedRuleIds: ['default:team-notes'] }, fn);
    const refs = [{ slug: 'notes/a', source_id: 'default' }];
    expect(await code(() => asMember(() => engine.getRecentSalience({ days: 7, excludePrivate: true })))).toBe('engine_capability_missing');
    expect(await code(() => asMember(() => engine.getSalienceScores(refs, { excludePrivate: true })))).toBe('engine_capability_missing');
    expect(await code(() => asMember(() => engine.findAnomalies({ since: '2026-01-02', excludePrivate: true })))).toBe('engine_capability_missing');
    // Without excludePrivate the caller's record does not matter: the read applies no page policy.
    expect(await code(() => asMember(() => engine.getRecentSalience({ days: 7 })))).toBeUndefined();
  });

  withAddon('excludePrivate on the fact reads serves a reader identity and grant but refuses folder rules, audiences, lineage and labelled-only', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    await engine.insertFacts([{ fact: 'f', entity_slug: 'people/a-example', source_markdown_slug: 'notes/a', row_num: 1, kind: 'fact', visibility: 'world', source: 'fence' }] as never, { source_id: 'default' });
    const reads: Record<string, () => Promise<unknown>> = {
      listFactsSince: () => engine.listFactsSince('default', new Date('2020-01-01T00:00:00Z'), { excludePrivate: true }),
      countWorldFacts: () => engine.countWorldFacts({ sourceId: 'default', entitySlugs: ['people/a-example'], worldOnly: false, excludePrivate: true }),
      getOntology: () => engine.getOntology('people/a-example', { excludePrivate: true }),
    };
    const reader = { identity: ['member:alice-example'], privateReadableSources: ['default'] };
    // Option C scope: each of these changes the fact policy text, and the store has no form for it.
    const refused = {
      folderRule: { ...reader, satisfiedRuleIds: ['default:team-notes'] },
      audience: { audience: ['member:alice-example', 'member:bob-example'], audienceIdentities: [['member:alice-example'], ['member:bob-example']] },
      lineage: { ...reader, lineage: true },
      labelledOnly: { ...reader, labelledOnly: true },
    };
    for (const [name, read] of Object.entries(reads)) {
      expect([name, await code(() => withCallerAccess(reader, read))]).toEqual([name, undefined]);
      for (const [kind, access] of Object.entries(refused)) {
        expect([name, kind, await code(() => withCallerAccess(access, read))]).toEqual([name, kind, 'engine_capability_missing']);
      }
    }
  });

  withAddon('readRemoteForgetTier under the remote floor serves no caller record, a restricted or unrestricted brain and the owner, and refuses labelled-only and folder coverage', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    const { ids } = await engine.insertFacts([{ fact: 'f', entity_slug: 'people/a-example', source_markdown_slug: 'notes/a', row_num: 1, kind: 'fact', visibility: 'world', source: 'fence' }] as never, { source_id: 'default' });
    const read = () => engine.readRemoteForgetTier({ factId: ids[0]!, sourceId: 'default', remoteFloor: true });
    const served = { restricted: { restricted: true }, unrestricted: { restricted: false }, owner: { owner: true }, ownerUnrestricted: { owner: true, restricted: false } };
    for (const [kind, access] of Object.entries(served)) {
      expect([kind, await withCallerAccess(access, read)]).toEqual([kind, expect.any(String)]);
    }
    expect(await read()).toEqual(expect.any(String));
    // A labelled-only caller or pending folder coverage renders a floor the store has no form for.
    expect(await code(() => withCallerAccess({ labelledOnly: true }, read))).toBe('engine_capability_missing');
    expect(await code(() => withCallerAccess({ folderCoverage: [{ source_id: 'default', prefix: 'team/' }] }, read))).toBe('engine_capability_missing');
  });

  withAddon('a chunk vector of the wrong width is refused, and writes nothing', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    const before = await engine.getChunks('notes/a');
    const chunk = { chunk_index: 0, chunk_text: 'Replaced.', chunk_source: 'compiled_truth', embedding: new Float32Array(4) } as never;
    expect(await code(() => engine.upsertChunks('notes/a', [chunk]))).toBe('invalid_argument');
    expect(await engine.getChunks('notes/a')).toEqual(before);
  });

  withAddon('upsertChunks serves embeddingColumn for the store column at any descriptor width; another column or type refuses and writes nothing', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    const chunk = (text: string) => ({ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', embedding: new Float32Array(1536).fill(0.5), model: 'm:one' }) as never;
    const column = (over: object) => ({ name: 'embedding', type: 'vector', dimensions: 1536, embeddingModel: '', ...over }) as never;
    // upsertChunks writes unsealed chunks (a write's seal publishes them), so each read asks for them.
    await engine.upsertChunks('notes/a', [chunk('Kept.')], { embeddingColumn: column({}) });
    const kept = await engine.getChunks('notes/a', { includeEmbedding: true, includeUnsealed: true });
    expect(kept.map((c) => [c.chunk_text, c.model, c.embedding?.length])).toEqual([['Kept.', 'm:one', 1536]]);
    for (const over of [{ name: 'embedding_image', dimensions: 1024 }, { name: 'embedding_voyage', embeddingModel: 'voyage:v' }, { type: 'halfvec' }]) {
      expect(await code(() => engine.upsertChunks('notes/a', [chunk('Replaced.')], { embeddingColumn: column(over) }))).toBe('engine_capability_missing');
    }
    expect(await code(() => engine.upsertChunks('notes/a', [chunk('Replaced.')], { embeddingColumn: 'embedding_image' as never }))).toBe('engine_capability_missing');
    expect(await engine.getChunks('notes/a', { includeEmbedding: true, includeUnsealed: true })).toEqual(kept);
    // The descriptor's width is not read (PGLite's `::vector` cast never reads it); the store's width check on the
    // vector still refuses a vector of another width, and writes nothing.
    const narrow = { chunk_index: 0, chunk_text: 'Narrow.', chunk_source: 'compiled_truth', embedding: new Float32Array(768).fill(0.5), model: 'm:one' } as never;
    expect(await code(() => engine.upsertChunks('notes/a', [narrow], { embeddingColumn: column({ dimensions: 768 }) }))).toBe('invalid_argument');
    expect(await engine.getChunks('notes/a', { includeEmbedding: true, includeUnsealed: true })).toEqual(kept);
    await engine.upsertChunks('notes/a', [chunk('Wide.')], { embeddingColumn: column({ dimensions: 768 }) });
    expect((await engine.getChunks('notes/a', { includeEmbedding: true, includeUnsealed: true })).map((c) => [c.chunk_text, c.embedding?.length])).toEqual([['Wide.', 1536]]);
    // A column with a model labels a chunk that names none, as PGLite's `writeCol.embeddingModel || ...` does.
    const unlabeled = { chunk_index: 0, chunk_text: 'Labeled.', chunk_source: 'compiled_truth', embedding: new Float32Array(1536).fill(0.25) } as never;
    await engine.upsertChunks('notes/a', [unlabeled], { embeddingColumn: column({ embeddingModel: 'm:column' }) });
    expect((await engine.getChunks('notes/a', { includeUnsealed: true })).map((c) => [c.chunk_text, c.model])).toEqual([['Labeled.', 'm:column']]);
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
    // An image search column leaves PGLite's active column at `embedding`, so the store answers.
    await engine.setConfig('search_embedding_column', 'embedding_image');
    expect((await engine.getStats()).page_count).toBe(1);
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
    // excludePrivate applies the page policy: a public page keeps its raw data.
    expect((await engine.getRawData('notes/a', undefined, { excludePrivate: true })).map((r) => r.data)).toEqual([row!.data]);
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

  test('keyword date bounds reach the store as the microseconds Postgres reads for each ISO shape', async () => {
    let sent: Record<string, unknown> = {};
    const brain = { searchKeywordPages: async (_query: string, options: Record<string, unknown>) => { sent = options; return []; } };
    const search = STORE_MEMBERS.searchKeywordPages as (brain: unknown, query: string, opts: unknown, page: unknown) => Promise<unknown>;
    const micros = async (afterDate: string) => {
      await search(brain, 'nebula', { afterDate }, { limit: 1 });
      return (sent.afterDate as { micros: string }).micros;
    };
    const at = (iso: string, extra: number) => (BigInt(Date.parse(iso)) * 1000n + BigInt(extra)).toString();
    // Each expected value is what `SET TimeZone='UTC'; SELECT $1::text::timestamptz` returns on Postgres 17.
    expect({
      sixDigits: await micros('2026-01-05T10:00:00.123456Z'),
      roundsDown: await micros('2026-01-05T10:00:00.1234565Z'),
      roundsUp: await micros('2026-01-05T10:00:00.1234575Z'),
      tieToEvenZero: await micros('2026-01-05T10:00:00.0000005Z'),
      tieToEvenTwo: await micros('2026-01-05T10:00:00.0000025Z'),
      tieToEvenFour: await micros('2026-01-05T10:00:00.0000035Z'),
      carry: await micros('2026-12-31T23:59:59.9999999Z'),
      nineDigitsOffset: await micros('2026-01-05 10:00:00.123456789+05:30'),
      lowercase: await micros('2026-01-05t10:00:00.123456789z'),
      midnight: await micros('2026-05-10T24:00:00.0000005Z'),
    }).toEqual({
      sixDigits: at('2026-01-05T10:00:00Z', 123456),
      roundsDown: at('2026-01-05T10:00:00Z', 123456),
      roundsUp: at('2026-01-05T10:00:00Z', 123458),
      tieToEvenZero: at('2026-01-05T10:00:00Z', 0),
      tieToEvenTwo: at('2026-01-05T10:00:00Z', 2),
      tieToEvenFour: at('2026-01-05T10:00:00Z', 4),
      carry: at('2027-01-01T00:00:00Z', 0),
      nineDigitsOffset: at('2026-01-05T04:30:00Z', 123457),
      lowercase: at('2026-01-05T10:00:00Z', 123457),
      midnight: at('2026-05-11T00:00:00Z', 0),
    });
    // 24:00:00.0000006 rounds to one microsecond past midnight, which Postgres rejects as out of range.
    expect(await micros('2026-05-10T24:00:00.0000006Z').catch((e: unknown) => (e as { code?: string }).code)).toBe('engine_capability_missing');
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

  test('countLabelFacts reads the label line into its literal labels, caps the store count, and refuses any other pattern', async () => {
    const line = (alts: string) => `(^|\\n)\\*\\*(${alts})[[:space:]]*:\\*\\*`;
    const labels = labelsOf(line(METADATA_LABELS.join('|')))!;
    expect(labels).toContain('organiser');
    expect(labels).toContain('organizer');
    expect(labels).toContain('action item');
    expect(labels).toContain('action items');
    expect(labels).not.toContain('dates');
    expect(labelsOf(line('Date|Time'))).toEqual(['date', 'time']);
    for (const bad of ['Date|', 'Dat.', 'Da+te', '[^a]te', 'd??', '(date)', 'déjà', 'x\\y']) expect(labelsOf(line(bad))).toBeNull();
    expect(labelsOf(`(^|\\n)\\*\\*(Date):\\*\\*`)).toBeNull();
    const sent: unknown[] = [];
    const brain = { countLabelFacts: async (q: unknown) => { sent.push(q); return 3; } };
    const count = STORE_MEMBERS.countLabelFacts as unknown as (brain: unknown, sourceIds: string[], cap: number, args: Record<string, string>) => Promise<unknown>;
    const args = { segmentSource: 's', contextLike: '%seg 1%', labelLine: line('Date'), terminalSource: 't', nonExtractableSource: 'n' };
    expect(await count(brain, ['default'], 2, args)).toEqual({ count: 2, capped: true });
    expect(await count(brain, ['default'], 3, args)).toEqual({ count: 3, capped: false });
    expect(sent[0]).toEqual({ sourceIds: ['default'], limit: 3, segmentSource: 's', contextContains: 'seg 1', labels: ['date'], terminalSource: 't', nonExtractableSource: 'n' });
    const code = async (run: () => Promise<unknown>) => { try { await run(); return 'ran'; } catch (e) { return (e as { code?: string }).code; } };
    expect(await code(() => count(brain, ['default'], 1.5, args))).toBe('engine_capability_missing');
    expect(await code(() => count(brain, ['default'], -2, args))).toBe('engine_capability_missing');
    expect(await code(() => count(brain, ['default'], 2, { ...args, labelLine: line('Da.e') }))).toBe('engine_capability_missing');
    for (const contextLike of ['seg%', '%se_g%', '%a%b%', '%a\\b%']) expect(await code(() => count(brain, ['default'], 2, { ...args, contextLike }))).toBe('engine_capability_missing');
    expect(sent).toHaveLength(2);
  });

  test('countPurgedPageFacts sends LIMIT cap + 1, counts the first cap rows by class, and refuses a cap that is not an integer', async () => {
    const sent: unknown[] = [];
    const brain = { countPurgedPageFacts: async (q: unknown) => { sent.push(q); return [true, false, true]; } };
    const count = STORE_MEMBERS.countPurgedPageFacts as unknown as (brain: unknown, sourceIds: string[], cap: number) => Promise<unknown>;
    expect(await count(brain, ['default'], 2)).toEqual({ evidenced: 1, ambiguous: 1, capped: true });
    expect(await count(brain, ['default'], 3)).toEqual({ evidenced: 2, ambiguous: 1, capped: false });
    expect(sent[0]).toEqual({ sourceIds: ['default'], limit: 3 });
    const code = async (run: () => Promise<unknown>) => { try { await run(); return 'ran'; } catch (e) { return (e as { code?: string }).code; } };
    expect(await code(() => count(brain, ['default'], 1.5))).toBe('engine_capability_missing');
    expect(await code(() => count(brain, ['default'], -2))).toBe('engine_capability_missing');
    expect(sent).toHaveLength(2);
  });
});

// MCP dispatch decides the caller's access before any work (access/caller.ts). On a Rust brain every read it makes must
// be a typed member: a raw read the engine refuses is swallowed as "permits nothing" and reads as a false refusal.
describe('MCP dispatch caller access on a Rust brain', () => {
  const stdio = (header?: string) => ({ remote: true, transport: 'stdio', sourceId: 'default', ...(header ? { onBehalfOf: { header } } : {}) }) as never;
  const dispatch = async (engine: RustEngine, op: string, opts: never) => {
    const out = await dispatchToolCall(engine as never, op, {}, opts);
    const text = out.content.map(c => c.text).join('\n');
    let code: unknown;
    try { code = (JSON.parse(text) as { code?: unknown }).code; } catch { /* a result, not an error */ }
    return { isError: out.isError === true, code };
  };

  withAddon('a stdio audience its config mcp.stdio_may_act_for lists passes caller access, and one it does not list is refused', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    await engine.setConfig('mcp.stdio_may_act_for', 'guest');
    expect(await dispatch(engine, 'get_stats', stdio('guest'))).toEqual({ isError: false, code: undefined });
    expect(await dispatch(engine, 'whoami', stdio('guest'))).toEqual({ isError: false, code: undefined });
    // Leak case: the list bounds the audience on Rust as on PGLite; an unlisted entry reads nothing.
    await engine.setConfig('mcp.stdio_may_act_for', 'member:alice-example');
    expect(await dispatch(engine, 'get_stats', stdio('guest'))).toEqual({ isError: true, code: 'on_behalf_of_not_permitted' });
    await engine.unsetConfig('mcp.stdio_may_act_for');
    expect(await dispatch(engine, 'get_stats', stdio('guest'))).toEqual({ isError: true, code: 'on_behalf_of_not_permitted' });
    expect(await dispatch(engine, 'get_stats', stdio())).toEqual({ isError: false, code: undefined });
  });

  withAddon('an audience of members and groups is checked with no raw read: the store has none, so each entry is unknown', async () => {
    const { engine } = await open();
    await engine.putPage('notes/a', page);
    await engine.setConfig('mcp.stdio_may_act_for', 'member:alice-example,group:team-a');
    const raw: string[] = [];
    const executeRaw = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: typeof executeRaw }).executeRaw = (async (sql: string, params?: unknown[]) => {
      raw.push(sql);
      return executeRaw(sql as never, params as never);
    }) as typeof executeRaw;
    for (const header of ['member:alice-example', 'group:team-a']) {
      expect(await dispatch(engine, 'get_stats', stdio(header))).toEqual({ isError: true, code: 'on_behalf_of_unknown_member' });
    }
    expect(raw).toEqual([]);
  });
});

// `gbrain access member add|list` and `access owner set` read members first (access/members.ts getMember, listMembers).
// On a Rust brain that read is a typed member, so it answers "no members" instead of stopping on raw SQL.
describe('access member reads on a Rust brain', () => {
  withAddon('getMember, memberByEmail and listMembers read no raw SQL and find no member: the store keeps none', async () => {
    const { engine } = await open();
    const raw: string[] = [];
    const executeRaw = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: typeof executeRaw }).executeRaw = (async (sql: string, params?: unknown[]) => {
      raw.push(sql);
      return executeRaw(sql as never, params as never);
    }) as typeof executeRaw;
    expect(await getMember(engine as never, 'alice-example')).toBeNull();
    expect(await listMembers(engine as never)).toEqual([]);
    expect(await listMembers(engine as never, { includeRemoved: true })).toEqual([]);
    expect(await code(() => memberByEmail(engine as never, 'alice@example.com'))).toBe('not_found');
    expect(raw).toEqual([]);
  });

  withAddon('legacyTokenByName and boundCredentials read no raw SQL and find no credential: the store keeps no tokens or clients', async () => {
    const { engine } = await open();
    const raw: string[] = [];
    const executeRaw = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: typeof executeRaw }).executeRaw = (async (sql: string, params?: unknown[]) => {
      raw.push(sql);
      return executeRaw(sql as never, params as never);
    }) as typeof executeRaw;
    expect(await code(() => legacyTokenByName(engine as never, 'laptop'))).toBe('invalid_params');
    expect(await boundCredentials(engine as never, 'alice-example')).toEqual([]);
    expect(raw).toEqual([]);
  });

  withAddon('audienceMemberIds reads no raw SQL and finds no audience member: the store keeps none', async () => {
    const { engine } = await open();
    const raw: string[] = [];
    const executeRaw = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: typeof executeRaw }).executeRaw = (async (sql: string, params?: unknown[]) => {
      raw.push(sql);
      return executeRaw(sql as never, params as never);
    }) as typeof executeRaw;
    const listed: string[][] = [];
    const list = engine.listAudienceAccessMembers.bind(engine);
    (engine as unknown as { listAudienceAccessMembers: typeof list }).listAudienceAccessMembers = async () => { const ids = await list(); listed.push(ids); return ids; };
    expect(await audienceMemberIds(engine as never)).toEqual([]);
    expect({ raw, listed }).toEqual({ raw: [], listed: [[]] });
  });

  withAddon('memberIdentityFor and stdioMemberIdentity read no raw SQL and find an empty identity: the store keeps no members', async () => {
    const { engine } = await open();
    const raw: string[] = [];
    const executeRaw = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: typeof executeRaw }).executeRaw = (async (sql: string, params?: unknown[]) => {
      raw.push(sql);
      return executeRaw(sql as never, params as never);
    }) as typeof executeRaw;
    const read: unknown[][] = [];
    const live = engine.readLiveMember.bind(engine);
    (engine as unknown as { readLiveMember: typeof live }).readLiveMember = async (via, key) => { read.push([via, key, await live(via, key)]); return live(via, key); };
    const identities = {
      token: await memberIdentityFor(engine as never, { principal: { kind: 'legacy_token', id: '00000000-0000-4000-8000-0000000000c1' } }),
      client: await memberIdentityFor(engine as never, { principal: { kind: 'oauth_client', id: 'client-alice' } }),
      stdioConfig: await memberIdentityFor(engine as never, { principal: { kind: 'local_stdio', id: 'stdio' } }),
      stdioMember: await stdioMemberIdentity(engine as never, 'alice-example'),
    };
    expect(identities).toEqual({ token: [], client: [], stdioConfig: [], stdioMember: [] });
    expect({ raw, read }).toEqual({
      raw: [],
      read: [['legacy_token', '00000000-0000-4000-8000-0000000000c1', null], ['oauth_client', 'client-alice', null],
        ['stdio_config', 'mcp.stdio_member', null], ['member', 'alice-example', null]],
    });
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
