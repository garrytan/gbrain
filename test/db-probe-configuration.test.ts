import { describe, expect, test } from 'bun:test';
import { runDbProbe, runDbReadinessProbe, assertWorkerDbReadiness } from '../src/core/minions/db-probe.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { LocalConfigurationError, isLocalConfigurationError } from '../src/core/minions/configuration-error.ts';

const budgets = { timeoutMs: 20, directTimeoutMs: 20 };
const fault = new LocalConfigurationError('postgres_cancellation_unavailable', 'Repair the driver, then restart.');
const success = async () => {};
const fail = (error: unknown) => async () => { throw error; };

describe('typed database configuration faults', () => {
  for (const probe of [runDbProbe, runDbReadinessProbe]) {
    for (const other of [new Error('ECONNREFUSED'), new DOMException('aborted', 'AbortError')]) {
      test(`${probe.name}: typed read fault precedes ${other.name} on direct`, async () => {
        const result = await probe({ ...budgets, probeRead: fail(fault), probeDirect: fail(other) });
        expect(result).toEqual({ ok: false, verdict: 'client_misconfigured', detail: fault.message, configurationError: fault });
      });
      test(`${probe.name}: typed direct fault precedes ${other.name} on read`, async () => {
        const result = await probe({ ...budgets, probeRead: fail(other), probeDirect: fail(fault) });
        expect(result).toEqual({ ok: false, verdict: 'client_misconfigured', detail: fault.message, configurationError: fault });
      });
    }
    test(`${probe.name}: typed fault needs no direct lane`, async () => {
      const result = await probe({ ...budgets, probeRead: fail(fault) });
      expect(result.ok === false && result.verdict).toBe('client_misconfigured');
    });
    test(`${probe.name}: matching text and structural impostors remain transient`, async () => {
      for (const error of [new Error(fault.message), { name: fault.name, reasonCode: fault.reasonCode, message: fault.message }]) {
        expect(isLocalConfigurationError(error)).toBe(false);
        const result = await probe({ ...budgets, probeRead: fail(error), probeDirect: fail(error) });
        expect(result.ok === false && result.verdict).toBe('server_unreachable');
      }
    });
    test(`${probe.name}: exhausted budgets abort both lanes without a permanent verdict`, async () => {
      const signals: AbortSignal[] = [];
      const hang = (signal: AbortSignal) => { signals.push(signal); return new Promise<void>(() => {}); };
      const result = await probe({ ...budgets, probeRead: hang, probeDirect: hang });
      expect(result.ok === false && result.verdict).toBe('server_unreachable');
      expect(signals.length).toBe(2);
      expect(signals.every(signal => signal.aborted)).toBe(true);
    });
    test(`${probe.name}: a typed direct fault takes precedence over a read timeout`, async () => {
      const result = await probe({
        ...budgets,
        probeRead: () => new Promise<void>(() => {}),
        probeDirect: fail(fault),
      });
      expect(result.ok === false && result.verdict).toBe('client_misconfigured');
    });
  }

  test('startup validates direct lane even with a healthy read pool', async () => {
    expect(await runDbProbe({ ...budgets, probeRead: success, probeDirect: fail(fault) })).toEqual({ ok: true });
    const result = await runDbReadinessProbe({ ...budgets, probeRead: success, probeDirect: fail(fault) });
    expect(result.ok === false && result.verdict).toBe('client_misconfigured');
    expect(await runDbReadinessProbe({ ...budgets, probeRead: success, probeDirect: success })).toEqual({ ok: true });
  });

  test('startup direct-only network fault is unknown, not a server outage', async () => {
    const result = await runDbReadinessProbe({ ...budgets, probeRead: success, probeDirect: fail(new Error('ECONNREFUSED')) });
    expect(result.ok === false && result.verdict).toBe('unknown');
  });

  test('single-lane healthy readiness requires no invented direct capability', async () => {
    expect(await runDbReadinessProbe({ ...budgets, probeRead: success })).toEqual({ ok: true });
  });

  test('engine adapter skips PGLite and probes both actual Postgres lanes', async () => {
    await assertWorkerDbReadiness({ kind: 'pglite' } as BrainEngine);
    const lanes: string[] = [];
    const engine = {
      kind: 'postgres',
      connectionManager: { isDualPoolActive: () => true },
      executeRaw: async (_sql: string, _params: unknown[], opts: { signal: AbortSignal }) => { expect(opts.signal).toBeInstanceOf(AbortSignal); lanes.push('read'); },
      executeRawDirect: async () => { lanes.push('direct'); throw fault; },
    } as unknown as BrainEngine;
    await expect(assertWorkerDbReadiness(engine)).rejects.toBe(fault);
    expect(lanes).toEqual(['read', 'direct']);
  });

  test('engine adapter does not duplicate a collapsed direct lane', async () => {
    let direct = false;
    await assertWorkerDbReadiness({
      kind: 'postgres',
      connectionManager: { isDualPoolActive: () => false },
      executeRaw: success,
      executeRawDirect: async () => { direct = true; },
    } as unknown as BrainEngine);
    expect(direct).toBe(false);
  });

  test('transient diagnostics redact connection credentials on both lanes', async () => {
    const result = await runDbReadinessProbe({
      ...budgets,
      probeRead: fail(new Error('postgresql://fixture:GSTACK_EXAMPLE_NONCE@localhost/test')),
      probeDirect: fail(new Error('password=other-private-value')),
    });
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(JSON.stringify(result)).not.toContain('GSTACK_EXAMPLE_NONCE');
    expect(result.ok === false && result.verdict).toBe('server_unreachable');
  });
});
