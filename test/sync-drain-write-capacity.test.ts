/**
 * #6278 (B7, defect 2): a managed drain whose next admission is refused for
 * write capacity (`queue_capacity`, the writer's outstanding-request cap held
 * by another writer's queued requests on the same principal) waits instead of
 * dying. Before this change the refusal escaped `performManagedSync`, the run
 * recorded a managed-sync failure that named `--retry-failed`, and the CLI
 * exited 1 with no drain summary and no `next` (the Phase 4.1b lock run). Now
 * the drain retries with backoff while the other writer's requests settle,
 * prints `waiting for write capacity (N outstanding)`, and after its
 * no-progress window ends `blocked` / `write_capacity` with `next` naming
 * writer status; a cumulative cap (permanent request IDs, receipt bytes) is
 * still a refusal that needs a config change, never a wait. The forced probe
 * fills the sync writer's own outstanding counter to the cap, so the pass is
 * refused exactly where the bench died. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { capacityError } from '../src/core/persistence/journal.ts';
import { isWriteCapacityWait } from '../src/core/persistence/admission-retry.ts';
import { drainManagedSync, drainJsonFields, drainNext, formatDrainSummary, runDrain } from '../src/core/persistence/sync-drain.ts';
import { ERROR_CATALOGUE } from '../src/core/error-catalogue.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const base: SyncResult = { status: 'synced', fromCommit: 'a', toCommit: 'b', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] };
const RESUME = 'gbrain sync --source s --no-pull';
const refused = () => capacityError('principal outstanding requests', { used: 99, limit: 100 });

function captureStderr(): { lines: string[]; waiting: () => string[]; restore(): void } {
  const lines: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return { lines, waiting: () => lines.filter(line => line.includes('waiting for write capacity')), restore: () => spy.mockRestore() };
}
const until = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); return check(); };

describe('write-capacity refusals at admission', () => {
  test('the outstanding-request refusal carries its counts and is a wait; cumulative caps and other codes are not', () => {
    const error = refused();
    expect(error).toMatchObject({ code: 'queue_capacity', message: 'Write capacity exhausted: principal outstanding requests.', detail: 'outstanding=99 limit=100' });
    expect(isWriteCapacityWait(error)).toBe(true);
    expect(isWriteCapacityWait(capacityError('brain outstanding requests', { used: 1000, limit: 1000 }))).toBe(true);
    expect(isWriteCapacityWait(capacityError('principal intent bytes'))).toBe(false);
    const cumulative = new OperationError('queue_capacity', 'Write capacity exhausted: principal permanent request IDs (5 used of 5).', 'raise it');
    cumulative.detail = 'principalLifetimeIds';
    expect(isWriteCapacityWait(cumulative)).toBe(false);
    expect(isWriteCapacityWait(new OperationError('storage_error', 'x', 'y'))).toBe(false);
    expect(isWriteCapacityWait(new Error('queue_capacity'))).toBe(false);
  });

  test('a refused pass is retried with backoff until capacity returns, printing the wait; the drain then finishes synced', async () => {
    let passes = 0;
    const err = captureStderr();
    try {
      const result = await runDrain({ announce: true, progressMs: 20, backoffMs: 5, stallMs: 5000, pass: async () => { if (++passes <= 4) throw refused(); return { ...base, managedCursor: { index: 3, total: 3 } }; } });
      expect(result.drain).toMatchObject({ outcome: 'synced', passes: 5 });
      expect(result.drain!.stop_reason).toBeUndefined();
      expect(err.waiting().length).toBeGreaterThanOrEqual(1);
      expect(err.waiting()[0]).toMatch(/^\[sync\] \d+\/\? processed · waiting for write capacity \(99 outstanding of 100\)$/);
    } finally { err.restore(); }
  });

  test('capacity still full after the no-progress window: blocked / write_capacity with the wait on the report, writer status as next, and docs', async () => {
    let passes = 0;
    const result = await runDrain({ backoffMs: 5, stallMs: 150, pass: async () => { passes++; throw refused(); } });
    expect(passes).toBeGreaterThan(1);
    expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'write_capacity', capacity: { outstanding: 99, limit: 100, scope: 'principal' } });
    expect(result.drain!.capacity!.waited_seconds).toBeGreaterThanOrEqual(0);
    const next = drainNext(result, RESUME, 's')!;
    expect(next).toMatchObject({ command: 'gbrain sources writer status --source s --json', safe_to_loop: false, docs: ERROR_CATALOGUE.sync_drain_write_capacity.docs });
    expect(next.why).toContain('99 of the write principal\'s 100 outstanding-request slots');
    expect(next.why).toContain(RESUME);
    expect(next.why).toContain('persistence.limits.principal_outstanding');
    expect(ERROR_CATALOGUE.sync_drain_write_capacity).toEqual({ code: 'queue_capacity', docs: 'docs/guides/write-refusals.md#drain-write-capacity' });
    expect(drainJsonFields(result, RESUME, 's')).toMatchObject({ outcome: 'blocked', next: { command: 'gbrain sources writer status --source s --json' } });
    const summary = formatDrainSummary(result, RESUME, 's');
    expect(summary[0]).toMatch(/^Managed sync blocked: 0 entries this run/);
    expect(summary.join('\n')).toContain('Waited');
    expect(summary.join('\n')).toContain('Next: gbrain sources writer status --source s --json');
  });

  test('a pass that succeeded before the refusal keeps its result on the blocked report; a cumulative cap still ends the drain with the error', async () => {
    let passes = 0;
    const pendingResult: SyncResult = { ...base, status: 'partial', reason: 'writer_yield', added: 7, managedCursor: { index: 7, total: 20 } };
    const result = await runDrain({ backoffMs: 5, stallMs: 100, pass: async () => { if (++passes === 1) return pendingResult; throw refused(); } });
    expect(result).toMatchObject({ added: 7, drain: { outcome: 'blocked', stop_reason: 'write_capacity', remaining: 13 } });
    const cumulative = new OperationError('queue_capacity', 'Write capacity exhausted: principal permanent request IDs (5 used of 5).', 'raise it');
    cumulative.detail = 'principalLifetimeIds';
    await expect(runDrain({ backoffMs: 5, stallMs: 100, pass: async () => { throw cumulative; } })).rejects.toBe(cumulative);
  });
});

describe('forced probe: a real managed sync refused for write capacity', () => {
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-drain-capacity-'));
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.(); rmSync(home, { recursive: true, force: true });
  });

  test('the cap held by other requests: the drain waits and prints, proceeds when they settle; held past the window it ends blocked with next, nothing in the failure ledger', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const id = `cap-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      const write = (name: string) => writeFileSync(join(root, 'notes', `${name}.md`), `---\ntitle: ${name}\n---\nA synthetic observation about ${name}.\n`);
      const commit = (message: string) => { git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
      mkdirSync(join(root, 'notes'), { recursive: true });
      git('init', '-q'); write('a'); commit('fixture');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
      await claimWorktree(engine, id, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
      const ledger = () => engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys::text LIKE $1", [`%${id}%`]);
      const outstanding = (n: number) => engine.executeRaw("UPDATE persistence_counters SET outstanding_count=$1 WHERE key LIKE 'principal:local_cli:%'", [n]);
      const err = captureStderr();
      try {
        // A first sync registers the writer's counter row.
        expect((await drainManagedSync(engine, opts, false)).drain).toMatchObject({ outcome: 'synced', written: 1 });
        const [principal] = await engine.executeRaw<{ key: string }>("SELECT key FROM persistence_counters WHERE key LIKE 'principal:local_cli:%'");
        expect(principal).toBeDefined();
        // Another writer on the same principal holds the whole cap (the bench: 89 queued adoption writes and one running against 100).
        await engine.setConfig('persistence.limits.principal_outstanding', '4');
        await outstanding(4);
        write('b'); write('c'); commit('two more');
        const drain = drainManagedSync(engine, { ...opts, drainStartedAt: Date.now() }, true);
        expect(await until(() => err.waiting().length > 0, 20_000)).toBe(true);
        expect(err.waiting()[0]).toMatch(/waiting for write capacity \(4 outstanding of 4\)$/);
        // The other writer's requests settle: the same drain proceeds.
        await outstanding(0);
        const result = await drain;
        expect(result.drain).toMatchObject({ outcome: 'synced', written: 2, remaining: 0 });
        expect(result.drain!.passes).toBeGreaterThan(1);
        expect(await engine.getPage('notes/c', { sourceId: id })).not.toBeNull();
        expect(await ledger()).toEqual([]);
        // Held past the window: one blocked stop with next, no uncaught error, no failure-ledger row, and the cursor intact for the rerun.
        await outstanding(4);
        write('d'); commit('one more');
        const blocked = await runDrain({ announce: false, stallMs: 300, backoffMs: 10, pass: (signal, onProgress) => import('../src/core/persistence/sync-run.ts')
          .then(m => m.performManagedSync(engine, { ...opts, signal, onProgress, drainStartedAt: Date.now() })) });
        expect(blocked.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'write_capacity', capacity: { outstanding: 4, limit: 4, scope: 'principal' } });
        expect(drainNext(blocked, `gbrain sync --source ${id} --no-pull`, id)!.command).toBe(`gbrain sources writer status --source ${id} --json`);
        expect(await ledger()).toEqual([]);
        expect(await engine.getPage('notes/d', { sourceId: id })).toBeNull();
        await outstanding(0);
        expect((await drainManagedSync(engine, opts, false)).drain).toMatchObject({ outcome: 'synced', written: 1 });
        expect(await engine.getPage('notes/d', { sourceId: id })).not.toBeNull();
      } finally { err.restore(); await engine.unsetConfig('persistence.limits.principal_outstanding'); await disposePersistenceConsumer(engine); }
    }
  }), 180_000);
});
