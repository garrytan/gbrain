/**
 * A page's attachments follow it when it is renamed.
 *
 * Authoring gate
 *  1. Protects: `gbrain files list` / `file_list` find attachments by `files.page_slug`. Every rename (a sync Git
 *     rename and `gbrain repair rename-identity` both move the page through `updateSlug`) must move the page's
 *     attachments to its new slug, and a one-time backfill must move attachments a past rename left behind.
 *  2. Fails when: a rename leaves `files.page_slug` on the old slug for a row bound to the page (`page_id`), or the
 *     backfill skips such a row, or touches a row that names no page.
 *  3. Why new: no test renames a page that has an attachment.
 *  4. Seams: real renames (sync of a Git move, the rename-identity repair, `updateSlug`) on PGLite and Postgres; the
 *     backfill migration's handler run directly against rows written stale on purpose.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { noteDoc, ROWS } from './helpers/hold-page-id-fixture.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const write = (root: string, path: string, body: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); };
const note = (title: string, extra = '') => `---\ntype: note\ntitle: ${title}\n---\n\n${title} body.\n${extra}`;

for (const backend of testBackends()) {
  describe(`attachments follow a renamed page (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void> = async () => {};
    const home = mkdtempSync(join(tmpdir(), 'gbrain-rename-files-'));
    const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_INTERACTIVE: '0', CI: '1' };
    beforeAll(async () => {
      if (backend === 'postgres') { const db = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = db.engine; close = db.close; }
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 180_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close(); rmSync(home, { recursive: true, force: true }); });
    beforeEach(() => _resetCliExitVerdictForTests());

    const pageId = async (sourceId: string, slug: string) => Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]?.id);
    const attach = (sourceId: string, slug: string, id: number | null, name: string) => engine.executeRaw(
      `INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, content_hash) VALUES ($1, $2, $3, $4, $5, 'h')`,
      [sourceId, slug, id, name, `${sourceId}/${name}-${randomUUID()}`]);
    const fileSlugs = async (sourceId: string) => (await engine.executeRaw<{ filename: string; page_slug: string }>(
      'SELECT filename, page_slug FROM files WHERE source_id=$1 ORDER BY filename', [sourceId])).map(r => [r.filename, r.page_slug]);

    async function gitSource(files: Record<string, string>, sourceId?: string) {
      const id = sourceId ?? `c${randomUUID().replace(/-/g, '').slice(0, 14)}`, root = join(home, id);
      mkdirSync(root, { recursive: true }); git(root, 'init', '-q', '-b', 'main');
      for (const [path, body] of Object.entries(files)) write(root, path, body);
      commit(root, 'initial');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      if (sourceId) await engine.executeRaw('UPDATE sources SET local_path = $2 WHERE id = $1', [id, root]);
      else await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
      const sync = () => performSync(engine, { repoPath: root, sourceId: id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
      await sync();
      return { id, root, sync };
    }

    test('a sync Git rename moves the page\'s attachments to the new slug; one that names it only by slug, and another page\'s, stay', () => withEnv(env, async () => {
      const s = await gitSource({ 'notes/plan.md': note('Plan'), 'notes/peer.md': note('Peer') });
      await attach(s.id, 'notes/plan', await pageId(s.id, 'notes/plan'), 'card.png');
      await attach(s.id, 'notes/plan', null, 'loose.png');
      // Bound to another page, it never moves by slug, whatever slug it names.
      await attach(s.id, 'notes/plan', await pageId(s.id, 'notes/peer'), 'peer.png');
      git(s.root, 'mv', 'notes/plan.md', 'notes/roadmap.md'); commit(s.root, 'rename the note');
      expect(await s.sync()).toMatchObject({ status: 'synced', renamed: 1 });
      expect(await fileSlugs(s.id)).toEqual([['card.png', 'notes/roadmap'], ['loose.png', 'notes/plan'], ['peer.png', 'notes/plan']]);
    }), 240_000);

    test('gbrain repair rename-identity moves the carried page\'s attachments to the new slug', () => withEnv(env, async () => {
      const s = await gitSource({ 'notes/plan.md': noteDoc(ROWS), 'notes/peer.md': note('Peer') });
      const old = await pageId(s.id, 'notes/plan');
      await attach(s.id, 'notes/plan', old, 'diagram.png');
      // A move with an edit and no identity signal: sync splits it into a delete plus an add.
      git(s.root, 'mv', 'notes/plan.md', 'notes/roadmap.md'); write(s.root, 'notes/roadmap.md', noteDoc(ROWS, 'An added paragraph.\n'));
      commit(s.root, 'move and edit');
      const split = await s.sync();
      expect(split.identityDowngrades?.map(e => [e.from, e.to])).toEqual([['notes/plan.md', 'notes/roadmap.md']]);
      // An attachment uploaded to the provisional page the split created, before the carry.
      const provisional = await pageId(s.id, 'notes/roadmap');
      await attach(s.id, 'notes/roadmap', provisional, 'sketch.png');
      const { runRepairCommand } = await import('../src/commands/repair.ts');
      const run = async (args: string[]) => {
        let printed = '';
        const log = console.log, out = process.stdout.write;
        console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
        process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
        try { await runRepairCommand(engine, [...args, '--json']); } finally { console.log = log; process.stdout.write = out; }
        return JSON.parse(printed).results[0] as { preview_hash: string; applied?: number };
      };
      const preview = await run(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap']);
      expect(await run(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap', '--apply', '--expect', preview.preview_hash, '--yes'])).toMatchObject({ applied: 1 });
      expect(await pageId(s.id, 'notes/roadmap')).toBe(old);
      expect(await fileSlugs(s.id)).toEqual([['diagram.png', 'notes/roadmap'], ['sketch.png', 'notes/roadmap']]);
      // Both now belong to the surviving page, so a later rename or a purge of the retired row treats them as its own.
      const owners = await engine.executeRaw<{ filename: string; page_id: number }>('SELECT filename, page_id FROM files WHERE source_id=$1 ORDER BY filename', [s.id]);
      expect(owners.map(o => [o.filename, Number(o.page_id)])).toEqual([['diagram.png', old], ['sketch.png', old]]);
    }), 240_000);

    test('a fallback rename (the stale row retired onto the page that materialized) gives the stale row\'s attachments to the surviving page', () => withEnv(env, async () => {
      const id = `f${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [id]);
      for (const slug of ['notes/stale', 'notes/fresh']) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x', timeline: '' }, { sourceId: id });
      const stale = await pageId(id, 'notes/stale'), fresh = await pageId(id, 'notes/fresh');
      await attach(id, 'notes/stale', stale, 'old.png');
      const { carryRenameIdentity } = await import('../src/commands/sync/renames.ts');
      await carryRenameIdentity(engine, id, 'notes/stale', 'notes/fresh');
      const rows = await engine.executeRaw<{ page_slug: string; page_id: number }>('SELECT page_slug, page_id FROM files WHERE source_id=$1', [id]);
      expect(rows.map(r => [r.page_slug, Number(r.page_id)])).toEqual([['notes/fresh', fresh]]);
    }), 60_000);

    test('an attachment uploaded with gbrain files upload --page follows a Git rename of its page', () => withEnv(env, async () => {
      // The CLI upload writes to the default source, so the Git checkout is the default source's.
      const s = await gitSource({ 'notes/cli-plan.md': note('Cli plan'), 'notes/cli-peer.md': note('Cli peer') }, 'default');
      const storageDir = mkdtempSync(join(tmpdir(), 'gbrain-rename-files-storage-'));
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: backend, storage: { backend: 'local', bucket: 'b', localPath: storageDir } }));
      const upload = join(home, 'cli-card.txt');
      writeFileSync(upload, 'card bytes\n');
      const { runFiles } = await import('../src/commands/files.ts');
      const log = console.log; console.log = () => {};
      try { await runFiles(engine, ['upload', upload, '--page', 'notes/cli-plan']); } finally { console.log = log; }
      const [row] = await engine.executeRaw<{ page_id: number | null }>("SELECT page_id FROM files WHERE filename = 'cli-card.txt'");
      expect(row?.page_id === null || row?.page_id === undefined ? null : Number(row.page_id)).toBe(await pageId('default', 'notes/cli-plan'));
      git(s.root, 'mv', 'notes/cli-plan.md', 'notes/cli-roadmap.md'); commit(s.root, 'rename the note');
      expect(await s.sync()).toMatchObject({ status: 'synced', renamed: 1 });
      const { operationsByName } = await import('../src/core/operations.ts');
      const listed = await operationsByName.file_list!.handler({ engine, config: { engine: backend }, remote: false, sourceId: 'default' } as never, { slug: 'notes/cli-roadmap' }) as Array<{ filename: string }>;
      expect(listed.map(f => f.filename)).toEqual(['cli-card.txt']);
      rmSync(join(home, '.gbrain', 'config.json'), { force: true });
      rmSync(storageDir, { recursive: true, force: true });
    }), 240_000);

    test('an attachment that names the page only by slug (no page id) stays where it is after a rename', () => withEnv(env, async () => {
      const id = `n${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [id]);
      await engine.putPage('notes/solo', { type: 'note', title: 'Solo', compiled_truth: 'x', timeline: '' }, { sourceId: id });
      await attach(id, 'notes/solo', null, 'solo.png');
      expect(await engine.updateSlug('notes/solo', 'notes/solo-renamed', { sourceId: id })).toBe(1);
      expect(await fileSlugs(id)).toEqual([['solo.png', 'notes/solo']]);
    }), 60_000);

    test('a slug-only attachment stays when a later page reuses the name after the earlier page and its rename history were deleted', () => withEnv(env, async () => {
      const id = `p${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [id]);
      await engine.putPage('notes/old', { type: 'note', title: 'A', compiled_truth: 'x', timeline: '' }, { sourceId: id });
      expect(await engine.updateSlug('notes/old', 'notes/b', { sourceId: id })).toBe(1);
      await attach(id, 'notes/old', null, 'left.png');
      // Deleting the page at notes/b also scrubs its rename history (scrubPurgedSlugStores deletes by new_slug).
      await engine.deletePages(['notes/b'], { sourceId: id });
      expect(await engine.executeRaw('SELECT 1 FROM slug_rename_history WHERE source_id = $1', [id])).toEqual([]);
      await engine.putPage('notes/old', { type: 'note', title: 'C', compiled_truth: 'y', timeline: '' }, { sourceId: id });
      expect(await engine.updateSlug('notes/old', 'notes/d', { sourceId: id })).toBe(1);
      expect(await fileSlugs(id)).toEqual([['left.png', 'notes/old']]);
    }), 60_000);

    test('a slug-only attachment an earlier rename left behind does not move to an unrelated page that reused the name', () => withEnv(env, async () => {
      const id = `r${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [id]);
      await engine.putPage('notes/old', { type: 'note', title: 'A', compiled_truth: 'x', timeline: '' }, { sourceId: id });
      expect(await engine.updateSlug('notes/old', 'notes/b', { sourceId: id })).toBe(1);
      // Left under the old name by a rename before this fix (the history now records old -> b).
      await attach(id, 'notes/old', null, 'left.png');
      await engine.putPage('notes/old', { type: 'note', title: 'C', compiled_truth: 'y', timeline: '' }, { sourceId: id });
      expect(await engine.updateSlug('notes/old', 'notes/d', { sourceId: id })).toBe(1);
      expect(await fileSlugs(id)).toEqual([['left.png', 'notes/old']]);
    }), 60_000);

    test('re-uploading a CLI attachment onto a page that reused its old name names that page and its slug together', () => withEnv(env, async () => {
      const storageDir = mkdtempSync(join(tmpdir(), 'gbrain-rename-files-storage-'));
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: backend, storage: { backend: 'local', bucket: 'b', localPath: storageDir } }));
      const upload = join(home, 'reuse-card.txt');
      const { runFiles } = await import('../src/commands/files.ts');
      const quiet = async (args: string[]) => { const log = console.log; console.log = () => {}; try { await runFiles(engine, args); } finally { console.log = log; } };
      await engine.putPage('notes/reuse-old', { type: 'note', title: 'First', compiled_truth: 'x', timeline: '' });
      writeFileSync(upload, 'first bytes\n');
      await quiet(['upload', upload, '--page', 'notes/reuse-old']);
      expect(await engine.updateSlug('notes/reuse-old', 'notes/reuse-new', { sourceId: 'default' })).toBe(1);
      await engine.putPage('notes/reuse-old', { type: 'note', title: 'Second', compiled_truth: 'y', timeline: '' });
      writeFileSync(upload, 'second bytes\n');
      await quiet(['upload', upload, '--page', 'notes/reuse-old']);
      const [row] = await engine.executeRaw<{ page_slug: string; page_id: number }>("SELECT page_slug, page_id FROM files WHERE filename = 'reuse-card.txt'");
      expect([row?.page_slug, Number(row?.page_id)]).toEqual(['notes/reuse-old', await pageId('default', 'notes/reuse-old')]);
      rmSync(join(home, '.gbrain', 'config.json'), { force: true });
      rmSync(storageDir, { recursive: true, force: true });
    }), 120_000);

    test('the backfill moves an attachment a past rename left behind, by its page id, and leaves one that names no page', () => withEnv(env, async () => {
      const id = `b${randomUUID().replace(/-/g, '').slice(0, 14)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [id]);
      await engine.putPage('notes/now', { type: 'note', title: 'Now', compiled_truth: 'x', timeline: '' }, { sourceId: id });
      await attach(id, 'notes/then', await pageId(id, 'notes/now'), 'stale.png');
      await attach(id, 'notes/then', null, 'orphan.png');
      // A row bound to a retired (soft-deleted) row keeps the name it is listed under; the retired row is not its owner now.
      await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'x', timeline: '' }, { sourceId: id });
      const gone = await pageId(id, 'notes/gone');
      await engine.executeRaw("UPDATE pages SET slug = 'notes/gone~purged-1', deleted_at = now() WHERE id = $1", [gone]);
      await attach(id, 'notes/now', gone, 'kept.png');
      const backfill = MIGRATIONS.find(m => m.name === 'files_follow_page_slug');
      expect(backfill).toBeDefined();
      await engine.transaction(async tx => {
        const sql = backfill!.sqlFor?.[backend] ?? backfill!.sql;
        if (sql) await tx.executeRaw(sql);
        if (backfill!.handler) await backfill!.handler(tx);
      });
      expect(await fileSlugs(id)).toEqual([['kept.png', 'notes/now'], ['orphan.png', 'notes/then'], ['stale.png', 'notes/now']]);
    }), 60_000);
  });
}

const pgOnly = testBackends().includes('postgres') ? describe : describe.skip;
pgOnly('attachments follow a renamed page: a role row security limits (postgres)', () => {
  const ROLE = `rename_files_role_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  let owner: BrainEngine, scoped: BrainEngine, close: () => Promise<void> = async () => {};
  beforeAll(async () => {
    const db = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    owner = db.engine; close = db.close;
    await owner.executeRaw(`CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.executeRaw(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await owner.executeRaw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
    await owner.executeRaw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
    await owner.executeRaw('ALTER TABLE slug_rename_history ENABLE ROW LEVEL SECURITY');
    // Every row-security table is open to the role, except that the rename history hides the move to notes/b.
    const tables = await owner.executeRaw<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity ORDER BY 1");
    for (const { tablename } of tables) {
      const using = tablename === 'slug_rename_history' ? "new_slug <> 'notes/b'" : 'true';
      await owner.executeRaw(`CREATE POLICY ${ROLE}_open ON ${tablename} FOR ALL TO ${ROLE} USING (${using}) WITH CHECK (true)`);
    }
    await owner.executeRaw(`DO $$ BEGIN EXECUTE format('ALTER ROLE %I IN DATABASE %I SET role TO %L', session_user, current_database(), '${ROLE}'); END $$`);
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    scoped = new PostgresEngine();
    await (scoped as InstanceType<typeof PostgresEngine>).connect({ database_url: db.databaseUrl, poolSize: 2 });
  }, 180_000);
  afterAll(async () => {
    await scoped?.disconnect();
    await owner.executeRaw(`DO $$ BEGIN EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET role', session_user, current_database()); END $$`).catch(() => undefined);
    await owner.executeRaw(`DROP OWNED BY ${ROLE}`).catch(() => undefined);
    await owner.executeRaw(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
    await disposePersistenceConsumer(owner);
    await close();
  });

  test('a rename by a role that cannot see the whole rename history leaves slug-only attachments where they are', async () => {
    await owner.putPage('notes/old', { type: 'note', title: 'A', compiled_truth: 'x', timeline: '' });
    expect(await owner.updateSlug('notes/old', 'notes/b', { sourceId: 'default' })).toBe(1);
    await owner.executeRaw(`INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, content_hash) VALUES ('default', 'notes/old', NULL, 'left.png', 'rls/left.png', 'h')`);
    await owner.putPage('notes/old', { type: 'note', title: 'C', compiled_truth: 'y', timeline: '' });
    expect(await scoped.updateSlug('notes/old', 'notes/d', { sourceId: 'default' })).toBe(1);
    const rows = await owner.executeRaw<{ page_slug: string }>("SELECT page_slug FROM files WHERE storage_path = 'rls/left.png'");
    expect(rows.map(r => r.page_slug)).toEqual(['notes/old']);
  }, 60_000);
});
