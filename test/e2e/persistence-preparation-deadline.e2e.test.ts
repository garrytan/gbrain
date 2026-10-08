/**
 * #6278 on Postgres: a managed catch-up never stalls on one stuck preparation
 * (the consumer side; the sync-side hold conversion is covered with the sync
 * tests). A 200-page managed source is drained through the real
 * `performSync`, with one sync member's origin check held open by the engine
 * in two shapes: a preparer that honours cancellation (the statement rejects
 * on abort) and one that ignores it (the reporter's shape: the await settles
 * only when the fixture lets it). Protects: the member is released at
 * `persistence.sync_preparation_ms` with `preparation_deadline` and one
 * counted attempt while its root keeps publishing the pages before it; while
 * it hangs, `gbrain sources writer status --json` names the step
 * (`origin_check`), what it waits on (`db`) and the owner process; the second
 * cut-off finishes the request `failed`/`preparation_stalled` within
 * budget x attempts plus slack (so the run ends `blocked` on that page instead
 * of waiting for the watchdog); the abandoned attempt's late result never
 * publishes. Pre-#6278 a sync member had no deadline, so both shapes held the
 * root for as long as the claim renewed, and this test timed out.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readWriterDiagnostics } from '../../src/core/persistence/diagnostics.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-prep-deadline-e2e-'));
let engine: BrainEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
const BUDGET_MS = 1_000;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const pad = (i: number) => String(i).padStart(3, '0');
async function fixture(e: BrainEngine, count: number) {
  const id = `prep-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) {
    const full = join(root, 'notes', `n${pad(i)}.md`); mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, `---\ntitle: Note ${i}\n---\nA durable observation number ${i}, see [[notes/n${pad((i + 7) % count)}]].\n`);
  }
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
const imports = (e: BrainEngine, source: string) => e.executeRaw<{ slug: string; state: string; blocked_reason: string | null; error_code: string | null; preparation_attempts: number; error_message: string | null }>(
  `SELECT slug,state,blocked_reason,error_code,preparation_attempts,error_message FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [source]);
const ORIGIN_CHECK_SQL = 'SELECT id,slug,source_path FROM pages WHERE source_id=$1 AND ';

/**
 * Holds the origin check of `path` open until `onHold(attempt)` resolves, then lets the statement run. The statement
 * itself takes no signal (the clock's signal is what `enterClaimStep` throws), so a preparer that honours cancellation is
 * modelled by letting the statement go once the consumer has released the request, one that ignores it by a fixed delay.
 */
function holdOriginCheck(e: BrainEngine, sourceId: string, path: string, slug: string, onHold: (attempt: number) => Promise<void>) {
  const original = e.executeRaw;
  let holds = 0;
  (e as { executeRaw: unknown }).executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[], opts?: unknown) {
    if (typeof sql === 'string' && sql.startsWith(ORIGIN_CHECK_SQL) && Array.isArray(params?.[1]) && (params![1] as string[]).includes(path)) {
      // Only the consumer's preparation of the claimed request is held; the sync feeder's own origin and waiver checks (no claim) pass.
      const [claimed] = await original.call(this, "SELECT 1 FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND state='running' AND intent->>'kind'='managed_sync_import'", [sourceId, slug]);
      if (claimed) await onHold(++holds);
    }
    return original.call(this, sql, params, opts as never);
  };
  return { restore: () => { (e as { executeRaw: unknown }).executeRaw = original; }, holds: () => holds };
}

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 12); engine = pg.engine; closePostgres = pg.close;
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

describe.skipIf(!hasDatabase())('managed catch-up preparation deadlines (Postgres, #6278)', () => {
  for (const shape of ['honours', 'ignores'] as const) {
    test(`one sync member whose preparation ${shape} cancellation is released at the budget and finished preparation_stalled on its second cut-off while the root keeps publishing`, async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
      if (!engine) return;
      const f = await fixture(engine, 200);
      const stuckPath = 'notes/n050.md';
      const stuckSlug = 'notes/n050';
      const held: number[] = [];
      const requestState = async () => (await engine!.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_sync_import'", [f.id, stuckSlug]))[0]?.state;
      const hold = holdOriginCheck(engine, f.id, stuckPath, stuckSlug, async () => {
        held.push(performance.now());
        if (shape === 'honours') await waitFor(async () => await requestState() !== 'running', { timeoutMs: 60_000 }).catch(() => undefined);
        else await Bun.sleep(BUDGET_MS * 1.5);
      });
      await engine.setConfig('sync.holds', 'fail');
      let result;
      try {
        result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 });
      } finally { hold.restore(); await engine.unsetConfig('sync.holds'); }
      const ended = performance.now();
      // The run stopped on that page instead of waiting for the watchdog: two cut-offs, then the terminal receipt.
      expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'blocked_by_failures' });
      expect(result.managedWrite?.slug).toBe(stuckSlug);
      const rows = await imports(engine, f.id);
      const stuck = rows.find(row => row.slug === stuckSlug)!;
      expect(stuck).toMatchObject({ state: 'failed', error_code: 'preparation_stalled', preparation_attempts: 2 });
      expect(stuck.error_message).toContain('step origin_check (waiting on db)');
      expect(stuck.error_message).toContain(`gbrain sources retry-held ${f.id}`);
      expect(hold.holds()).toBe(2);
      // Time from the first cut-off attempt to the terminal receipt stays inside budget x attempts plus slack.
      expect(ended - held[0]!).toBeLessThan(BUDGET_MS * 2 + 20_000);
      // The root kept publishing: every page before the stuck one committed; nothing after it published; the late result never did.
      const stuckAt = rows.findIndex(row => row.slug === stuckSlug);
      expect(stuckAt).toBeGreaterThan(0);
      expect(rows.slice(0, stuckAt).every(row => row.state === 'committed')).toBe(true);
      expect(rows.slice(0, stuckAt).every(row => row.preparation_attempts === 0)).toBe(true);
      expect(await engine.getPage(stuckSlug, { sourceId: f.id })).toBeNull();
      for (const row of rows.slice(stuckAt + 1)) expect(await engine.getPage(row.slug, { sourceId: f.id })).toBeNull();
      expect(rows.slice(stuckAt + 1).every(row => ['cancelled', 'queued'].includes(row.state))).toBe(true);
      // The members behind it in its own group were released uncharged, never claim_lost.
      expect(rows.filter(row => row.blocked_reason === 'claim_lost')).toEqual([]);
      expect(rows.filter(row => row.preparation_attempts > 0).map(row => row.slug)).toEqual([stuckSlug]);
    }), 300_000);
  }

  test('while a member prepares past one renewal, writer status names its step, wait cause, owner and budget; a preparation inside its budget still publishes', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
    if (!engine) return;
    const budget = 15_000;
    await engine.setConfig('persistence.sync_preparation_ms', String(budget));
    resetWriteSwitches();
    const f = await fixture(engine, 20);
    let observed: Awaited<ReturnType<typeof readWriterDiagnostics>>['blockers'][number] | undefined;
    // The hold outlives the 10 s renewal cadence (so the step is stamped) and ends inside the budget (so the page still publishes).
    const hold = holdOriginCheck(engine, f.id, 'notes/n005.md', 'notes/n005', async () => {
      await waitFor(async () => {
        const status = await readWriterDiagnostics(engine!);
        const blocker = status.blockers.find(b => b.state === 'running' && b.claim?.step === 'origin_check');
        if (blocker) observed = blocker;
        return !!blocker;
      }, { timeoutMs: budget - 1_000, label: 'writer status names the origin check step' }).catch(() => undefined);
    });
    try {
      const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 });
      expect(result.drain).toMatchObject({ outcome: 'synced' });
      expect(observed).toBeDefined();
      expect(observed).toMatchObject({ operation: 'submit_job', intent_kind: 'managed_sync_import', preparation_attempts: 0 });
      expect(observed!.claim).toMatchObject({ phase: 'preparing', step: 'origin_check', waiting_on: 'db', budget_ms: budget, stall: null, owner: { pid: process.pid, kind: expect.any(String) } });
      expect(observed!.claim!.step_age_ms).toBeGreaterThanOrEqual(0);
      expect((await imports(engine, f.id)).every(row => row.state === 'committed' && row.preparation_attempts === 0)).toBe(true);
    } finally {
      hold.restore();
      await engine.setConfig('persistence.sync_preparation_ms', String(BUDGET_MS));
      resetWriteSwitches();
    }
  }), 300_000);

  test('with the preparation_deadlines switch off the member keeps its root for as long as the claim renews (the pre-#6278 behaviour), until the fixture lets it go', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4', GBRAIN_PREPARATION_DEADLINES: '0' }, async () => {
    if (!engine) return;
    resetWriteSwitches();
    const f = await fixture(engine, 40);
    const release = Promise.withResolvers<void>();
    const held: number[] = [];
    const hold = holdOriginCheck(engine, f.id, 'notes/n010.md', 'notes/n010', async () => { held.push(performance.now()); await release.promise; });
    try {
      const sync = performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 4 });
      await waitFor(() => held.length === 1, { timeoutMs: 60_000 });
      await Bun.sleep(BUDGET_MS * 3);
      const rows = await imports(engine, f.id);
      expect(rows.find(row => row.slug === 'notes/n010')).toMatchObject({ state: 'running', preparation_attempts: 0 });
      release.resolve();
      const result = await sync;
      expect(result.drain).toMatchObject({ outcome: 'synced' });
      expect((await imports(engine, f.id)).every(row => row.state === 'committed' && row.preparation_attempts === 0)).toBe(true);
    } finally { release.resolve(); hold.restore(); resetWriteSwitches(); }
  }), 300_000);
});
