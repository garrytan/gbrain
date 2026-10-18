/**
 * #6543 D5 (+ #6518): on a managed brain, rows the pre-managed sync left in the local ledger
 * (`sync-failures.jsonl`, often `auto_skipped`) were never retried or cleared by a managed sync, while doctor told the
 * operator to run `gbrain sync --no-pull --retry-failed`, which printed "No local ledger entries" and left them.
 *
 * Now a successful managed sync reconciles each legacy row of its source on its own against the imported commit, the
 * live page and any hold: a row whose file the commit holds with a live page (or whose file is gone with no page)
 * settles; rows for files the sync did not index, or recorded on a commit this checkout does not have (a replaced
 * source), stay. Mirror rows whose durable failure is gone are pruned only after the durable lookup succeeds.
 * `--retry-failed` names the legacy rows, and doctor names them as their own count.
 *
 * Regression that fails it: legacy rows surviving a successful sync, an unindexed file's row disappearing, the stale
 * mirror surviving, "No local ledger entries" printed while legacy rows exist, or doctor without the legacy note.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSyncInner } from '../src/commands/sync/run.ts';
import { checkSyncFailures } from '../src/commands/doctor/checks/sync-failures.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { loadSyncFailures, syncFailuresPath } from '../src/core/sync-failure-ledger.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-legacy-ledger-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, GBRAIN_SYNC_NO_DELEGATE: '1' };
let engine: PGLiteEngine;
const captured: string[] = [];
const orig = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr), log: console.log, error: console.error };
function capture(): void {
  captured.length = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => { captured.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
  console.log = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
}
function release(): void { process.stdout.write = orig.out; process.stderr.write = orig.err; console.log = orig.log; console.error = orig.error; }

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 120_000);
afterAll(async () => {
  release();
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

function legacyRow(sourceId: string, path: string, commit: string, extra: Record<string, unknown> = {}): string {
  const at = '2026-09-01T00:00:00.000Z';
  return JSON.stringify({ source_id: sourceId, path, error: 'source_changed: file and database disagree', code: 'source_changed', commit,
    first_seen: at, ts: at, attempts: 3, state: 'auto_skipped', resolved_at: at, acknowledged: false, acknowledged_at: null, ...extra });
}

test('a successful managed sync settles legacy rows it imports, keeps unindexed and replaced-source rows, prunes a stale mirror; retry and doctor name them', async () => withEnv(env, async () => {
  const id = `legacy-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); mkdirSync(join(root, 'assets'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  writeFileSync(join(root, 'notes', 'a.md'), '---\ntitle: A\n---\nA durable observation.\n');
  writeFileSync(join(root, 'assets', 'data.bin'), Buffer.from([0, 1, 2, 3]));
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'initial']);
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

  writeFileSync(syncFailuresPath(), [
    legacyRow(id, 'notes/a.md', head),
    legacyRow(id, 'notes/gone.md', head),
    legacyRow(id, 'assets/data.bin', head),
    legacyRow(id, 'notes/old.md', '0123456789abcdef0123456789abcdef01234567'),
    legacyRow(id, 'notes/mirror.md', head, { state: 'open', managed_cursor_key: 'stale-cursor-key', request_id: null, run_id: 'r', observation_id: 'o' }),
  ].join('\n') + '\n');

  const before = await checkSyncFailures(engine, { sourceIds: [id], remote: false });
  expect(before?.message).toContain('legacy ledger');
  expect(before?.message).toContain(`gbrain sync --source ${id}`);

  capture();
  try { await runSyncInner(engine, ['--source', id, '--no-pull', '--retry-failed', '--no-embed', '--no-extract']); } finally { release(); }
  const output = captured.join('\n');
  expect(output).not.toContain('No local ledger entries');
  expect(output).toContain('4 legacy ledger row(s)');

  const rows = loadSyncFailures().filter(row => row.source_id === id);
  expect(rows.map(row => row.path).sort()).toEqual(['assets/data.bin', 'notes/old.md']);
  expect(rows.every(row => !row.managed_cursor_key)).toBe(true);

  const after = await checkSyncFailures(engine, { sourceIds: [id], remote: false });
  expect(after?.message).toContain('2 of these are legacy ledger row(s)');
  expect(after?.message).not.toContain('notes/a.md');
  const noEngine = await checkSyncFailures(null, { sourceIds: [id], remote: false });
  expect(noEngine?.message).toContain('2 unresolved sync failure(s)');
}), 120_000);
