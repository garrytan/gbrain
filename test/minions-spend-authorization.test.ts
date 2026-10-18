/**
 * Submit-time spend authorization on queued paid jobs (PGLite).
 *
 * Protects: the strict record parser, the trusted-only storage path, the
 * claim-time `legacy_default` stamp, the coalesce compare-and-set, the
 * per-acquisition fence trigger, and the worker guard's group metering.
 * Regressions that fail it: a record read from job data, a claim that stamps
 * the wrong rows, an old-protocol claim that runs a spend-authorized row, or
 * a guard that does not reserve against the group.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { invokeAI } from '../src/core/ai/invocation-guard.ts';
import {
  jobSpendAuthorization, parseSpendAuthorization, runWithJobSpend, spendBasis, spendSubmitSummary,
  type SpendAuthorization,
} from '../src/core/minions/spend-authorization.ts';
import type { MinionJob, MinionJobContext } from '../src/core/minions/types.ts';
import type { Authorization } from '../src/core/consent.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM mcp_spend_reservations');
  await engine.executeRaw('DELETE FROM mcp_spend_log');
  await engine.executeRaw('DELETE FROM minion_jobs');
});

const auth = (cap: number, source: Authorization['cap_source'] = 'derived'): Authorization =>
  ({ consented_effects: ['paid'], cap_usd: cap, cap_source: source, via: 'yes' });
const record = (cap = 10, source: Authorization['cap_source'] = 'derived', of = 2) =>
  jobSpendAuthorization(auth(cap, source), { command: 'book-mirror', est_usd: cap / 1.5, of, argv: ['gbrain', 'book-mirror', '--slug', 'a-book'] });
const ctxFor = (job: MinionJob) => ({ id: job.id, name: job.name, data: job.data, attempts_made: 0 }) as unknown as MinionJobContext;

/** A priced provider attempt: maximum `maxCents`, actual `actualCents` (claude-sonnet-5 input at $2/Mtok, reserved at 2x). */
const attempt = (maxCents: number, actualCents: number, model = 'anthropic:claude-sonnet-5') => invokeAI(
  { operation: 'test', kind: 'chat', model, maxInputTokens: maxCents * 2500, maxOutputTokens: 0 },
  async () => 'ok', () => ({ inputTokens: actualCents * 5000, outputTokens: 0 }));

async function claimed(name: string, opts: Record<string, unknown> = {}, spend?: SpendAuthorization): Promise<MinionJob> {
  await queue.add(name, { prompt: 'x' }, opts, { allowProtectedSubmit: true, ...(spend ? { spendAuthorization: spend } : {}) });
  const job = await queue.claim('tok', 60_000, 'default', [name]);
  if (!job) throw new Error('nothing claimed');
  return job;
}

describe('spend authorization record', () => {
  test('the parser accepts each kind and rejects malformed or unknown shapes', () => {
    const capped = record();
    expect(parseSpendAuthorization(capped)).toEqual(capped);
    const uncapped = jobSpendAuthorization({ uncapped: true, via: 'max_usd' }, { command: 'enrich', of: 1 });
    expect(parseSpendAuthorization(JSON.stringify(uncapped))).toMatchObject({ cap_usd: null, uncapped: true, cap_source: 'user' });
    expect(parseSpendAuthorization({ version: 1, kind: 'legacy_default', group_id: capped.group_id, cap_usd: 5, cap_source: 'default', command: 'enrich', authorized_at: '2026-10-05T00:00:00.000Z' }))
      .toMatchObject({ kind: 'legacy_default' });
    expect(parseSpendAuthorization(null)).toBeNull();
    for (const bad of [
      { ...capped, kind: 'granted' },
      { ...capped, extra: true },
      { ...capped, cap_usd: null },
      { ...capped, group_id: 'not-a-uuid' },
      { ...capped, cap_usd: -1 },
      [],
    ]) expect(() => parseSpendAuthorization(bad)).toThrow(TypeError);
  });

  test('a record in job data is never read as authorization', async () => {
    const job = await queue.add('enrich', { sourceId: 'default', spend_authorization: record() });
    expect(job.spend_authorization).toBeNull();
    expect(spendBasis(job).basis).toBe('unrecorded');
  });

  test('a malformed column marks the job invalid and the guard refuses to run it', async () => {
    const job = await claimed('subagent', {}, record());
    await engine.executeRaw(`UPDATE minion_jobs SET spend_authorization = '{"version":2}'::jsonb WHERE id = $1`, [job.id]);
    const reread = (await queue.getJob(job.id))!;
    expect(reread.spend_authorization_invalid).toBe(true);
    expect(spendBasis(reread).basis).toBe('invalid');
    await expect(runWithJobSpend(engine, reread, ctxFor(reread), async () => 'ran')).rejects.toThrow('spend_authorization_invalid');
  });
});

describe('claim-time legacy_default', () => {
  test('stamps only NULL rows of the consent-gated producers, with the job-type cap', async () => {
    const rows = [
      ['subagent', 'book-mirror:a-book:ch-1', {}],
      ['enrich', 'enrich:default:abc', { maxCostUsd: 2 }],
      ['enrich', 'cli:enrich:abcd1234', {}],
      ['enrich', 'other:enrich', {}],
      ['subagent', 'enrich:default:x', {}],
    ] as const;
    for (const [name, key, data] of rows) await queue.add(name, { ...data, sourceId: 'default' }, { idempotency_key: key }, { allowProtectedSubmit: true });
    const seen: Record<string, SpendAuthorization | null> = {};
    for (let i = 0; i < rows.length; i++) {
      const job = await queue.claim(`tok-${i}`, 60_000, 'default', ['subagent', 'enrich']);
      seen[job!.idempotency_key!] = job!.spend_authorization ?? null;
    }
    expect(seen['book-mirror:a-book:ch-1']).toMatchObject({ kind: 'legacy_default', cap_usd: 5, cap_source: 'default', command: 'book-mirror' });
    expect(seen['enrich:default:abc']).toMatchObject({ kind: 'legacy_default', cap_usd: 2, command: 'enrich' });
    expect(seen['cli:enrich:abcd1234']).toMatchObject({ kind: 'legacy_default', cap_usd: 5 });
    expect(seen['other:enrich']).toBeNull();
    expect(seen['enrich:default:x']).toBeNull();
    expect(new Set(Object.values(seen).filter(Boolean).map(r => r!.group_id)).size).toBe(3);
  });

  test('a legacy_default subagent runs under the $5 default cap and logs its basis', async () => {
    const job = await claimed('subagent', { idempotency_key: 'book-mirror:a-book:ch-2' });
    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation(((line: string) => { logs.push(String(line)); }) as never);
    try {
      expect(await runWithJobSpend(engine, job, ctxFor(job), async () => { await attempt(300, 100); return 'done'; })).toBe('done');
    } finally { log.mockRestore(); }
    const basis = JSON.parse(logs.find(l => l.includes('job_spend_basis'))!.split('job_spend_basis ')[1]!);
    expect(basis).toMatchObject({ job_id: job.id, basis: 'legacy_default', cap_usd: 5, cap_source: 'default' });
    const holds = await engine.executeRaw<{ budget_key: string; status: string }>('SELECT budget_key, status FROM mcp_spend_reservations');
    expect(holds).toEqual([{ budget_key: `group:${job.spend_authorization!.group_id}`, status: 'settled' }]);
  });
});

describe('coalesce compare-and-set', () => {
  test('NULL and legacy rows adopt the new authorization; an authorized row keeps its own', async () => {
    const key = 'book-mirror:b-book:ch-1';
    const legacy = await queue.add('subagent', { prompt: 'x' }, { idempotency_key: key }, { allowProtectedSubmit: true });
    expect(legacy.spend_authorization).toBeNull();
    const first = record();
    const adopted = await queue.add('subagent', { prompt: 'x' }, { idempotency_key: key }, { allowProtectedSubmit: true, spendAuthorization: first });
    expect(adopted.id).toBe(legacy.id);
    expect(adopted.spend_authorization?.group_id).toBe(first.group_id);
    const second = record(20);
    const kept = await queue.add('subagent', { prompt: 'x' }, { idempotency_key: key }, { allowProtectedSubmit: true, spendAuthorization: second });
    expect(kept.spend_authorization?.group_id).toBe(first.group_id);
    expect((await queue.getJob(legacy.id))!.spend_authorization?.group_id).toBe(first.group_id);
    const { summary, lines } = spendSubmitSummary(second, [kept], ['gbrain', 'book-mirror', '--slug', 'b-book']);
    expect(summary.kept).toEqual([{ group_id: first.group_id, cap_usd: 10, job_ids: [legacy.id] }]);
    expect(lines.join('\n')).toContain(`gbrain jobs cancel --group ${first.group_id}`);
  });

  test('a stamped legacy_default row is re-authorized by a rerun', async () => {
    const job = await claimed('subagent', { idempotency_key: 'book-mirror:c-book:ch-1' });
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'waiting', lock_token = NULL WHERE id = $1`, [job.id]);
    const next = record();
    const adopted = await queue.add('subagent', { prompt: 'x' }, { idempotency_key: 'book-mirror:c-book:ch-1' }, { allowProtectedSubmit: true, spendAuthorization: next });
    expect(adopted.spend_authorization).toMatchObject({ kind: 'authorized', group_id: next.group_id });
  });
});

describe('per-acquisition fence', () => {
  const oldClaim = (id: number, token: string) => engine.executeRaw(
    `UPDATE minion_jobs SET status = 'active', claim_generation = claim_generation + 1, lock_token = $2, attempts_started = attempts_started + 1 WHERE id = $1`,
    [id, token]);

  test('an old-protocol claim of a spend-authorized row is refused; a NULL row is still claimable', async () => {
    const fenced = await queue.add('subagent', { prompt: 'x' }, {}, { allowProtectedSubmit: true, spendAuthorization: record() });
    const open = await queue.add('subagent', { prompt: 'y' }, {}, { allowProtectedSubmit: true });
    await expect(oldClaim(fenced.id, 'old')).rejects.toThrow('Minion spend protocol 1 required');
    await expect(oldClaim(open.id, 'old')).resolves.toBeDefined();
  });

  test('new-worker claim, stall, then an old-worker reclaim is refused', async () => {
    const job = await claimed('subagent', {}, record());
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'waiting', lock_token = NULL WHERE id = $1`, [job.id]);
    await expect(oldClaim(job.id, 'old')).rejects.toThrow('Minion spend protocol 1 required');
    const again = await queue.claim('tok-new', 60_000, 'default', ['subagent']);
    expect(again?.id).toBe(job.id);
  });
});

describe('uncapped records', () => {
  test('reserve nothing', async () => {
    const spend = jobSpendAuthorization({ uncapped: true, via: 'max_usd' }, { command: 'enrich', of: 1 });
    const job = await claimed('subagent', {}, spend);
    let sawSpend = false;
    await runWithJobSpend(engine, job, ctxFor(job), async (ctx) => { sawSpend = ctx.spend?.record.uncapped === true; await attempt(300, 100); });
    expect(sawSpend).toBe(true);
    expect(await engine.executeRaw('SELECT 1 FROM mcp_spend_reservations')).toEqual([]);
  });
});

// Protect registered operator pricing in a user-capped worker, which canonical-only
// tests do not cover. Reverting override loading refuses before IO or fails settlement.
// Uses the existing production invocation guard and isolated PGLite, no new seam.
test('a user-capped job admits and settles a registered zero-price local model', async () => {
  const previous = await engine.getConfig('pricing.overrides');
  await engine.setConfig('pricing.overrides', JSON.stringify({ 'litellm:local-test': { input: 0, output: 0 }, 'llama-server-reranker:local-test': 0 }));
  try {
    const job = await claimed('subagent', {}, record(0.000001, 'user'));
    let calls = 0;
    await runWithJobSpend(engine, job, ctxFor(job), async () => invokeAI(
      { operation: 'test-local', kind: 'chat', model: 'litellm:local-test', maxInputTokens: 10000, maxOutputTokens: 1000 },
      async () => { calls++; return 'ok'; }, () => ({ inputTokens: 900, outputTokens: 40 }),
    ));
    await runWithJobSpend(engine, job, ctxFor(job), async () => invokeAI(
      { operation: 'test-rerank', kind: 'rerank', model: 'llama-server-reranker:local-test', maxInputTokens: 10000 },
      async () => { calls++; return 'ranked'; }, () => ({ inputTokens: 900, outputTokens: 0 }),
    ));
    expect(calls).toBe(2);
    const holds = await engine.executeRaw<{ status: string; actual_cents: string }>('SELECT status, actual_cents FROM mcp_spend_reservations');
    expect(holds).toHaveLength(2);
    expect(holds.every(h => h.status === 'settled' && Number(h.actual_cents) === 0)).toBe(true);
    for (const [model, refusal] of [['anthropic:claude-sonnet-5', 'cost_cap_exceeded'], ['example:unpriced-model', 'no_pricing']]) {
      await expect(runWithJobSpend(engine, job, ctxFor(job), async () => invokeAI(
        { operation: 'test-denied', kind: 'chat', model: model!, maxInputTokens: 10000, maxOutputTokens: 1000 },
        async () => { calls++; return 'unexpected'; }, () => ({ inputTokens: 1, outputTokens: 1 }),
      ))).rejects.toThrow(refusal);
    }
    expect(calls).toBe(2);
  } finally {
    await engine.setConfig('pricing.overrides', previous ?? '{}');
  }
});
