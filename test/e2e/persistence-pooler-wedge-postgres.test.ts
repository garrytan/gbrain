/**
 * #6278 (PR 1.5): a consumer round-trip a transaction-mode pooler never
 * completes must settle client-side, and the catch-up must go on.
 *
 * The live report: through Supavisor :6543 the consumer's `expired_claims`
 * CTE sat with its backend in `ClientRead`; the 5 s phase deadline fired, the
 * cancel request never reached the backend, and the awaited promise never
 * settled, so the whole owner parked until the watchdog. Here the pool's
 * `reserve()` is wrapped so that one `expired_claims` statement behaves like
 * that wedge: it never settles, its `cancel()` resolves without ending it,
 * and only `discard()` (what `runUnsafe` does after the settle window)
 * rejects it. Everything else runs against the real Postgres.
 *
 * Fails before the fix: the sync never returns (the test times out). After:
 * the phase ends `deadline_exceeded`, the consumer keeps ticking and the
 * 60-page catch-up drains `synced` with no `storage_error` report.
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
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';
import { hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-pooler-wedge-e2e-'));
let engine: BrainEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function fixture(e: BrainEngine, count: number) {
  const id = `wedge-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) {
    const full = join(root, 'notes', `n${String(i).padStart(3, '0')}.md`); mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`);
  }
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

interface Reserved { unsafe: (sql: string, params?: unknown[], opts?: unknown) => Promise<unknown[]> & { cancel?: () => Promise<void> }; discard?: () => void; release: () => void }
type Pool = ((...args: unknown[]) => unknown) & { reserve: (opts?: unknown) => Promise<Reserved> };

/** Wedges the first `expired_claims` statement the consumer issues through a reserved connection; counts cancels and discards. */
function wedgeExpiredClaims(pool: Pool) {
  const originalReserve = pool.reserve;
  const seen = { wedged: 0, cancels: 0, discards: 0, settledBy: null as null | 'cancel' | 'discard' };
  pool.reserve = async (opts?: unknown) => {
    const reserved = await originalReserve.call(pool, opts);
    if (seen.wedged > 0) return reserved;
    const originalUnsafe = reserved.unsafe.bind(reserved);
    const originalDiscard = reserved.discard?.bind(reserved);
    let reject: ((error: unknown) => void) | undefined;
    reserved.unsafe = (sql: string, params?: unknown[], unsafeOpts?: unknown) => {
      if (seen.wedged > 0 || !sql.startsWith('WITH expired AS')) return originalUnsafe(sql, params, unsafeOpts);
      seen.wedged++;
      const statement = new Promise<unknown[]>((_, rej) => { reject = rej; }) as Promise<unknown[]> & { cancel: () => Promise<void> };
      // The pooler swallows the cancel: it resolves, the backend stays in ClientRead, the statement never ends on its own.
      statement.cancel = async () => { seen.cancels++; };
      return statement;
    };
    reserved.discard = () => {
      seen.discards++;
      if (reject) { seen.settledBy ??= 'discard'; reject(Object.assign(new Error('write CONNECTION_DESTROYED'), { code: 'CONNECTION_DESTROYED' })); reject = undefined; }
      originalDiscard?.();
    };
    return reserved;
  };
  return { seen, restore: () => { pool.reserve = originalReserve; } };
}

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 12); engine = pg.engine; closePostgres = pg.close;
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

describe.skipIf(!hasDatabase())('#6278 PR 1.5: a wedged consumer round-trip settles client-side and the catch-up drains', () => {
  test('one expired_claims statement never completes: cancel is swallowed, the connection is discarded at the settle window, the phase ends deadline_exceeded and 60 pages still sync', async () =>
    withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_CANCEL_SETTLE_MS: '300' }, async () => {
      if (!engine) return;
      const f = await fixture(engine, 60);
      const pool = (engine as unknown as { sql: Pool }).sql;
      const wedge = wedgeExpiredClaims(pool);
      const lines: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      (process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
      const started = performance.now();
      let result;
      try {
        result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 2 });
      } finally {
        (process.stderr as unknown as { write: unknown }).write = write;
        wedge.restore();
      }
      expect(wedge.seen.wedged).toBe(1);
      expect(wedge.seen.cancels).toBe(1);
      expect(wedge.seen.discards).toBeGreaterThanOrEqual(1);
      expect(wedge.seen.settledBy).toBe('discard');
      expect(result.drain).toMatchObject({ outcome: 'synced' });
      const rows = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [f.id]);
      expect(rows.length).toBe(60);
      expect(rows.every(row => row.state === 'committed')).toBe(true);
      expect(lines.filter(line => line.includes('phase=expired_claims') && line.includes('reason=deadline_exceeded')).length).toBe(1);
      expect(lines.filter(line => line.includes('reason=storage_error') || line.includes('CONNECTION_DESTROYED'))).toEqual([]);
      // The wedge cost one phase deadline (5 s) plus the settle window, not the watchdog.
      expect(performance.now() - started).toBeLessThan(120_000);
    }), 180_000);
});
