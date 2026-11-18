/**
 * Track 2 keeps #8155 for the typed preparation reads (persistence/bounded-reads.ts `TYPED_PREPARATION_READS`).
 * Master issued these reads as raw statements through the preparer's bounded view, which passed the claim clock's
 * signal: an abort after the connection was reserved discarded it and ended the call, so a socket or pooler that
 * stopped answering never kept the read pending. The typed methods run under the view's read deadline
 * (postgres-engine.ts `preparationRead`, postgres-engine/bounded-statement.ts `runDeadlineRead`).
 *
 * Protects:
 * - a typed read stalled on a connection that never answers ends when the clock's signal aborts, with the signal's
 *   reason (as master's raw path), and its reserved connection is discarded, not released;
 * - a group's shared source read (`preparationReads`) goes out once for every member and takes no member's
 *   deadline or signal, so one member's abort never rejects a sibling's read.
 * Fails when the typed path drops the clock's signal, or `getSource` bypasses the group memo.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { boundedReads } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase } from '../src/core/persistence/claim-phase.ts';
import { preparationReads } from '../src/core/persistence/group-publish.ts';
import { readDeadline, readDeadlineSignal } from '../src/core/read-deadline.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

const never = () => new Promise<never>(() => {});

test('a typed preparation read stalled on its connection ends at the clock\'s abort and discards the connection', async () => {
  const counts = { discards: 0, releases: 0 };
  const fake = makeFakeSql(stmt => (/chunker_version/.test(stmt.text) ? never() : undefined));
  const reserve = fake.sql.reserve;
  fake.sql.reserve = async () => {
    const r = await reserve();
    r.discard = () => { counts.discards++; };
    const release = r.release;
    r.release = () => { counts.releases++; release(); };
    return r;
  };
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const controller = new AbortController();
  const reason = { code: 'preparation_deadline' };
  const reads = boundedReads(engine, startClaimPhase(Date.now(), controller.signal, 60_000));
  const call = reads.getPageSealState(7);
  setTimeout(() => controller.abort(reason), 20);
  const outcome = await Promise.race([call.then(() => 'resolved', (error: unknown) => error), Bun.sleep(1_000).then(() => 'still pending')]);
  expect(outcome).toBe(reason);
  expect(counts).toEqual({ discards: 1, releases: 0 });
});

test('a group\'s shared source read goes out once for every member, without a member\'s deadline or signal', async () => {
  const seen: Array<{ deadline: number | undefined; signal: AbortSignal | undefined }> = [];
  const gate = Promise.withResolvers<{ id: string }>();
  const engine = { kind: 'postgres', executeRaw: async () => [],
    getSource: (id: string) => { seen.push({ deadline: readDeadline(), signal: readDeadlineSignal() }); return gate.promise.then(row => ({ ...row, id })); } } as unknown as BrainEngine;
  const shared = preparationReads(engine);
  const a = new AbortController();
  const readA = boundedReads(shared, startClaimPhase(Date.now(), a.signal, 10_000)).getSource('default');
  const readB = boundedReads(shared, startClaimPhase(Date.now(), new AbortController().signal, 10_000)).getSource('default');
  expect(seen).toEqual([{ deadline: undefined, signal: undefined }]);
  a.abort({ code: 'preparation_deadline' });
  gate.resolve({ id: 'default' });
  expect((await readB) as unknown).toEqual({ id: 'default' });
  expect((await readA) as unknown).toEqual({ id: 'default' });
  // Another source is its own read.
  await Promise.all([shared.getSource('other'), gate.promise]);
  expect(seen).toHaveLength(2);
});
