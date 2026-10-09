/**
 * #6355: a session that drops under a write's admission is an ambiguous outcome,
 * never a refusal. The crash robot (`pooler_disconnect`, seed 5105) saw an
 * `edit_page` caller get the raw `write CONNECTION_CLOSED` back while its
 * admitted request went on to commit, so the receipt the caller held was untrue.
 * `retryWriteAdmission` now re-runs the attempt after a connection loss (every
 * attempt begins by reading the retained request id, so a re-run replays an
 * admitted row instead of admitting again) and, when the session keeps dropping,
 * returns the typed `write_outcome_unknown` with the id to read.
 *
 * Forced probe: `admitWrite` whose transaction commits but whose COMMIT
 * acknowledgment is lost (the wrapper throws `CONNECTION_CLOSED` after the body
 * ran). Before the fix the raw error escaped while the row existed; now the
 * admitted row comes back and exactly one request exists.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { admitWrite, getWriteRequest } from '../src/core/persistence/journal.ts';
import { CONNECTION_LOSS_RETRY_MS, retryWriteAdmission, writeOutcomeUnknown } from '../src/core/persistence/admission-retry.ts';
import { isConnectionLoss } from '../src/core/retry-matcher.ts';
import { CODES } from '../src/core/error-registry.ts';
import { admission, fixtures, initializeFixtures, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-admission-connection-loss-'));
const config: HarnessConfig = {
  kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 5105, schedules: 0, operations: 0,
  sourceIds: ['admission-loss', 'admission-loss-other'], principalIds: [randomUUID()],
};
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
let engine: PGLiteEngine;
const dropped = (code = 'CONNECTION_CLOSED', message = `write ${code} 127.0.0.1:5432`) => Object.assign(new Error(message), { code });

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
}), 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('isConnectionLoss: the drop shapes a pooler, a failover and pg_terminate_backend produce; not auth, not a lock or statement timeout', () => {
  for (const error of [dropped(), dropped('CONNECTION_ENDED'), dropped('CONNECTION_DESTROYED'), Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
    Object.assign(new Error('connection_failure'), { code: '08006' }), new Error('write ECONNABORTED db.example.invalid:5432'), new Error('write EPIPE'), new Error('Connection terminated unexpectedly')]) {
    expect(isConnectionLoss(error)).toBe(true);
  }
  for (const error of [Object.assign(new Error('canceled'), { code: '57014' }), Object.assign(new Error('lock'), { code: '55P03' }), Object.assign(new Error('serialize'), { code: '40001' }),
    new Error('password authentication failed for user "x"'), new OperationError('revision_conflict', 'x', 'y')]) {
    expect(isConnectionLoss(error)).toBe(false);
  }
});

test('retryWriteAdmission re-runs the attempt after a connection loss, ends write_outcome_unknown when it keeps dropping, and leaves every other error alone', async () => {
  const id = randomUUID();
  let calls = 0;
  const row = { request_id: id };
  // One drop, then the re-run reads the admitted row (what every attempt does first): the caller gets the row.
  expect(await retryWriteAdmission(id, async () => { calls++; if (calls === 1) throw dropped(); return row; })).toBe(row);
  expect(calls).toBe(2);
  // Keeps dropping: three re-runs on the 100/300/900 ms schedule, then the typed outcome with the id to read.
  calls = 0;
  const started = performance.now();
  const outcome = await retryWriteAdmission(id, async () => { calls++; throw dropped('57P01', 'terminating connection due to administrator command'); }).catch(error => error as OperationError);
  expect(calls).toBe(CONNECTION_LOSS_RETRY_MS.length + 1);
  expect(performance.now() - started).toBeGreaterThanOrEqual(CONNECTION_LOSS_RETRY_MS.reduce((a, b) => a + b, 0) - 20);
  expect(outcome).toBeInstanceOf(OperationError);
  expect(outcome).toMatchObject({ code: 'write_outcome_unknown', writeError: 'write_outcome_unknown', reason: 'connection_lost', detail: 'terminating connection due to administrator command' });
  expect(outcome.message).toContain('whether it was accepted is unknown');
  expect(outcome.suggestion).toContain(id);
  expect(outcome.fix).toMatchObject({ argv: ['gbrain', 'write-request', '--', id], mcp: { tool: 'get_write_request', arguments: { request_id: id } }, actor: 'agent' });
  expect(CODES.write_outcome_unknown).toMatchObject({ class: 'retryable', actor: 'agent' });
  // A batch id is not a request id: the fix is writer status.
  expect(writeOutcomeUnknown('batch 7', dropped()).fix?.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--json']);
  // The budget bounds the re-runs too.
  calls = 0;
  const short = await retryWriteAdmission(id, async () => { calls++; throw dropped(); }, 60).catch(error => error as OperationError);
  expect(short.code).toBe('write_outcome_unknown'); expect(calls).toBeLessThanOrEqual(2);
  // Any other error still escapes at once; a confirmed abort still retries as before.
  calls = 0;
  await expect(retryWriteAdmission(id, async () => { calls++; throw new OperationError('revision_conflict', 'x', 'y'); })).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(calls).toBe(1);
  calls = 0;
  expect(await retryWriteAdmission(id, async () => { calls++; if (calls === 1) throw Object.assign(new Error('deadlock'), { code: '40P01' }); return row; })).toBe(row);
  expect(calls).toBe(2);
});

test('forced probe: admitWrite whose COMMIT acknowledgment is lost returns the admitted row instead of the raw socket error, and exactly one request exists', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const input = admission(config, sources[0], 'notes/ambiguous', 'A write whose commit acknowledgment the pooler dropped.');
  let drops = 0;
  // The transaction body runs and commits; the socket closes before the client hears about it.
  const lossy = <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => engine.transaction(fn).then(value => { if (drops++ === 0) throw dropped(); return value; });
  const row = await admitWrite(engine, input, undefined, lossy);
  // The lent transaction is tried once; the re-run that found the admitted row ran on the engine's pool.
  expect(drops).toBe(1);
  expect(row.request_id).toBe(input.requestId!);
  expect(['queued', 'running', 'committed']).toContain(row.state);
  const stored = await getWriteRequest(engine, input.principal, input.requestId!);
  expect(stored?.id).toBe(row.id);
  expect(await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests WHERE request_id=$1::uuid', [input.requestId])).toEqual([{ n: 1 }]);
  // A pool whose sessions never come back: the typed outcome, still exactly one request (admitted by the first, acknowledged-lost attempt).
  const second = admission(config, sources[0], 'notes/ambiguous-twice', 'A second write under a connection that keeps dropping.');
  const always = <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => engine.transaction(fn).then(() => { throw dropped('CONNECTION_ENDED'); });
  const dying = Object.create(engine) as BrainEngine;
  Object.defineProperty(dying, 'transaction', { value: always });
  Object.defineProperty(dying, 'reconnect', { value: async () => undefined });
  const unknown = await admitWrite(dying, second).then(() => null, error => error as OperationError);
  expect(unknown).toMatchObject({ code: 'write_outcome_unknown' });
  expect(unknown!.suggestion).toContain(second.requestId!);
  expect(await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests WHERE request_id=$1::uuid', [second.requestId])).toEqual([{ n: 1 }]);
  // Reading the id, as the fix says, finds the accepted write; replaying it is a read.
  expect((await getWriteRequest(engine, second.principal, second.requestId!))?.request_id).toBe(second.requestId!);
  expect((await admitWrite(engine, second)).request_id).toBe(second.requestId!);
  expect(await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests WHERE request_id=$1::uuid', [second.requestId])).toEqual([{ n: 1 }]);
}), 60_000);

test('forced probe: a lent connection (the consumer\'s lane) that dropped is not retried; the re-run admits on the engine\'s pool', async () => withEnv(env, async () => {
  // The robot\'s probe write after `pooler_disconnect` (seed 5105, s1 of 10): the admission ran on the consumer\'s warm lane whose
  // backend the fault had killed, every re-run hit the same dead reservation ("Connection is no longer owned") and the caller got
  // write_outcome_unknown for a connection the pool could have served. The lent transaction is used once; the pool finishes the write.
  const sources = await fixtures(engine, config);
  const input = admission(config, sources[0], 'notes/lane-dropped', 'A write admitted on a lane the pooler killed.');
  let lent = 0;
  const deadLane = <T>(_fn: (tx: BrainEngine) => Promise<T>): Promise<T> => { lent++; return Promise.reject(dropped('CONNECTION_CLOSED', 'CONNECTION_CLOSED: Connection is no longer owned')); };
  let reconnects = 0;
  const pooled = Object.create(engine) as BrainEngine;
  Object.defineProperty(pooled, 'reconnect', { value: async () => { reconnects++; } });
  const row = await admitWrite(pooled, input, undefined, deadLane);
  expect(lent).toBe(1);
  expect(reconnects).toBe(1);
  expect(row.request_id).toBe(input.requestId!);
  expect(await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests WHERE request_id=$1::uuid', [input.requestId])).toEqual([{ n: 1 }]);
}), 60_000);
