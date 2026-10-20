/**
 * #5459-adjacent (fix wave 15 P4.5): a `--full` tree walk used to schedule a Git deletion for every live page whose
 * origin is absent from `ls-tree <target>`, including pages imported from untracked working-tree files
 * (`--working-tree` / `sync.include_working_tree`). The walk now reads the page's durable import provenance
 * (`sync-import-provenance` in op_checkpoints, written by the import itself and untouched by receipt compaction,
 * which nulls `persistence_requests.intent`): a page imported from the working tree whose file is still present is
 * kept and counted as `working_tree_kept`; unknown provenance with the file present holds too; a tracked Git
 * deletion is still applied even when a copy of the file lingers untracked. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { drainManagedSync } from '../src/core/persistence/sync-drain.ts';
import { compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { readSyncImportProvenance, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { maintenanceAttribution } from '../src/core/persistence/attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-untracked-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function repo() {
  const root = join(home, `r-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name: string, body = `A synthetic observation about ${name}.`) => writeFileSync(join(root, 'notes', `${name}.md`), `---\ntitle: ${name}\n---\n${body}\n`);
  const remove = (name: string) => unlinkSync(join(root, 'notes', `${name}.md`));
  const commitStaged = (message: string) => { git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message, '--allow-empty'); return git('rev-parse', 'HEAD'); };
  const commit = (message: string) => { git('add', '-A'); return commitStaged(message); };
  git('init', '-q');
  return { root, git, write, remove, commit, commitStaged };
}

describe('--full tree walk keeps pages imported from untracked working-tree files', () => {
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } await closePostgres?.(); });

  async function managedSource(engine: BrainEngine) {
    const r = repo();
    const id = `wt-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    r.write('base'); r.commit('base');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, r.root]);
    await claimWorktree(engine, id, r.root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
    expect((await drainManagedSync(engine, opts, false)).drain).toMatchObject({ outcome: 'synced' });
    const live = async () => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [id])).map(p => p.slug);
    const page = async (slug: string) => (await engine.executeRaw<{ id: number; deleted_at: string | null; knowledge_revision: string }>('SELECT id,deleted_at,knowledge_revision FROM pages WHERE source_id=$1 AND slug=$2', [id, slug]))[0] ?? null;
    const incarnation = (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]))[0]!.incarnation;
    const full = async () => { const result = await drainManagedSync(engine, { ...opts, full: true }, false); expect(result.drain).toMatchObject({ outcome: 'synced' }); return result; };
    return { r, id, opts, live, page, incarnation, full };
  }

  test('working-tree import survives a --full walk (fresh, compacted and legacy provenance; after a non-sync write), and is counted', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const { r, id, opts, live, page, incarnation, full } = await managedSource(engine);
      r.write('scratch', 'An untracked working-tree note.');
      expect((await drainManagedSync(engine, { ...opts, workingTree: true }, false)).drain).toMatchObject({ outcome: 'synced' });
      expect(await live()).toEqual(['notes/base', 'notes/scratch']);
      const scratch = (await page('notes/scratch'))!;

      // 1. Fresh provenance: the walk keeps the page and counts it.
      let result = await full();
      expect(await live()).toEqual(['notes/base', 'notes/scratch']);
      expect(result.working_tree_kept).toBe(1);
      expect(await readSyncImportProvenance(engine, id, incarnation, scratch.id)).toMatchObject({ origin: 'notes/scratch.md', working: true });

      // 2. Receipt compaction nulls every request intent (journal.ts); the proof must not live there.
      await compactWriteReceipts(engine, 0);
      expect((await engine.executeRaw<{ n: number }>("SELECT COUNT(*)::int AS n FROM persistence_requests WHERE intent IS NOT NULL AND intent->>'kind'='managed_sync_import'"))[0].n).toBe(0);
      result = await full();
      expect(await live()).toEqual(['notes/base', 'notes/scratch']);
      expect(result.working_tree_kept).toBe(1);

      // 3. An intervening non-sync write (a coordinated maintenance edit) moves the page's revision; the page still stays.
      await engine.transaction(async tx => withCoordinatedWrite(tx, [id], async () => {
        await tx.executeRaw("UPDATE pages SET compiled_truth=compiled_truth||E'\\nEdited by maintenance.', knowledge_revision=gen_random_uuid() WHERE source_id=$1 AND slug='notes/scratch'", [id]);
      }, await maintenanceAttribution(tx)));
      expect((await page('notes/scratch'))!.knowledge_revision).not.toBe(scratch.knowledge_revision);
      result = await full();
      expect(await live()).toEqual(['notes/base', 'notes/scratch']);
      expect(result.working_tree_kept).toBe(1);

      // 4. Legacy provenance (recorded before the `working` stamp existed): unknown provenance plus a present file holds.
      await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0}',(completed_keys->0)-'working') WHERE op=$1 AND fingerprint=$2",
        [SYNC_IMPORT_PROVENANCE_OP, `${id}:${incarnation}:${scratch.id}`]);
      expect(await readSyncImportProvenance(engine, id, incarnation, scratch.id)).not.toHaveProperty('working');
      result = await full();
      expect(await live()).toEqual(['notes/base', 'notes/scratch']);
      expect(result.working_tree_kept).toBe(1);

      // 5. The untracked file is gone: nothing backs the page any more, and the counter is absent. #6712 PR 4b (design v3.2
      // §2.3 row 6, `delete_drift`): step 3's maintenance write moved the page with no proof, so the deletion is held
      // file_drift (side deleted, state file_gone) for a person's Decision instead of soft-deleting a page that changed.
      r.remove('scratch');
      result = await full();
      expect(await live()).toEqual(['notes/base', 'notes/scratch']);
      expect((result.held ?? []).map(item => [item.path, item.code, item.side, item.state, item.slug])).toEqual([['notes/scratch.md', 'file_drift', 'deleted', 'file_gone', 'notes/scratch']]);
      expect(result.working_tree_kept).toBeUndefined();
    }
  }), 300_000);

  test('an explicit tracked Git deletion is applied even when a copy of the file lingers untracked (Git is the truth for tracked paths)', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const { r, id, live, page, incarnation, full } = await managedSource(engine);
      r.write('tracked'); r.commit('add tracked');
      await full();
      expect(await live()).toEqual(['notes/base', 'notes/tracked']);
      const tracked = (await page('notes/tracked'))!;
      r.git('rm', '-q', '--cached', 'notes/tracked.md'); r.commitStaged('stop tracking');
      // The bytes are still on disk, untracked.
      expect(r.git('status', '--porcelain')).toContain('?? notes/tracked.md');
      const result = await full();
      expect(await live()).toEqual(['notes/base']);
      expect((await page('notes/tracked'))!.deleted_at).not.toBeNull();
      expect(result.working_tree_kept).toBeUndefined();
      expect(await readSyncImportProvenance(engine, id, incarnation, tracked.id)).toMatchObject({ working: false });
    }
  }), 300_000);

  test('the same slug in another source is judged by its own provenance; the kept page never shields or dooms it', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const a = await managedSource(engine);
      const b = await managedSource(engine);
      a.r.write('shared', 'Untracked in source A.');
      expect((await drainManagedSync(engine, { ...a.opts, workingTree: true }, false)).drain).toMatchObject({ outcome: 'synced' });
      b.r.write('shared', 'Tracked in source B.'); b.r.commit('add shared');
      await b.full();
      expect(await a.live()).toEqual(['notes/base', 'notes/shared']);
      expect(await b.live()).toEqual(['notes/base', 'notes/shared']);
      // B removes its tracked copy: B's page goes, A's untracked-backed page stays, each walk counting only its own source.
      b.r.remove('shared'); b.r.commit('remove shared');
      const resultB = await b.full();
      expect(await b.live()).toEqual(['notes/base']);
      expect(resultB.working_tree_kept).toBeUndefined();
      const resultA = await a.full();
      expect(await a.live()).toEqual(['notes/base', 'notes/shared']);
      expect(resultA.working_tree_kept).toBe(1);
    }
  }), 300_000);
});
