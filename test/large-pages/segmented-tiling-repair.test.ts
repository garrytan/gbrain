/**
 * GST-1209: doctor `segmented_tiling` and `gbrain repair segmented-tiling`.
 *
 * 1. Protects: doctor lists a live segmented page whose live rows do not cover its body and writes nothing. The repair's
 *    preview names the page, its file and HEAD's blob under a hash; `--apply` refuses without that hash; the apply
 *    republishes the page from the blob at HEAD as a new generation that tiles, keeps the damaged generation as a
 *    version by reference, writes a receipt, clears the sync hold, and the next managed sync completes with no hold.
 *    A source with no Git checkout refuses the preview (not_a_git_repo); a remote caller is refused.
 * 2. Fails when: doctor misses the page or writes, an apply runs without the previewed hash or against a changed page,
 *    the republished generation does not tile, the hold survives, or a repo-less source reads as republishable.
 * 3. PGLite; the managed fixture follows test/large-pages/managed-sync-segmented-freeze.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readGitHold } from '../../src/core/persistence/sync-holds.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { untiledSegmentedPages } from '../../src/core/page-body/body-tiling.ts';
import { resolveRepairScope, runRepair } from '../../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairRunner } from '../../src/core/repair/registry.ts';
import { segmentedTilingRepair, SEGMENTED_TILING_RECEIPT_OP } from '../../src/core/repair/segmented-tiling.ts';
import { segmentedTilingCheck } from '../../src/commands/doctor/checks/segmented-tiling.ts';
import { withEnv } from '../helpers/with-env.ts';
import { withManagedFixtureWrite } from '../helpers/managed-e2e-fixture-write.ts';
import { conversationBody } from '../helpers/conversation-page.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-tiling-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
const SLUG = 'people/person-example';
const FILE = 'people/person-example.md';
let engine: PGLiteEngine;

function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string): void { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'test content'); }
const person = (bytes: number) => '---\ntype: person\ntitle: Person Example\n---\n\n# Person Example\n\n' + conversationBody(bytes, { seed: 7 }) + '\n<!-- timeline -->\n- **2026-10-01** | manual — first\n';
/** Deletes the page's last live manifest row: its live generation no longer covers its body. */
const damage = (sourceId: string, pageId: number) => withManagedFixtureWrite(engine, [sourceId], tx => tx.executeRaw(
  'DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND seq=(SELECT max(seq) FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL)', [pageId]));
const counts = async () => (await engine.executeRaw<Record<string, number>>(`SELECT (SELECT count(*)::int FROM pages) AS pages, (SELECT count(*)::int FROM page_body_manifest) AS manifest,
  (SELECT count(*)::int FROM page_body_stagings) AS stagings, (SELECT count(*)::int FROM page_versions) AS versions, (SELECT count(*)::int FROM op_checkpoints) AS checkpoints,
  (SELECT max(knowledge_revision::text) FROM pages) AS revision`))[0];

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

async function managedFixture() {
  await disposePersistenceConsumer(engine);
  await engine.setConfig('pages.segmented_storage', 'on');
  const sourceId = `tiling-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId);
  mkdirSync(join(root, 'people'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, FILE), person(1260 * 1024));
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect(await performManagedSync(engine, { sourceId, noPull: true })).toMatchObject({ status: 'first_sync', filesImported: 1 });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, SLUG]);
  return { sourceId, root, pageId: Number(row!.id) };
}

test('doctor lists the damaged page read-only; the repair republishes it from HEAD and the next sync completes', async () => withEnv(env, async () => {
  const f = await managedFixture();
  expect((await segmentedTilingCheck(engine, [f.sourceId])).status).toBe('ok');
  await damage(f.sourceId, f.pageId);
  appendFileSync(join(f.root, FILE), '- **2026-11-02** | meeting — second\n');
  commit(f.root);
  const held = await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true });
  expect((held.held ?? []).map(hold => [hold.path, hold.code])).toEqual([[FILE, 'page_write_failed']]);
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.sourceId]);
  expect(await readGitHold(engine, f.sourceId, source!.incarnation, FILE)).not.toBeNull();

  const before = await counts();
  const check = await segmentedTilingCheck(engine, [f.sourceId]);
  expect(await counts()).toEqual(before);
  expect(check).toMatchObject({ status: 'fail', details: { pages: [expect.objectContaining({ source_id: f.sourceId, slug: SLUG, rows: expect.any(Number) })] } });
  expect(check.fix?.argv).toEqual(['gbrain', 'repair', 'segmented-tiling', '--source', f.sourceId]);
  const [damaged] = await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] });

  expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).not.toContain('segmented-tiling');
  const scope = await resolveRepairScope(engine, f.sourceId);
  const run = (apply: boolean, expect?: string) => repairRunner(engine, { apply, logger }).then(runner => runner.run('segmented-tiling', scope, { explicit: true, sourceFlag: f.sourceId, ...(expect ? { expect } : {}) }));
  await expect(repairRunner(engine, { apply: false, logger }).then(runner => runner.run('segmented-tiling', scope, {}))).rejects.toThrow(/explicit/);
  const remote = { engine, config: { engine: engine.kind }, logger, dryRun: true, remote: true, sourceId: f.sourceId } as never;
  await expect(runRepair(remote, segmentedTilingRepair, scope, { apply: false, explicit: true })).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(run(true)).rejects.toThrow(/preview/i);

  const preview = await run(false);
  const hash = preview.preview_hash!;
  const blob = git(f.root, 'rev-parse', `HEAD:${FILE}`);
  expect(preview.listing).toEqual([{ item: `${f.sourceId}:${SLUG} (revision ${damaged!.revision})`, class: 'republish', detail: expect.stringContaining(`blob ${blob.slice(0, 12)}`) }]);
  expect((await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] }))).toEqual([damaged!]);
  await expect(run(true, 'f'.repeat(64))).rejects.toMatchObject({ code: 'preview_changed' });

  const applied = await run(true, hash);
  expect(applied.applied).toBe(1);
  expect(applied.outcomes).toEqual({ republished: 1 });
  expect(await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] })).toEqual([]);
  const [page] = await engine.executeRaw<{ body_generation: number }>('SELECT body_generation FROM pages WHERE id=$1', [f.pageId]);
  expect(Number(page!.body_generation)).toBe(damaged!.body_generation + 1);
  expect(await engine.executeRaw('SELECT body_generation::int AS g, body_bytes::int AS b FROM page_versions WHERE page_id=$1 AND body_generation=$2',
    [f.pageId, damaged!.body_generation])).toContainEqual({ g: damaged!.body_generation, b: damaged!.body_bytes });
  const body = await materializeSegmentedBody(engine, f.pageId, f.sourceId);
  expect(body.timeline).toContain('meeting — second');
  const [receipt] = await engine.executeRaw<{ completed_keys: Array<Record<string, unknown>> }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
    [SEGMENTED_TILING_RECEIPT_OP, `${hash}:${f.pageId}`]);
  expect(receipt!.completed_keys[0]).toMatchObject({ slug: SLUG, generation_before: damaged!.body_generation, blob, hold_cleared: true });
  expect(await readGitHold(engine, f.sourceId, source!.incarnation, FILE)).toBeNull();

  const after = await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true });
  expect(after.status).toBe('synced');
  expect(after.failures).toBeUndefined();
  expect(after.held ?? []).toEqual([]);
  expect((await segmentedTilingCheck(engine, [f.sourceId])).status).toBe('ok');
  expect((await run(false)).listing ?? []).toEqual([]);
}), 300_000);

test('a source without a Git checkout refuses the preview: Git is the only copy it republishes', async () => withEnv(env, async () => {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const sourceId = `repoless-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
  await engine.setConfig('pages.segmented_storage', 'on');
  await importFromContent(engine, 'notes/repoless-example', person(1260 * 1024), { sourceId, noEmbed: true });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, 'notes/repoless-example']);
  await engine.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND seq=(SELECT max(seq) FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL)', [row!.id]);
  expect((await segmentedTilingCheck(engine, [sourceId])).status).toBe('fail');
  const scope = await resolveRepairScope(engine, sourceId);
  await expect(repairRunner(engine, { apply: false, logger }).then(runner => runner.run('segmented-tiling', scope, { explicit: true, sourceFlag: sourceId })))
    .rejects.toMatchObject({ code: 'not_a_git_repo' });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}), 300_000);
