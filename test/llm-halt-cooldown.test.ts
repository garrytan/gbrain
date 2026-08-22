/**
 * #4310 — provider-identity-keyed global-LLM-halt cooldown at the queued-job
 * boundary (facts-absorb).
 *
 * Pre-fix: a globally-broken provider (revoked key, exhausted quota, hard
 * rate limit) made every queued facts-absorb job burn its own attempts on
 * doomed LLM calls and dead-letter independently. The wrapper arms one
 * provider-keyed cooldown on a halt-class error, DEFERS matching jobs without
 * burning attempts (RateLeaseUnavailableError + retryInMs → worker lease-full
 * requeue), and admits exactly one bounded probe on expiry.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  withGlobalLlmHaltCooldown,
  providerIdentityForJob,
  _resetLlmHaltCooldownsForTests,
  llmHaltCooldownRemainingMs,
  HALT_COOLDOWN_BASE_MS,
} from '../src/core/minions/llm-halt-cooldown.ts';
import { RateLeaseUnavailableError } from '../src/core/minions/rate-leases.ts';
import { RATE_LIMIT_HALT_STREAK } from '../src/core/ai/errors.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { withEnv } from './helpers/with-env.ts';

const job = (data: Record<string, unknown> = {}): MinionJobContext =>
  ({
    id: 1,
    name: 'facts-absorb',
    data,
    attempts_made: 0,
    signal: new AbortController().signal,
    deadlineAtMs: null,
    updateProgress: async () => {},
  }) as unknown as MinionJobContext;

const authError = () => Object.assign(new Error('provider rejected'), { status: 401 });
const billingError = () => new Error('insufficient_quota: monthly spend limit reached');
const rateLimitError = () => Object.assign(new Error('slow down'), { status: 429 });

beforeEach(() => _resetLlmHaltCooldownsForTests());
afterEach(() => {
  _resetLlmHaltCooldownsForTests();
});

function makeWrapped(opts: {
  key?: string;
  fail?: () => Error | null; // null = succeed
  now?: () => number;
  calls?: { count: number };
}) {
  const calls = opts.calls ?? { count: 0 };
  const handler = async () => {
    calls.count++;
    const err = opts.fail?.();
    if (err) throw err;
    return { ok: true };
  };
  return {
    calls,
    run: withGlobalLlmHaltCooldown(() => opts.key ?? 'prov-a', handler, { now: opts.now }),
  };
}

describe('auth class', () => {
  test('first failure propagates AND arms the cooldown; next job defers without a handler call', async () => {
    const { run, calls } = makeWrapped({ fail: authError });
    await expect(run(job())).rejects.toThrow('provider rejected'); // visible failure
    expect(llmHaltCooldownRemainingMs('prov-a')).toBeGreaterThan(0);

    await expect(run(job())).rejects.toBeInstanceOf(RateLeaseUnavailableError);
    expect(calls.count).toBe(1); // deferred job never reached the provider
  });

  test('deferral carries retryInMs ≈ remaining cooldown (worker requeues delayed, no attempt burned)', async () => {
    const { run } = makeWrapped({ fail: authError });
    await run(job()).catch(() => {});
    try {
      await run(job());
      throw new Error('expected deferral');
    } catch (e) {
      const lease = e as RateLeaseUnavailableError;
      expect(lease).toBeInstanceOf(RateLeaseUnavailableError);
      expect(lease.key).toBe('global-llm-halt:auth:prov-a');
      expect(lease.retryInMs).toBeGreaterThanOrEqual(1000);
      expect(lease.retryInMs!).toBeLessThanOrEqual(HALT_COOLDOWN_BASE_MS.auth + 6000);
    }
  });
});

describe('billing class', () => {
  test('first billing failure arms the cooldown', async () => {
    const { run, calls } = makeWrapped({ fail: billingError });
    await expect(run(job())).rejects.toThrow('insufficient_quota');
    await expect(run(job())).rejects.toBeInstanceOf(RateLeaseUnavailableError);
    expect(calls.count).toBe(1);
  });
});

describe('rate_limit class', () => {
  test(`arms only after ${RATE_LIMIT_HALT_STREAK} consecutive 429s (streak shared ACROSS jobs)`, async () => {
    const { run, calls } = makeWrapped({ fail: rateLimitError });
    for (let i = 0; i < RATE_LIMIT_HALT_STREAK - 1; i++) {
      await expect(run(job())).rejects.toThrow('slow down'); // still per-item
      expect(llmHaltCooldownRemainingMs('prov-a')).toBe(0);
    }
    await expect(run(job())).rejects.toThrow('slow down'); // streak crosses threshold
    expect(llmHaltCooldownRemainingMs('prov-a')).toBeGreaterThan(0);
    await expect(run(job())).rejects.toBeInstanceOf(RateLeaseUnavailableError);
    expect(calls.count).toBe(RATE_LIMIT_HALT_STREAK);
  });

  test('a success between 429s clears the shared streak', async () => {
    let n = 0;
    const { run } = makeWrapped({ fail: () => (++n === 2 ? null : rateLimitError()) });
    await run(job()).catch(() => {});
    await run(job()); // success → streak reset
    await run(job()).catch(() => {});
    await run(job()).catch(() => {});
    expect(llmHaltCooldownRemainingMs('prov-a')).toBe(0); // 2 consecutive < threshold
  });
});

describe('probe on expiry', () => {
  test('one probe admitted; success clears the cooldown', async () => {
    let t = 1_000_000;
    let failNow = true;
    const { run, calls } = makeWrapped({ fail: () => (failNow ? authError() : null), now: () => t });
    await run(job()).catch(() => {});
    expect(llmHaltCooldownRemainingMs('prov-a', t)).toBe(HALT_COOLDOWN_BASE_MS.auth);

    t += HALT_COOLDOWN_BASE_MS.auth + 1; // cooldown lapsed
    failNow = false; // provider recovered
    const result = await run(job()); // the bounded probe
    expect(result).toEqual({ ok: true });
    expect(llmHaltCooldownRemainingMs('prov-a', t)).toBe(0);
    await run(job()); // steady state restored
    expect(calls.count).toBe(3);
  });

  test('probe failure re-arms with DOUBLED backoff', async () => {
    let t = 1_000_000;
    const { run } = makeWrapped({ fail: authError, now: () => t });
    await run(job()).catch(() => {});
    t += HALT_COOLDOWN_BASE_MS.auth + 1;
    await expect(run(job())).rejects.toThrow('provider rejected'); // probe fails
    const remaining = llmHaltCooldownRemainingMs('prov-a', t);
    expect(remaining).toBe(HALT_COOLDOWN_BASE_MS.auth * 2);
  });

  test('while the probe is in flight, other jobs defer on a short retry', async () => {
    let t = 1_000_000;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let armed = true;
    const handler = async () => {
      if (armed) { armed = false; throw authError(); }
      await gate;
      return { ok: true };
    };
    const run = withGlobalLlmHaltCooldown(() => 'prov-a', handler, { now: () => t });
    await run(job()).catch(() => {});
    t += HALT_COOLDOWN_BASE_MS.auth + 1;
    const probe = run(job()); // in flight, parked on the gate
    await expect(run(job())).rejects.toBeInstanceOf(RateLeaseUnavailableError);
    release();
    expect(await probe).toEqual({ ok: true });
  });

  test('a nested deferral from the probe releases the probe slot (no permanent wedge)', async () => {
    let t = 1_000_000;
    let mode: 'halt' | 'nested-defer' | 'ok' = 'halt';
    const handler = async () => {
      if (mode === 'halt') throw authError();
      if (mode === 'nested-defer') throw new RateLeaseUnavailableError('model-lease', 1, 1, 500);
      return { ok: true };
    };
    const run = withGlobalLlmHaltCooldown(() => 'prov-a', handler, { now: () => t });
    await run(job()).catch(() => {}); // arms the cooldown
    t += HALT_COOLDOWN_BASE_MS.auth + 1;
    mode = 'nested-defer';
    // The admitted probe defers via a nested lease wrapper — passes through.
    await expect(run(job())).rejects.toBeInstanceOf(RateLeaseUnavailableError);
    // Pre-fix: probeInFlight stayed latched forever, so this job (and the
    // requeued probe itself) deferred on the 15s cadence until worker restart.
    mode = 'ok';
    expect(await run(job())).toEqual({ ok: true });
  });
});

describe('strikes escalate per probe, not per concurrent failure', () => {
  test('a burst of concurrent halt-class failures arms ONE strike (base cooldown, not escalated)', async () => {
    let t = 1_000_000;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const handler = async () => { await gate; throw authError(); };
    const run = withGlobalLlmHaltCooldown(() => 'prov-a', handler, { now: () => t });
    // Three jobs in flight BEFORE any cooldown exists — all fail together.
    const a = run(job()).catch(() => {});
    const b = run(job()).catch(() => {});
    const c = run(job()).catch(() => {});
    release();
    await Promise.all([a, b, c]);
    // Pre-fix: each concurrent failure incremented strikes (3 → 20min).
    // The documented policy is consecutive halted PROBES → exponential re-arm.
    expect(llmHaltCooldownRemainingMs('prov-a', t)).toBe(HALT_COOLDOWN_BASE_MS.auth);
  });
});

describe('isolation + hatches', () => {
  test('cooldown is provider-keyed: a different provider is unaffected', async () => {
    const a = makeWrapped({ key: 'prov-a', fail: authError });
    const b = makeWrapped({ key: 'prov-b', fail: () => null });
    await a.run(job()).catch(() => {});
    expect(await b.run(job())).toEqual({ ok: true });
  });

  test('non-halt errors stay per-item (no cooldown)', async () => {
    const { run } = makeWrapped({ fail: () => new Error('context length exceeded for this page') });
    await run(job()).catch(() => {});
    expect(llmHaltCooldownRemainingMs('prov-a')).toBe(0);
    await expect(run(job())).rejects.toThrow('context length'); // handler ran again
  });

  test('GBRAIN_LLM_HALT_COOLDOWN=0 disables the mechanism', async () => {
    await withEnv({ GBRAIN_LLM_HALT_COOLDOWN: '0' }, async () => {
      const { run, calls } = makeWrapped({ fail: authError });
      await run(job()).catch(() => {});
      await run(job()).catch(() => {});
      expect(calls.count).toBe(2); // no deferral — pre-#4310 behavior
    });
  });
});

describe('providerIdentityForJob', () => {
  test('job model override wins; provider half is the key', () => {
    expect(providerIdentityForJob(job({ model: 'anthropic:claude-x' }), () => 'openai:gpt-4o')).toBe('anthropic');
  });
  test('falls back to the configured chat model', () => {
    expect(providerIdentityForJob(job(), () => 'openai:gpt-4o')).toBe('openai');
  });
  test('bare model ids key on the whole string', () => {
    expect(providerIdentityForJob(job({ model: 'gpt-4o' }), () => null)).toBe('gpt-4o');
  });
});

describe('RateLeaseUnavailableError.retryInMs (worker contract)', () => {
  test('optional field carried for the worker lease-full path', () => {
    expect(new RateLeaseUnavailableError('k', 1, 1, 5000).retryInMs).toBe(5000);
    expect(new RateLeaseUnavailableError('k', 1, 1).retryInMs).toBeUndefined();
  });
});
