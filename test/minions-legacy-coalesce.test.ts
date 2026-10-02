/**
 * #5157 / #5114: one coalesce rule on every coalesce path of
 * `MinionQueue.add` (PGLite; Postgres runs the same matrix in
 * `test/e2e/minions-legacy-coalesce-postgres.test.ts`).
 *
 * Only SQL NULL authority (rows from before the v0.50 cutover) gets the
 * legacy rule; JSONB null, malformed and future authority keep the
 * cross-authority denial.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { APPLICATION_AUTHORITY, assertNoUnreviewedJobs, coalesceDecision, prepareRemoteJob } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { ALL_STATUSES, LEGACY_DOCS, PATHS, expectedOutcome, racingEngine, runCoalesceMatrix } from './helpers/legacy-coalesce-matrix.ts';
import { withEnv } from './helpers/with-env.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'gbrain-legacy-coalesce-'));
const root = join(sandbox, 'repo');
const brainHome = join(sandbox, 'home');
let engine: PGLiteEngine;

function isolated<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: brainHome, DATABASE_URL: undefined }, fn);
}
function ctx(): OperationContext {
  return {
    engine, config: {} as OperationContext['config'], dryRun: false, remote: true, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} },
    auth: { token: 'test-only', clientId: 'client-a', principal: { kind: 'oauth_client', id: 'client-a' }, scopes: ['admin'], sourceId: 'default' },
  };
}
const remote = () => prepareRemoteJob(ctx(), 'lint', {});

beforeAll(async () => isolated(async () => {
  mkdirSync(root); mkdirSync(brainHome);
  execFileSync('git', ['init', '-q', root]);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}), 60_000);
afterAll(async () => { await engine?.disconnect(); rmSync(sandbox, { recursive: true, force: true }); }, 60_000);
beforeEach(async () => isolated(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM oauth_clients');
  await engine.executeRaw("UPDATE sources SET config = '{}'::jsonb, archived = false, local_path = $1 WHERE id = 'default'", [root]);
  await engine.executeRaw("INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, scope, source_id) VALUES ('client-a', 'test-only', 'example-client', 'admin', 'default')");
}));

describe('coalesceDecision (raw rows)', () => {
  const remoteAuthority = { version: 1, kind: 'remote_generic', principal: { kind: 'oauth_client', id: 'client-a' } } as never;
  test('SQL NULL gets the legacy rule; JSONB null, malformed and future authority keep the denial', () => {
    for (const status of ALL_STATUSES) {
      for (const [caller, authority] of [['application', APPLICATION_AUTHORITY], ['remote', remoteAuthority]] as const) {
        const legacy = { id: 7, name: 'synthesize', status, submission_authority: null, legacy_authority_is_null: true };
        const expected = expectedOutcome('sql_null', status, caller);
        if (expected === 'deny-legacy') {
          let docs: string | undefined;
          try { coalesceDecision(legacy, authority); } catch (error) { docs = (error as { docs?: string }).docs; }
          expect(docs, `${status}/${caller}`).toBe(LEGACY_DOCS);
        } else {
          expect(coalesceDecision(legacy, authority), `${status}/${caller}`).toBe(expected as 'coalesce' | 'release');
        }
        for (const raw of [null, { version: 1 }, { version: 2, kind: 'application' }]) {
          // A missing marker is never legacy: JSONB null decodes to JS null too.
          for (const marker of [false, undefined]) {
            expect(() => coalesceDecision({ id: 7, name: 'synthesize', status, submission_authority: raw, legacy_authority_is_null: marker }, authority))
              .toThrow('coalescing across');
          }
        }
      }
    }
  });
});

describe('legacy coalesce matrix on every queue path (PGLite)', () => {
  test('variant x path x status x caller', () => isolated(async () => {
    const cells = await runCoalesceMatrix(engine, remote);
    const expectedCells = 4 * Object.values(PATHS).reduce((n, p) => n + p.statuses.length * p.callers.length, 0);
    expect(cells).toBe(expectedCells);
  }), 180_000);

  test('the existing cross-authority denial still holds for remote callers over an application row', () => isolated(async () => {
    const queue = new MinionQueue(engine);
    const accepted = await remote();
    await queue.add('lint', accepted.data, { idempotency_key: 'same-key' });
    const trusted = { submissionAuthority: accepted.authority };
    await expect(queue.add('lint', accepted.data, { idempotency_key: 'same-key' }, trusted)).rejects.toThrow('coalescing across');
    await expect(new MinionQueue(racingEngine(engine)).add('lint', accepted.data, { idempotency_key: 'same-key' }, trusted)).rejects.toThrow('coalescing across');
  }));

  test('resubmission over a dead legacy key inserts a fresh job that a worker runs', () => isolated(async () => {
    const queue = new MinionQueue(engine);
    const old = await queue.add('legacy-fixture', { n: 1 }, { idempotency_key: 'dream:synth-v2:example' });
    await engine.executeRaw("UPDATE minion_jobs SET status = 'dead', submission_authority = NULL WHERE id = $1", [old.id]);
    const fresh = await queue.add('legacy-fixture', { n: 1 }, { idempotency_key: 'dream:synth-v2:example' });
    expect(fresh.id).not.toBe(old.id);
    await assertNoUnreviewedJobs(engine);
    let ran = 0;
    const worker = new MinionWorker(engine, { pollInterval: 10, healthCheckInterval: 0, stalledInterval: 60000 });
    worker.register('legacy-fixture', async () => { ran++; return { ok: true }; });
    const running = worker.start();
    for (let i = 0; i < 200 && (await queue.getJob(fresh.id))?.status !== 'completed'; i++) await new Promise(r => setTimeout(r, 25));
    worker.stop();
    await running;
    expect(ran).toBe(1);
    expect((await queue.getJob(fresh.id))?.status).toBe('completed');
  }), 30_000);

  test('a release that lost its CAS (the row was reviewed in between) coalesces through the race path', () => isolated(async () => {
    const old = await new MinionQueue(engine).add('legacy-fixture', { n: 2 }, { idempotency_key: 'cas-key' });
    await engine.executeRaw("UPDATE minion_jobs SET status = 'cancelled', submission_authority = NULL WHERE id = $1", [old.id]);
    // Between the fast-path read and the release, an operator authorizes the row.
    const reviewing = new Proxy(engine, {
      get(target, prop) {
        if (prop !== 'transaction') { const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v; }
        return <T>(fn: (tx: PGLiteEngine) => Promise<T>) => target.transaction(tx => fn(new Proxy(tx, {
          get(t, p) {
            if (p !== 'executeRaw') { const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v; }
            return async (sql: string, params?: unknown[]) => {
              if (sql.includes('SET idempotency_key = NULL')) {
                await t.executeRaw("UPDATE minion_jobs SET status = 'completed', submission_authority = $2::jsonb WHERE id = $1", [old.id, APPLICATION_AUTHORITY]);
              }
              return t.executeRaw(sql, params);
            };
          },
        }) as PGLiteEngine));
      },
    });
    const result = await new MinionQueue(reviewing as PGLiteEngine).add('legacy-fixture', { n: 2 }, { idempotency_key: 'cas-key' });
    expect(result.id).toBe(old.id);
    expect(result.coalesced).toBe(true);
    const [{ count }] = await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM minion_jobs');
    expect(count).toBe('1');
  }));
});
