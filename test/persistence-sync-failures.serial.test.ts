import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { loadSyncFailures, acknowledgeFailures, autoSkipFailures } from '../src/core/sync-failure-ledger.ts';
import { printSyncResult, runSync } from '../src/commands/sync.ts';
import { buildSingleSyncJsonEnvelope } from '../src/core/sync-embed-backfill.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { checkSyncFailures } from '../src/commands/doctor/checks/sync-failures.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { stampByCheckpoint } from './helpers/pass-fold.ts';
import { renderFactsTable, parseFactsFence } from '../src/core/facts-fence.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-failures-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
function commit(root: string) { git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture content'); return git(root, 'rev-parse', 'HEAD'); }
async function fixture(engine: BrainEngine, files: Record<string, string>) {
  const id = `sync-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); await makeGitFixture(root);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  const head = commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, head };
}
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  // #5988: these fixtures force failed receipts with unreadable YAML, which sync now holds by default; sync.holds=fail keeps them fail-closed.
  for (const engine of engines) await engine.setConfig('sync.holds', 'fail');
}, 120_000);

// #6712 PR 3 (L7) / PR 4b: the withdrawal is written back over the committed edit, so its revision is attested, not drift.
// The next plain sync imports the commit with no refusal and cannot restore the fact (the cursor engine first refused the
// frozen revision with revision_conflict and resumed through guarded rediscovery; the pass reads the moved page directly).
test('a withdrawal written back over a committed edit: the next plain sync imports the commit and cannot restore the fact', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const body = renderFactsTable([{ rowNum: 1, claim: 'synthetic sync withdrawal', visibility: 'world', kind: 'fact', confidence: 1,
      notability: 'medium', active: true }]);
    const f = await fixture(engine, { 'a.md': 'First stable observation.\n', 'z.md': body });
    const options = { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true };
    expect((await performManagedSync(engine, options)).status).toBe('first_sync');
    const fact = await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () =>
      tx.insertFact({ fact: 'synthetic sync withdrawal', source: 'synthetic', visibility: 'world' }, { source_id: f.id }), TEST_WRITE_ATTRIBUTION));
    writeFileSync(join(f.root, 'a.md'), 'First updated observation.\n');
    writeFileSync(join(f.root, 'z.md'), `Preserve this new prose.\n${body}`); commit(f.root);
    expect((await performManagedSync(engine, options, { maxPages: 1, maxMs: 1000 })).status).toBe('partial');
    await disposePersistenceConsumer(engine);
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => recordFactWithdrawal(tx, fact.id, f.id), TEST_WRITE_ATTRIBUTION));
    const repaired = await performManagedSync(engine, options);
    expect(repaired.status).toBe('synced');
    const current = (await engine.readPageSnapshot('z', { sourceId: f.id }))!;
    expect(current.page.compiled_truth).toContain('Preserve this new prose.');
    expect(parseFactsFence(current.page.compiled_truth).facts[0].forgotten).toBe(true);
    expect(parseFactsFence(readFileSync(join(f.root, 'z.md'), 'utf8')).facts[0].forgotten).toBe(true);
    expect(await readManagedSyncFailures(engine, [f.id])).toHaveLength(0);
    expect((await performManagedSync(engine, options)).status).toBe('up_to_date');
  }
}), 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

type ManagedResult = Awaited<ReturnType<typeof performManagedSync>>;
const PASS_COUNTS = ['added', 'modified', 'deleted', 'renamed', 'chunksCreated', 'bankedFiles', 'filesImported'] as const;
/**
 * #6712 PR 4b: a replay is a pass of its own. It reports the stop it replays (status, failures, codes, diagnostic and
 * target) under its own pass id, and admits nothing, so its counts are zero and it plans no round.
 */
const replayOf = (stop: ManagedResult) => ({ ...stop, ...Object.fromEntries(PASS_COUNTS.filter(key => key in stop).map(key => [key, 0])), pagesAffected: [],
  pass: { ...stop.pass!, pass_id: expect.not.stringMatching(new RegExp(`^${stop.pass!.pass_id}$`)), candidates: 0, remaining: 0, round: 0 } });

// #6712 PR 3 (L7): an unchanged file replays its recorded failure (no new request); once the fix is committed, the plain sync retries it.
test('failed managed receipt stays diagnostic across replay and restart, and the plain sync admits it again once repaired', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': 'Useful stable first observation.\n', 'bad.md': '---\ntitle: [broken\n---\nBroken content.\n' });
    const options = { sourceId: f.id, noPull: true };
    const failed = await performManagedSync(engine, options);
    expect(failed).toMatchObject({ status: 'blocked_by_failures', added: 1, filesImported: 1 });
    expect((failed as any).failures).toEqual([expect.objectContaining({ source_id: f.id, path: 'bad.md', code: expect.any(String), message: expect.any(String), request_id: expect.any(String), run_id: expect.any(String), target: f.head })]);
    const receipts = await engine.executeRaw('SELECT id,state,intent,error_code,error_message FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
    const ledger = loadSyncFailures().filter(r => r.source_id === f.id);
    expect(ledger).toHaveLength(1); expect(ledger[0].attempts).toBe(1);
    expect(ledger[0]).toMatchObject({ code: failed.failureCodes![0].code, request_id: failed.failures![0].request_id });
    expect(acknowledgeFailures(f.id).count).toBe(0); expect(autoSkipFailures(f.id, ['bad.md']).count).toBe(0);
    await disposePersistenceConsumer(engine);
    const replay = await performManagedSync(engine, options);
    expect(replay).toEqual(replayOf(failed));
    expect(loadSyncFailures().filter(r => r.source_id === f.id)).toEqual(ledger);
    expect(await engine.executeRaw('SELECT id,state,intent,error_code,error_message FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id])).toEqual(receipts);
    expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
    expect(buildSingleSyncJsonEnvelope(f.id, failed)).toMatchObject({ failures: (failed as any).failures, failure_codes: failed.failureCodes });
    let output = ''; printSyncResult(failed, { write: (text: string) => { output += text; } } as any);
    expect(output).toContain('bad.md'); expect(output).toContain(`After repair, run gbrain sync --source ${f.id} --no-pull to retry it under a new request.`);
    expect(output).not.toContain('--retry-failed'); expect(output).not.toContain('--skip-failed');
    writeFileSync(join(f.root, 'bad.md'), 'Repaired useful second observation.\n');
    const repairedHead = commit(f.root);
    const repaired = await performManagedSync(engine, options);
    expect(repaired).toMatchObject({ status: 'first_sync', toCommit: repairedHead });
    expect(loadSyncFailures().filter(r => r.source_id === f.id)).toHaveLength(0);
    expect((await engine.getPage('bad', { sourceId: f.id }))?.compiled_truth).toContain('Repaired');
    expect(await engine.executeRaw('SELECT id,state,intent,error_code,error_message FROM persistence_requests WHERE source_id=$1 ORDER BY sequence LIMIT 2', [f.id])).toEqual(receipts);
  }
}), 120_000);

test('CRLF checkout is not newer divergent content, but substantive edits remain protected', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'note.md': 'Original canonical observation.\n' });
    const options = { sourceId: f.id, noPull: true };
    await performManagedSync(engine, options);
    const next = 'Updated canonical observation.\n';
    writeFileSync(join(f.root, 'note.md'), next); commit(f.root);
    writeFileSync(join(f.root, 'note.md'), next.replace(/\n/g, '\r\n'));
    expect(await performManagedSync(engine, options)).toMatchObject({ status: 'synced', modified: 1 });
    expect(readFileSync(join(f.root, 'note.md'), 'utf8')).toBe(next.replace(/\n/g, '\r\n'));
    writeFileSync(join(f.root, 'note.md'), 'Another committed observation.\n'); commit(f.root);
    writeFileSync(join(f.root, 'note.md'), 'Divergent uncommitted observation.\n');
    expect(await performManagedSync(engine, options)).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'source_changed', count: 1 }] });
    expect((await engine.getPage('note', { sourceId: f.id }))?.compiled_truth).toContain('Updated');
  }
}), 120_000);

test.each(['lone_cr', 'trailing_spaces', 'bom', 'content'] as const)('fresh CRLF equivalence does not accept %s differences', async difference => withEnv(env, async () => {
  for (const engine of engines) {
    const original = 'Original canonical observation.\n';
    const f = await fixture(engine, { 'note.md': original });
    const options = { sourceId: f.id, noPull: true };
    await performManagedSync(engine, options);
    const pinned = 'Updated canonical observation.\n';
    writeFileSync(join(f.root, 'note.md'), pinned); commit(f.root);
    const working = difference === 'lone_cr' ? pinned.replace(/\n/g, '\r')
      : difference === 'trailing_spaces' ? pinned.replace(/\n/g, ' \r\n')
      : difference === 'bom' ? '\ufeff' + pinned.replace(/\n/g, '\r\n')
      : pinned.replace('Updated', 'Divergent').replace(/\n/g, '\r\n');
    writeFileSync(join(f.root, 'note.md'), working);
    const blocked = await performManagedSync(engine, options);
    expect(blocked).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'source_changed', count: 1 }],
      managedWrite: { write_error: 'source_changed', reason: 'pinned_git_worktree_conflict' } });
    expect(blocked.managedWrite?.line_endings).toBeUndefined();
    expect(readFileSync(join(f.root, 'note.md'), 'utf8')).toBe(working);
    expect((await engine.getPage('note', { sourceId: f.id }))?.compiled_truth).toBe(original.trim());
    expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(f.head);
  }
}), 120_000);

// #6712 PR 4b: no unfinished run pins the stale blob any more. The next pass pins the newer commit, whose CRLF checkout is
// the same content, and imports it; the bytes the interrupted pass saw for z.md are never published.
test('CRLF checkout of a newer commit after an interrupted pass imports the newer commit; the stale blob the interrupted pass saw is never published', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': 'Original first observation.\n', 'z.md': 'Original last observation.\n' });
    const options = { sourceId: f.id, noPull: true };
    await performManagedSync(engine, options);
    writeFileSync(join(f.root, 'a.md'), 'Updated first observation.\n');
    writeFileSync(join(f.root, 'z.md'), 'Updated last observation.\n');
    const pinned = commit(f.root);
    expect(await performManagedSync(engine, options, { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial', filesImported: 1, toCommit: pinned });
    const newer = 'Newer last observation.\n';
    writeFileSync(join(f.root, 'z.md'), newer); const newerHead = commit(f.root);
    writeFileSync(join(f.root, 'z.md'), newer.replace(/\n/g, '\r\n'));
    const resumed = await performManagedSync(engine, options);
    expect(resumed).toMatchObject({ status: 'synced', toCommit: newerHead, modified: 1, pass: { kind: 'full', outcome: 'synced', candidates: 1 } });
    expect(resumed.managedWrite?.line_endings).toBeUndefined();
    expect((await engine.getPage('z', { sourceId: f.id }))?.compiled_truth).toBe('Newer last observation.');
    expect(readFileSync(join(f.root, 'z.md'), 'utf8')).toBe(newer.replace(/\n/g, '\r\n'));
    expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(newerHead);
    // z.md was imported by the first sync and by the newer commit, never at the stale pinned blob.
    expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND intent->>'path'='z.md' AND intent->>'kind'='managed_sync_import'", [f.id])).toHaveLength(2);
  }
}), 120_000);

test('full sync cannot hide an older failed incremental cursor or repeat its committed deletion', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'bad.md': 'Originally valid source observation.\n', 'remove.md': 'Content deliberately removed later.\n' });
    const options = { sourceId: f.id, noPull: true };
    await performManagedSync(engine, options);
    rmSync(join(f.root, 'remove.md'));
    writeFileSync(join(f.root, 'bad.md'), '---\ntitle: [broken\n---\nBroken content.\n');
    const target = commit(f.root);
    const blocked = await performManagedSync(engine, options);
    expect(blocked).toMatchObject({ status: 'blocked_by_failures', deleted: 1, filesImported: 1, toCommit: target });
    const failedId = blocked.failures![0].request_id;
    const receipts = await engine.executeRaw('SELECT id,state,intent,error_code FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
    const replay = await performManagedSync(engine, options);
    expect(replay).toEqual(replayOf(blocked));
    expect(await engine.executeRaw('SELECT id,state,intent,error_code FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id])).toEqual(receipts);
    // #6712 PR 1: one cursor per source, so `--full` resumes the failed cursor instead of starting its own; with the file
    // unchanged it replays the same failure and moves nothing (before, a full run synced under a separate key beside it).
    // #6712 PR 4b: the pass analog of resuming the failed run is replaying the same recorded failure (same request).
    expect(await performManagedSync(engine, { ...options, full: true })).toMatchObject({ status: 'blocked_by_failures', toCommit: target,
      failures: [expect.objectContaining({ request_id: failedId, path: 'bad.md' })], pass: { outcome: 'blocked', candidates: 0 } });
    const [source] = await engine.executeRaw('SELECT last_commit,last_sync_at FROM sources WHERE id=$1', [f.id]);
    expect(await performManagedSync(engine, options)).toEqual(replayOf(blocked));
    expect(await engine.executeRaw('SELECT last_commit,last_sync_at FROM sources WHERE id=$1', [f.id])).toEqual([source]);
    rmSync(join(home, 'sync-failures.jsonl'), { force: true });
    await disposePersistenceConsumer(engine);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([expect.objectContaining({ request_id: failedId, target, path: 'bad.md' })]);
    const local = await checkSyncFailures(engine, { sourceIds: [f.id], remote: false });
    expect(local?.status).not.toBe('ok'); expect(local?.message).toContain(failedId!); expect(local?.message).toContain('bad.md');
    const remote = await checkSyncFailures(engine, { sourceIds: [f.id], remote: true });
    expect(remote?.status).not.toBe('ok'); expect(remote?.message).not.toContain(f.id); expect(remote?.message).not.toContain('bad.md');
    expect(remote?.message).not.toContain(failedId!); expect(remote?.message).not.toContain(target); expect(remote?.message).not.toContain('--skip-failed');
    expect(await checkSyncFailures(engine, { sourceIds: [], remote: true })).toBeNull();
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '10 days' WHERE op LIKE 'managed-sync%'");
    await purgeStaleCheckpoints(engine);
    expect(await performManagedSync(engine, options)).toEqual(replayOf(blocked));
    // #6712 PR 3 (L7): once the file's fix is committed, the `--full` run retries the recorded failure by rediscovering from
    // HEAD: it converges at the new commit under a new run and does not repeat the committed deletion.
    writeFileSync(join(f.root, 'bad.md'), 'Repaired valid source observation.\n');
    const fullTarget = commit(f.root);
    expect(fullTarget).not.toBe(target);
    const repaired = await performManagedSync(engine, { ...options, full: true });
    expect(repaired).toMatchObject({ status: 'synced', toCommit: fullTarget, deleted: 0 }); expect(repaired.pass!.pass_id).not.toBe(blocked.pass!.pass_id);
    expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND intent->>'path'='remove.md' AND intent->>'kind'='managed_sync_delete'", [f.id])).toHaveLength(1);
    expect(await readManagedSyncFailures(engine, [f.id])).toHaveLength(0);
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
  }
}), 120_000);

const QUOTED_EXCLUDE = "it's a dir/**";
async function captureCli(fn: () => unknown): Promise<string> {
  const originalLog = console.log, originalWrite = process.stdout.write, originalErr = process.stderr.write, originalExit = process.exit;
  let out = '';
  console.log = (...args: unknown[]) => { out += args.join(' ') + '\n'; };
  process.stdout.write = ((value: unknown) => { out += String(value); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((value: unknown) => { out += String(value); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { throw new Error(`fixture-cli-exit ${code}`); }) as typeof process.exit;
  try { await fn(); } catch (error) { if (!String((error as Error).message).startsWith('fixture-cli-exit')) throw error; }
  finally {
    console.log = originalLog; process.stdout.write = originalWrite; process.stderr.write = originalErr; process.exit = originalExit;
    _resetCliExitVerdictForTests(); process.exitCode = 0;
  }
  return out;
}

test('managed failure retry hints name the failed cursor options locally, shell-quoted, and stay redacted remotely', async () => withEnv({ ...env, GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SYNC_NO_EXTRACT_NUDGE: '1' }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'bad.md': '---\ntitle: [broken\n---\nRetry hint fixture.\n' });
    const blocked = await performManagedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, full: true, exclude: [QUOTED_EXCLUDE] });
    expect(blocked.status).toBe('blocked_by_failures');
    const recorded = { full: true, workingTree: false, srcSubpath: null, exclude: [QUOTED_EXCLUDE], includeHidden: [], strategy: null };
    expect(blocked.failures).toEqual([expect.objectContaining({ syncOptions: recorded, processingOptions: expect.objectContaining({ noEmbed: true }) })]);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([expect.objectContaining({ syncOptions: recorded })]);
    const retry = `gbrain sync --source ${f.id} --no-pull --no-embed --full --exclude 'it'\\''s a dir/**'`;

    const local = await checkSyncFailures(engine, { sourceIds: [f.id], remote: false });
    expect(local?.message).toContain(`Fix the cause, then run ${retry}.`);
    expect(local?.message).not.toContain('with the same source and options');
    const remote = await checkSyncFailures(engine, { sourceIds: [f.id], remote: true });
    expect(remote?.message).not.toContain(QUOTED_EXCLUDE);
    expect(remote?.message).not.toContain('--exclude');

    const printed = await captureCli(() => printSyncResult(blocked));
    expect(printed).toContain(`After repair, run ${retry} to retry it under a new request.`);
    const { managedWrite: _diagnostic, ...bare } = blocked;
    const printedBare = await captureCli(() => printSyncResult(bare));
    expect(printedBare).toContain(`Fix the cause, then run: ${retry} (this admits a fresh run after active work drains).`);

    const legacy = { ...blocked.failures![0] };
    delete legacy.syncOptions; delete legacy.processingOptions;
    const printedLegacy = await captureCli(() => printSyncResult({ ...bare, failures: [legacy] }));
    expect(printedLegacy).toContain(`Fix the cause, then run: gbrain sync --source ${f.id} --no-pull with the same options as the failed run (this receipt no longer records them)`);

    const d = await fixture(engine, { 'note.md': 'A stable discovery observation.\n' });
    const execute = engine.executeRaw;
    engine.executeRaw = function (this: BrainEngine, sql: string, params?: unknown[]) {
      // #6712 PR 4b: the pass's level read (a Postgres cursor declared over it, or PGLite keyset pages) stands where the cursor's discovery read stood.
      if (sql.includes('SELECT p.id, p.slug, p.source_path, p.knowledge_revision::text AS revision') && params?.[0] === d.id) throw new OperationError('storage_error', 'Synthetic discovery failure');
      return execute.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    let thrown: Error | undefined;
    try { await performManagedSync(engine, { sourceId: d.id, noPull: true, exclude: [QUOTED_EXCLUDE] }); }
    catch (error) { thrown = error as Error; }
    finally { engine.executeRaw = execute; }
    expect(thrown?.message).toContain(`Fix the cause, then run: gbrain sync --source ${d.id} --no-pull --exclude 'it'\\''s a dir/**'`);
  }
}), 120_000);

test('--retry-failed counts every managed failure of the source, whatever options the failed run used (#6712 PR 1: one cursor key)', async () => withEnv({ ...env, GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SYNC_NO_EXTRACT_NUDGE: '1' }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'bad.md': '---\ntitle: [broken\n---\nRetry count fixture.\n' });
    await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{syncEnabled}','false'::jsonb) WHERE id<>$1", [f.id]);
    const flags = ['--no-pull', '--no-embed', '--no-extract', '--no-auto-embed', '--no-schema-pack', '--source', f.id];
    await captureCli(() => runSync(engine, [...flags, '--exclude', QUOTED_EXCLUDE]));
    expect(await readManagedSyncFailures(engine, [f.id])).toHaveLength(1);

    const other = await captureCli(() => runSync(engine, [...flags, '--retry-failed']));
    expect(other).toContain('Retrying 1 previously-failed file(s)...');
    expect(other).not.toContain('belong to a run with different sync options');
  }
}), 120_000);

// #6712 PR 4b: a non-company source keeps no cursor, so a checkpoint moved away from an interrupted run is no longer a
// failure (the next pass classifies the tree at HEAD; the cursor's checkpoint_moved orphan is gone) and an explicit retry has
// no frozen cursor to leave alone. A pass that stops before admitting a file still records a diagnosable failure with no
// receipt: a failed level read (phase discovery, at the HEAD it read) and a page changed between the level read and its freeze
// (sync.holds=fail: phase freeze, nothing admitted for that file). Each clears once a pass converges.
test('a pass that fails reading its level or freezing a changed page stays diagnosable without a file receipt', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const d = await fixture(engine, { 'note.md': 'A stable level observation.\n' });
    const execute = engine.executeRaw;
    engine.executeRaw = function (this: BrainEngine, sql: string, params?: unknown[]) {
      if (sql.includes('SELECT p.id, p.slug, p.source_path, p.knowledge_revision::text AS revision') && params?.[0] === d.id) throw new OperationError('storage_error', 'Synthetic level read failure');
      return execute.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    try {
      await expect(performManagedSync(engine, { sourceId: d.id, noPull: true })).rejects.toMatchObject({ code: 'storage_error' });
      await expect(performManagedSync(engine, { sourceId: d.id, noPull: true })).rejects.toMatchObject({ code: 'storage_error' });
    } finally { engine.executeRaw = execute; }
    expect(await readManagedSyncFailures(engine, [d.id])).toEqual([expect.objectContaining({ phase: 'discovery', path: '<discovery>', target: d.head, code: 'storage_error',
      message: 'Synthetic level read failure', request_id: null, attempts: 1 })]);
    expect(loadSyncFailures().filter(row => row.source_id === d.id)).toEqual([expect.objectContaining({ code: 'storage_error', request_id: null, attempts: 1 })]);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [d.id])).toEqual([]);
    expect((await performManagedSync(engine, { sourceId: d.id, noPull: true })).status).toBe('first_sync');
    expect(await readManagedSyncFailures(engine, [d.id])).toHaveLength(0);
    expect(loadSyncFailures().filter(row => row.source_id === d.id)).toHaveLength(0);

    const c = await fixture(engine, { 'a.md': 'First enumerated page.\n', 'b.md': 'Second enumerated page.\n' });
    expect((await performManagedSync(engine, { sourceId: c.id, noPull: true })).status).toBe('first_sync');
    writeFileSync(join(c.root, 'a.md'), 'First changed page.\n'); writeFileSync(join(c.root, 'b.md'), 'Second changed page.\n');
    const head = commit(c.root);
    let changed = false;
    installFaultHook(async (point, detail) => {
      if (point !== 'sync:after_freeze' || changed || detail.sourceId !== c.id || detail.path !== 'a.md') return;
      changed = true;
      await engine.transaction(tx => withCoordinatedWrite(tx, [c.id], () => tx.putPage('b', {
        type: 'note', title: 'b', compiled_truth: 'A newer accepted database observation.', timeline: '', frontmatter: {}, content_hash: 'newer',
      }, { sourceId: c.id }), TEST_WRITE_ATTRIBUTION));
    });
    try { await expect(performManagedSync(engine, { sourceId: c.id, noPull: true })).rejects.toMatchObject({ code: 'revision_conflict' }); }
    finally { installFaultHook(undefined); }
    expect(changed).toBe(true);
    expect(await readManagedSyncFailures(engine, [c.id])).toEqual([expect.objectContaining({ phase: 'freeze', path: 'b.md', code: 'revision_conflict', request_id: null, target: head })]);
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND intent->>'path'='b.md' AND intent->>'target'=$2", [c.id, head])).toEqual([]);
    expect((await engine.getPage('b', { sourceId: c.id }))?.compiled_truth).toContain('newer accepted');
  }
}), 120_000);

test('local single and all-source CLI JSON carry durable diagnostics and fail the exit verdict', async () => withEnv({ ...env, GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SYNC_NO_EXTRACT_NUDGE: '1' }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'bad.md': '---\ntitle: [broken\n---\nCLI failure fixture.\n' });
    await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{syncEnabled}','false'::jsonb) WHERE id<>$1", [f.id]);
    const originalLog = console.log, originalWrite = process.stdout.write, originalErr = process.stderr.write, originalExit = process.exit;
    let stdout = '', stderr = '', exitCode: number | undefined;
    console.log = (...args: unknown[]) => { stdout += args.join(' ') + '\n'; };
    process.stdout.write = ((value: unknown) => { stdout += String(value); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((value: unknown) => { stderr += String(value); return true; }) as typeof process.stderr.write;
    process.exit = ((code?: number) => { exitCode = code; throw new Error('fixture-cli-exit'); }) as typeof process.exit;
    const flags = ['--json', '--no-pull', '--no-embed', '--no-extract', '--no-auto-embed', '--no-schema-pack'];
    try {
      await runSync(engine, [...flags, '--source', f.id]);
      const single = JSON.parse(stdout.trim());
      // #6712 PR 4b: the pass has no cursor run, so the envelope carries no run-cumulative counts (no run_id, no counts_scope).
      expect(single).toEqual(expect.objectContaining({ sync_status: 'blocked_by_failures', outcome: 'blocked', failures: [expect.objectContaining({ path: 'bad.md', source_id: f.id, request_id: expect.any(String), phase: 'receipt' })] }));
      expect(single).not.toHaveProperty('counts_scope');
      expect(currentExitCode()).toBe(1); expect(stderr).toContain(`After repair, run gbrain sync --source ${f.id} --no-pull --no-embed --no-extract --no-schema-pack to retry it under a new request.`);
      expect(stderr).not.toContain('--retry-failed'); expect(stderr).not.toContain('--skip-failed');
      stdout = ''; stderr = '';
      try { await runSync(engine, [...flags, '--all', '--serial']); } catch (error) { if ((error as Error).message !== 'fixture-cli-exit') throw error; }
      const all = JSON.parse(stdout.trim());
      expect(all).toEqual(expect.objectContaining({ error_count: 1, ok_count: 0, sources: [expect.objectContaining({ source_id: f.id, status: 'error', sync_status: 'blocked_by_failures', failures: single.failures, failure_codes: single.failure_codes })] }));
      expect(exitCode).toBe(1); expect(stderr).toContain(single.failures[0].request_id); expect(stderr).not.toContain('--skip-failed');
    } finally {
      console.log = originalLog; process.stdout.write = originalWrite; process.stderr.write = originalErr; process.exit = originalExit;
      _resetCliExitVerdictForTests(); process.exitCode = 0;
    }
  }
}), 120_000);

test.skipIf(!backends.includes('pglite'))('a new process reads the same failed receipt from a persisted PGLite brain', async () => withEnv(env, async () => {
  const database = join(home, 'restart-db');
  const engine = new PGLiteEngine(); await engine.connect({ database_path: database }); await engine.initSchema();
  await engine.setConfig('sync.holds', 'fail');
  let expected: Awaited<ReturnType<typeof performManagedSync>>, sourceId: string;
  try {
    const f = await fixture(engine, { 'bad.md': '---\ntitle: [broken\n---\nRestart failure fixture.\n' });
    sourceId = f.id;
    expected = await performManagedSync(engine, { sourceId, noPull: true });
    expect(expected.status).toBe('blocked_by_failures');
  } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  const script = `
    import {PGLiteEngine} from ${JSON.stringify(join(import.meta.dir, '../src/core/pglite-engine.ts'))};
    import {performManagedSync} from ${JSON.stringify(join(import.meta.dir, '../src/core/persistence/sync-run.ts'))};
    import {disposePersistenceConsumer} from ${JSON.stringify(join(import.meta.dir, '../src/core/persistence/service.ts'))};
    const engine = new PGLiteEngine(); await engine.connect({database_path:${JSON.stringify(database)}});
    try {
      const result = await performManagedSync(engine,{sourceId:${JSON.stringify(sourceId!)},noPull:true});
      const receipts = await engine.executeRaw('SELECT count(*)::int AS count FROM persistence_requests WHERE source_id=$1',[${JSON.stringify(sourceId!)}]);
      console.log(JSON.stringify({result,receipts}));
    } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: home, env: { ...process.env, ...env, DATABASE_URL: '', GBRAIN_DATABASE_URL: '' }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toMatchObject({ code: 0 });
  expect(JSON.parse(stdout)).toEqual({ result: replayOf(expected!), receipts: [{ count: 1 }] });
}), 120_000);

test('remote managed failure results expose only aggregates, never private receipt details', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'private-note.md': '---\ntitle: [broken\n---\nPrivate failure fixture.\n' });
    const clientId = `sync-client-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
      VALUES($1,'fixture-client','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, f.id]);
    const ctx = { engine, remote: true, sourceId: f.id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: f.id, allowedOperations: ['submit_job'] } } as OperationContext;
    const accepted = await prepareRemoteJob(ctx, 'sync', { noPull: true });
    const result = await withSubmissionAuthority(accepted.authority, () => performManagedSync(engine, accepted.data));
    expect(result).toEqual(expect.objectContaining({ status: 'blocked_by_failures', failedFiles: 1, failureCodes: [{ code: expect.any(String), count: 1 }] }));
    expect(result.failures).toBeUndefined(); expect(result.runId).toBeUndefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private-note'); expect(serialized).not.toContain(f.head); expect(serialized).not.toContain(f.root);
  }
}), 120_000);

test('remote pending sync keeps its private receipt off the response while resuming the same request', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    const f = await fixture(engine, { 'private-pending.md': 'A private observation awaiting publication.\n' });
    const clientId = `sync-client-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
      VALUES($1,'fixture-client','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, f.id]);
    const ctx = { engine, remote: true, sourceId: f.id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: f.id, allowedOperations: ['submit_job'] } } as OperationContext;
    const accepted = await prepareRemoteJob(ctx, 'sync', { noPull: true });
    const lock = await acquireWorktree((await getWorktreeBinding(engine, f.id))!);
    expect(lock).not.toBeNull();
    try {
      const run = () => withSubmissionAuthority(accepted.authority, () => performManagedSync(engine, accepted.data));
      const pending = await run();
      expect(pending).toMatchObject({ status: 'partial', reason: 'writer_pending', added: 0, filesImported: 0 });
      expect(pending.managedWrite).toBeUndefined();
      expect(pending.failures).toBeUndefined();
      expect(pending.runId).toBeUndefined();
      const requests = await engine.executeRaw<{ request_id: string }>('SELECT request_id FROM persistence_requests WHERE source_id=$1', [f.id]);
      expect(requests).toHaveLength(1);
      const serialized = JSON.stringify(pending);
      for (const privateValue of ['private-pending', 'A private observation', f.root, f.head, requests[0].request_id]) expect(serialized).not.toContain(privateValue);
      // #6712 PR 4b: each pass has its own pass_id; otherwise the second pending result is identical and resumes the same request.
      const again = await run();
      expect(again.pass!.pass_id).not.toBe(pending.pass!.pass_id);
      expect({ ...again, pass: { ...again.pass!, pass_id: '' } }).toEqual({ ...pending, pass: { ...pending.pass!, pass_id: '' } });
      expect(await engine.executeRaw('SELECT request_id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual(requests);
      // A pass that waits on its own queued request stops resumable (writer_pending) and records no failure; only a blocked stop does.
      expect(await readManagedSyncFailures(engine, [f.id])).toHaveLength(0);
      await lock!.release();
      // The same request commits once the worktree is free, but a remote caller cannot stamp the converged checkpoint: the
      // pass stops for the brain host, with the page imported and last_commit untouched.
      expect(await run()).toMatchObject({ status: 'blocked_by_failures', reason: 'reconcile_host_required',
        pass: { kind: 'full', outcome: 'blocked', stop_reason: 'reconcile_host_required', candidates: 0 } });
      expect((await engine.getPage('private-pending', { sourceId: f.id }))?.compiled_truth).toContain('A private observation awaiting publication.');
      expect(await engine.executeRaw('SELECT request_id,state FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual([{ request_id: requests[0].request_id, state: 'committed' }]);
      expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
    } finally { await lock?.release(); await disposePersistenceConsumer(engine); }
  }
}), 120_000);

// #6712 PR 4b: a non-company source keeps no manifest. An interrupted pass resumes on the next plain sync under a new pass,
// and the page it already imported is no longer a candidate (it is not imported twice).
test('an interrupted pass resumes on the next sync; the page it imported is not a candidate again', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': 'First committed observation.\n', 'b.md': 'Second committed observation.\n' });
    const options = { sourceId: f.id, noPull: true };
    const partial = await performManagedSync(engine, options, { maxPages: 1, maxMs: 1000 });
    expect(partial).toMatchObject({ status: 'partial', reason: 'writer_yield', filesImported: 1 });
    const resumed = await performManagedSync(engine, options);
    expect(resumed).toMatchObject({ status: 'first_sync', pass: { kind: 'full', outcome: 'synced', candidates: 1 } });
    expect(resumed.pass!.pass_id).not.toBe(partial.pass!.pass_id);
    const imports = await engine.executeRaw<{ path: string }>("SELECT intent->>'path' AS path FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [f.id]);
    expect(imports.map(row => row.path).sort()).toEqual(['a.md', 'b.md']);
    expect(await readManagedSyncFailures(engine, [f.id])).toHaveLength(0);
    expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(f.head);
  }
}), 120_000);

// #6712 PR 3 (L7): an unchanged file replays its recorded failure; a changed one is admitted again by the plain sync.
test('a new failed admission increments attempts but repeating retry during repaired progress does not reset the run', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': 'Useful successful first observation.\n', 'bad.md': '---\ntitle: [broken\n---\nFailed observation.\n' });
    const options = { sourceId: f.id, noPull: true };
    const first = await performManagedSync(engine, options);
    expect(await performManagedSync(engine, { ...options, retryFailed: true })).toEqual(replayOf(first));
    writeFileSync(join(f.root, 'bad.md'), '---\ntitle: [still broken\n---\nFailed observation.\n');
    const second = await performManagedSync(engine, options);
    expect(second.failures![0].request_id).not.toBe(first.failures![0].request_id);
    expect(second.failures![0].attempts).toBe(2);
    expect(await performManagedSync(engine, options)).toEqual(replayOf(second));
    writeFileSync(join(f.root, 'bad.md'), 'Repaired successful second observation.\n'); commit(f.root);
    const slice = { maxPages: 1, maxMs: 1000 };
    // The slice stops after the import, before its checkpoint request: a folded stamp would converge in it (#6926).
    const start = await stampByCheckpoint(() => performManagedSync(engine, options, slice));
    expect(start.status).toBe('partial'); expect(start.filesImported).toBe(1);
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(1);
    // #6712 PR 4b: the retry is the next pass. It does not re-admit the import the interrupted pass committed, and it
    // converges at the repaired commit, which clears the recorded failure.
    const continued = await performManagedSync(engine, { ...options, retryFailed: true }, slice);
    expect(continued).toMatchObject({ status: 'first_sync', filesImported: 0, pass: { outcome: 'synced', candidates: 0 } });
    expect(continued.pass!.pass_id).not.toBe(start.pass!.pass_id);
    expect(await engine.executeRaw("SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'path'='bad.md' ORDER BY sequence", [f.id]))
      .toEqual([{ state: 'failed' }, { state: 'failed' }, { state: 'committed' }]);
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
    expect((await performManagedSync(engine, options)).status).toBe('up_to_date');
  }
}), 120_000);
