/**
 * Child process for the F0 restart test. `crash`: queue a page write, start a
 * refresh, and exit the process right after `git merge --ff-only` succeeded
 * and before the merged bookkeeping commits. `restart`: open the brain as a
 * fresh owner, let the resident consumer's startup recovery move the refresh,
 * then `--resume` it and report the final state as one JSON line.
 * `kill-syncing` (#7679): start a refresh and SIGKILL this process once the row
 * is `syncing` (merged, member syncs not yet run), printing its pid first.
 */
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import type { GBrainConfig } from '../../src/core/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../../src/core/persistence/service.ts';
import { refreshWorktree } from '../../src/core/persistence/worktree-refresh.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

const input = JSON.parse(process.env.GBRAIN_TEST_REFRESH_CHILD!) as { database: GBrainConfig; sourceId: string; worktreeId: string; mode: 'crash' | 'restart' | 'kill-syncing' };
if (input.database.database_url) assertSafeE2eDatabaseUrl(input.database.database_url);
const engine: BrainEngine = input.database.engine === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
await engine.connect(input.database);
const state = async () => (await engine.executeRaw<{ state: string }>(
  'SELECT state FROM persistence_worktree_refreshes WHERE worktree_id=$1::uuid ORDER BY created_at DESC LIMIT 1', [input.worktreeId]))[0]?.state ?? null;

if (input.mode === 'kill-syncing') {
  await refreshWorktree(engine, input.sourceId, { hooks: { boundary: point => {
    if (point !== 'syncing') return;
    writeSync(1, `REFRESH_KILLED_IN_SYNCING ${process.pid}\n`);
    process.kill(process.pid, 'SIGKILL');
  } } });
  process.stdout.write('REFRESH_UNEXPECTED_FINISH\n');
} else if (input.mode === 'crash') {
  const requestId = randomUUID();
  await submitPageMutation({ engine, sourceId: input.sourceId, remote: false, dryRun: false, config: { engine: engine.kind, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} } }, { operation: 'put_page', waitMs: 0,
    params: { slug: 'notes/pre-fence', content: '---\ntitle: Pre fence\ntype: note\n---\nAccepted before the fence.\n', request_id: requestId } }).catch(() => {});
  process.stdout.write(`REFRESH_PRE_FENCE ${requestId}\n`);
  await refreshWorktree(engine, input.sourceId, { hooks: { boundary: point => {
    if (point !== 'merged') return;
    process.stdout.write('REFRESH_CRASH_AFTER_MERGE\n');
    process.exit(137);
  } } });
  process.stdout.write('REFRESH_UNEXPECTED_FINISH\n');
} else {
  const seen: Array<string | null> = [await state()];
  startPersistenceConsumer(engine, { engine: engine.kind } as GBrainConfig);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && seen[seen.length - 1] !== 'syncing') {
    await new Promise(resolve => setTimeout(resolve, 100));
    const next = await state();
    if (next !== seen[seen.length - 1]) seen.push(next);
  }
  const result = await refreshWorktree(engine, input.sourceId, { resume: true });
  seen.push(await state());
  const requests = await engine.executeRaw<{ state: string; slug: string }>('SELECT state,slug FROM persistence_requests WHERE worktree_id=$1::uuid ORDER BY sequence', [input.worktreeId]);
  process.stdout.write(`REFRESH_RESULT ${JSON.stringify({ seen, result, requests })}\n`);
  await disposePersistenceConsumer(engine);
}
await engine.disconnect();
