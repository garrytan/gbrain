/**
 * #5157 / #5114 coalesce matrix, shared by the PGLite unit test and the
 * Postgres E2E test so both engines run the same table.
 *
 * Every case submits once through `MinionQueue.add` to create a row with the
 * right name, payload, hash and key, rewrites that row's status and
 * authority to the case's variant, then submits the same request again on
 * one of the five coalesce paths and checks the outcome.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, type SubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import type { MinionJobInput } from '../../src/core/minions/types.ts';
import { OperationError } from '../../src/core/ops/contract.ts';

export type AuthorityVariant = 'sql_null' | 'jsonb_null' | 'malformed' | 'future';
export type CoalescePath = 'idempotency' | 'param' | 'pending' | 'waiting' | 'race';
export type Outcome = 'coalesce' | 'release' | 'deny-legacy' | 'deny-cross';
export type Caller = 'application' | 'remote';
export interface RemoteSubmission { data: Record<string, unknown>; authority: SubmissionAuthority }

export const AUTHORITY_VARIANTS: Record<AuthorityVariant, string | null> = {
  sql_null: null,
  jsonb_null: 'null',
  malformed: '{"version":1}',
  future: '{"version":2,"kind":"application"}',
};
export const ALL_STATUSES = ['dead', 'cancelled', 'completed', 'failed', 'waiting', 'active', 'delayed', 'waiting-children', 'paused'] as const;
type Status = typeof ALL_STATUSES[number];

/** The statuses each path can select as a coalesce target, and the callers it serves. */
export const PATHS: Record<CoalescePath, { statuses: readonly Status[]; callers: readonly Caller[] }> = {
  idempotency: { statuses: ALL_STATUSES, callers: ['application', 'remote'] },
  race: { statuses: ALL_STATUSES, callers: ['application', 'remote'] },
  // Param coalescing is application-only by design (queue.ts coalesceActive).
  param: { statuses: ['waiting'], callers: ['application'] },
  pending: { statuses: ['waiting', 'active'], callers: ['application', 'remote'] },
  waiting: { statuses: ['waiting'], callers: ['application', 'remote'] },
};

export const LEGACY_DOCS = 'docs/guides/repair.md#legacy-job-authority';

export function expectedOutcome(variant: AuthorityVariant, status: Status, caller: Caller): Outcome {
  if (variant !== 'sql_null') return 'deny-cross';
  if (status === 'dead' || status === 'cancelled') return 'release';
  if ((status === 'completed' || status === 'failed') && caller === 'application') return 'coalesce';
  return 'deny-legacy';
}

/**
 * Hides the first idempotency-key read inside each transaction, so the
 * fast path misses and the INSERT's ON CONFLICT lands on the race path
 * exactly as a concurrent winner would.
 */
export function racingEngine(engine: BrainEngine): BrainEngine {
  const bind = <T extends object>(target: T, prop: string | symbol) => {
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  return new Proxy(engine, {
    get(target, prop) {
      if (prop !== 'transaction') return bind(target, prop);
      return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => {
        let hidden = false;
        return fn(new Proxy(tx, {
          get(t, p) {
            if (p !== 'executeRaw') return bind(t, p);
            return (sql: string, params?: unknown[]) => {
              if (!hidden && /FROM minion_jobs WHERE idempotency_key = \$1$/.test(sql.trim())) { hidden = true; return Promise.resolve([]); }
              return t.executeRaw(sql, params);
            };
          },
        }));
      });
    },
  });
}

function optsFor(path: CoalescePath): Partial<MinionJobInput> {
  switch (path) {
    case 'idempotency': case 'race': return { idempotency_key: 'matrix-key' };
    case 'param': return { coalesce_params: true };
    case 'pending': return { maxPending: 1 };
    case 'waiting': return { maxWaiting: 1 };
  }
}

async function setVariant(engine: BrainEngine, id: number, status: Status, variant: AuthorityVariant): Promise<void> {
  // The queue protocol trigger only lets a claim make a row active, and only
  // with authority present, so claim first and rewrite the authority after.
  if (status === 'active') {
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'active', lock_token = 'matrix', lock_until = now() + interval '1 hour',
      claim_generation = claim_generation + 1 WHERE id = $1`, [id]);
  } else {
    await engine.executeRaw('UPDATE minion_jobs SET status = $2 WHERE id = $1', [id, status]);
  }
  await engine.executeRaw('UPDATE minion_jobs SET submission_authority = $2::text::jsonb WHERE id = $1', [id, AUTHORITY_VARIANTS[variant]]);
}

async function rejection(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { return error as OperationError; }
  throw new Error('expected a refusal');
}

/** Runs one case and asserts its outcome; returns the outcome it observed. */
export async function runCoalesceCase(
  engine: BrainEngine,
  remote: () => Promise<RemoteSubmission>,
  c: { variant: AuthorityVariant; status: Status; caller: Caller; path: CoalescePath },
): Promise<Outcome> {
  await engine.executeRaw('DELETE FROM minion_jobs');
  const submission = c.caller === 'remote' ? await remote() : { data: { matrix: true, sourceId: 'default' }, authority: APPLICATION_AUTHORITY };
  const name = c.caller === 'remote' ? 'lint' : 'matrix-job';
  const opts = optsFor(c.path);
  const trusted = { submissionAuthority: submission.authority };
  const first = await new MinionQueue(engine).add(name, submission.data, opts, trusted);
  await setVariant(engine, first.id, c.status, c.variant);
  const [{ count: before }] = await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM minion_jobs');
  const queue = new MinionQueue(c.path === 'race' ? racingEngine(engine) : engine);
  const expected = expectedOutcome(c.variant, c.status, c.caller);
  const label = JSON.stringify(c);

  const [raw] = await engine.executeRaw<Record<string, unknown>>(
    'SELECT *, submission_authority IS NULL AS legacy_authority_is_null FROM minion_jobs WHERE id = $1', [first.id]);
  let decided: Outcome;
  try { decided = coalesceDecision(raw!, submission.authority); }
  catch (error) { decided = (error as OperationError).docs === LEGACY_DOCS ? 'deny-legacy' : 'deny-cross'; }
  expect(decided, `${label} decision`).toBe(expected);

  if (expected === 'deny-legacy' || expected === 'deny-cross') {
    const error = await rejection(() => queue.add(name, submission.data, opts, trusted));
    expect(error, label).toBeInstanceOf(OperationError);
    expect(error.code, label).toBe('permission_denied');
    if (expected === 'deny-legacy') {
      expect(error.docs, label).toBe(LEGACY_DOCS);
      expect(error.suggestion, label).toContain(c.status === 'active' ? `gbrain jobs cancel ${first.id}` : 'gbrain jobs authorize-legacy --select');
      expect(error.message, label).toContain(`job ${first.id} (${name}, ${c.status})`);
    } else {
      expect(error.message, label).toContain('coalescing across');
      expect(error.docs, label).toBeUndefined();
    }
  } else {
    const result = await queue.add(name, submission.data, opts, trusted);
    const [old] = await engine.executeRaw<{ idempotency_key: string | null; data: Record<string, unknown> | string }>(
      'SELECT idempotency_key, data FROM minion_jobs WHERE id = $1', [first.id]);
    if (expected === 'coalesce') {
      expect(result.id, label).toBe(first.id);
      expect(result.coalesced, label).toBe(true);
    } else {
      expect(result.id, label).not.toBe(first.id);
      expect(result.coalesced, label).toBeFalsy();
      expect(result.submission_authority, label).toEqual(submission.authority);
      const data = typeof old!.data === 'string' ? JSON.parse(old!.data) : old!.data;
      expect(old!.idempotency_key, label).toBeNull();
      expect(data.__released_idempotency_key, label).toBe('matrix-key');
      const [{ count: after }] = await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM minion_jobs');
      expect(Number(after), label).toBe(Number(before) + 1);
      return expected;
    }
  }
  const [{ count: after }] = await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM minion_jobs');
  expect(Number(after), `${label} inserted nothing`).toBe(Number(before));
  return expected;
}

/** Every (variant x path x status x caller) cell; returns how many cells ran. */
export async function runCoalesceMatrix(engine: BrainEngine, remote: () => Promise<RemoteSubmission>): Promise<number> {
  let cells = 0;
  for (const variant of Object.keys(AUTHORITY_VARIANTS) as AuthorityVariant[]) {
    for (const [path, spec] of Object.entries(PATHS) as Array<[CoalescePath, typeof PATHS[CoalescePath]]>) {
      for (const status of spec.statuses) {
        for (const caller of spec.callers) {
          await runCoalesceCase(engine, remote, { variant, status, caller, path });
          cells++;
        }
      }
    }
  }
  return cells;
}
