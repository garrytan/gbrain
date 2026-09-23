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
import { OperationError } from '../src/core/ops/contract.ts';
import { admitWrite, completeWrite, claimNextWrite, markRecovering } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

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
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

test('failed managed receipt stays diagnostic across replay, restart, and explicit repaired admission', async () => withEnv(env, async () => {
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
    writeFileSync(join(f.root, 'bad.md'), 'Repaired useful second observation.\n');
    const repairedHead = commit(f.root);
    const replay = await performManagedSync(engine, options);
    expect(replay).toEqual(failed);
    expect(loadSyncFailures().filter(r => r.source_id === f.id)).toEqual(ledger);
    expect(await engine.executeRaw('SELECT id,state,intent,error_code,error_message FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id])).toEqual(receipts);
    expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
    expect(buildSingleSyncJsonEnvelope(f.id, failed)).toMatchObject({ failures: (failed as any).failures, failure_codes: failed.failureCodes });
    let output = ''; printSyncResult(failed, { write: (text: string) => { output += text; } } as any);
    expect(output).toContain('bad.md'); expect(output).toContain('--retry-failed'); expect(output).not.toContain('--skip-failed');
    const repaired = await performManagedSync(engine, { ...options, retryFailed: true });
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

test('CRLF checkout of a newer commit does not replace the stale blob pinned by an unfinished run', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': 'Original first observation.\n', 'z.md': 'Original last observation.\n' });
    const options = { sourceId: f.id, noPull: true };
    await performManagedSync(engine, options);
    writeFileSync(join(f.root, 'a.md'), 'Updated first observation.\n');
    writeFileSync(join(f.root, 'z.md'), 'Updated last observation.\n');
    const pinned = commit(f.root);
    expect(await performManagedSync(engine, options, { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial', filesImported: 1, toCommit: pinned });
    const newer = 'Newer last observation.\n';
    writeFileSync(join(f.root, 'z.md'), newer); commit(f.root);
    writeFileSync(join(f.root, 'z.md'), newer.replace(/\n/g, '\r\n'));
    const blocked = await performManagedSync(engine, options);
    expect(blocked).toMatchObject({ status: 'blocked_by_failures', toCommit: pinned, failureCodes: [{ code: 'source_changed', count: 1 }] });
    expect(blocked.managedWrite?.line_endings).toBeUndefined();
    expect((await engine.getPage('z', { sourceId: f.id }))?.compiled_truth).toBe('Original last observation.');
    expect(readFileSync(join(f.root, 'z.md'), 'utf8')).toBe(newer.replace(/\n/g, '\r\n'));
    expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(f.head);
    expect(await performManagedSync(engine, options)).toEqual(blocked);
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
    expect(replay).toEqual(blocked);
    expect(await engine.executeRaw('SELECT id,state,intent,error_code FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id])).toEqual(receipts);
    writeFileSync(join(f.root, 'bad.md'), 'Repaired valid source observation.\n');
    const fullTarget = commit(f.root);
    expect(await performManagedSync(engine, { ...options, full: true })).toMatchObject({ status: 'synced', toCommit: fullTarget });
    const [source] = await engine.executeRaw('SELECT last_commit,last_sync_at FROM sources WHERE id=$1', [f.id]);
    expect(await performManagedSync(engine, options)).toEqual(blocked);
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
    expect(await performManagedSync(engine, options)).toEqual(blocked);
    const repaired = await performManagedSync(engine, { ...options, retryFailed: true });
    expect(repaired.status).toBe('synced'); expect(repaired.runId).not.toBe(blocked.runId);
    expect(await readManagedSyncFailures(engine, [f.id])).toHaveLength(0);
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
  }
}), 120_000);

test('checkpoint, discovery, and freeze failures remain diagnosable without a file receipt', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'note.md': 'A stable observation before checkpoint.\n' });
    const options = { sourceId: f.id, noPull: true };
    expect((await performManagedSync(engine, options, { maxPages: 1, maxMs: 1000 })).status).toBe('partial');
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [f.id, f.head])));
    const blocked = await performManagedSync(engine, options);
    expect(blocked).toEqual(expect.objectContaining({ status: 'blocked_by_failures', failures: [expect.objectContaining({ path: '<checkpoint>', phase: 'checkpoint', code: 'revision_conflict' })] }));
    expect(await performManagedSync(engine, options)).toEqual(blocked);
    expect(await performManagedSync(engine, { ...options, retryFailed: true })).toMatchObject({ status: 'synced' });
    expect(await readManagedSyncFailures(engine, [f.id])).toHaveLength(0);

    const d = await fixture(engine, { 'note.md': 'A stable discovery observation.\n' });
    const execute = engine.executeRaw;
    engine.executeRaw = function (this: BrainEngine, sql: string, params?: unknown[]) {
      if (sql.includes('SELECT id,slug,source_path,knowledge_revision FROM pages') && params?.[0] === d.id) throw new OperationError('storage_error', 'Synthetic discovery failure');
      return execute.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    try {
      await expect(performManagedSync(engine, { sourceId: d.id, noPull: true })).rejects.toMatchObject({ code: 'storage_error' });
      await expect(performManagedSync(engine, { sourceId: d.id, noPull: true })).rejects.toMatchObject({ code: 'storage_error' });
    } finally { engine.executeRaw = execute; }
    expect(await readManagedSyncFailures(engine, [d.id])).toEqual([expect.objectContaining({ phase: 'discovery', path: '<discovery>', request_id: null, target: d.head, attempts: 1 })]);
    await performManagedSync(engine, { sourceId: d.id, noPull: true, retryFailed: true });
    expect(await readManagedSyncFailures(engine, [d.id])).toHaveLength(0);

    const c = await fixture(engine, { 'a.md': 'First enumerated page.\n', 'b.md': 'Second enumerated page.\n' });
    await performManagedSync(engine, { sourceId: c.id, noPull: true }, { maxPages: 1, maxMs: 1000 });
    await engine.transaction(tx => withCoordinatedWrite(tx, [c.id], () => tx.putPage('b', {
      type: 'note', title: 'b', compiled_truth: 'A newer accepted database observation.', timeline: '', frontmatter: {}, content_hash: 'newer',
    }, { sourceId: c.id })));
    await expect(performManagedSync(engine, { sourceId: c.id, noPull: true })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await readManagedSyncFailures(engine, [c.id])).toEqual([expect.objectContaining({ phase: 'freeze', path: 'b.md', request_id: null, target: c.head })]);
    expect((await engine.getPage('b', { sourceId: c.id }))?.compiled_truth).toContain('newer accepted');
  }
}), 120_000);

test('explicit retry leaves a frozen terminal cursor untouched while queued work exists', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'bad.md': '---\ntitle: [broken\n---\nBad content.\n' });
    const options = { sourceId: f.id, noPull: true };
    const blocked = await performManagedSync(engine, options);
    await disposePersistenceConsumer(engine);
    const [row] = await engine.executeRaw<any>('SELECT * FROM persistence_requests WHERE source_id=$1', [f.id]);
    const active = await admitWrite(engine, { requestId: randomUUID(), operation: row.operation, sourceId: row.source_id,
      sourceIncarnation: row.source_incarnation, slug: row.slug, pageId: row.page_id, worktreeId: row.worktree_id,
      topologyGeneration: row.topology_generation, principal: row.authority.principal, authority: row.authority,
      callerIntent: { ...row.intent, runId: 'another-active-run' }, intent: { ...row.intent, runId: 'another-active-run' } });
    writeFileSync(join(f.root, 'bad.md'), 'Repaired useful source content.\n'); commit(f.root);
    expect(await performManagedSync(engine, { ...options, retryFailed: true })).toEqual(blocked);
    expect((await engine.executeRaw<{ run: string }>("SELECT completed_keys->0->>'runId' AS run FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]))[0].run).toBe(blocked.runId!);
    const claimed = await claimNextWrite(engine, localHostId()); expect(claimed?.id).toBe(active.id);
    expect(await performManagedSync(engine, { ...options, retryFailed: true })).toEqual(blocked);
    await markRecovering(engine, claimed!, 'Synthetic recovering fixture');
    expect(await performManagedSync(engine, { ...options, retryFailed: true })).toEqual(blocked);
    await engine.transaction(tx => completeWrite(tx, claimed!, 'cancelled', {}, { code: 'storage_error', message: 'Fixture cleanup' }));
    expect((await performManagedSync(engine, { ...options, retryFailed: true })).status).toBe('first_sync');
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
      expect(single).toEqual(expect.objectContaining({ sync_status: 'blocked_by_failures', failures: [expect.objectContaining({ path: 'bad.md', source_id: f.id, request_id: expect.any(String), phase: 'receipt' })], counts_scope: 'run_cumulative' }));
      expect(currentExitCode()).toBe(1); expect(stderr).toContain('--retry-failed'); expect(stderr).not.toContain('--skip-failed');
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

test('a new process reads the same failed receipt from a persisted PGLite brain', async () => withEnv(env, async () => {
  const database = join(home, 'restart-db');
  const engine = new PGLiteEngine(); await engine.connect({ database_path: database }); await engine.initSchema();
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
  expect(JSON.parse(stdout)).toEqual({ result: expected!, receipts: [{ count: 1 }] });
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
      expect(await run()).toEqual(pending);
      expect(await engine.executeRaw('SELECT request_id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual(requests);
      expect(await readManagedSyncFailures(engine, [f.id])).toHaveLength(1);
      await lock!.release();
      expect(await run()).toMatchObject({ status: 'first_sync', added: 1 });
    } finally { await lock?.release(); await disposePersistenceConsumer(engine); }
  }
}), 120_000);

test('missing manifest is a durable nonfile blocker and only explicit idle retry rediscovers it', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': 'First committed observation.\n', 'b.md': 'Second committed observation.\n' });
    const options = { sourceId: f.id, noPull: true };
    const partial = await performManagedSync(engine, options, { maxPages: 1, maxMs: 1000 });
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [partial.runId]);
    await expect(performManagedSync(engine, options)).rejects.toMatchObject({ code: 'storage_error' });
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([expect.objectContaining({ phase: 'resume', path: '<resume>', run_id: partial.runId, target: f.head })]);
    expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
    const repaired = await performManagedSync(engine, { ...options, retryFailed: true });
    expect(repaired.status).toBe('first_sync'); expect(repaired.runId).not.toBe(partial.runId);
    expect(await readManagedSyncFailures(engine, [f.id])).toHaveLength(0);
  }
}), 120_000);

test('a new failed admission increments attempts but repeating retry during repaired progress does not reset the run', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'a.md': 'Useful successful first observation.\n', 'bad.md': '---\ntitle: [broken\n---\nFailed observation.\n' });
    const options = { sourceId: f.id, noPull: true };
    const first = await performManagedSync(engine, options);
    const second = await performManagedSync(engine, { ...options, retryFailed: true });
    expect(second.failures![0].request_id).not.toBe(first.failures![0].request_id);
    expect(second.failures![0].attempts).toBe(2);
    expect(await performManagedSync(engine, options)).toEqual(second);
    writeFileSync(join(f.root, 'bad.md'), 'Repaired successful second observation.\n'); commit(f.root);
    const slice = { maxPages: 1, maxMs: 1000 };
    const start = await performManagedSync(engine, { ...options, retryFailed: true }, slice);
    expect(start.status).toBe('partial'); expect(start.filesImported).toBe(1);
    const continued = await performManagedSync(engine, { ...options, retryFailed: true }, slice);
    expect(continued.runId).toBe(start.runId); expect(continued.filesImported).toBe(2);
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(1);
    expect((await performManagedSync(engine, options)).status).toBe('first_sync');
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
  }
}), 120_000);
