/**
 * #8155 for the typed reads the doctor bounds that are NOT in `BOUNDED_TYPED_READS`
 * (src/core/statement-deadline.ts `DEADLINE_BOUND_READS`), on Postgres.
 *
 * On master the doctor sent these statements through `executeRaw` on the deadline-bound engine, which passed an
 * `AbortSignal.timeout(left)`: a socket or pooler that stopped answering after the connection was reserved had the
 * connection discarded at the deadline. A member that does not go through `this.executeRaw` (`readJournalLimitRows`
 * runs on the engine's `preparationRead`, so `runDeadlineRead`'s reserved connection) only takes that path when it
 * is handed a signal; the wrapper handed it none, so an unanswered connection held the read until the pool's
 * in-flight watchdog (`GBRAIN_PG_STUCK_GRACE_MS`, 30 s by default) retired it.
 *
 * Protects: such a member, called under the doctor's statement deadline on a reserved connection that never answers,
 * rejects with a deadline failure at the deadline (not at the watchdog), marks the scope expired, and leaves no
 * connection of the engine open on the stalled path and no gauge slot checked out.
 * Fails when `deadlineBoundEngine` runs a non-`BOUNDED_TYPED_READS` typed read without the deadline's abort signal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { BOUNDED_TYPED_READS, deadlineBoundEngine, deadlineFailure, withStatementDeadline, type StatementDeadline } from '../../src/core/statement-deadline.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

/** A relay to the test database that, once armed, swallows what already-open connections send, so the server never answers them. */
class StallRelay {
  readonly sockets = new Set<Socket>();
  armed = false;
  port = 0;
  private server: Server;
  constructor(private target: { host: string; port: number }) {
    this.server = createServer(client => {
      const upstream = createConnection(this.target);
      const stallable = !this.armed;
      for (const s of [client, upstream]) { this.sockets.add(s); s.on('error', () => {}); s.on('close', () => { this.sockets.delete(s); client.destroy(); upstream.destroy(); }); }
      client.on('data', chunk => { if (!(stallable && this.armed)) upstream.write(chunk); });
      upstream.on('data', chunk => client.write(chunk));
    });
  }
  listen(): Promise<void> {
    return new Promise(done => this.server.listen(0, '127.0.0.1', () => { this.port = (this.server.address() as { port: number }).port; done(); }));
  }
  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>(done => this.server.close(() => done()));
  }
}

let engine: PostgresEngine | undefined;
let relay: StallRelay | undefined;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4);
  const target = new URL(pg.databaseUrl);
  relay = new StallRelay({ host: target.hostname, port: Number(target.port || 5432) });
  await relay.listen();
  await pg.engine.disconnect();
  const through = new URL(pg.databaseUrl);
  through.hostname = '127.0.0.1';
  through.port = String(relay.port);
  // The engine under test connects through the relay; the helper's own engine only built the schema.
  engine = new PostgresEngine();
  await engine.connect({ database_url: through.toString(), poolSize: 2 });
  close = async () => { await engine!.disconnect(); await relay!.close(); await pg.close(); };
}, 120_000);
afterAll(async () => { await close?.(); });

const DEADLINE_MS = 400;
/** Well under the watchdog, well over the timers' slack. */
const MARGIN_MS = 2_500;

describe.skipIf(!hasDatabase())('a typed read outside BOUNDED_TYPED_READS under the statement deadline (Postgres)', () => {
  test('the member under test is a deadline-bound read that is not in BOUNDED_TYPED_READS', () => {
    expect(BOUNDED_TYPED_READS.has('readJournalLimitRows')).toBe(false);
  });

  test('without a deadline the read answers through the relay', async () => {
    expect(Array.isArray(await engine!.readJournalLimitRows())).toBe(true);
  });

  test('readJournalLimitRows on a connection that never answers ends at the deadline, discards the connection and gives back its gauge slot', async () => {
    const gauge = (engine as unknown as { checkoutGauge: { snapshot(): Record<string, number> } }).checkoutGauge;
    // One idle connection, opened before the stall, is the one the read reserves.
    await engine!.readJournalLimitRows();
    const before = relay!.sockets.size;
    expect(before).toBeGreaterThan(0);
    relay!.armed = true;
    const scope: StatementDeadline = { startedAt: Date.now(), deadlineAt: Date.now() + DEADLINE_MS, expired: false };
    const bound = deadlineBoundEngine(engine as unknown as BrainEngine);
    const started = Date.now();
    const outcome = await Promise.race([
      withStatementDeadline(scope, async () => bound.readJournalLimitRows()).then(() => 'resolved', (error: unknown) => error),
      Bun.sleep(DEADLINE_MS + MARGIN_MS).then(() => 'still pending'),
    ]);
    const elapsed = Date.now() - started;
    relay!.armed = false;
    expect(outcome, `readJournalLimitRows did not end within ${DEADLINE_MS + MARGIN_MS} ms`).not.toBe('still pending');
    expect(outcome).not.toBe('resolved');
    expect(deadlineFailure(outcome), String(outcome)).toBe(true);
    expect(elapsed).toBeLessThan(DEADLINE_MS + MARGIN_MS);
    expect(scope.expired).toBe(true);
    // The stalled connection was discarded: its relay sockets closed; the gauge slot came back.
    await Bun.sleep(200);
    expect(relay!.sockets.size).toBeLessThan(before);
    expect(gauge.snapshot().reserved).toBe(0);
    // The engine serves the next caller on a fresh connection.
    expect(Array.isArray(await engine!.readJournalLimitRows())).toBe(true);
  }, 30_000);
});
