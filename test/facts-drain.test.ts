/**
 * Automatic facts drain (Foundations 2, Lane D; src/core/facts/drain.ts).
 * Protects: queued facts-absorb jobs on PGLite get extracted with no
 * `gbrain jobs work`, within the per-run, daily and job-count caps, and every
 * stop other than "queue empty" leaves the jobs queued with no attempt counted
 * (budget, oversized job, no key, shutdown, unpriced model under a user cap).
 * Stubs only the gateway chat transport (`__setChatTransportForTests`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import {
  FACTS_DRAIN_STATE_KEY, __resetFactsDrainNoticesForTests, readFactsDrainState, readFactsDrainStatus, runFactsDrain, takeFactsDrainNotice,
  validateFactsDrainConfigValue,
} from '../src/core/facts/drain.ts';
import { runPhaseFactsDrain } from '../src/core/cycle/facts-drain.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { DEGRADED_STATE } from '../src/core/degraded-marker.ts';

let engine: PGLiteEngine;
const KEYS = { ANTHROPIC_API_KEY: 'sk-test-drain', OPENAI_API_KEY: 'sk-test-drain' };
const NO_KEYS = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GBRAIN_MODEL: undefined };
const MODEL = 'anthropic:claude-sonnet-4-6';
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_VERSION));
  __resetFactsDrainNoticesForTests();
  __setChatTransportForTests(null);
  configureGateway({ embedding_disabled: true, env: KEYS } as never);
  await engine.setConfig('facts.extraction_model', MODEL);
  await engine.setConfig('embedding_disabled', 'true');
});

function reply(text: string, usage = { input_tokens: 10, output_tokens: 10 }): ChatResult {
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: MODEL, providerId: 'anthropic',
    usage: { ...usage, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
}
function factsReply(slug: string) {
  return reply(JSON.stringify({ facts: [{ fact: `${slug} shipped the beta in 2026`, kind: 'fact', entity: 'companies/acme-example', confidence: 0.9, notability: 'high' }] }));
}

let seeded = 0;
async function seed(n: number): Promise<string[]> {
  const slugs: string[] = [];
  const queue = new MinionQueue(engine);
  for (let k = 0; k < n; k++) {
    const i = seeded++;
    const slug = `notes/drain-${i}`;
    await engine.putPage(slug, { type: 'note', title: `Note ${i}`, compiled_truth: `Acme Example shipped the beta in 2026. Note ${i}. ${'A substantive project record. '.repeat(6)}`, timeline: '', frontmatter: {} } as never);
    await queue.add('facts-absorb', { slug, sourceId: 'default', source: 'mcp:put_page', notabilityFilter: 'all', visibility: 'private' },
      { queue: 'default', idempotency_key: `facts-absorb:test:${slug}`, max_attempts: 5, backoff_delay: 60_000 });
    slugs.push(slug);
  }
  return slugs;
}
async function jobRows() {
  return engine.executeRaw<{ status: string; attempts_made: number; attempts_started: number }>(
    "SELECT status, attempts_made, attempts_started FROM minion_jobs WHERE name='facts-absorb' ORDER BY id");
}
async function factCount() {
  const [row] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE fact LIKE '%shipped the beta%'");
  return Number(row?.n ?? 0);
}
const run = (logs: string[], extra: Partial<Parameters<typeof runFactsDrain>[1]> = {}) =>
  runFactsDrain(engine, { owner: 'serve', log: line => logs.push(line), yieldMs: 0, ...extra });
const isolated = <T>(env: Record<string, string | undefined>, fn: () => Promise<T>) => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-facts-drain-'));
  return withEnv({ GBRAIN_HOME: home, ...env }, fn).finally(() => rmSync(home, { recursive: true, force: true }));
};

describe('runFactsDrain', () => {
  test('an unavailable backend never certifies an empty queue', async () => {
    const degraded = { kind: 'pglite', [DEGRADED_STATE]: () => true } as unknown as BrainEngine;
    const phase = await runPhaseFactsDrain(degraded, { dryRun: false });
    expect(phase.status).toBe('skipped');
    expect(phase.summary).not.toContain('no queued');
    const failed = { kind: 'pglite', getConfig: async () => { throw new Error('synthetic storage unavailable'); } } as unknown as BrainEngine;
    const errorPhase = await runPhaseFactsDrain(failed, { dryRun: false });
    expect(errorPhase.status).toBe('warn');
    expect(errorPhase.summary).toContain('? facts-absorb job(s) remain');
  });

  test('future-delayed facts work is reported as incomplete, not clean', async () => isolated(KEYS, async () => {
    await seed(1);
    await engine.executeRaw("UPDATE minion_jobs SET status='delayed', delay_until=now() + interval '1 hour' WHERE name='facts-absorb'");
    const phase = await runPhaseFactsDrain(engine, { dryRun: false });
    expect(phase.status).toBe('warn');
    expect(phase.details).toMatchObject({ outcome: 'idle', backlog_after: 0, delayed_after: 1, remaining_after: 1 });
    expect((await jobRows())[0].status).toBe('delayed');
  }));

  test('a live active lease remains reported as incomplete and is not stolen', async () => isolated(KEYS, async () => {
    await seed(1);
    const queue = new MinionQueue(engine);
    const lease = await queue.claim('other-owner', 3_600_000, 'default', ['facts-absorb']);
    expect(lease).not.toBeNull();
    const phase = await runPhaseFactsDrain(engine, { dryRun: false });
    expect(phase.status).toBe('warn');
    expect(phase.details).toMatchObject({ outcome: 'idle', backlog_after: 0, active_after: 1, remaining_after: 1 });
    expect(await engine.executeRaw<{ status: string; lock_token: string }>("SELECT status,lock_token FROM minion_jobs WHERE name='facts-absorb'")).toEqual([{ status: 'active', lock_token: 'other-owner' }]);
  }));

  test('waiting work can drain while delayed work remains and phase warns', async () => isolated(KEYS, async () => {
    await seed(2);
    await engine.executeRaw("UPDATE minion_jobs SET status='delayed', delay_until=now() + interval '1 hour' WHERE id=(SELECT max(id) FROM minion_jobs WHERE name='facts-absorb')");
    __setChatTransportForTests(async () => factsReply('x'));
    const phase = await runPhaseFactsDrain(engine, { dryRun: false });
    expect(phase.status).toBe('warn');
    expect(phase.details).toMatchObject({ outcome: 'drained', completed: 1, backlog_after: 0, delayed_after: 1, remaining_after: 1 });
  }));

  test('paused and waiting-children facts work is not reported as complete', async () => isolated(KEYS, async () => {
    await seed(2);
    const parents = await engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE name='facts-absorb' ORDER BY id");
    await engine.executeRaw("UPDATE minion_jobs SET status='paused' WHERE id=$1", [parents[0].id]);
    // An actual live child is required; an orphan waiting-children row is correctly promoted by the queue.
    await new MinionQueue(engine).add('facts-absorb', { slug: 'notes/blocked-child', sourceId: 'default' },
      { parent_job_id: parents[1].id, delay: 3_600_000 });
    let calls = 0;
    __setChatTransportForTests(async () => { calls++; throw new Error('no model call is expected for non-runnable jobs'); });
    const phase = await runPhaseFactsDrain(engine, { dryRun: false });
    expect(phase.status).toBe('warn');
    expect(phase.details).toMatchObject({ outcome: 'idle', paused_after: 1, waiting_children_after: 1, delayed_after: 1, remaining_after: 3 });
    expect(calls).toBe(0);
    expect((await jobRows()).map(j => j.status).sort()).toEqual(['delayed', 'paused', 'waiting-children']);
  }));

  test('failed final queue read reports unknown instead of stale pre-processing counts', async () => isolated(KEYS, async () => {
    await seed(1);
    __setChatTransportForTests(async () => factsReply('x'));
    let reads = 0;
    const failing = new Proxy(engine, {
      get(target, property) {
        if (property === 'executeRaw') return async (sql: string, args?: unknown[]) => {
          if (sql.startsWith('SELECT status, count(*)::int AS n FROM minion_jobs') && ++reads === 2) {
            throw new Error('synthetic final queue read failure');
          }
          return target.executeRaw(sql, args);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const phase = await runPhaseFactsDrain(failing, { dryRun: false });
    expect(phase.status).toBe('warn');
    expect(phase.details.completed).toBe(1);
    expect(phase.details.remaining_after).toBeUndefined();
    expect(phase.details.backlog_after).toBeNull();
    expect(phase.summary).toContain('? facts-absorb job(s) remain');
    expect((await jobRows()).map(job => job.status)).toEqual(['completed']);
  }));

  test('a genuinely empty facts queue remains clean', async () => isolated(KEYS, async () => {
    const phase = await runPhaseFactsDrain(engine, { dryRun: false });
    expect(phase.status).toBe('ok');
    expect(phase.details).toMatchObject({ outcome: 'idle', remaining_after: 0, waiting_after: 0, delayed_after: 0, active_after: 0 });
  }));

  test('extracts every queued page with zero commands; before the drain they sit waiting', () => isolated(KEYS, async () => {
    await seed(3);
    expect((await jobRows()).map(j => j.status)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(await factCount()).toBe(0);
    __setChatTransportForTests(async (opts: ChatOpts) => factsReply(String(opts.messages?.[0]?.content ?? '').match(/Note \d/)?.[0] ?? 'x'));
    const logs: string[] = [];
    const r = await run(logs);
    expect(r).toMatchObject({ outcome: 'drained', completed: 3, failed: 0, deferred: 0, backlog_before: 3, backlog_after: 0 });
    expect((await jobRows()).map(j => j.status)).toEqual(['completed', 'completed', 'completed']);
    expect(await factCount()).toBe(3);
    const status = await readFactsDrainStatus(engine);
    expect(status.health).toBe('idle');
    expect(status.last_run).toMatchObject({ owner: 'serve', outcome: 'drained', completed: 3 });
  }));

  test('first run reports backlog, estimated spend, caps and the opt-out (golden)', () => isolated(KEYS, async () => {
    await seed(2);
    __setChatTransportForTests(async () => factsReply('x'));
    const logs: string[] = [];
    await run(logs);
    expect(logs[0]).toMatch(/^\[gbrain notice facts_drain\] Automatic fact extraction is on: 2 queued page\(s\), about \$0\.0\d\d with anthropic:claude-sonnet-4-6, at most \$1\.00 per run and \$5\.00 per day\. To opt out: gbrain config set facts\.extraction_enabled false$/);
    expect(takeFactsDrainNotice()).toMatchObject({ code: 'facts_drain_first_run', kind: 'info', fix: { argv: ['gbrain', 'config', 'set', 'facts.extraction_enabled', 'false'] } });
    await seed(1);
    const again: string[] = [];
    await run(again);
    expect(again).toEqual([]);
  }));

  test('partial-batch budget exhaustion leaves the rest queued with no attempt counted', () => isolated(KEYS, async () => {
    await seed(4);
    await engine.setConfig('facts.drain_budget_usd', '0.15');
    __setChatTransportForTests(async () => ({ ...factsReply('x'), usage: { input_tokens: 15_000, output_tokens: 1_000, cache_read_tokens: 0, cache_creation_tokens: 0 } }));
    const logs: string[] = [];
    const r = await run(logs);
    expect(r.outcome).toBe('budget_exhausted');
    expect(r.completed).toBeGreaterThanOrEqual(1);
    expect(r.completed).toBeLessThan(4);
    const rows = await jobRows();
    const left = rows.filter(j => j.status !== 'completed');
    expect(left.length).toBe(4 - r.completed);
    for (const j of left) expect(j).toMatchObject({ status: 'waiting', attempts_made: 0 });
    expect(r.error).toMatchObject({ code: 'facts_drain_deferred', reason: 'budget_exhausted', fix: { argv: ['gbrain', 'config', 'set', 'facts.drain_budget_usd', '0.30'], consent: ['paid'] } });
    expect((await readFactsDrainStatus(engine)).health).toBe('deferred');
  }));

  test('an oversized single job is deferred unclaimed, never failed', () => isolated(KEYS, async () => {
    await seed(1);
    await engine.setConfig('facts.drain_budget_usd', '0.02');
    let calls = 0;
    __setChatTransportForTests(async () => { calls++; return factsReply('x'); });
    const r = await run([]);
    expect(r.outcome).toBe('job_over_budget');
    expect(calls).toBe(0);
    expect(await jobRows()).toEqual([{ status: 'waiting', attempts_made: 0, attempts_started: 0 }]);
    expect(r.error?.fix?.argv?.slice(0, 4)).toEqual(['gbrain', 'config', 'set', 'facts.drain_budget_usd']);
  }));

  test('the rolling daily cap stops a run before any claim', () => isolated(KEYS, async () => {
    await seed(2);
    await engine.setConfig(FACTS_DRAIN_STATE_KEY, JSON.stringify({ version: 1, first_run_reported_at: new Date().toISOString(),
      runs: [{ owner: 'cycle', started_at: new Date(Date.now() - 3600_000).toISOString(), finished_at: new Date().toISOString(), outcome: 'max_jobs',
        completed: 50, failed: 0, deferred: 0, facts_inserted: 50, spent_usd: 5, unpriced_calls: 0, backlog_before: 60, backlog_after: 10, model: MODEL }] }));
    const r = await run([]);
    expect(r.outcome).toBe('daily_budget_exhausted');
    expect(r.remaining_after).toBe(2);
    expect((await jobRows()).map(j => j.attempts_started)).toEqual([0, 0]);
    expect(r.error?.fix?.argv).toEqual(['gbrain', 'config', 'set', 'facts.drain_daily_budget_usd', '10.00']);
  }));

  test('keyless: jobs wait, one notice per process, and they run once a key exists', () => isolated(NO_KEYS, async () => {
    configureGateway({ embedding_disabled: true, env: {} } as never);
    await seed(2);
    const logs: string[] = [];
    const first = await run(logs);
    expect(first.outcome).toBe('no_key');
    expect(first.remaining_after).toBe(2);
    expect(first.error).toMatchObject({ code: 'facts_drain_deferred', reason: 'no_key', fix: { argv: ['gbrain', 'providers', 'list'], actor: 'user' } });
    expect(logs.filter(l => l.includes('facts_drain_deferred'))).toHaveLength(1);
    expect(takeFactsDrainNotice()).toMatchObject({ code: 'facts_drain_deferred', kind: 'degraded' });
    const second: string[] = [];
    expect((await run(second)).outcome).toBe('no_key');
    expect(second).toEqual([]);
    expect(takeFactsDrainNotice()).toBeNull();
    expect(await jobRows()).toEqual([{ status: 'waiting', attempts_made: 0, attempts_started: 0 }, { status: 'waiting', attempts_made: 0, attempts_started: 0 }]);
    expect((await readFactsDrainStatus(engine)).health).toBe('deferred');

    await withEnv(KEYS, async () => {
      configureGateway({ embedding_disabled: true, env: KEYS } as never);
      __setChatTransportForTests(async () => factsReply('x'));
      const r = await run([]);
      expect(r).toMatchObject({ outcome: 'drained', completed: 2 });
    });
  }));

  test('a keyless queue with no backlog stays silent', () => isolated(NO_KEYS, async () => {
    configureGateway({ embedding_disabled: true, env: {} } as never);
    const logs: string[] = [];
    expect((await run(logs)).outcome).toBe('idle');
    expect(logs).toEqual([]);
    expect(takeFactsDrainNotice()).toBeNull();
  }));

  test('shutdown mid-job returns the job to the queue with no attempt counted and no facts', () => isolated(KEYS, async () => {
    await seed(1);
    const abort = new AbortController();
    __setChatTransportForTests(async (opts: ChatOpts) => {
      abort.abort(new Error('shutdown'));
      await new Promise((_, reject) => {
        if (opts.abortSignal?.aborted) reject(opts.abortSignal.reason);
        opts.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal!.reason), { once: true });
      });
      return factsReply('x');
    });
    const r = await run([], { signal: abort.signal });
    expect(r.outcome).toBe('aborted');
    expect(r.deferred).toBe(1);
    const [job] = await jobRows();
    expect(job.attempts_made).toBe(0);
    expect(['waiting', 'delayed']).toContain(job.status);
    expect(await factCount()).toBe(0);
  }));

  test('max_jobs bounds one run', () => isolated(KEYS, async () => {
    await seed(3);
    await engine.setConfig('facts.drain_max_jobs', '2');
    __setChatTransportForTests(async () => factsReply('x'));
    const r = await run([]);
    expect(r).toMatchObject({ outcome: 'max_jobs', completed: 2, backlog_after: 1 });
  }));

  test('an unpriced model warns and runs under the default caps, and refuses with the register-the-rate fix under a user cap', () => isolated(KEYS, async () => {
    await engine.setConfig('facts.extraction_model', 'anthropic:claude-unpriced-example');
    await seed(1);
    __setChatTransportForTests(async () => factsReply('x'));
    expect((await run([])).outcome).toBe('drained');
    await seed(1);
    await engine.setConfig('facts.drain_budget_usd', '1');
    const r = await run([]);
    expect(r.outcome).toBe('no_pricing');
    expect(r.error?.fix?.argv?.slice(0, 3)).toEqual(['gbrain', 'pricing', 'set']);
    expect((await jobRows()).at(-1)).toMatchObject({ status: 'waiting', attempts_made: 0 });
  }));

  test('facts.extraction_enabled false is the opt-out', () => isolated(KEYS, async () => {
    await seed(1);
    await engine.setConfig('facts.extraction_enabled', 'false');
    expect((await run([])).outcome).toBe('disabled');
    expect((await readFactsDrainStatus(engine)).health).toBe('disabled');
  }));

  test('state keeps the newest runs and never writes stdout', () => isolated(KEYS, async () => {
    const write = process.stdout.write;
    const out: string[] = [];
    process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof write;
    try {
      __setChatTransportForTests(async () => factsReply('x'));
      for (let i = 0; i < 3; i++) { await seed(1); await runFactsDrain(engine, { owner: 'cycle', yieldMs: 0 }); }
    } finally { process.stdout.write = write; }
    expect(out.filter(s => s.includes('facts_drain'))).toEqual([]);
    expect((await readFactsDrainState(engine)).runs.length).toBeGreaterThanOrEqual(1);
  }));
});

test('config validation for facts.drain_* keys', () => {
  expect(validateFactsDrainConfigValue('facts.drain_budget_usd', '2.5')).toBeNull();
  expect(validateFactsDrainConfigValue('facts.drain_budget_usd', '-1')).toContain('must be a number from 0.01 to 100');
  expect(validateFactsDrainConfigValue('facts.drain_max_jobs', '2.5')).toContain('whole number');
  expect(validateFactsDrainConfigValue('facts.other', 'x')).toBeNull();
});
