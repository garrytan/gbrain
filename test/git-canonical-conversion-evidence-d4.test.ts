/**
 * d4 and items 2, 3, 6 and 7 of the convergence plan's PR A, on a managed brain: a page with no import record converts
 * by content evidence (never a timestamp), undecided pages wait on an owner's decisions file, a database write that races
 * the recheck is held instead of overwritten, a failed apply reports where it stopped and how to roll back without
 * rewriting, and an approval applies across time to the pages unchanged since it was given.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { applyApprovedConversion, applyGitConversion, applyMixedConversion, conversionApproval, conversionRecovery, conversionReviewList, planGitConversion,
  planMixedConversion, readConversionApproval, readConversionDecisions, writeConversionFile, type ConversionDecision } from '../src/core/persistence/git-conversion.ts';
import { previewReindex, runSourcesReindex } from '../src/commands/sources-reindex.ts';
import { runSourcesCanonical } from '../src/commands/sources-canonical.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => '---\ntype: concept\ntitle: ' + slug + '\n---\n\n' + body + '\n';
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const PROCESSING = { noEmbed: true, noExtract: true };
const SLUGS = ['notes/same', 'notes/db', 'notes/file', 'notes/both', 'notes/none'];
const DB_EDIT = (slug: string) => `Written to the database alone: ${slug}.`;
const GIT_EDIT = (slug: string) => `Edited by a plain git commit: ${slug}.`;

const strict = async (engine: BrainEngine) => (await engine.executeRaw<{ s: boolean }>("SELECT COALESCE(config->>'canonical','')='git' AS s FROM sources WHERE id='default'"))[0]!.s;
const body = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ body: string }>("SELECT compiled_truth AS body FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]))[0]?.body;
const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => r.path);
const databaseOnlyEdit = (engine: BrainEngine, slug: string, text: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
  "UPDATE pages SET compiled_truth=$1, knowledge_revision=$2::uuid, revision_write_request_id=NULL WHERE source_id='default' AND slug=$3", [text, randomUUID(), slug]), TEST_WRITE_ATTRIBUTION));
async function dropImportRecord(engine: BrainEngine, slug: string): Promise<void> {
  const [row] = await engine.executeRaw<{ id: string }>("SELECT id::text FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-import-provenance' AND fingerprint LIKE $1", [`default:%:${row!.id}`]);
}
const conversionShas = (root: string, since: string) => git(root, 'log', '--reverse', '--format=%H', `${since}..HEAD`).split('\n').filter(Boolean);

async function cli(engine: BrainEngine, args: string[]): Promise<Record<string, any>> {
  const lines: string[] = [];
  const log = console.log, priorExitCode = process.exitCode;
  console.log = (line: unknown) => { lines.push(String(line)); };
  try { await runSourcesCanonical(engine, [...args, '--json']); } finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
  return JSON.parse(lines.at(-1)!);
}

const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
};

/**
 * After the first sync every page but notes/same loses its import record, as pages imported before records existed have none:
 *   notes/db: a writer archived its preimage and edited the row (only the database moved: adopt);
 *   notes/file: a plain git commit edited the file, and then a non-content updated_at bump (only the file moved: Git wins);
 *   notes/both: both of the above (both moved: a decision);
 *   notes/none: a row edit with no archived version (no evidence: a decision).
 */
async function evidenceSource(brain: ManagedBrain): Promise<void> {
  const { engine, root } = brain;
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  for (const slug of ['notes/db', 'notes/both']) { await engine.createVersion(slug, { sourceId: 'default' }); await databaseOnlyEdit(engine, slug, DB_EDIT(slug)); }
  await databaseOnlyEdit(engine, 'notes/none', DB_EDIT('notes/none'));
  for (const slug of ['notes/db', 'notes/file', 'notes/both', 'notes/none']) await dropImportRecord(engine, slug);
  for (const slug of ['notes/file', 'notes/both']) writeFileSync(join(root, `${slug}.md`), note(slug, GIT_EDIT(slug)));
  git(root, 'commit', '-qam', 'plain git edit');
  await engine.executeRaw("UPDATE pages SET updated_at = now() + interval '30 days' WHERE source_id='default' AND slug IN ('notes/file','notes/both')");
}

/** The owner's decisions for the two undecided pages, written as the review list with "decision" filled in. */
async function decide(brain: ManagedBrain, dir: string, picks: Record<string, ConversionDecision['decision']>): Promise<ConversionDecision[]> {
  const list = await conversionReviewList(brain.engine, await planGitConversion(brain.engine, 'default'));
  const file = join(dir, 'decisions.json');
  await writeConversionFile(brain.engine, file, '--list-out', { ...list, pages: list.pages.map(entry => ({ ...(entry as object), decision: picks[(entry as { slug: string }).slug] ?? null })) });
  return readConversionDecisions(brain.engine, file, 'default');
}

for (const backend of testBackends()) describe(`[${backend}] conversion by content evidence (convergence PR A)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const outside = () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-conversion-files-')); return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }; };

  test('d4 and the timestamp trap: each page goes to the side that moved, and the undecided ones wait on a decisions file bound into the hash', () => managedBrain(async brain => {
    const { engine, root } = brain;
    const files = outside();
    try {
      await evidenceSource(brain);
      const plan = await planGitConversion(engine, 'default');
      expect(plan.preview).toMatchObject({ evidence: { count: 4, by: { adopt_db_moved: 1, git_wins_file_moved: 1, both_moved: 1, no_evidence: 1 } },
        git_wins: { by: { file_moved: 1 } }, discard: { count: 2, by: { no_record_both_moved: 1, no_record_no_evidence: 1 } }, decisions: { digest: null } });
      expect(plan.preview.adopt.sample).toEqual(['notes/db.md']);
      expect(plan.preview.git_wins.sample).toEqual(['notes/file.md']);
      await expect(applyGitConversion(engine, 'default', plan.preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'git_conversion_blocked' });

      // Item 2: the review list and decisions are written 0600 and refused under a source root.
      await expect(writeConversionFile(engine, join(root, 'review.json'), '--list-out', {})).rejects.toMatchObject({ code: 'conversion_file_in_source_root' });
      expect((await cli(engine, ['default', '--to', 'git', '--dry-run', '--list-out', join(root, 'notes', 'review.json')]))).toMatchObject({ status: 'refused', code: 'conversion_file_in_source_root' });
      const list = await conversionReviewList(engine, plan);
      expect(list.pages.map(entry => (entry as { slug: string }).slug).sort()).toEqual(['notes/both', 'notes/none']);
      const decisions = await decide(brain, files.dir, { 'notes/both': 'git_wins', 'notes/none': 'adopt' });
      expect(statSync(join(files.dir, 'decisions.json')).mode & 0o777).toBe(0o600);
      const decided = await planGitConversion(engine, 'default', { decisions });
      expect(decided.preview).toMatchObject({ discard: { count: 0 }, decisions: { applied: 2, stale: 0, unused: 0 }, git_wins: { by: { file_moved: 1, decided: 1 } } });
      expect(decided.preview.decisions.digest).not.toBeNull();
      expect(decided.preview.preview_hash).not.toBe(plan.preview.preview_hash);
      await expect(applyGitConversion(engine, 'default', decided.preview.preview_hash, PROCESSING)).rejects.toMatchObject({ code: 'preview_changed' });

      // A decision names a page at its revision: once the page moves again, the decision is stale and not applied.
      await databaseOnlyEdit(engine, 'notes/none', 'Edited once more.');
      expect((await planGitConversion(engine, 'default', { decisions })).preview).toMatchObject({ decisions: { applied: 1, stale: 1 }, discard: { by: { no_record_no_evidence: 1 } } });
      await databaseOnlyEdit(engine, 'notes/none', DB_EDIT('notes/none'));
      const again = await decide(brain, files.dir, { 'notes/both': 'git_wins', 'notes/none': 'adopt' });
      const final = await planGitConversion(engine, 'default', { decisions: again });
      // The printed apply carries the decisions file the hash binds, so running it exactly as printed applies.
      const printed = await cli(engine, ['default', '--to', 'git', '--dry-run', '--decisions', join(files.dir, 'decisions.json')]);
      expect(printed.apply).toEqual(['gbrain', 'sources', 'canonical', 'default', '--to', 'git', '--apply', '--expect', final.preview.preview_hash, '--decisions', join(files.dir, 'decisions.json')]);
      expect(again).toHaveLength(2);
      expect(await cli(engine, [...printed.apply.slice(3), '--no-embed', '--no-extract'])).toMatchObject({ status: 'converted', reclassified: [] });
      expect(await body(engine, 'notes/file')).toContain(GIT_EDIT('notes/file'));
      expect(await body(engine, 'notes/both')).toContain(GIT_EDIT('notes/both'));
      expect(await body(engine, 'notes/db')).toContain(DB_EDIT('notes/db'));
      expect(readFileSync(join(root, 'notes/db.md'), 'utf8')).toContain(DB_EDIT('notes/db'));
      expect(readFileSync(join(root, 'notes/none.md'), 'utf8')).toContain(DB_EDIT('notes/none'));
      expect(await strict(engine)).toBe(true);
    } finally { files.done(); }
  }, { databaseUrl, setup }), 240_000);

  test('item 3: a database write that races the recheck is held, never overwritten, and the source stays mixed', () => managedBrain(async brain => {
    const { engine, root } = brain;
    const files = outside();
    try {
      await evidenceSource(brain);
      const base = git(root, 'rev-parse', 'HEAD');
      const decisions = await decide(brain, files.dir, { 'notes/both': 'git_wins', 'notes/none': 'adopt' });
      const { preview } = await planGitConversion(engine, 'default', { decisions });
      installFaultHook(async point => { if (point === 'conversion:after_recheck') await databaseOnlyEdit(engine, 'notes/file', 'A racing database write.'); });
      let error: unknown;
      try { await applyGitConversion(engine, 'default', preview.preview_hash, { ...PROCESSING, decisions }); } catch (caught) { error = caught; } finally { installFaultHook(undefined); }
      expect(error).toMatchObject({ code: 'git_conversion_incomplete', detail: 'changed_since_preview' });
      expect(await body(engine, 'notes/file')).toBe('A racing database write.');
      expect(await strict(engine)).toBe(false);
      expect(await holds(engine)).toContain('notes/file.md');
      expect(conversionRecovery(error)).toMatchObject({ mode: 'mixed', reclassified: ['notes/file.md'], commits: conversionShas(root, base), rollback: [] });
    } finally { files.done(); }
  }, { databaseUrl, setup }), 240_000);

  const staleHold = async (engine: BrainEngine, incarnation: string, slug: string) => {
    const [page] = await engine.executeRaw<{ id: string }>("SELECT id::text FROM pages WHERE source_id='default' AND slug=$1", [slug]);
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: `${slug}.md`, source_path: `${slug}.md`, slug, page_id: Number(page!.id),
      code: 'concurrent_write', message: 'A write moved the page during the pass.', upstream_version: '0'.repeat(64), observed_at: new Date().toISOString(),
      run_id: null, mode: 'managed', meta: { recovery_version: 1, blob_oid: '0'.repeat(40) } }));
  };

  test('item 3: a hold written after the plan over a page that moved since is bound, so its re-run never imports over the database', () => managedBrain(async brain => {
    const { engine } = brain;
    const files = outside();
    try {
      await evidenceSource(brain);
      const decisions = await decide(brain, files.dir, { 'notes/both': 'git_wins', 'notes/none': 'adopt' });
      const plan = await planGitConversion(engine, 'default', { decisions });
      installFaultHook(async point => {
        if (point !== 'conversion:after_recheck') return;
        await databaseOnlyEdit(engine, 'notes/file', 'A racing database write under a hold.');
        await staleHold(engine, plan.incarnation, 'notes/file');
      });
      let error: unknown;
      try { await applyGitConversion(engine, 'default', plan.preview.preview_hash, { ...PROCESSING, decisions }); } catch (caught) { error = caught; } finally { installFaultHook(undefined); }
      expect(error).toMatchObject({ code: 'git_conversion_incomplete', detail: 'changed_since_preview' });
      expect(await body(engine, 'notes/file')).toBe('A racing database write under a hold.');
      expect(conversionRecovery(error)).toMatchObject({ mode: 'mixed', reclassified: ['notes/file.md'] });
      expect(await strict(engine)).toBe(false);
    } finally { files.done(); }
  }, { databaseUrl, setup }), 240_000);

  test('item 3: a planned hold another run replaced after the plan stops the apply before any strict pass', () => managedBrain(async brain => {
    const { engine } = brain;
    const files = outside();
    try {
      await evidenceSource(brain);
      const decisions = await decide(brain, files.dir, { 'notes/both': 'git_wins', 'notes/none': 'adopt' });
      await staleHold(engine, (await planGitConversion(engine, 'default')).incarnation, 'notes/same');
      const plan = await planGitConversion(engine, 'default', { decisions });
      expect(plan.holds.map(hold => hold.path)).toEqual(['notes/same.md']);
      installFaultHook(async point => {
        if (point !== 'conversion:after_recheck') return;
        await new Promise(resolve => setTimeout(resolve, 5));
        await staleHold(engine, plan.incarnation, 'notes/same');
      });
      let error: unknown;
      try { await applyGitConversion(engine, 'default', plan.preview.preview_hash, { ...PROCESSING, decisions }); } catch (caught) { error = caught; } finally { installFaultHook(undefined); }
      expect(error).toMatchObject({ code: 'git_conversion_incomplete', detail: 'changed_since_preview' });
      expect(conversionRecovery(error)).toMatchObject({ mode: 'mixed', phase: 'holds' });
      expect(await strict(engine)).toBe(false);
      expect(await holds(engine)).toContain('notes/same.md');
    } finally { files.done(); }
  }, { databaseUrl, setup }), 240_000);

  test('item 6: a failure after the flip reports the mode, commits, push and writes, and the rollback keeps the adopted pages\' live content', () => managedBrain(async brain => {
    const { engine, root } = brain;
    const files = outside();
    try {
      await evidenceSource(brain);
      const base = git(root, 'rev-parse', 'HEAD');
      const decisions = await decide(brain, files.dir, { 'notes/both': 'git_wins', 'notes/none': 'adopt' });
      const { preview } = await planGitConversion(engine, 'default', { decisions });
      let error: unknown;
      try {
        await applyGitConversion(engine, 'default', preview.preview_hash, { ...PROCESSING, decisions, onProgress: progress => { if (progress.phase === 'strict_pass_2') throw new Error('stopped in the second strict pass'); } });
      } catch (caught) { error = caught; }
      expect(String(error)).toContain('stopped in the second strict pass');
      const recovery = conversionRecovery(error)!;
      expect(recovery).toMatchObject({ mode: 'git', phase: 'strict_pass_2', accepted: { adopted: 2, withheld: 0 }, push: { state: expect.any(String) },
        rollback: [['gbrain', 'sources', 'reindex', 'default', '--from-git', '--dry-run'], ['gbrain', 'sources', 'canonical', 'default', '--to', 'mixed', '--dry-run']] });
      expect(recovery.commits).toEqual(conversionShas(root, base));
      expect(recovery.commits.length).toBeGreaterThan(0);

      const live = { db: await body(engine, 'notes/db'), none: await body(engine, 'notes/none') };
      const reindex = await previewReindex(engine, 'default');
      await runSourcesReindex(engine, ['default', '--from-git', '--apply', '--expect', reindex.preview_hash, '--no-embed', '--no-extract', '--json']);
      expect(await applyMixedConversion(engine, 'default', (await planMixedConversion(engine, 'default')).preview_hash)).toEqual({ status: 'mixed', source_id: 'default' });
      expect(await strict(engine)).toBe(false);
      expect(await body(engine, 'notes/db')).toBe(live.db);
      expect(await body(engine, 'notes/none')).toBe(live.none);
      expect(live.db).toContain(DB_EDIT('notes/db'));
      expect(live.none).toContain(DB_EDIT('notes/none'));
    } finally { files.done(); }
  }, { databaseUrl, setup }), 240_000);

  test('item 7: a commit between approval and apply leaves the changed page unapplied and lists the delta with counts', () => managedBrain(async brain => {
    const { engine, root } = brain;
    const files = outside();
    try {
      await evidenceSource(brain);
      const decisions = await decide(brain, files.dir, { 'notes/both': 'git_wins', 'notes/none': 'adopt' });
      const approvalFile = join(files.dir, 'approval.json');
      const written = await cli(engine, ['default', '--to', 'git', '--dry-run', '--decisions', join(files.dir, 'decisions.json'), '--approval-out', approvalFile]);
      expect(written.written.approval).toBe(approvalFile);
      expect(statSync(approvalFile).mode & 0o777).toBe(0o600);
      const approval = await readConversionApproval(engine, approvalFile, 'default');
      expect(approval).toMatchObject({ kind: 'gbrain-conversion-approval', decisions: decisions.map(d => ({ slug: d.slug })) });
      expect(approval).toEqual(conversionApproval(await planGitConversion(engine, 'default', { decisions })));

      writeFileSync(join(root, 'notes/db.md'), note('notes/db', 'A commit that landed after the approval.'));
      git(root, 'commit', '-qam', 'a commit after the approval');
      const result = await applyApprovedConversion(engine, 'default', approval, PROCESSING);
      expect(result).toMatchObject({ status: 'delta', committed: { pages: 1 } });
      expect(result.delta!.items).toContainEqual({ item: 'adopt:notes/db.md', reason: 'changed' });
      expect(result.delta!.count).toBe(Object.values(result.delta!.by).reduce((a, b) => a + b, 0));
      expect(result.delta!.count).toBeGreaterThan(0);
      expect(await strict(engine)).toBe(false);
      expect(await body(engine, 'notes/db')).toContain(DB_EDIT('notes/db'));
      expect(readFileSync(join(root, 'notes/db.md'), 'utf8')).toContain('A commit that landed after the approval.');
      expect(readFileSync(join(root, 'notes/none.md'), 'utf8')).toContain(DB_EDIT('notes/none'));

      const refused = await cli(engine, ['default', '--to', 'git', '--apply', '--approved', approvalFile, '--no-embed', '--no-extract']);
      expect(refused).toMatchObject({ status: 'delta', code: 'git_conversion_delta' });
    } finally { files.done(); }
  }, { databaseUrl, setup }), 240_000);

  test('item 6: a partial approved apply that fails after a commit reports that commit; an approval\'s decisions are checked like a decisions file', () => managedBrain(async brain => {
    const { engine, root } = brain;
    const files = outside();
    try {
      await evidenceSource(brain);
      const decisions = await decide(brain, files.dir, { 'notes/both': 'git_wins', 'notes/none': 'adopt' });
      const approval = conversionApproval(await planGitConversion(engine, 'default', { decisions }));
      const twice = join(files.dir, 'twice.json');
      await writeConversionFile(engine, twice, '--approval-out', { ...approval, decisions: [...approval.decisions, approval.decisions[0]] });
      await expect(readConversionApproval(engine, twice, 'default')).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('decided twice') });
      const noItems = join(files.dir, 'no-items.json');
      await writeConversionFile(engine, noItems, '--approval-out', { ...approval, items: null });
      await expect(readConversionApproval(engine, noItems, 'default')).rejects.toMatchObject({ code: 'invalid_params' });
      writeFileSync(`${join(files.dir, 'stale.json')}.${process.pid}.tmp`, '');
      await expect(writeConversionFile(engine, join(files.dir, 'stale.json'), '--approval-out', approval)).rejects.toMatchObject({ code: 'invalid_params' });
      expect(await cli(engine, ['constructor', '--to', 'git', '--dry-run'])).not.toMatchObject({ message: expect.stringContaining('needs a file path') });

      writeFileSync(join(root, 'notes/db.md'), note('notes/db', 'A commit that landed after the approval.'));
      git(root, 'commit', '-qam', 'a commit after the approval');
      const base = git(root, 'rev-parse', 'HEAD');
      installFaultHook(async point => { if (point === 'conversion:group_committed') throw new Error('injected after the first group'); });
      let error: unknown;
      try { await applyApprovedConversion(engine, 'default', approval, PROCESSING); } catch (caught) { error = caught; } finally { installFaultHook(undefined); }
      expect(error).toMatchObject({ message: 'injected after the first group' });
      expect(conversionShas(root, base)).toHaveLength(1);
      expect(conversionRecovery(error)).toMatchObject({ mode: 'mixed', phase: 'adopt', commits: conversionShas(root, base), rollback: [] });
      expect(await strict(engine)).toBe(false);
    } finally { files.done(); }
  }, { databaseUrl, setup }), 240_000);

  test('item 7: an approval nothing moved under applies whole, as its hash would', () => managedBrain(async brain => {
    const { engine } = brain;
    const files = outside();
    try {
      await evidenceSource(brain);
      const decisions = await decide(brain, files.dir, { 'notes/both': 'git_wins', 'notes/none': 'adopt' });
      const incarnation = (await planGitConversion(engine, 'default')).incarnation;
      await staleHold(engine, incarnation, 'notes/same');
      const approval = conversionApproval(await planGitConversion(engine, 'default', { decisions }));
      // A sync re-screening a held path rewrites only its observed_at: the approval still applies whole.
      await new Promise(resolve => setTimeout(resolve, 5));
      await staleHold(engine, incarnation, 'notes/same');
      expect(await applyApprovedConversion(engine, 'default', approval, PROCESSING)).toMatchObject({ status: 'converted', committed: { pages: 2 }, holds_cleared: 1 });
      expect(await strict(engine)).toBe(true);
    } finally { files.done(); }
  }, { databaseUrl, setup }), 240_000);
});
