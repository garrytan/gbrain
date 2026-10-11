/**
 * #5431 (W14 P1.8): a sync rename whose destination slug is already occupied.
 * Before, `updateSlug`'s unique violation was swallowed and the rename fell
 * back to import + soft-delete: the page's identity (versions, timeline,
 * edges, aliases, withdrawals) stayed on the soft-deleted row, a tombstone at
 * the destination was revived under a foreign id, and the stale `source_path`
 * exposed the live renamed page to the full-sync purge.
 *
 * Now the unique violation is classified. A tombstone destination is merged
 * in one maintenance transaction: the tombstone is re-keyed purge-style
 * (`<slug>~purged-<id>`, history retained, never hard-deleted) and the page
 * moves with its id; `source_path` is repaired in the same transaction. Any
 * other error fails the file without advancing the checkpoint. When the
 * rename still has to fall back to add semantics, `movePageIdReferences`
 * carries the page-id-keyed rows to the row that materialized, deduplicating
 * on the links composite key, before the stale row is soft-deleted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { movePageIdReferences } from '../src/core/page-state/rename-alias.ts';
import { maintenanceTransaction } from '../src/core/persistence/attribution.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-rename-collision-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const person = (title: string, body: string, aliases: string[] = []) => `---\ntype: person\ntitle: ${title}\n${aliases.length ? `aliases: [${aliases.join(', ')}]\n` : ''}---\n\n${body}\n`;

for (const kind of backends) describe(`sync rename onto an occupied slug (${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); });

  async function fixture(run: (f: { source: string; root: string; sync: (opts?: Record<string, unknown>) => Promise<any> }) => Promise<void>) {
    const source = `rc-${randomUUID().replace(/-/g, '').slice(0, 12)}`, root = join(home, source);
    mkdirSync(join(root, 'people'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.email', 'example@example.invalid'); git(root, 'config', 'user.name', 'Example');
    writeFileSync(join(root, 'people', 'alice.md'), person('Alice', 'Alice is a person who [[people/carol]] knows.', ['Ali']));
    writeFileSync(join(root, 'people', 'carol.md'), person('Carol', 'Carol is a person.'));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'initial');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [source, root]);
    const sync = (opts: Record<string, unknown> = {}) => performSync(engine, { repoPath: root, sourceId: source, noPull: true, noEmbed: true, noExtract: true, ...opts });
    await withEnv(env, async () => { await sync(); await run({ source, root, sync }); });
  }
  const page = async (source: string, slug: string) => (await engine.executeRaw<{ id: number; deleted_at: string | null; source_path: string | null; compiled_truth: string }>(
    'SELECT id, deleted_at, source_path, compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [source, slug]))[0];
  const count = async (sql: string, params: unknown[]) => Number((await engine.executeRaw<{ n: number | string }>(sql, params))[0].n);

  /** Versions, timeline, a fact withdrawal and edges on a page: the identity a rename must carry (its declared alias comes from the file's frontmatter). */
  async function decorate(source: string, id: number, slug: string, peer: number) {
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash) VALUES($1, 'private', $2, 'deadbeef') ON CONFLICT DO NOTHING", [source, slug]);
    await engine.executeRaw("INSERT INTO page_versions(page_id, compiled_truth, frontmatter) VALUES($1, 'older text', '{}'::jsonb)", [id]);
    await engine.executeRaw("INSERT INTO timeline_entries(page_id, date, source, summary) VALUES($1, '2024-01-02', 'test', $2)", [id, `${slug} met someone`]);
    await engine.executeRaw("INSERT INTO links(from_page_id, to_page_id, link_type, link_source) VALUES($1, $2, 'knows', 'test') ON CONFLICT DO NOTHING", [id, peer]);
    await engine.executeRaw("INSERT INTO links(from_page_id, to_page_id, link_type, link_source) VALUES($2, $1, 'knows', 'test') ON CONFLICT DO NOTHING", [id, peer]);
    await engine.executeRaw("INSERT INTO links(from_page_id, to_page_id, link_type, link_source, origin_page_id) VALUES($2, $2, 'self', 'test', $1) ON CONFLICT DO NOTHING", [id, peer]);
  }
  const identity = async (id: number) => ({
    versions: await count('SELECT count(*) AS n FROM page_versions WHERE page_id=$1', [id]),
    timeline: await count('SELECT count(*) AS n FROM timeline_entries WHERE page_id=$1', [id]),
    outbound: await count('SELECT count(*) AS n FROM links WHERE from_page_id=$1', [id]),
    inbound: await count('SELECT count(*) AS n FROM links WHERE to_page_id=$1', [id]),
    origin: await count('SELECT count(*) AS n FROM links WHERE origin_page_id=$1', [id]),
  });

  test('tombstone destination: merged in one transaction, tombstone re-keyed with its history, identity and source_path move with the page', () => fixture(async f => {
    const alice = await page(f.source, 'people/alice'), carol = await page(f.source, 'people/carol');
    await decorate(f.source, alice.id, 'people/alice', carol.id);
    await engine.putPage('people/bob', { type: 'person', title: 'Bob (old)', compiled_truth: 'an earlier bob' }, { sourceId: f.source });
    const bob = await page(f.source, 'people/bob');
    await engine.executeRaw("INSERT INTO page_versions(page_id, compiled_truth, frontmatter) VALUES($1, 'bob v1', '{}'::jsonb)", [bob.id]);
    await engine.executeRaw("INSERT INTO links(from_page_id, to_page_id, link_type, link_source) VALUES($1, $2, 'knows', 'test')", [bob.id, carol.id]);
    await engine.softDeletePages(['people/bob'], { sourceId: f.source });
    const before = await identity(alice.id);

    renameSync(join(f.root, 'people', 'alice.md'), join(f.root, 'people', 'bob.md'));
    git(f.root, 'add', '-A'); git(f.root, 'commit', '-qm', 'rename alice to bob');
    const result = await f.sync();
    expect(result.status).toBe('synced');

    const moved = await page(f.source, 'people/bob');
    expect(moved.id).toBe(alice.id);
    expect(moved.deleted_at).toBeNull();
    expect(moved.source_path).toBe('people/bob.md');
    expect(moved.compiled_truth).toContain('Alice is a person');
    expect(await page(f.source, 'people/alice')).toBeUndefined();
    const { versions, ...after } = await identity(alice.id);
    const { versions: versionsBefore, ...rest } = before;
    expect(after).toEqual(rest);
    expect(versions >= versionsBefore).toBe(true);
    expect(await engine.executeRaw('SELECT slug FROM page_aliases WHERE source_id=$1 AND alias_norm=$2', [f.source, 'ali'])).toEqual([{ slug: 'people/bob' }]);
    expect(await engine.executeRaw('SELECT subject FROM fact_withdrawals WHERE source_id=$1', [f.source])).toEqual([{ subject: 'people/bob' }]);
    expect(await count("SELECT count(*) AS n FROM slug_aliases WHERE source_id=$1 AND alias_slug='people/alice' AND canonical_slug='people/bob'", [f.source])).toBe(1);

    const tombstone = await page(f.source, `people/bob~purged-${bob.id}`);
    expect(tombstone.id).toBe(bob.id);
    expect(tombstone.deleted_at).not.toBeNull();
    expect(await count('SELECT count(*) AS n FROM page_versions WHERE page_id=$1', [bob.id])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM links WHERE from_page_id=$1', [bob.id])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.source])).toBe(2);

    // The full-sync purge must not read the renamed page as a removed file.
    const full = await f.sync({ full: true });
    expect(['synced', 'first_sync']).toContain(full.status);
    expect((await page(f.source, 'people/bob')).deleted_at).toBeNull();
    expect(await count('SELECT count(*) AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.source])).toBe(2);
  }), 120_000);

  test('live destination: the add fallback carries the stale row\'s identity onto the destination row before soft-deleting it', () => fixture(async f => {
    const alice = await page(f.source, 'people/alice'), carol = await page(f.source, 'people/carol');
    await decorate(f.source, alice.id, 'people/alice', carol.id);
    await engine.putPage('people/bob', { type: 'person', title: 'Bob (live)', compiled_truth: 'a live bob' }, { sourceId: f.source });
    const bob = await page(f.source, 'people/bob');
    await engine.executeRaw("INSERT INTO links(from_page_id, to_page_id, link_type, link_source) VALUES($1, $2, 'knows', 'test')", [bob.id, carol.id]);
    const before = await identity(alice.id);

    renameSync(join(f.root, 'people', 'alice.md'), join(f.root, 'people', 'bob.md'));
    git(f.root, 'add', '-A'); git(f.root, 'commit', '-qm', 'rename alice onto a live bob');
    const result = await f.sync();
    expect(result.status).toBe('synced');

    const moved = await page(f.source, 'people/bob');
    expect(moved.id).toBe(bob.id);
    expect(moved.compiled_truth).toContain('Alice is a person');
    expect((await page(f.source, 'people/alice')).deleted_at).not.toBeNull();
    expect(await identity(alice.id)).toEqual({ versions: 0, timeline: 0, outbound: 0, inbound: 0, origin: 0 });
    const after = await identity(bob.id);
    expect(after.timeline).toBe(before.timeline);
    expect(after.outbound).toBe(before.outbound);
    expect(after.inbound).toBe(before.inbound);
    expect(after.origin).toBe(before.origin);
    expect(after.versions >= before.versions).toBe(true);
    expect(await engine.executeRaw('SELECT slug FROM page_aliases WHERE source_id=$1 AND alias_norm=$2', [f.source, 'ali'])).toEqual([{ slug: 'people/bob' }]);
    expect(await engine.executeRaw('SELECT subject FROM fact_withdrawals WHERE source_id=$1', [f.source])).toEqual([{ subject: 'people/bob' }]);
    expect(await engine.executeRaw('SELECT canonical_slug FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2', [f.source, 'people/alice'])).toEqual([{ canonical_slug: 'people/bob' }]);
  }), 120_000);

  test('another SQLSTATE on the rename fails the file and leaves the checkpoint where it was', () => fixture(async f => {
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_test_refuse_slug() RETURNS trigger AS $$
      BEGIN IF NEW.slug = 'people/boom' THEN RAISE EXCEPTION 'injected rename failure' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await engine.executeRaw('CREATE TRIGGER gbrain_test_refuse_slug BEFORE UPDATE OF slug ON pages FOR EACH ROW EXECUTE FUNCTION gbrain_test_refuse_slug()');
    try {
      const anchor = (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.source]))[0].last_commit;
      renameSync(join(f.root, 'people', 'alice.md'), join(f.root, 'people', 'boom.md'));
      git(f.root, 'add', '-A'); git(f.root, 'commit', '-qm', 'rename alice to boom');
      const result = await f.sync();
      expect(result.status).toBe('blocked_by_failures');
      expect(result.failedFiles).toBe(1);
      expect((await page(f.source, 'people/alice')).deleted_at).toBeNull();
      expect(await page(f.source, 'people/boom')).toBeUndefined();
      expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.source]))[0].last_commit).toBe(anchor);
    } finally {
      await engine.executeRaw('DROP TRIGGER IF EXISTS gbrain_test_refuse_slug ON pages');
      await engine.executeRaw('DROP FUNCTION IF EXISTS gbrain_test_refuse_slug()');
    }
    const result = await f.sync();
    expect(result.status).toBe('synced');
    expect((await page(f.source, 'people/boom')).compiled_truth).toContain('Alice is a person');
  }), 120_000);

  test('movePageIdReferences carries edges, timeline and versions to the surviving row and deduplicates on the links key', () => fixture(async f => {
    const alice = await page(f.source, 'people/alice'), carol = await page(f.source, 'people/carol');
    await engine.putPage('people/dup', { type: 'person', title: 'Dup', compiled_truth: 'the surviving row' }, { sourceId: f.source });
    const dup = await page(f.source, 'people/dup');
    await decorate(f.source, alice.id, 'people/alice', carol.id);
    await engine.executeRaw("INSERT INTO links(from_page_id, to_page_id, link_type, link_source) VALUES($1, $2, 'knows', 'test')", [dup.id, carol.id]);
    await engine.executeRaw("INSERT INTO timeline_entries(page_id, date, source, summary) VALUES($1, '2024-01-02', 'test', 'people/alice met someone')", [dup.id]);
    const total = await count('SELECT count(*) AS n FROM links', []);
    const from = await identity(alice.id), to = await identity(dup.id);

    await maintenanceTransaction(engine, tx => movePageIdReferences(tx, alice.id, dup.id));

    expect(await identity(alice.id)).toEqual({ versions: 0, timeline: 0, outbound: 0, inbound: 0, origin: 0 });
    const after = await identity(dup.id);
    expect(after.versions).toBe(from.versions + to.versions);
    expect(after.timeline).toBe(from.timeline + to.timeline - 1);
    expect(after.outbound).toBe(from.outbound + to.outbound - 1);
    expect(after.inbound).toBe(from.inbound + to.inbound);
    expect(after.origin).toBe(from.origin + to.origin);
    expect(await count('SELECT count(*) AS n FROM links', [])).toBe(total - 1);
    expect(await count('SELECT count(*) AS n FROM links WHERE from_page_id=$1 AND to_page_id=$2 AND link_type=$3', [dup.id, carol.id, 'knows'])).toBe(1);
  }), 120_000);
});
