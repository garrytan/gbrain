/**
 * #6712 PR 0: managed-sync import provenance (`sync-import-provenance` in op_checkpoints) records what the publish
 * left on disk and what it produced: `disk_sha256` and `disk_blob_oid` (the canonical writeback when the publish wrote
 * one, else the file's bytes), `revision` (the page revision of that publish) and `parser` (import parser version, Markdown
 * chunker, schema pack; never the release, so it holds across upgrades that change no parsing). Nothing reads them yet; a later content-addressed resume compares them with `git ls-tree`.
 *
 * Protects: the fields are written, in the publish transaction, for a plain import, an update, a canonical writeback
 * (the written-back file, not the input) and a file whose disk bytes differ from the pinned blob only by line endings;
 * a record without them (older releases, repairs) is read and replaced by the next publish of the page.
 * Regression it catches: a record that hashes the pinned input instead of the bytes on disk, or omits the revision.
 * #6712 PR 1: code and image pages record the same fields (their parser names the code chunker or the image importer),
 * so the discovery prescreen can match them. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncImportProvenance, SYNC_IMPORT_PARSER_VERSION, SYNC_IMPORT_PROVENANCE_OP, syncImportParserFor } from '../src/core/persistence/sync-holds.ts';
import { chunkerStamp } from '../src/core/chunkers/code.ts';
import { loadActivePackForEngine } from '../src/core/schema-pack/engine-resolution.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-provenance-disk-'));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;
// A facts fence with a fixable kind (`partnership` maps to `fact`): the import rewrites the file canonically.
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const fixable = `---\ntitle: Fixable\n---\nA synthetic page.\n\n${FB}\n${FH}\n| 1 | Acme-example partners with an example vendor | partnership | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n${FBE}\n`;

describe('managed-sync import provenance records the bytes on disk, the revision and the parser', () => {
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
    await closePostgres?.(); rmSync(home, { recursive: true, force: true });
  });
  const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
    async () => { for (const engine of engines) await fn(engine); });

  async function fixture(engine: BrainEngine, files: Record<string, string | Buffer>, config: Record<string, string> = {}) {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const id = `prov-${randomUUID().slice(0, 12)}`, root = join(home, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
    for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
    const head = commit(root, 'seed');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, JSON.stringify(config)]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
    return { id, root, head, incarnation, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function provenanceOf(engine: BrainEngine, f: Fixture, slug: string) {
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
    return { snapshot, record: (await readSyncImportProvenance(engine, f.id, f.incarnation, Number(snapshot.page.id)))! };
  }
  /** What the record must say about `path` as it is on disk now. */
  async function expectDisk(engine: BrainEngine, f: Fixture, slug: string, path: string) {
    const { snapshot, record } = await provenanceOf(engine, f, slug);
    const disk = readFileSync(join(f.root, path));
    const pack = await loadActivePackForEngine(engine, { remote: false, sourceId: f.id }).catch(() => null);
    expect(record).toMatchObject({ origin: path, disk_sha256: sha256(disk), disk_blob_oid: git(f.root, 'hash-object', '--no-filters', path), revision: snapshot.revision,
      parser: { parser_version: SYNC_IMPORT_PARSER_VERSION, markdown_chunker: MARKDOWN_CHUNKER_VERSION, schema_pack: pack?.identity ?? null } });
    expect(record.parser).not.toHaveProperty('gbrain_version');
    return record;
  }

  test('a plain import and its update record the file bytes, its blob id and each publish revision', async () => each(async engine => {
    const f = await fixture(engine, { 'notes/plain.md': note('A first synthetic observation.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    const first = await expectDisk(engine, f, 'notes/plain', 'notes/plain.md');
    expect(first.disk_sha256).toBe(first.raw_sha256);
    expect(first.disk_blob_oid).toBe(git(f.root, 'rev-parse', 'HEAD:notes/plain.md'));
    writeFileSync(join(f.root, 'notes/plain.md'), note('A second synthetic observation.')); commit(f.root, 'update');
    expect((await performManagedSync(engine, f.opts)).status).toBe('synced');
    const second = await expectDisk(engine, f, 'notes/plain', 'notes/plain.md');
    expect(second.revision).not.toBe(first.revision);
    expect(second.disk_sha256).not.toBe(first.disk_sha256);
  }), 120_000);

  test('a canonical writeback records the written-back file, not the input it imported', async () => each(async engine => {
    const f = await fixture(engine, { 'people/fixable.md': fixable });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    const written = readFileSync(join(f.root, 'people/fixable.md'), 'utf8');
    expect(written).not.toBe(fixable); expect(written).toContain('| fact |');
    const record = await expectDisk(engine, f, 'people/fixable', 'people/fixable.md');
    expect(record.raw_sha256).toBe(sha256(fixable));
    expect(record.disk_sha256).not.toBe(record.raw_sha256);
    expect(record.disk_blob_oid).not.toBe(git(f.root, 'rev-parse', 'HEAD:people/fixable.md'));
  }), 120_000);

  test('disk bytes that differ from the pinned blob only by line endings are what the record hashes', async () => each(async engine => {
    const f = await fixture(engine, { 'notes/crlf.md': note('A synthetic observation with line endings.') });
    writeFileSync(join(f.root, 'notes/crlf.md'), note('A synthetic observation with line endings.').replace(/\n/g, '\r\n'));
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    const record = await expectDisk(engine, f, 'notes/crlf', 'notes/crlf.md');
    expect(record.raw_sha256).toBe(sha256(note('A synthetic observation with line endings.')));
    expect(record.disk_sha256).not.toBe(record.raw_sha256);
  }), 120_000);

  test.each([['batched'], ['per-entry']] as const)('a %s no-op waiver records the provenance in its waiver transaction without a new revision', async mode => withEnv({ GBRAIN_SYNC_WAIVE_BATCH: mode === 'batched' ? undefined : '0' }, () => each(async engine => {
    const f = await fixture(engine, { 'notes/one.md': note('A first unchanged observation.'), 'notes/two.md': note('A second unchanged observation.'), 'people/fixable.md': fixable });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    commit(f.root, 'commit the canonical writeback');
    const before = new Map<string, string>();
    for (const slug of ['notes/one', 'notes/two', 'people/fixable']) {
      const { snapshot } = await provenanceOf(engine, f, slug);
      before.set(slug, snapshot.revision);
      // A page an older release imported (or whose record was lost) has no provenance.
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [SYNC_IMPORT_PROVENANCE_OP, `${f.id}:${f.incarnation}:${snapshot.page.id}`]);
    }
    const full = await performManagedSync(engine, { ...f.opts, full: true });
    expect(full).toMatchObject({ status: 'synced', waived: { imports: 3, deletes: 0 } });
    for (const [slug, path] of [['notes/one', 'notes/one.md'], ['notes/two', 'notes/two.md'], ['people/fixable', 'people/fixable.md']] as const) {
      const record = await expectDisk(engine, f, slug, path);
      expect(record.revision).toBe(before.get(slug)!);
      expect(record.disk_sha256).toBe(record.raw_sha256);
    }
  })), 120_000);

  test('#6712 PR 1: a code page and an image page record the file bytes, the revision and their own parser', async () => withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBEDDING_IMAGE_OCR: 'false' }, () => each(async engine => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const f = await fixture(engine, { 'src/example.ts': 'export const example = 1;\n', 'notes/photo.png': png, 'notes/plain.md': note('A synthetic note beside code.') }, { strategy: 'auto' });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    for (const [path, parser] of [['src/example.ts', `code=1;chunker=${chunkerStamp()}`], ['notes/photo.png', 'image=1']] as const) {
      const [{ slug }] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND source_path=$2', [f.id, path]);
      const { snapshot, record } = await provenanceOf(engine, f, slug);
      const disk = readFileSync(join(f.root, path));
      expect(record).toMatchObject({ origin: path, disk_sha256: sha256(disk), disk_blob_oid: git(f.root, 'rev-parse', `HEAD:${path}`), revision: snapshot.revision,
        parser: { parser_version: parser, markdown_chunker: MARKDOWN_CHUNKER_VERSION, schema_pack: null } });
      expect(record.parser).toEqual(syncImportParserFor(path, null));
    }
  })), 120_000);

  test('a record without the fields is read as it is, and the next publish of the page stamps them', async () => each(async engine => {
    const f = await fixture(engine, { 'notes/legacy.md': note('A synthetic observation an older release imported.') });
    expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
    const { snapshot, record } = await provenanceOf(engine, f, 'notes/legacy');
    const { disk_sha256: _a, disk_blob_oid: _b, revision: _c, parser: _d, ...legacy } = record;
    await engine.executeRaw('UPDATE op_checkpoints SET completed_keys=$3::text::jsonb WHERE op=$1 AND fingerprint=$2',
      [SYNC_IMPORT_PROVENANCE_OP, `${f.id}:${f.incarnation}:${snapshot.page.id}`, JSON.stringify([legacy])]);
    const read = await readSyncImportProvenance(engine, f.id, f.incarnation, Number(snapshot.page.id));
    expect(read).toMatchObject({ raw_sha256: record.raw_sha256 });
    expect(read).not.toHaveProperty('disk_sha256'); expect(read).not.toHaveProperty('revision');
    writeFileSync(join(f.root, 'notes/legacy.md'), note('A synthetic observation this release imported.')); commit(f.root, 'update');
    expect((await performManagedSync(engine, f.opts)).status).toBe('synced');
    await expectDisk(engine, f, 'notes/legacy', 'notes/legacy.md');
  }), 120_000);
});
