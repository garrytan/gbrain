/**
 * GST-2843: a read-only mirror whose every held page came due for one re-check (holds an older gbrain wrote) stayed
 * blocked / pass_abandoned after GST-2515.
 *   - A stopped pass that re-checked held pages and cleared their re-check trigger saved work, so it does not build the
 *     abandoned streak; a pass that re-checks the same holds on every pass still does, and still ends abandoned.
 *   - While the pass is what keeps the source from converging, status names the pass's next step, not a held page's decision.
 *   - On a read-only mirror the held comparison reads the file: a page that differs is compared like a writable source's,
 *     and only a file that is gone reads no_drift / database_only. It still writes nothing, and sync holds the same paths.
 *   - The held comparison is not complete while held pages remain past its window.
 *   - sources status counts every hold per code, not only the listed ones.
 * PGLite always; Postgres when DATABASE_URL is set (managedBrain). Synthetic content only.
 */
import { describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as gitStream from '../src/core/persistence/sync-git-stream.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { PASS_BATCH_KEY_PREFIX, readPassBatch } from '../src/core/persistence/sync-pass-batch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { FILE_DRIFT_VERSION, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { readPassRow } from '../src/core/persistence/sync-pass-row.ts';
import { passBanked } from '../src/core/persistence/sync-pass-status.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { gitHoldStatusJson, readGitHoldStatuses } from '../src/core/persistence/connector-status.ts';
import { resolveRepairScope, type RepairPlanOptions } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const doc = (title: string, body: string, extra = '') => `---\ntype: concept\ntitle: ${title}\n${extra}---\n\n${body}\n`;
const commitAll = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const files = (root: string, entries: Record<string, string>) => {
  for (const [slug, content] of Object.entries(entries)) { mkdirSync(join(root, slug, '..'), { recursive: true }); writeFileSync(join(root, `${slug}.md`), content); }
};
const setupWith = (entries: Record<string, string>) => ({ root }: { root: string }) => { git(root, 'init', '-q'); files(root, entries); commitAll(root, 'pages'); };
const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const mirror = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"mirror_read_only": true}'::jsonb WHERE id='default'`);
const incarnation = async (engine: BrainEngine) => (await engine.executeRaw<{ i: string }>("SELECT incarnation::text AS i FROM sources WHERE id='default'"))[0]!.i;
const holdRows = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string; upstream_version: string | null; meta: Record<string, unknown> } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => r);
/** Pages as an older gbrain left them: no import record, and a revision no import or write request produced. */
const legacy = async (engine: BrainEngine) => {
  await coordinated(engine, "DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
  await coordinated(engine, "UPDATE pages SET knowledge_revision=gen_random_uuid(), revision_write_request_id=NULL WHERE source_id='default'");
};
class Killed extends Error {}
/** One sync stopped after `after` cursor checkpoints, as a killed process leaves it: its pass row open and no failure recorded. */
async function stoppedSync(engine: BrainEngine, after: number) {
  let n = 0;
  installFaultHook(async point => { if (point === 'sync:mid_checkpoint' && ++n > after) throw new Killed('killed'); });
  try { await performManagedSync(engine, OPTS); } catch (e) { if (!(e instanceof Killed) && !String(e).includes('killed')) throw e; } finally { installFaultHook(undefined); }
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-failure'");
}
async function repair(engine: BrainEngine, opts: Partial<RepairPlanOptions>) {
  return withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
    (await repairRunner(engine, { apply: false, logger })).run('file-drift', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', ...opts } as never));
}
type Plan = { complete: boolean; listing?: Array<{ item: string; class: string; detail?: string }>; details?: Record<string, any> };
const classes = (plan: unknown) => Object.fromEntries(((plan as Plan).listing ?? []).map(entry => [entry.item.replace('default:', ''), entry.class]));

/** A mirror whose `count` pages changed in the database, lost their import records and had their files rewritten upstream: one side-unknown hold each. */
async function unknownHolds(engine: BrainEngine, root: string, count: number): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await mirror(engine);
  await coordinated(engine, "UPDATE pages SET compiled_truth=compiled_truth||' Edited in the database.' WHERE source_id='default' AND slug LIKE 'notes/%'");
  await legacy(engine);
  files(root, Object.fromEntries(Array.from({ length: count }, (_, i) => [`notes/n${i}`, doc(`notes/n${i}`, `Body ${i}, rewritten upstream.`)])));
  commitAll(root, 'upstream rewrites');
  await performManagedSync(engine, OPTS);
  expect((await holdRows(engine)).filter(h => h.code === 'file_drift' && h.meta.side === 'unknown')).toHaveLength(count);
}
const notes = (count: number, extra: Record<string, string> = {}) => setupWith({ ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`notes/n${i}`, doc(`notes/n${i}`, `Body ${i}.`)])), ...extra });

describe.each(testBackends())('GST-2843: stopped passes that only re-check holds (%s)', backend => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a stopped pass that re-checked old holds and cleared their trigger saved work: no abandoned streak, and the plain sync finishes', () => managedBrain(async ({ engine, root }) => {
    await unknownHolds(engine, root, 12);
    // An older gbrain wrote these holds before the drift screen's current version, so every one is due for one re-check.
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,drift_version}','2'::jsonb) WHERE op='sync-hold'");
    const inc = await incarnation(engine);
    for (let pass = 0; pass < 3; pass++) await stoppedSync(engine, 2);
    const due = (await holdRows(engine)).filter(h => (h.meta.drift_version as number) < FILE_DRIFT_VERSION).length;
    expect(due).toBeLessThan(12);
    expect((await readPassRow(engine, 'default', inc))?.value.obligations.abandoned_streak ?? 0).toBe(0);
    const status: any = await readSyncStatus(engine, 'default');
    expect(status.reason).not.toBe('pass_abandoned');
    const finished: any = await performManagedSync(engine, OPTS);
    expect(finished.status).toBe('synced');
    expect((await holdRows(engine)).every(h => h.meta.drift_version === FILE_DRIFT_VERSION)).toBe(true);
  }, { databaseUrl, setup: notes(12) }), 600_000);

  test('the earlier versions old holds are re-checked against are read per batch, after the batch is admitted, not for the whole round first', () => managedBrain(async ({ engine, root }) => {
    await unknownHolds(engine, root, 6);
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,drift_version}','1'::jsonb) WHERE op='sync-hold'");
    const events: string[] = [];
    const real = gitStream.pathBlobHistories;
    const reads = spyOn(gitStream, 'pathBlobHistories').mockImplementation(async (...args: Parameters<typeof real>) => {
      events.push(`history:${args[2].length}`);
      return real(...args);
    });
    try {
      const result: any = await performManagedSync(engine, { ...OPTS, onProgress: (e: { phase?: string }) => { if (e.phase === 'managed_sync.round_admit' || e.phase === 'managed_sync.round_batch') events.push(e.phase); } } as never);
      expect(result.status).toBe('synced');
    } finally { reads.mockRestore(); }
    expect(events.filter(e => e.startsWith('history:'))).toEqual(['history:6']);
    expect(events.indexOf('history:6')).toBeGreaterThan(events.indexOf('managed_sync.round_batch'));
  }, { databaseUrl, setup: notes(6) }), 600_000);

  test('a pass killed while it reads the Git history of re-checked holds leaves that step on its row, and status names it', () => managedBrain(async ({ engine, root }) => {
    await unknownHolds(engine, root, 3);
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,drift_version}','1'::jsonb) WHERE op='sync-hold'");
    const inc = await incarnation(engine);
    const reads = spyOn(gitStream, 'pathBlobHistories').mockImplementation(async (...args: Parameters<typeof gitStream.pathBlobHistories>) => {
      const onPath = args[4]!;
      onPath(args[2][0]!);
      setSystemTime(new Date(Date.now() + 31_000));
      onPath(args[2][1]!);
      for (let i = 0; i < 200 && !(await readPassRow(engine, 'default', inc))?.value.telemetry.step; i++) await Bun.sleep(50);
      throw new Killed('killed');
    });
    try { await performManagedSync(engine, OPTS); } catch (e) { if (!String(e).includes('killed')) throw e; } finally { reads.mockRestore(); setSystemTime(); }
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-failure'");
    expect((await readPassRow(engine, 'default', inc))?.value.telemetry).toMatchObject({ outcome: 'open', step: { name: 'drift_history', done: 2, total: 3 } });
    const status: any = await readSyncStatus(engine, 'default');
    expect(status.reason).toBe('pass_interrupted');
    expect(status.next.why).toContain('reading the Git history of held pages it re-checks (2 of 3 paths of its batch)');
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect((await readPassRow(engine, 'default', inc))?.value.telemetry.step).toBeUndefined();
  }, { databaseUrl, setup: notes(3) }), 600_000);

  test('passes that re-check the same holds every time still build the streak, end abandoned, and status then names the pass step over a held page', () => managedBrain(async ({ engine, root }) => {
    await unknownHolds(engine, root, 1);
    // Slug conflicts re-check on every pass by design: a pass that only re-holds them moves nothing.
    files(root, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`clash/c${i}`, doc(`clash/c${i}`, 'Slug conflict.', 'slug: notes/n0\n')])));
    commitAll(root, 'upstream adds conflicting slugs');
    await performManagedSync(engine, OPTS);
    expect((await holdRows(engine)).filter(h => h.code === 'frontmatter_slug_conflict').length).toBeGreaterThan(2);
    const inc = await incarnation(engine);
    for (let pass = 0; pass < 3; pass++) await stoppedSync(engine, 1);
    expect((await readPassRow(engine, 'default', inc))?.value.obligations.abandoned_streak).toBeGreaterThanOrEqual(2);
    const status: any = await readSyncStatus(engine, 'default');
    expect([status.state, status.reason]).toEqual(['blocked', 'pass_abandoned']);
    expect(status.next.argv).toEqual(['gbrain', 'doctor', '--json']);
    expect(status.next.user_message ?? '').not.toContain('needs a decision');
    expect(status.needs_human).toBe(false);
    expect(status.needs_human_from).toMatchObject({ kind: 'hold', code: 'file_drift' });
  }, { databaseUrl, setup: notes(1) }), 600_000);
});

describe.each(testBackends())('GST-2843: the held comparison on a read-only mirror (%s)', backend => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  /** The `file_drift` hold an older screen wrote for a page, at its current revision. */
  async function seedHold(engine: BrainEngine, slug: string, meta: Record<string, unknown>): Promise<void> {
    const [page] = await engine.executeRaw<{ id: string; revision: string; incarnation: string }>(`SELECT p.id::text AS id, p.knowledge_revision::text AS revision,
      s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id='default' AND p.slug=$1`, [slug]);
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: page!.incarnation, path: `${slug}.md`, source_path: `${slug}.md`, slug,
      page_id: Number(page!.id), code: 'file_drift', message: `${slug}.md is held: file drift`, upstream_version: null, observed_at: new Date().toISOString(),
      run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, page_revision: page!.revision, ...meta } as never }));
  }
  /** Four held pages on a mirror: same (agrees with its file), newer-file, newer-page (each differs in body), gone (its file left Git). */
  async function heldPages(engine: BrainEngine, root: string): Promise<void> {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await coordinated(engine, "UPDATE pages SET compiled_truth='An old database body.', updated_at=now() - interval '2 hours' WHERE source_id='default' AND slug='notes/newer-file'");
    files(root, { 'notes/newer-file': doc('notes/newer-file', 'A newer file body.') });
    git(root, 'rm', '-q', '--', 'notes/gone.md');
    commitAll(root, 'edit and remove');
    await coordinated(engine, "UPDATE pages SET compiled_truth='A newer database body.', updated_at=now() + interval '1 minute' WHERE source_id='default' AND slug='notes/newer-page'");
    await legacy(engine);
    await mirror(engine);
    for (const slug of ['notes/same', 'notes/newer-file', 'notes/newer-page']) await seedHold(engine, slug, { sides: 'unknown', side: 'unknown', drift_version: FILE_DRIFT_VERSION });
    await seedHold(engine, 'notes/gone', { side: 'deleted', state: 'file_gone' });
  }
  const heldSetup = setupWith(Object.fromEntries(['same', 'newer-file', 'newer-page', 'gone'].map(name => [`notes/${name}`, doc(`notes/${name}`, `The committed body of notes/${name}.`)])));

  test('a held page that differs from its file is compared, not read as no drift; only a gone file is database-only', () => managedBrain(async ({ engine, root }) => {
    await heldPages(engine, root);
    const compared = await repair(engine, { held: true }) as Plan;
    expect(classes(compared)).toEqual({ 'notes/gone': 'no_drift', 'notes/newer-file': 'prefer_file', 'notes/newer-page': 'needs_human', 'notes/same': 'release_hold' });
    const pages = Object.fromEntries((compared.details!.pages as Array<{ slug: string; evidence?: { differs: string; newer: string } | null }>).map(page => [page.slug, page.evidence]));
    expect([pages['notes/newer-file'], pages['notes/newer-page']].map(found => [found!.differs, found!.newer])).toEqual([['body', 'file'], ['body', 'database']]);
    expect(pages['notes/gone']).toBeNull();
  }, { databaseUrl, setup: heldSetup }), 240_000);

  test('the comparison changes nothing sync does: a sync after it holds the same paths with the same records', () => managedBrain(async ({ engine, root }) => {
    await heldPages(engine, root);
    await performManagedSync(engine, OPTS);
    const strip = (rows: Awaited<ReturnType<typeof holdRows>>) => rows.map(({ path, code, upstream_version, meta }) => ({ path, code, upstream_version, side: meta.side, state: meta.state }));
    const before = strip(await holdRows(engine));
    const revisions = async () => JSON.stringify(await engine.executeRaw("SELECT slug, knowledge_revision::text, deleted_at IS NULL AS live FROM pages ORDER BY slug"));
    const pages = await revisions();
    await repair(engine, { held: true });
    await performManagedSync(engine, OPTS);
    expect(strip(await holdRows(engine))).toEqual(before);
    expect(await revisions()).toBe(pages);
    expect(git(root, 'status', '--porcelain')).toBe('');
  }, { databaseUrl, setup: heldSetup }), 240_000);
});

describe.each(testBackends())('GST-2843: counts past a window or a listing limit (%s)', backend => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('the held comparison is complete only at its last window, and sources status counts every hold per code', () => managedBrain(async ({ engine, root }) => {
    await unknownHolds(engine, root, 230);
    const first = await repair(engine, { held: true }) as Plan;
    expect(first.details!.window).toMatchObject({ previewed: 200, remaining: 30, complete: false });
    expect(first.complete).toBe(false);
    expect(first.details!.window.next_command).toContain(`--held --cursor ${first.details!.window.next_cursor}`);
    const last = await repair(engine, { held: true, cursor: first.details!.window.next_cursor }) as Plan;
    expect(last.details!.window).toMatchObject({ remaining: 0, complete: true });
    expect(last.complete).toBe(true);
    // A listing that reads 50 holds (the sync result's detail cap) still counts all 230 per code.
    const status = (await withEnv({ GBRAIN_SYNC_HOLD_CAP: '50' }, () => readGitHoldStatuses(engine, ['default']))).get('default')!;
    const json: any = gitHoldStatusJson('default', status, { mode: 'summary' });
    expect([json.count, json.truncated, status.items.length]).toEqual([230, true, 50]);
    expect(json.by_code).toEqual([expect.objectContaining({ code: 'file_drift', count: 230 })]);
    expect(json.by_code_complete).toBeUndefined();
  }, { databaseUrl, setup: notes(230) }), 900_000);
});

describe.each(testBackends())('GST-2843: a pass that settled one re-check among many still-due ones (%s)', backend => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('the settled re-check counts as progress even behind more than 50 rewritten holds that stay due', () => managedBrain(async ({ engine }) => {
    const inc = await incarnation(engine);
    const before = '2026-01-01T00:00:00.000Z', started = '2026-01-02T00:00:00.000Z', during = '2026-01-02T00:05:00.000Z';
    const hold = (path: string, code: string, meta: Record<string, unknown>) => [`default:${inc}:${path}`, JSON.stringify([{ version: 1, source_id: 'default', incarnation: inc, path,
      source_path: path, slug: null, page_id: null, code, message: 'synthetic', upstream_version: null, observed_at: during, held_at: before, updated_at: during,
      run_id: 'pass-1', mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, ...meta } }])];
    // Rewritten by the pass and still due (a transient hold below its attempt cap), then one hold whose re-screen settled.
    const rows = [...Array.from({ length: 520 }, (_, i) => hold(`a/n${String(i).padStart(3, '0')}.md`, 'preparation_stalled', { attempts: 1 })), hold('z/settled.md', 'invalid_frontmatter', {})];
    await coordinated(engine, "INSERT INTO op_checkpoints(op,fingerprint,completed_keys) SELECT 'sync-hold', f, k::jsonb FROM unnest($1::text[], $2::text[]) AS t(f, k)",
      [rows.map(([fingerprint]) => fingerprint), rows.map(([, keys]) => keys)]);
    expect(await passBanked(engine, 'default', inc, { pass_id: 'pass-1', started_at: started })).toBe(true);
  }, { databaseUrl }), 120_000);
});

describe.each(testBackends())('GST-2843: a held page that keeps moving under killed passes (%s)', backend => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const SLUG = 'people/alice-example', PATH = 'people/alice-example.md';
  const person = (body: string, extra = '') => `---\ntype: person\ntitle: Alice Example\n${extra}---\n\n${body}\n`;
  const setup = ({ root }: { root: string }) => { git(root, 'init', '-q'); files(root, { 'people/alice-example': person('Works at acme-example.') }); commitAll(root, 'pages'); };
  const theHold = async (engine: BrainEngine) => (await holdRows(engine)).find(h => h.path === PATH)!;
  /** A database-only write raced the import of a newer Git version (#6194), then eight files claim the page's slug, so every pass re-checks them. */
  async function movingHold(engine: BrainEngine, ctx: OperationContext, root: string) {
    await engine.setConfig('sync.write_through', 'false');
    const put = async (text: string) => {
      const id = randomUUID(), current = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, request_id: id, expected_revision: current!.revision, content: person(text) } });
      await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [id]))[0]?.state === 'committed', { timeoutMs: 20_000, label: 'put commits' });
    };
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    files(root, { 'people/alice-example': person('Works at acme-example; the Git edit.') });
    commitAll(root, 'git edit');
    let fired = false;
    installFaultHook(async (point, detail) => {
      if (point !== 'sync:mid_checkpoint' || detail.sourceId !== 'default' || fired) return;
      const [row] = await engine.executeRaw<{ pass_id: string | null }>("SELECT completed_keys->0->'telemetry'->>'pass_id' AS pass_id FROM op_checkpoints WHERE op='managed-sync-pass' AND completed_keys->0->>'source_id'='default'");
      if (!row?.pass_id || !Array.from({ length: 8 }, (_, b) => readPassBatch<{ pending?: { slug?: string } | null }>(`${PASS_BATCH_KEY_PREFIX}${row.pass_id}:${b}`)?.pending?.slug).includes(SLUG)) return;
      fired = true;
      await put('A database edit.');
    });
    try { expect((await performManagedSync(engine, OPTS)).held?.[0]?.code).toBe('concurrent_write'); } finally { installFaultHook(undefined); }
    files(root, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`people/clash${i}`, person('Slug conflict.', `slug: ${SLUG}\n`)])));
    commitAll(root, 'upstream adds conflicting slugs');
    await performManagedSync(engine, OPTS);
    return put;
  }

  test('passes that only re-hold a page edited before each of them build the streak, end abandoned, and status names the page with its ask', () => managedBrain(async ({ engine, ctx, root }) => {
    const put = await movingHold(engine, ctx as OperationContext, root);
    const inc = await incarnation(engine);
    const passes: Array<{ code: string; rewritten: boolean; moved: unknown; banked: boolean }> = [];
    for (let pass = 0; pass < 3; pass++) {
      await put(`A database edit before pass ${pass}.`);
      await stoppedSync(engine, 6);
      const telemetry = (await readPassRow(engine, 'default', inc))!.value.telemetry, hold: any = (await engine.executeRaw<{ r: unknown }>(
        "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' AND completed_keys->0->>'path'=$1", [PATH]))[0]!.r;
      passes.push({ code: hold.code, rewritten: hold.run_id === telemetry.pass_id, moved: hold.meta.basis_moved, banked: await passBanked(engine, 'default', inc, telemetry) });
    }
    const status: any = await readSyncStatus(engine, 'default');
    expect([status.state, status.reason]).toEqual(['blocked', 'pass_abandoned']);
    expect(status.needs_human).toBe(true);
    const hold = status.holds.find((h: { path: string }) => h.path === PATH);
    expect(hold.needs_human).toBe(true);
    expect(status.needs_human_from).toEqual({ kind: 'hold', path: PATH, slug: SLUG, code: hold.code });
    expect(status.human_reason).toBe(hold.human_reason);
    expect(status.next.user_message).toContain(`needs a decision: page ${SLUG}`);
    // Each pass re-checked the page because it moved, and rewrote its hold marked so; none of them counts as saved work.
    expect(passes).toEqual(Array.from({ length: 3 }, () => ({ code: hold.code, rewritten: true, moved: true, banked: false })));
  }, { databaseUrl, setup }), 600_000);

  test('a later re-check that is not a move clears the mark, so that hold counts as saved work again', () => managedBrain(async ({ engine, ctx, root }) => {
    const put = await movingHold(engine, ctx as OperationContext, root);
    const inc = await incarnation(engine);
    await put('A second database edit.');
    await stoppedSync(engine, 6);
    expect((await theHold(engine)).meta).toMatchObject({ basis_moved: true });
    // The page stops moving; an older drift screen's version makes the hold due for one re-check that is not a move.
    await coordinated(engine, "UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,drift_version}','1'::jsonb) WHERE op='sync-hold' AND completed_keys->0->>'path'=$1", [PATH]);
    await stoppedSync(engine, 6);
    const hold = await theHold(engine);
    expect(hold.meta.drift_version).toBe(FILE_DRIFT_VERSION);
    expect(hold.meta.basis_moved).toBeUndefined();
    expect(await passBanked(engine, 'default', inc, (await readPassRow(engine, 'default', inc))!.value.telemetry)).toBe(true);
  }, { databaseUrl, setup }), 600_000);
});
