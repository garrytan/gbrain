/**
 * #6318 on Postgres: a managed-sync preparation's engine-internal reads end at the budget on the server too. #6278 bounded
 * the preparation's raw reads (`executeRaw` with `timeoutMs`), but the engine's own reads (`readPageSnapshot` and the
 * import pipeline's lookups) went to the pool as autocommit statements: under `LOCK TABLE pages IN ACCESS EXCLUSIVE MODE`
 * held in another session they waited for as long as the lock lasted, so the member was released at the budget while its
 * statement stayed on the server, pinning a connection (docs/eval/managed-sync-stall-repro.md, Phase 4.1b).
 *
 * Value: protects=the read deadline on the engine's scoped reads issued through a preparation's bounded view
 * (persistence/bounded-reads.ts, read-deadline.ts); fails_when=a statement of the sync waits on the lock past the budget plus
 * slack while the lock is still held (the pre-fix path: the member's page snapshot read stayed waiting until the lock
 * dropped); why_new=the #6278 lock-wait test takes the lock at the origin check, a raw read; seam=the claimed member's
 * `readPageSnapshot` is intercepted only to take the lock right before it runs (the read itself runs unchanged);
 * no_claim=the consumer's projection-queue probes (`page_projection_jobs`, not preparation reads), which this does not bound.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import postgres from '#postgres';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-prep-engine-reads-e2e-'));
let engine: BrainEngine | undefined;
let databaseUrl = '';
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
const BUDGET_MS = 2_000;
/** How long past the budget a statement may still wait on the lock (the server ends it at the budget). */
const SLACK_MS = 3_000;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const pad = (i: number) => String(i).padStart(3, '0');

async function fixture(e: BrainEngine, count: number) {
  const id = `enginereads-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) {
    const full = join(root, 'notes', `n${pad(i)}.md`); mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`);
  }
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

/** Another session holding `pages` ACCESS EXCLUSIVE until `drop()`, and a reader of the preparation statements waiting on it. */
async function holdPagesLock(url: string) {
  const holder = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
  const dropped = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<void>();
  const transaction = holder.begin(async sql => {
    for (;;) {
      await sql.unsafe('SAVEPOINT lock_attempt');
      try { await sql.unsafe('LOCK TABLE pages IN ACCESS EXCLUSIVE MODE NOWAIT'); break; }
      catch (error) {
        if ((error as { code?: string }).code !== '55P03') throw error;
        await sql.unsafe('ROLLBACK TO SAVEPOINT lock_attempt');
        await Bun.sleep(20);
      }
    }
    acquired.resolve();
    await dropped.promise;
  }).catch(error => { acquired.reject(error); throw error; });
  await acquired.promise;
  const waiting = async () => Array.from(await holder.unsafe(
    `SELECT pid, (extract(epoch FROM now()-query_start)*1000)::int AS age_ms, left(query,100) AS query FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query NOT LIKE '%page_projection_jobs%'`)) as Array<{ pid: number; age_ms: number; query: string }>;
  const request = async (sourceId: string, slug: string) => (Array.from(await holder.unsafe(
    `SELECT state,error_code,error_message,preparation_attempts FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_sync_import'`,
    [sourceId, slug])) as Array<{ state: string; error_code: string | null; error_message: string | null; preparation_attempts: number }>)[0];
  return { waiting, request, drop: async () => { dropped.resolve(); await transaction.catch(() => undefined); await holder.end(); } };
}

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 12); engine = pg.engine; closePostgres = pg.close; databaseUrl = pg.databaseUrl;
  await engine.setConfig('persistence.sync_preparation_ms', String(BUDGET_MS));
  await engine.setConfig('persistence.preparation_ceiling_ms', '60000');
  resetWriteSwitches();
}, 120_000);
afterAll(async () => {
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine!); await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine!.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  });
  resetWriteSwitches();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!hasDatabase())('a lock-blocked engine read of a preparation ends at the budget (Postgres, #6318)', () => {
  test('the page snapshot read ends on the server at the budget: no statement of the sync waits on the lock past it while the lock is held', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SYNC_BULK_SIZE: '1' }, async () => {
    if (!engine) return;
    const f = await fixture(engine, 30);
    const stuckSlug = 'notes/n012';
    let lock: Awaited<ReturnType<typeof holdPagesLock>> | undefined;
    const oldest: { age_ms: number; query: string } = { age_ms: 0, query: '' };
    let watched: Promise<void> = Promise.resolve();
    const original = engine.readPageSnapshot;
    let holds = 0;
    (engine as { readPageSnapshot: unknown }).readPageSnapshot = async function (this: BrainEngine, slug: string, opts?: Parameters<BrainEngine['readPageSnapshot']>[1]) {
      if (slug === stuckSlug && opts?.sourceId === f.id && !lock) {
        const [claimed] = await engine!.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND state='running' AND intent->>'kind'='managed_sync_import'", [f.id, stuckSlug]);
        if (claimed) {
          holds++;
          lock = await holdPagesLock(databaseUrl);
          // Held until the member's terminal receipt and one more budget plus slack, sampling the statements that wait on it.
          watched = (async () => {
            let terminalAt: number | null = null;
            await waitFor(async () => {
              for (const row of await lock!.waiting()) if (row.age_ms > oldest.age_ms) Object.assign(oldest, row);
              if (terminalAt === null && (await lock!.request(f.id, stuckSlug))?.state === 'failed') terminalAt = performance.now();
              return terminalAt !== null && performance.now() - terminalAt > BUDGET_MS + SLACK_MS;
            }, { timeoutMs: BUDGET_MS * 4 + SLACK_MS * 4 + 10_000, intervalMs: 100, label: 'the lock window' }).catch(() => undefined);
            await lock!.drop();
          })();
        }
      }
      return original.call(this, slug, opts);
    };
    await engine.setConfig('sync.holds', 'fail');
    try {
      await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 1 });
    } finally { (engine as { readPageSnapshot: unknown }).readPageSnapshot = original; await watched; await lock?.drop().catch(() => undefined); await engine.unsetConfig('sync.holds'); }
    expect(holds).toBe(1);
    const stuck = await engine.executeRaw<{ state: string; error_code: string | null; error_message: string | null }>(
      `SELECT state,error_code,error_message FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_sync_import'`, [f.id, stuckSlug]);
    expect(stuck[0]).toMatchObject({ state: 'failed', error_code: 'preparation_stalled' });
    // Before the bound, the first attempt's snapshot read was still waiting when the lock dropped (its age, the whole window).
    expect({ age_over_bound: oldest.age_ms >= BUDGET_MS + SLACK_MS, query: oldest.query }).toMatchObject({ age_over_bound: false });
  }), 300_000);
});
