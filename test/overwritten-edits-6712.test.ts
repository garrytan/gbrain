/**
 * #6712 follow-up: find and restore database edits an incremental managed sync silently overwrote.
 *
 * The overwrite is seeded the way it happens on a released brain: a database-only `put_page` (`sync.write_through`
 * off), then a committed edit of the same file, then an incremental sync that publishes the file over the edit with no
 * hold. On a base without #6887 any page reproduces it; the seed also drops the page's import provenance record (a page
 * last imported before PR 0 recorded one), which no released classifier guards in a delta sync, so the seed reproduces
 * with or without #6887 and these tests never depend on that fix.
 *
 * Protects:
 * - a seeded overwrite is detected `high` (also after receipt compaction nulled every intent), and `repair
 *   overwritten-edits` restores the edit through a database-only revert bound to the preview, leaves the committed file
 *   as it is, holds that file `file_drift`, and the next sync keeps the edit; the restored page is no longer reported;
 * - a normal sync-written history is not flagged: a file-only edit, a write-through edit later edited in Git, and a
 *   database-only edit no import replaced;
 * - a page that moved after the preview is `changed_since_preview`: nothing is restored and no hold is written;
 * - an apply interrupted after its restore committed but before the hold was written replays the same request and
 *   writes the hold, instead of reporting the restored page as moved;
 * - on a host that does not own the checkout the restore applies but reports the file left unheld
 *   (`restored_file_unheld`, `checkout_not_on_this_host`) with the owner host's command, and that command
 *   (`gbrain repair file-drift --prefer database`, run once the host owns the checkout) writes the edit to the file.
 *
 * Doctor `sync_overwritten_db_edits` warns with the source's count and slugs for a high finding and is ok otherwise.
 *
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { scanOverwrittenEdits } from '../src/core/persistence/overwritten-edits.ts';
import { clearGitHold, readGitHold, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { resolveRepairScope, type RepairItemOutcome } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { overwrittenEditsRepair } from '../src/core/repair/overwritten-edits.ts';
import { overwrittenEditsEntry } from '../src/commands/doctor/checks/overwritten-edits.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { waitFor } from './helpers/wait-for.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['notes/a', 'notes/b', 'notes/c', 'notes/d']) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
  commit(root, 'notes');
};
const incarnationOf = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='default'"))[0]!.incarnation;
const holdOf = async (engine: BrainEngine, path: string) => readGitHold(engine, 'default', await incarnationOf(engine), path);
const bodyOf = async (engine: BrainEngine, slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth ?? '';
const revisionOf = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
async function putPage(engine: BrainEngine, ctx: OperationContext, slug: string, body: string): Promise<void> {
  const requestId = randomUUID();
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId, expected_revision: await revisionOf(engine, slug), content: note(slug, body) } });
  await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed', { timeoutMs: 30_000 });
}
/** A database-only edit of `slug`, then a committed edit of its file and an incremental sync that publishes it over the edit. */
async function seedOverwrite(engine: BrainEngine, ctx: OperationContext, root: string, slug: string): Promise<void> {
  await engine.setConfig('sync.write_through', 'false');
  await putPage(engine, ctx, slug, 'DBONLYMARKER the agent edit.');
  await engine.setConfig('sync.write_through', 'true');
  const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [SYNC_IMPORT_PROVENANCE_OP, `default:${await incarnationOf(engine)}:${page!.id}`]);
  writeFileSync(join(root, `${slug}.md`), note(slug, 'The second committed body.'));
  commit(root, `edit ${slug}`);
  await performManagedSync(engine, OPTS);
  expect(await bodyOf(engine, slug)).toContain('The second committed body.');
}
const doctor = async (engine: BrainEngine) => ((await overwrittenEditsEntry.run({ engine, tier: 'standard', doFix: false, dryRun: false } as unknown as DoctorContext)) as Check[])[0]!;
const repair = async (engine: BrainEngine, opts: { expect?: string; slugs?: string[] } = {}) =>
  (await repairRunner(engine, { apply: opts.expect !== undefined, logger })).run('overwritten-edits', await resolveRepairScope(engine, 'default'),
    { explicit: true, sourceFlag: 'default', ...(opts.slugs ? { slugs: opts.slugs } : {}), ...(opts.expect ? { expect: opts.expect } : {}) });

for (const databaseUrl of process.env.DATABASE_URL ? [undefined, process.env.DATABASE_URL] : [undefined]) describe(`#6712 overwritten database edits (${databaseUrl ? 'postgres' : 'pglite'})`, () => {
  test('a seeded overwrite is detected and restored without publishing over the committed file', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await seedOverwrite(engine, ctx, root, 'notes/a');

    const scan = await scanOverwrittenEdits(engine, 'default');
    expect(scan.edits.map(edit => [edit.slug, edit.confidence, edit.db_operation])).toEqual([['notes/a', 'high', 'put_page']]);
    const warned = await doctor(engine);
    expect(warned.status).toBe('warn');
    expect(warned.details).toMatchObject({ count: 1, unknown: 0, sources: [{ source_id: 'default', count: 1, slugs: ['notes/a'] }] });
    expect(warned.fix?.argv).toEqual(['gbrain', 'repair', 'overwritten-edits', '--source', 'default', '--json']);
    expect(categorizeCheck('sync_overwritten_db_edits')).toBe('brain');

    await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw("UPDATE persistence_requests SET completed_at = now() - interval '400 days'"); });
    expect(await compactWriteReceipts(engine, 0)).toBeGreaterThan(0);
    expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE intent IS NOT NULL AND operation IN ('put_page','submit_job') AND slug='notes/a'"))[0]!.n).toBe(0);
    expect((await scanOverwrittenEdits(engine, 'default')).edits.map(edit => [edit.slug, edit.confidence])).toEqual([['notes/a', 'high']]);

    const preview = await repair(engine);
    expect(preview.listing?.map(entry => [entry.item, entry.class])).toEqual([['default:notes/a', 'restore_database_edit']]);
    expect(JSON.stringify(preview.details)).toContain('+DBONLYMARKER the agent edit.');
    expect(await bodyOf(engine, 'notes/a')).toContain('The second committed body.');

    const applied = await repair(engine, { expect: preview.preview_hash });
    expect(applied.outcome_items?.map(entry => entry.outcome)).toEqual(['restored_file_held']);
    expect(await bodyOf(engine, 'notes/a')).toContain('DBONLYMARKER');
    const [restore] = await engine.executeRaw<{ outcome: { write_through: { written: boolean; skipped?: string } }; worktree_id: string | null }>(
      "SELECT outcome, worktree_id::text AS worktree_id FROM persistence_requests WHERE operation='revert_version' AND slug='notes/a'");
    expect(restore!.outcome.write_through).toEqual({ written: false, skipped: 'overwrite_restore' });
    expect(restore!.worktree_id).toBeNull();
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain('The second committed body.');
    const hold = await holdOf(engine, 'notes/a.md');
    expect(hold?.code).toBe('file_drift');
    expect(hold?.meta.page_revision).toBe(await revisionOf(engine, 'notes/a'));

    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A third committed body.'));
    commit(root, 'edit a again');
    await performManagedSync(engine, OPTS);
    expect(await bodyOf(engine, 'notes/a')).toContain('DBONLYMARKER');
    expect((await holdOf(engine, 'notes/a.md'))?.code).toBe('file_drift');
    expect((await scanOverwrittenEdits(engine, 'default')).edits).toEqual([]);
    expect((await doctor(engine)).status).toBe('ok');
  }, { setup, databaseUrl }), 180_000);

  test('a normal sync-written history is not flagged', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await putPage(engine, ctx, 'notes/c', 'A write-through edit.');
    commit(root, 'write-through publication');
    await engine.setConfig('sync.write_through', 'false');
    await putPage(engine, ctx, 'notes/d', 'A database-only edit no import replaced.');
    await engine.setConfig('sync.write_through', 'true');
    writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'A file-only edit.'));
    writeFileSync(join(root, 'notes/c.md'), note('notes/c', 'A later committed body of c.'));
    commit(root, 'edit b and c');
    await performManagedSync(engine, OPTS);
    expect(await bodyOf(engine, 'notes/b')).toContain('A file-only edit.');
    expect(await bodyOf(engine, 'notes/c')).toContain('A later committed body of c.');
    expect(await bodyOf(engine, 'notes/d')).toContain('no import replaced');
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions'))[0]!.n).toBeGreaterThanOrEqual(3);
    const scan = await scanOverwrittenEdits(engine, 'default');
    expect(scan).toMatchObject({ high: 0, unknown: 0, edits: [], truncated: false });
    expect((await repair(engine)).listing).toEqual([]);
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { count: 0, unknown: 0 } });
  }, { setup, databaseUrl }), 180_000);

  test('a page that moved after the preview is refused and nothing is restored or held', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await seedOverwrite(engine, ctx, root, 'notes/a');
    const preview = await repair(engine, { slugs: ['notes/a'] });
    expect(preview.listing?.map(entry => entry.class)).toEqual(['restore_database_edit']);
    await engine.setConfig('sync.write_through', 'false');
    await putPage(engine, ctx, 'notes/a', 'A newer database edit after the preview.');
    const applied = await repair(engine, { slugs: ['notes/a'], expect: preview.preview_hash });
    expect(applied.outcome_items?.map(entry => [entry.outcome, entry.reason])).toEqual([['changed_since_preview', 'page_moved']]);
    expect(await bodyOf(engine, 'notes/a')).toContain('A newer database edit after the preview.');
    expect((await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE operation='revert_version'")).length).toBe(0);
    expect(await holdOf(engine, 'notes/a.md')).toBeNull();
  }, { setup, databaseUrl }), 180_000);

  test('an apply interrupted after its restore committed replays it and writes the hold', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const ctx = { engine, config: { engine: engine.kind }, logger, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
    await seedOverwrite(engine, ctx, root, 'notes/a');
    const preview = await repair(engine, { slugs: ['notes/a'] });
    const scope = await resolveRepairScope(engine, 'default');
    const [item] = (await overwrittenEditsRepair.plan(engine, scope, null, { apply: true, expect: preview.preview_hash, slugs: ['notes/a'] })).items;
    const first = await overwrittenEditsRepair.apply(ctx, item!) as RepairItemOutcome;
    expect(first.outcome).toBe('restored_file_held');
    const restored = await revisionOf(engine, 'notes/a');
    expect(await clearGitHold(engine, { sourceId: 'default', incarnation: await incarnationOf(engine), path: 'notes/a.md', observedAt: new Date().toISOString() })).toBe(true);
    expect(await holdOf(engine, 'notes/a.md')).toBeNull();

    const replay = await overwrittenEditsRepair.apply(ctx, item!) as RepairItemOutcome;
    expect([replay.outcome, replay.detail?.replayed, replay.detail?.request_id]).toEqual(['restored_file_held', true, first.detail?.request_id]);
    expect(await revisionOf(engine, 'notes/a')).toBe(restored);
    expect(await bodyOf(engine, 'notes/a')).toContain('DBONLYMARKER');
    expect((await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE operation='revert_version'")).length).toBe(1);
    expect((await holdOf(engine, 'notes/a.md'))?.meta.page_revision).toBe(restored);
  }, { setup, databaseUrl }), 180_000);

  test('a restore on a host that does not own the checkout reports the file left unheld and names the owner host command', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await seedOverwrite(engine, ctx, root, 'notes/a');
    const preview = await repair(engine, { slugs: ['notes/a'] });
    expect(preview.warnings?.join(' ')).toContain("Only the host that owns the source's checkout compares the file");
    await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id = $1::uuid', [randomUUID()]);
    const applied = await repair(engine, { slugs: ['notes/a'], expect: preview.preview_hash });
    const [outcome] = applied.outcome_items ?? [];
    expect([outcome?.outcome, outcome?.detail?.held, outcome?.detail?.why]).toEqual(['restored_file_unheld', false, 'checkout_not_on_this_host']);
    expect(String(outcome?.detail?.next)).toContain('gbrain repair file-drift --source default --slug notes/a --prefer database');
    expect(await bodyOf(engine, 'notes/a')).toContain('DBONLYMARKER');
    expect(await holdOf(engine, 'notes/a.md')).toBeNull();
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain('The second committed body.');

    await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id = $1::uuid', [localHostId()]);
    const scope = await resolveRepairScope(engine, 'default');
    const drift = { explicit: true, sourceFlag: 'default', slugs: ['notes/a'], prefer: 'database' as const };
    const driftPreview = await (await repairRunner(engine, { apply: false, logger })).run('file-drift', scope, drift);
    expect(driftPreview.listing?.map(entry => [entry.item, entry.class])).toEqual([['default:notes/a', 'prefer_database']]);
    const driftApplied = await (await repairRunner(engine, { apply: true, logger })).run('file-drift', scope, { ...drift, expect: driftPreview.preview_hash });
    expect(driftApplied.outcome_items?.map(entry => entry.outcome)).toEqual(['repaired']);
    expect(readFileSync(join(root, 'notes/a.md'), 'utf8')).toContain('DBONLYMARKER');
  }, { setup, databaseUrl }), 180_000);
});
