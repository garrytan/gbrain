/**
 * GST-1209: doctor `segmented_tiling` and `gbrain repair segmented-tiling`.
 *
 * 1. Protects: doctor lists a live segmented page whose live rows do not cover its body and writes nothing. The repair's
 *    preview names the page, its file and HEAD's blob under a hash; `--apply` refuses without that hash; the apply
 *    republishes the page from the blob at HEAD as a new generation that tiles, keeps the damaged generation as a
 *    version by reference, writes a receipt, clears the sync hold, and the next managed sync completes with no hold.
 *    A source with no Git checkout refuses the preview (not_a_git_repo); a remote caller is refused.
 * 2. Fails when: doctor misses the page or writes, an apply runs without the previewed hash or against a changed page,
 *    the republished generation does not tile, the hold survives, a repo-less source reads as republishable, or a file
 *    that narrows who can read the page or that the content gate would quarantine is republished under the stored frontmatter.
 * 3. PGLite; the managed fixture follows test/large-pages/managed-sync-segmented-freeze.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readGitHold, readSyncImportProvenance, writeGitHold } from '../../src/core/persistence/sync-holds.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { untiledSegmentedPages } from '../../src/core/page-body/body-tiling.ts';
import { resolveRepairScope, runRepair } from '../../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairRunner } from '../../src/core/repair/registry.ts';
import { segmentedTilingRepair, SEGMENTED_TILING_RECEIPT_OP, survey } from '../../src/core/repair/segmented-tiling.ts';
import { readSyncStatus } from '../../src/core/persistence/sync-status.ts';
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
const person = (bytes: number, fence = '') => '---\ntype: person\ntitle: Person Example\n---\n\n# Person Example\n\n' + fence + conversationBody(bytes, { seed: 7 }) + '\n<!-- timeline -->\n- **2026-10-01** | manual — first\n';
const PURGED = 'Person Example keeps the spare key under the blue mat.';
const KEPT = 'Person Example prefers the green notebook.';
const FENCE = ['## Facts', '', '<!--- gbrain:facts:begin -->', '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|', `| 1 | ${PURGED} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`,
  `| 2 | ${KEPT} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`, '<!--- gbrain:facts:end -->', '', ''].join('\n');
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

async function managedFixture(content = person(1260 * 1024)) {
  await disposePersistenceConsumer(engine);
  await engine.setConfig('pages.segmented_storage', 'on');
  const sourceId = `tiling-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId);
  mkdirSync(join(root, 'people'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, FILE), content);
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
  const hold = (await readGitHold(engine, f.sourceId, source!.incarnation, FILE))!;
  expect(hold.message).toContain(`gbrain repair segmented-tiling --source <source> --slug ${SLUG}`);
  expect((await readSyncStatus(engine, f.sourceId, { detail: false })).holds.find(h => h.path === FILE)).toMatchObject({ fault_code: 'page_body_rows_unreadable', needs_human: true,
    safe_actions: ['repair'], fix: { argv: ['gbrain', 'repair', 'segmented-tiling', '--source', f.sourceId, '--slug', SLUG] } });

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

test('a page HEAD no longer holds, or whose file another sync hold withholds, is listed held and never written', async () => withEnv(env, async () => {
  const f = await managedFixture();
  await damage(f.sourceId, f.pageId);
  const scope = await resolveRepairScope(engine, f.sourceId);
  const run = (apply: boolean, expect?: string) => repairRunner(engine, { apply, logger }).then(runner => runner.run('segmented-tiling', scope, { explicit: true, sourceFlag: f.sourceId, ...(expect ? { expect } : {}) }));
  const [damaged] = await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] });
  git(f.root, 'rm', '-q', FILE);
  commit(f.root);
  const gone = await run(false);
  expect(gone.listing).toEqual([{ item: `${f.sourceId}:${SLUG} (revision ${damaged!.revision})`, class: 'held', detail: expect.stringContaining(`holds no file at ${FILE}`) }]);
  expect(await run(true, gone.preview_hash!)).toMatchObject({ applied: 0 });
  expect(await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] })).toEqual([damaged!]);

  git(f.root, 'checkout', '-q', 'HEAD~1', '--', FILE);
  commit(f.root);
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.sourceId]);
  await writeGitHold(engine, { source_id: f.sourceId, incarnation: source!.incarnation, path: FILE, source_path: FILE, slug: SLUG, page_id: f.pageId, code: 'write_gate_rejected',
    message: 'The write gate rejected this file.', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: 1 } });
  const gated = await run(false);
  expect(gated.listing).toEqual([expect.objectContaining({ class: 'held', detail: expect.stringContaining('sync hold (write_gate_rejected)') })]);
  expect(await run(true, gated.preview_hash!)).toMatchObject({ applied: 0 });
  expect(await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] })).toEqual([damaged!]);
  expect(await readGitHold(engine, f.sourceId, source!.incarnation, FILE)).toMatchObject({ code: 'write_gate_rejected' });
}), 300_000);

test('a file the next sync would hold, or one that changes who can read the page, is listed held and never written', async () => withEnv(env, async () => {
  const f = await managedFixture();
  await damage(f.sourceId, f.pageId);
  const scope = await resolveRepairScope(engine, f.sourceId);
  const run = (apply: boolean, expect?: string) => repairRunner(engine, { apply, logger }).then(runner => runner.run('segmented-tiling', scope, { explicit: true, sourceFlag: f.sourceId, ...(expect ? { expect } : {}) }));
  const [damaged] = await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] });
  for (const [frontmatter, detail] of [['slug: people/other-example', 'the next sync would hold the file ('], ['readable_by: [alice-example]', 'changes who can read the page']] as const) {
    writeFileSync(join(f.root, FILE), person(1260 * 1024).replace('type: person\n', `type: person\n${frontmatter}\n`));
    commit(f.root);
    const preview = await run(false);
    expect(preview.listing).toEqual([expect.objectContaining({ class: 'held', detail: expect.stringContaining(detail) })]);
    expect(await run(true, preview.preview_hash!)).toMatchObject({ applied: 0 });
    expect(await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] })).toEqual([damaged!]);
  }
}), 300_000);

test('a file a privacy alias makes private, or one the content gate would quarantine, is listed held and never written', async () => withEnv(env, async () => {
  const f = await managedFixture();
  await damage(f.sourceId, f.pageId);
  const scope = await resolveRepairScope(engine, f.sourceId);
  const run = (apply: boolean, expect?: string) => repairRunner(engine, { apply, logger }).then(runner => runner.run('segmented-tiling', scope, { explicit: true, sourceFlag: f.sourceId, ...(expect ? { expect } : {}) }));
  const [damaged] = await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] });
  const cases = [[person(1260 * 1024).replace('type: person\n', 'type: person\naccess: private\n'), 'changes who can read the page'],
    [person(1260 * 1024).replace('type: person\n', 'type: person\nconfidentiality: secret\n'), 'changes who can read the page'],
    [person(1260 * 1024).replace('# Person Example\n\n', '# Person Example\n\nCloudflare Ray ID: 0000example\n\n'), 'content gate would mark the page quarantine']] as const;
  for (const [content, detail] of cases) {
    writeFileSync(join(f.root, FILE), content);
    commit(f.root);
    const preview = await run(false);
    expect(preview.listing).toEqual([expect.objectContaining({ class: 'held', detail: expect.stringContaining(detail) })]);
    expect(await run(true, preview.preview_hash!)).toMatchObject({ applied: 0 });
    expect(await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] })).toEqual([damaged!]);
  }
  expect(await engine.executeRaw('SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1 AND chunk_text LIKE $2', [f.pageId, '%0000example%'])).toEqual([{ n: 0 }]);
}), 300_000);

test('the apply refuses preview_changed when HEAD moved after the preview, and writes nothing', async () => withEnv(env, async () => {
  const f = await managedFixture();
  await damage(f.sourceId, f.pageId);
  const scope = await resolveRepairScope(engine, f.sourceId);
  const run = (apply: boolean, expect?: string) => repairRunner(engine, { apply, logger }).then(runner => runner.run('segmented-tiling', scope, { explicit: true, sourceFlag: f.sourceId, ...(expect ? { expect } : {}) }));
  const preview = await run(false);
  appendFileSync(join(f.root, FILE), '- **2026-11-03** | meeting — third\n');
  commit(f.root);
  const before = await counts();
  await expect(run(true, preview.preview_hash!)).rejects.toMatchObject({ code: 'preview_changed' });
  expect(await counts()).toEqual(before);
  expect(await untiledSegmentedPages(engine, { sourceIds: [f.sourceId] })).toHaveLength(1);
}), 300_000);

test('a claim the owner purged stays out: the apply republishes the file through the purge overlay', async () => withEnv(env, async () => {
  const f = await managedFixture(person(1260 * 1024, FENCE));
  await engine.executeRaw("INSERT INTO fact_purges(source_id, visibility, subject, fact_hash) VALUES ($1, 'world', '*', gbrain_fact_fingerprint($2))", [f.sourceId, PURGED]);
  await damage(f.sourceId, f.pageId);
  const scope = await resolveRepairScope(engine, f.sourceId);
  const run = (apply: boolean, expect?: string) => repairRunner(engine, { apply, logger }).then(runner => runner.run('segmented-tiling', scope, { explicit: true, sourceFlag: f.sourceId, ...(expect ? { expect } : {}) }));
  expect(await run(true, (await run(false)).preview_hash!)).toMatchObject({ applied: 1 });
  const body = await materializeSegmentedBody(engine, f.pageId, f.sourceId);
  expect(body.compiled_truth).toContain(KEPT);
  expect(body.compiled_truth).not.toContain(PURGED);
  expect(await engine.executeRaw('SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1 AND chunk_text LIKE $2', [f.pageId, `%${PURGED}%`])).toEqual([{ n: 0 }]);
}), 300_000);

test('the republished page is recorded as imported from HEAD: the next sync holds no file_drift for a page the file imports', async () => withEnv(env, async () => {
  const f = await managedFixture();
  // A tag only the database holds: every import keeps it, so importing the file would also write the tag back into it.
  await withManagedFixtureWrite(engine, [f.sourceId], tx => tx.addTag(SLUG, 'kept-example', { sourceId: f.sourceId }));
  appendFileSync(join(f.root, FILE), '- **2026-11-01** | meeting — first follow-up\n');
  commit(f.root);
  expect((await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true })).held ?? []).toEqual([]);
  await damage(f.sourceId, f.pageId);
  appendFileSync(join(f.root, FILE), '- **2026-11-02** | meeting — second\n');
  commit(f.root);
  expect(((await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true })).held ?? []).map(hold => hold.code)).toEqual(['page_write_failed']);
  const scope = await resolveRepairScope(engine, f.sourceId);
  const run = (apply: boolean, expect?: string) => repairRunner(engine, { apply, logger }).then(runner => runner.run('segmented-tiling', scope, { explicit: true, sourceFlag: f.sourceId, ...(expect ? { expect } : {}) }));
  expect(await run(true, (await run(false)).preview_hash!)).toMatchObject({ applied: 1 });
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.sourceId]);
  const [republished] = await engine.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE id=$1', [f.pageId]);
  const blob = git(f.root, 'rev-parse', `HEAD:${FILE}`);
  expect(await readSyncImportProvenance(engine, f.sourceId, source!.incarnation, f.pageId)).toMatchObject({ revision: republished!.revision, disk_blob_oid: blob, blob_oid: blob, origin: FILE });

  const after = await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true });
  expect(after.held ?? []).toEqual([]);
  expect(after.status).toBe('synced');
  expect((await readSyncStatus(engine, f.sourceId, { detail: false })).holds).toEqual([]);
}), 300_000);

test('a republished page whose stored frontmatter the file no longer imports records no provenance, so sync guards the stored frontmatter', async () => withEnv(env, async () => {
  const f = await managedFixture();
  await damage(f.sourceId, f.pageId);
  writeFileSync(join(f.root, FILE), readFileSync(join(f.root, FILE), 'utf8').replace('type: person', 'type: person\nstatus: active') + '- **2026-11-02** | meeting — second\n');
  commit(f.root);
  await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true });
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.sourceId]);
  const before = await readSyncImportProvenance(engine, f.sourceId, source!.incarnation, f.pageId);
  const scope = await resolveRepairScope(engine, f.sourceId);
  const run = (apply: boolean, expect?: string) => repairRunner(engine, { apply, logger }).then(runner => runner.run('segmented-tiling', scope, { explicit: true, sourceFlag: f.sourceId, ...(expect ? { expect } : {}) }));
  expect(await run(true, (await run(false)).preview_hash!)).toMatchObject({ applied: 1 });
  expect(await readSyncImportProvenance(engine, f.sourceId, source!.incarnation, f.pageId)).toEqual(before);
  const after = await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true });
  expect((after.held ?? []).map(hold => hold.code)).toEqual(['file_drift']);
}), 300_000);

test('#8504: an archived source is never listed, a multi-source fix names a source, a preview over its limit says so, an unknown source refuses', async () => withEnv(env, async () => {
  const f = await managedFixture();
  const second = 'people/other-example.md';
  writeFileSync(join(f.root, second), person(1260 * 1024).replace(/Person Example/g, 'Other Example'));
  commit(f.root);
  await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true });
  const [other] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [f.sourceId, 'people/other-example']);
  const g = await managedFixture();
  await damage(f.sourceId, f.pageId); await damage(f.sourceId, Number(other!.id)); await damage(g.sourceId, g.pageId);

  const both = await segmentedTilingCheck(engine, [f.sourceId, g.sourceId]);
  const [firstSource, otherSource] = [f.sourceId, g.sourceId].sort();
  expect(both.fix?.argv).toEqual(['gbrain', 'repair', 'segmented-tiling', '--source', firstSource]);
  expect(both.fix?.why).toContain(`gbrain repair segmented-tiling --source ${otherSource}`);

  const limited = await survey(engine, { source_id: f.sourceId, slugs: [] }, 1);
  expect([limited.pages.length + limited.held, limited.truncated]).toEqual([1, true]);
  expect((await survey(engine, { source_id: f.sourceId, slugs: [] })).truncated).toBe(false);

  await expect(resolveRepairScope(engine, 'missing-example')).rejects.toMatchObject({ code: 'invalid_params' });
  const archive = (archived: boolean) => engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    await tx.executeRaw('UPDATE sources SET archived=$2 WHERE id=$1', [g.sourceId, archived]);
  });
  await archive(true);
  expect(await untiledSegmentedPages(engine, { sourceIds: [g.sourceId] })).toEqual([]);
  expect((await segmentedTilingCheck(engine, [f.sourceId, g.sourceId])).fix?.why).not.toContain(g.sourceId);
  await expect(resolveRepairScope(engine, g.sourceId)).rejects.toMatchObject({ code: 'invalid_params' });
  await archive(false);
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
