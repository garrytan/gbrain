/**
 * #6288 part 2: a recorded managed sync failure under a cursor key autopilot never resumes (a `--full` run's) can be cleared.
 *
 * Protects: after a successful managed sync, a failure row of that source whose cursor is gone and whose file the imported
 * commit settles (imported and not held; or absent from the commit with no live page) is removed from the database and from the JSONL mirror; a row for
 * a file that is held or never imported stays. `gbrain sync --acknowledge-managed <request_id|path>` removes only settled
 * rows and refuses the rest (unsettled, or an unfinished cursor) with `managed_failure_unsettled`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runSyncInner } from '../src/commands/sync/run.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { acknowledgeManagedSyncFailures, readManagedSyncImported, recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-6288-'));
let engine: PGLiteEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'change'); };
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;
async function fixture() {
  const id = `sf-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(join(root, 'a.md'), note('Alpha.')); writeFileSync(join(root, 'b.md'), note('Beta.'));
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
  expect((await performSync(engine, opts)).status).toBe('first_sync');
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  return { id, root, opts, incarnation: source!.incarnation };
}
/** A failure recorded under a cursor key with no cursor, as a `--full` run that stopped before saving one leaves it. */
async function staleFailure(f: { id: string; incarnation: string }, path: string, key = `full-${randomUUID()}`) {
  const requestId = randomUUID();
  await recordManagedSyncFailure(engine, { source_id: f.id, source_incarnation: f.incarnation, path, code: 'invalid_params', message: 'Invalid YAML frontmatter.',
    request_id: requestId, run_id: randomUUID(), target: 'deadbeef', cursor_key: key, phase: 'receipt', state: 'failed', observation_id: requestId });
  return { key, requestId };
}
const rows = async (id: string) => (await engine.executeRaw<{ path: string }>("SELECT completed_keys->0->>'path' AS path FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys->0->>'source_id'=$1 ORDER BY 1", [id])).map(r => r.path);
const mirrored = (id: string) => loadSyncFailures().filter(row => row.source_id === id).map(row => row.path).sort();

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('a successful managed sync clears a stale failure its imported commit settles and keeps one it does not', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  const f = await fixture();
  await staleFailure(f, 'a.md');
  await staleFailure(f, 'gone.md');
  writeFileSync(join(f.root, 'c.md'), '---\ntitle: [broken\n---\nGamma, committed but held.\n');
  commit(f.root);
  await staleFailure(f, 'c.md');
  expect(await rows(f.id)).toEqual(['a.md', 'c.md', 'gone.md']);
  expect(mirrored(f.id)).toEqual(['a.md', 'c.md', 'gone.md']);
  expect((await performSync(engine, f.opts)).status).toBe('synced');
  expect(await rows(f.id)).toEqual(['c.md']);
  expect(mirrored(f.id)).toEqual(['c.md']);
}), 120_000);

test('--acknowledge-managed removes a settled failure by request id and refuses an unsettled one or an unfinished cursor', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'missing.md'), '---\ntitle: [broken\n---\nCommitted, held, never imported.\n');
  commit(f.root);
  expect((await performSync(engine, f.opts)).status).toBe('synced');
  const settled = await staleFailure(f, 'b.md');
  await staleFailure(f, 'missing.md');
  const imported = (await readManagedSyncImported(engine, f.id))!;
  const ack = await acknowledgeManagedSyncFailures(engine, imported, settled.requestId);
  expect(ack.cleared.map(row => row.path)).toEqual(['b.md']);
  expect(ack.refused).toEqual([]);
  await expect(runSyncInner(engine, ['--source', f.id, '--acknowledge-managed', 'missing.md'])).rejects.toMatchObject({ code: 'managed_failure_unsettled' });
  expect(await rows(f.id)).toEqual(['missing.md']);
  const unfinished = await staleFailure(f, 'a.md');
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync',$1,'[{"done":false}]'::jsonb)`, [unfinished.key]);
  const refused = await acknowledgeManagedSyncFailures(engine, imported, 'a.md');
  expect(refused.cleared).toEqual([]);
  expect(refused.refused.map(row => row.reason)).toEqual(['cursor_unfinished']);
}), 120_000);
