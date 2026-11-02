/**
 * #8071 (detection and repair half): a managed source whose checkpoint (`sources.last_commit`) moved past a commit while
 * the rows of the files that commit changed kept their old text, with no hold.
 *
 * The bug state is seeded the way a sync that skipped the import leaves it: the file is rewritten and committed, the
 * checkpoint is moved to that commit outside the owner's write guards, and the page's import record names the
 * checkpoint's blob: as `disk_blob_oid` next to the old `blob_oid` (the record a publication that re-read the moved
 * working file leaves, the root cause), or as both. An honest record that still names only the old blob is healed by the
 * next sync on its own; a record naming the new blob makes every later sync report up_to_date. The row keeps its old text.
 *
 * Protects:
 * - doctor `sync_rows_behind_checkpoint` compares each row with the file at the checkpoint commit (not the record, not
 *   the working tree) and warns with the count and the preview command; a plain sync does not heal the row;
 * - `gbrain repair rows-behind` previews the rows (writes nothing), applies exactly the previewed set through the managed
 *   import of the checkpoint's bytes, and the check is clean afterwards;
 * - a database edit made since the last import, a held path and a path changed after the checkpoint are not behind; a
 *   row with no import record is listed apart and joins the set only with --include-ambiguous;
 * - a checkpoint file the import refuses is held with the refusal's code instead of imported;
 * - the scan checks its deadline inside a batch and reports how far it got; doctor counts unproven rows without the
 *   importer's confirmation; a hold row applies the refusal the apply computes;
 * - a path sync does not read (`sync.exclude`) is not behind; an unreadable checkpoint commit is unknown, never clean;
 *   nested typed index pages are screened from the batch's checkpoint blobs, without a Git lookup per page;
 * - the apply refuses a reimport row whose page moved since the preview and a hold row whose import is no longer refused;
 * - repo-less: a brain with no checkout reports not_applicable (ok) and the preview lists nothing.
 *
 * PGLite always; Postgres too when DATABASE_URL is set (test/e2e wrapper).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { readGitHold, SYNC_IMPORT_PROVENANCE_OP, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { resolveRepairScope, type RepairKind } from '../src/core/repair/core.ts';
import { EXPLICIT_REPAIR_REGISTRY, repairRunner } from '../src/core/repair/registry.ts';
import { scanRowsBehind } from '../src/core/persistence/rows-behind.ts';
import { rowsBehindEntry } from '../src/commands/doctor/checks/rows-behind.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { SYNC_READ_BOUND } from '../src/core/persistence/sync-blobs.ts';
import { PREVIEW_APPROVAL_OP } from '../src/core/persistence/preview-approval.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const KIND = 'rows-behind' as RepairKind;
const CHECK = 'sync_rows_behind_checkpoint';
const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SLUGS = ['notes/a', 'notes/b', 'notes/c', 'notes/d', 'notes/e'];
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
  commit(root, 'notes');
};

const incarnationOf = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='default'"))[0]!.incarnation;
const pageOf = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ id: number; revision: string; body: string }>(
  "SELECT id, knowledge_revision::text AS revision, compiled_truth AS body FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;
const recordOf = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ record: Record<string, unknown> }>('SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
  [SYNC_IMPORT_PROVENANCE_OP, `default:${await incarnationOf(engine)}:${(await pageOf(engine, slug)).id}`]))[0]?.record ?? null;
const doctor = async (engine: BrainEngine) => (await rowsBehindEntry.run({ engine, tier: 'standard' } as never) as Array<Record<string, any>>)[0]!;
const repair = async (engine: BrainEngine, opts: { apply?: boolean; expect?: string; includeAmbiguous?: boolean } = {}) => (await repairRunner(engine, { apply: opts.apply === true, logger }))
  .run(KIND, await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', expect: opts.expect, includeAmbiguous: opts.includeAmbiguous });
const listing = (plan: { listing?: Array<{ item: string; class: string }> }) => (plan.listing ?? []).map(entry => [entry.item, entry.class]).sort();

/** Writes outside the owner's write guards, as only its publications may (the checkpoint and the import record). */
async function unguarded(engine: BrainEngine, write: () => Promise<void>): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { await write(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

/**
 * Commits new contents for each slug's file, then moves the checkpoint to that commit without importing it. `record`:
 * `checkpoint` rewrites the page's import record to name the new blob as both blobs; `disk` names the old blob as
 * `blob_oid` and the new one as `disk_blob_oid` (the record a publication that re-read the moved working file leaves,
 * #8071 root cause); `none` deletes it (a page last imported before records existed).
 */
async function seedBehind(engine: BrainEngine, root: string, files: Record<string, { content: string; record: 'checkpoint' | 'disk' | 'none' }>): Promise<string> {
  for (const [slug, file] of Object.entries(files)) writeFileSync(join(root, `${slug}.md`), file.content);
  commit(root, 'rewrite');
  const head = git(root, 'rev-parse', 'HEAD');
  const incarnation = await incarnationOf(engine);
  await unguarded(engine, async () => {
    await engine.executeRaw("UPDATE sources SET last_commit=$1 WHERE id='default'", [head]);
    for (const [slug, file] of Object.entries(files)) {
      const fingerprint = `default:${incarnation}:${(await pageOf(engine, slug)).id}`;
      if (file.record === 'none') { await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [SYNC_IMPORT_PROVENANCE_OP, fingerprint]); continue; }
      const blob = git(root, 'rev-parse', `HEAD:${slug}.md`);
      const imported = file.record === 'disk' ? git(root, 'rev-parse', `HEAD~1:${slug}.md`) : blob;
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0}', completed_keys->0 || jsonb_build_object('blob_oid', $3::text, 'disk_blob_oid', $4::text))
        WHERE op=$1 AND fingerprint=$2`, [SYNC_IMPORT_PROVENANCE_OP, fingerprint, imported, blob]);
    }
  });
  return head;
}

async function putDatabaseOnly(engine: BrainEngine, ctx: OperationContext, slug: string, body: string): Promise<void> {
  await engine.setConfig('sync.write_through', 'false');
  try {
    const requestId = randomUUID();
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId, expected_revision: (await pageOf(engine, slug)).revision, content: note(slug, body) } });
    await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed', { timeoutMs: 30_000 });
  } finally { await engine.setConfig('sync.write_through', 'true'); }
}

for (const backend of testBackends()) describe(`[${backend}] #8071: rows behind the sync checkpoint`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a row the checkpoint moved past is reported, previewed without writing, re-imported, and the check is clean', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const before = await pageOf(engine, 'notes/a');
    const oldBlob = git(root, 'rev-parse', 'HEAD:notes/a.md');
    const head = await seedBehind(engine, root, { 'notes/a': { content: note('notes/a', 'The redacted body of notes/a.'), record: 'disk' } });
    const newBlob = git(root, 'rev-parse', 'HEAD:notes/a.md');
    expect(await recordOf(engine, 'notes/a')).toMatchObject({ blob_oid: oldBlob, disk_blob_oid: newBlob });

    // Nothing heals it: the next sync trusts the record and reports the source caught up.
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect((await pageOf(engine, 'notes/a')).body).toContain('The committed body of notes/a.');

    const scan = await scanRowsBehind(engine, 'default');
    expect(scan).toMatchObject({ status: 'known', checkpoint: head, complete: true });
    expect(scan.behind.map(row => [row.slug, row.path])).toEqual([['notes/a', 'notes/a.md']]);

    const warned = await doctor(engine);
    expect(categorizeCheck(CHECK)).toBe('brain');
    expect(warned).toMatchObject({ name: CHECK, status: 'warn', details: { count: 1, sources: [{ source_id: 'default', checkpoint: head, behind: 1, samples: ['notes/a'] }] } });
    expect(warned.message).toContain('gbrain repair rows-behind --source default');
    expect(warned.fix.argv).toEqual(['gbrain', 'repair', 'rows-behind', '--source', 'default', '--json']);

    expect(EXPLICIT_REPAIR_REGISTRY.map(spec => spec.kind)).toContain(KIND);
    const requestsBefore = (await engine.executeRaw('SELECT 1 FROM persistence_requests')).length;
    const preview = await repair(engine);
    expect(listing(preview)).toEqual([['default:notes/a', 'reimport']]);
    expect(preview.affected).toBe(1);
    expect(await pageOf(engine, 'notes/a')).toEqual(before);
    expect((await engine.executeRaw('SELECT 1 FROM persistence_requests')).length).toBe(requestsBefore);

    const applied = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(applied.outcome_items?.map(item => [item.item, item.outcome])).toEqual([['default:notes/a', 'reimported']]);
    expect((await pageOf(engine, 'notes/a')).body).toContain('The redacted body of notes/a.');
    // The re-import rewrites the stale record: it names the bytes the row now holds and no longer the old blob.
    const rewritten = await recordOf(engine, 'notes/a');
    expect(rewritten).toMatchObject({ disk_blob_oid: newBlob });
    expect([rewritten?.blob_oid, rewritten?.disk_blob_oid]).not.toContain(oldBlob);
    expect(await doctor(engine)).toMatchObject({ name: CHECK, status: 'ok', details: { count: 0 } });
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect((await pageOf(engine, 'notes/a')).body).toContain('The redacted body of notes/a.');
    // The rewritten record no longer matches a later commit's blob, so the next sync imports it.
    writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'A later body of notes/a.'));
    commit(root, 'later');
    await performManagedSync(engine, OPTS);
    expect((await pageOf(engine, 'notes/a')).body).toContain('A later body of notes/a.');
    expect(await doctor(engine)).toMatchObject({ name: CHECK, status: 'ok', details: { count: 0 } });
  }, { databaseUrl, setup }), 240_000);

  test('a database edit since the import, a held path and a later commit are not behind; a row without a record needs --include-ambiguous', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await putDatabaseOnly(engine, ctx, 'notes/b', 'A database-only edit of notes/b.');
    await seedBehind(engine, root, {
      'notes/c': { content: note('notes/c', 'The redacted body of notes/c.'), record: 'checkpoint' },
      'notes/d': { content: note('notes/d', 'The redacted body of notes/d.'), record: 'none' },
      'notes/e': { content: note('notes/e', 'The redacted body of notes/e.'), record: 'checkpoint' },
    });
    const c = await pageOf(engine, 'notes/c');
    const incarnation = await incarnationOf(engine);
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: 'notes/c.md', source_path: 'notes/c.md', slug: 'notes/c',
      page_id: Number(c.id), code: 'file_drift', message: 'held for the test', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION } }));
    // notes/e changes again after the checkpoint: the next sync imports it, so it is not reported behind.
    writeFileSync(join(root, 'notes/e.md'), note('notes/e', 'A later body of notes/e.'));
    commit(root, 'later');

    const scan = await scanRowsBehind(engine, 'default');
    expect(scan.behind).toEqual([]);
    expect(scan.unproven.map(row => row.slug)).toEqual(['notes/d']);
    expect(scan.counts).toMatchObject({ held: 1, database_moved: 1, changed_after_checkpoint: 1 });
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { count: 0, unproven: 1 } });

    const preview = await repair(engine);
    expect(listing(preview)).toEqual([['default:notes/d', 'excluded:unproven']]);
    expect(preview.affected).toBe(0);
    const widened = await repair(engine, { includeAmbiguous: true });
    expect(listing(widened)).toEqual([['default:notes/d', 'reimport']]);
    const applied = await repair(engine, { apply: true, expect: widened.preview_hash, includeAmbiguous: true });
    expect(applied.outcome_items?.map(item => [item.item, item.outcome])).toEqual([['default:notes/d', 'reimported']]);
    expect((await pageOf(engine, 'notes/d')).body).toContain('The redacted body of notes/d.');
    expect((await pageOf(engine, 'notes/b')).body).toContain('A database-only edit of notes/b.');
    expect((await pageOf(engine, 'notes/c')).body).toContain('The committed body of notes/c.');
  }, { databaseUrl, setup }), 240_000);

  test('a checkpoint file the import refuses is held with the refusal code instead of imported', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await seedBehind(engine, root, { 'notes/a': { content: '---\ntype: concept\ntitle: [unclosed\n---\n\nThe redacted body of notes/a.\n', record: 'checkpoint' } });
    expect((await doctor(engine))).toMatchObject({ status: 'warn', details: { count: 1 } });
    const preview = await repair(engine);
    expect(listing(preview)).toEqual([['default:notes/a', 'hold:invalid_frontmatter']]);
    const applied = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(applied.outcome_items?.map(item => [item.item, item.outcome])).toEqual([['default:notes/a', 'held']]);
    expect((await readGitHold(engine, 'default', await incarnationOf(engine), 'notes/a.md'))?.code).toBe('invalid_frontmatter');
    expect((await pageOf(engine, 'notes/a')).body).toContain('The committed body of notes/a.');
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { count: 0 } });
  }, { databaseUrl, setup }), 240_000);

  test('a page stored in segments is compared by hash and re-imported; a file over the read bound is held file_too_large without being read', () => managedBrain(async ({ engine, root }) => {
    const big = (marker: string) => note('notes/big', Array.from({ length: 30_000 }, (_, i) => `${marker} line ${i} of a large page body.`).join('\n'));
    writeFileSync(join(root, 'notes/big.md'), big('Committed')); commit(root, 'big');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    expect((await engine.executeRaw<{ storage: string }>("SELECT body_storage AS storage FROM pages WHERE source_id='default' AND slug='notes/big'"))[0]!.storage).toBe('segmented');
    await seedBehind(engine, root, {
      'notes/big': { content: big('Redacted'), record: 'checkpoint' },
      'notes/a': { content: note('notes/a', 'x'.repeat(SYNC_READ_BOUND + 1)), record: 'checkpoint' },
    });
    const scan = await scanRowsBehind(engine, 'default');
    expect(scan.behind.map(row => [row.slug, row.refusal?.code ?? null]).sort()).toEqual([['notes/a', 'file_too_large'], ['notes/big', null]]);
    const preview = await repair(engine);
    expect(listing(preview)).toEqual([['default:notes/a', 'hold:file_too_large'], ['default:notes/big', 'reimport']]);
    const applied = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(applied.outcome_items?.map(item => [item.item, item.outcome]).sort()).toEqual([['default:notes/a', 'held'], ['default:notes/big', 'reimported']]);
    expect(await readGitHold(engine, 'default', await incarnationOf(engine), 'notes/a.md')).toMatchObject({ code: 'file_too_large', upstream_version: null });
    const live = (marker: string) => engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM page_body_manifest m JOIN pages p ON p.id = m.page_id JOIN page_segment_texts t ON t.source_id = m.source_id AND t.sha256 = m.sha256 WHERE p.source_id = 'default' AND p.slug = 'notes/big' AND m.gen_to IS NULL AND m.staging_id IS NULL AND position(convert_to($1, 'UTF8') in t.body) > 0",
      [marker],
    ).then(rows => rows[0]!.n);
    expect(await live('Committed line 0 of')).toBe(0);
    expect(await live('Redacted line 0 of')).toBeGreaterThan(0);
    expect((await scanRowsBehind(engine, 'default')).behind).toEqual([]);
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { count: 0 } });
  }, { databaseUrl, setup }), 240_000);

  test('the scan checks its deadline inside a batch and says how far it got; doctor counts unproven rows without confirming them', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await seedBehind(engine, root, Object.fromEntries(SLUGS.map(slug => [slug, { content: note(slug, `The redacted body of ${slug}.`), record: slug === 'notes/e' ? 'none' as const : 'checkpoint' as const }])));
    const full = await scanRowsBehind(engine, 'default');
    expect(full).toMatchObject({ complete: true, pages: 5, behind_count: 4, unproven_count: 1 });
    expect(full.unproven[0]!.digest).toBeDefined();

    // A clock that passes the deadline on its eighth read (one before the batch, five before the comparisons, one before
    // the first confirmation): the one batch of five rows must stop part way through, after one confirmed row.
    let reads = 0;
    const stopped = await scanRowsBehind(engine, 'default', { deadlineAt: 1, now: () => (reads++ < 7 ? 0 : 1) });
    expect(stopped.complete).toBe(false);
    expect(stopped.pages).toBeGreaterThan(0);
    expect(stopped.pages).toBeLessThan(5);
    expect(typeof stopped.stopped_at).toBe('number');
    expect(stopped.behind_count + stopped.unproven_count).toBeLessThan(5);
    expect(Object.values(stopped.counts).reduce((sum, n) => sum + n, 0) + stopped.behind_count + stopped.unproven_count).toBe(stopped.pages);

    const counted = await scanRowsBehind(engine, 'default', { confirmUnproven: false });
    expect(counted).toMatchObject({ complete: true, behind_count: 4, unproven_count: 1 });
    expect(counted.unproven[0]!.digest).toBeUndefined();
    const warned = await doctor(engine);
    expect(warned).toMatchObject({ status: 'warn', details: { count: 4, unproven: 1 } });
    expect(warned.message).toContain('replaces any database-only edit');

    // gstack-timing-ok: a 1 ms scan deadline forces the time-bounded path; no elapsed time is asserted
    const partial = await withEnv({ GBRAIN_DOCTOR_ROWS_BEHIND_TIMEOUT_MS: '1' }, async () => { await new Promise(resolve => setTimeout(resolve, 5)); return doctor(engine); });
    expect(partial).toMatchObject({ status: 'ok', details: { sources: [{ complete: false }] } });
    expect(partial.message).toMatch(/stopped after \d+ page\(s\)/);
  }, { databaseUrl, setup }), 240_000);

  test('a hold row applies the refusal the apply computes, not the one saved with the preview', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await seedBehind(engine, root, { 'notes/a': { content: '---\ntype: concept\ntitle: [unclosed\n---\n\nThe redacted body of notes/a.\n', record: 'checkpoint' } });
    const preview = await repair(engine);
    expect(listing(preview)).toEqual([['default:notes/a', 'hold:invalid_frontmatter']]);
    // Age the saved set: its refusal no longer matches what the import of the committed file says.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,items,0,refusal}', '{"code":"invalid_fence","message":"saved with an older preview"}'::jsonb)
      WHERE op=$1 AND completed_keys->0->>'hash'=$2`, [PREVIEW_APPROVAL_OP, preview.preview_hash]);
    const applied = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(applied.outcome_items?.map(item => [item.item, item.outcome])).toEqual([['default:notes/a', 'held']]);
    const hold = await readGitHold(engine, 'default', await incarnationOf(engine), 'notes/a.md');
    expect(hold?.code).toBe('invalid_frontmatter');
    expect(hold?.message).not.toContain('saved with an older preview');
  }, { databaseUrl, setup }), 240_000);

  test('a path sync does not read (sync.exclude) is not behind; an unreadable checkpoint commit is unknown, never clean', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.exclude', 'notes/a.md');
    await seedBehind(engine, root, { 'notes/a': { content: note('notes/a', 'The redacted body of notes/a.'), record: 'checkpoint' } });
    const scan = await scanRowsBehind(engine, 'default');
    expect(scan.behind).toEqual([]);
    expect(scan.counts).toMatchObject({ not_eligible: 1 });
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { count: 0 } });
    const preview = await repair(engine);
    expect(listing(preview)).toEqual([]);
    expect((await pageOf(engine, 'notes/a')).body).toContain('The committed body of notes/a.');

    await unguarded(engine, () => engine.executeRaw("UPDATE sources SET last_commit=$1 WHERE id='default'", ['f'.repeat(40)]).then(() => {}));
    expect(await scanRowsBehind(engine, 'default')).toMatchObject({ status: 'unknown', reason: 'checkpoint_unreadable', complete: false });
    expect(await doctor(engine)).toMatchObject({ name: CHECK, status: 'ok', readiness_state: 'unknown' });
  }, { databaseUrl, setup }), 240_000);

  test('nested typed index pages are screened with one batched head read per batch, not a Git read per page; a large one is read alone', () => managedBrain(async ({ engine, root }) => {
    for (const dir of ['notes/s1', 'notes/s2', 'notes/s3']) { mkdirSync(join(root, dir), { recursive: true }); writeFileSync(join(root, dir, 'index.md'), note(dir, `The index of ${dir}.`)); }
    mkdirSync(join(root, 'notes/big'), { recursive: true });
    writeFileSync(join(root, 'notes/big/index.md'), note('notes/big', 'A long index line.\n'.repeat(5_000)));
    commit(root, 'indexes');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const trace = join(tmpdir(), `gbrain-rows-behind-trace-${randomUUID()}.log`);
    try {
      const scan = await withEnv({ GIT_TRACE: trace }, () => scanRowsBehind(engine, 'default'));
      expect(scan).toMatchObject({ status: 'known', complete: true, behind: [], pages: 9 });
      // The small index pages' heads come from one batched read of their checkpoint blobs, never a lookup per page. A blob
      // larger than the head kept is not loaded into the batch's read; its head is read on its own (one lookup).
      expect(readFileSync(trace, 'utf8').split('\n').filter(line => line.includes('cat-file') && line.includes('--batch-check'))).toHaveLength(1);
    } finally { rmSync(trace, { force: true }); }
  }, { databaseUrl, setup }), 240_000);

  test('the apply refuses a reimport row whose page moved since the preview and a hold row whose import is no longer refused', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await seedBehind(engine, root, {
      'notes/a': { content: note('notes/a', 'The redacted body of notes/a.'), record: 'checkpoint' },
      'notes/b': { content: note('notes/b', 'The redacted body of notes/b.'), record: 'checkpoint' },
    });
    const preview = await repair(engine);
    expect(listing(preview)).toEqual([['default:notes/a', 'reimport'], ['default:notes/b', 'reimport']]);
    await putDatabaseOnly(engine, ctx, 'notes/a', 'A database-only edit of notes/a.');
    // The saved set names notes/b as a hold, as a preview taken while its import was refused would have.
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(jsonb_set(completed_keys, '{0,items,1,action}', '"hold"'), '{0,items,1,refusal}', '{"code":"invalid_frontmatter","message":"saved with an older preview"}'::jsonb)
      WHERE op=$1 AND completed_keys->0->>'hash'=$2 AND completed_keys->0->'items'->1->>'slug'='notes/b'`, [PREVIEW_APPROVAL_OP, preview.preview_hash]);
    const applied = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(applied.outcome_items?.map(item => [item.item, item.outcome, item.reason])).toEqual([
      ['default:notes/a', 'changed_since_preview', 'page_moved'], ['default:notes/b', 'changed_since_preview', 'import_no_longer_refused']]);
    expect((await pageOf(engine, 'notes/a')).body).toContain('A database-only edit of notes/a.');
    expect((await pageOf(engine, 'notes/b')).body).toContain('The committed body of notes/b.');
    expect(await readGitHold(engine, 'default', await incarnationOf(engine), 'notes/b.md')).toBeNull();
  }, { databaseUrl, setup }), 240_000);

  test('repo-less: a brain with no checkout is not applicable and the preview lists nothing', async () => {
    const home = (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'gbrain-rows-behind-'));
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.putPage('notes/a', { type: 'concept', title: 'notes/a', compiled_truth: 'A page only the database holds.' }, { sourceId: 'default' });
        expect(await scanRowsBehind(engine, 'default')).toMatchObject({ status: 'not_applicable' });
        expect(await doctor(engine)).toMatchObject({ name: CHECK, status: 'ok', readiness_state: 'not_applicable' });
        const preview = await repair(engine);
        expect(preview.affected).toBe(0);
        expect(preview.listing ?? []).toEqual([]);
      } finally { await close(); }
    });
  }, 120_000);
});
