/**
 * Postgres twin of test/shadow-journal-bookkeeping-delegates.test.ts: the REAL PostgresEngine delegates of the eight journal
 * bookkeeping members (src/shadow/follow.ts JOURNAL_BOOKKEEPING_MEMBERS), called on a fresh migrated brain through a seam that records
 * every statement they send, and PostgresEngine.onCheckout on a connected engine.
 *
 * Protects: a Postgres delegate sends only the statements the census names (JOURNAL_MEMBER_STATEMENTS), so every table it writes is
 * one the follower publishes for it; lockPersistenceCounters opens its own transaction when called outside one and sends the same
 * statements; onCheckout sends no statement.
 * Regression it catches: a Postgres delegate or onCheckout that gains a statement the census does not list, for example an UPDATE
 * of pages, which the follower would no longer see.
 * Needs DATABASE_URL; skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { JOURNAL_BOOKKEEPING_MEMBERS } from '../../src/shadow/follow.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { MEMBERS, assertWithinCensus, recordingEngine, runDelegates } from '../helpers/shadow-journal-delegates.ts';

const d = hasDatabase() ? describe : describe.skip;

d('Postgres delegates of the journal bookkeeping members', () => {
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  let ran: Awaited<ReturnType<typeof runDelegates>>;

  beforeAll(async () => {
    template = await persistencePostgresTemplate(process.env.DATABASE_URL!);
    ({ engine, close } = await template.clone());
    ran = await runDelegates('postgres', engine);
  }, 180_000);
  afterAll(async () => { await close(); await template.dispose(); });

  test('the cases cover exactly the listed members', () => {
    expect([...JOURNAL_BOOKKEEPING_MEMBERS].sort()).toEqual([...MEMBERS].sort());
    expect([...ran.keys()].sort()).toEqual([...MEMBERS].sort());
  });

  for (const member of MEMBERS) {
    test(`${member} sends only the statements its census names, and writes only the tables the follower publishes for it`, () => {
      const calls = ran.get(member)!;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      assertWithinCensus(member, calls.map((c) => c.statements));
    });
  }

  test('the recorder sees a statement a delegate adds, in and out of a transaction, and the census check rejects it', async () => {
    const outside = recordingEngine('postgres', engine);
    await outside.engine.executeRaw('UPDATE pages SET title = title WHERE false');
    expect(outside.statements.map((s) => s.sql)).toEqual(['UPDATE pages SET title = title WHERE false']);
    await engine.transaction(async (tx) => {
      const inside = recordingEngine('postgres', tx);
      await inside.engine.executeRaw('UPDATE pages SET title = title WHERE false');
      expect(inside.statements.map((s) => s.sql)).toEqual(['UPDATE pages SET title = title WHERE false']);
    });
    const sent = ran.get('completeEffectRow')!.map((c) => c.statements);
    expect(() => assertWithinCensus('completeEffectRow', [...sent, outside.statements])).toThrow();
  });
});

d('PostgresEngine.onCheckout on a connected engine', () => {
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  beforeAll(async () => { template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => { await close(); });

  test('registers a listener, sends no statement, and the unsubscribe removes the listener', async () => {
    const seen = recordingEngine('postgres', engine);
    let calls = 0;
    const stop = seen.engine.onCheckout(() => { calls += 1; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(seen.statements).toEqual([]);

    // A checkout of a connection (here a transaction) runs the listener; the listener's own work is the caller's, so it sends nothing here.
    await engine.transaction(async () => {});
    expect(calls).toBe(1);
    stop();
    await engine.transaction(async () => {});
    expect(calls).toBe(1);
    expect(seen.statements).toEqual([]);
  });
});
