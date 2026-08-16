/**
 * issue #6 — `runDbProbe` verdict matrix (hermetic; injected deps only).
 *
 *   read OK                          → { ok: true }
 *   read FAIL + direct OK            → pool_starved (honest disjunction wording)
 *   read FAIL + direct FAIL          → server_unreachable
 *   read FAIL + no direct lane       → unknown
 *   hung probes                      → cancelled via their AbortSignals
 *   diagnostics absent/throwing      → fail-open (verdict still produced)
 *   tracked=0 subset                 → message points at untracked traffic
 */

import { describe, expect, test } from 'bun:test';
import { runDbProbe } from '../src/core/minions/db-probe.ts';

const FAST = { timeoutMs: 5_000, directTimeoutMs: 5_000 };
const SHORT = { timeoutMs: 50, directTimeoutMs: 50 };

describe('runDbProbe verdict matrix', () => {
  test('read OK → ok:true, no verdict', async () => {
    const res = await runDbProbe({ probeRead: async () => {}, ...FAST });
    expect(res).toEqual({ ok: true });
  });

  test('read FAIL + direct OK → pool_starved with honest-disjunction wording', async () => {
    const res = await runDbProbe({
      probeRead: async () => { throw new Error('probe timeout after 10000ms'); },
      probeDirect: async () => {},
      getDiagnostics: () => ({
        tracked: { raw: 9, direct: 0, reserved: 1, tx: 0 },
        poolMax: 10,
      }),
      ...FAST,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.verdict).toBe('pool_starved');
    expect(res.detail).toContain('server IS reachable');
    // Codex-2 #2: the message must NOT claim to distinguish client pool
    // exhaustion from a pooler-layer fault.
    expect(res.detail).toContain('client pool exhaustion or a pooler-layer fault');
    expect(res.detail).toContain('raw=9');
    expect(res.detail).toContain('read pool max 10');
    // Codex-2 #3: no invented waiter arithmetic anywhere in the message.
    expect(res.detail).not.toMatch(/waiting/i);
    expect(res.detail).toContain('subset');
  });

  test('read FAIL + direct FAIL → server_unreachable', async () => {
    const res = await runDbProbe({
      probeRead: async () => { throw new Error('probe timeout after 10000ms'); },
      probeDirect: async () => { throw new Error('connect ECONNREFUSED'); },
      ...FAST,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.verdict).toBe('server_unreachable');
    expect(res.detail).toContain('ECONNREFUSED');
  });

  test('read FAIL + no direct lane → unknown', async () => {
    const res = await runDbProbe({
      probeRead: async () => { throw new Error('boom'); },
      ...FAST,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.verdict).toBe('unknown');
    expect(res.detail).toContain('no direct lane');
  });

  test('hung read probe: cancelled via its signal at the deadline', async () => {
    let readSignal: AbortSignal | undefined;
    const res = await runDbProbe({
      probeRead: (signal) => {
        readSignal = signal;
        return new Promise<never>(() => {});
      },
      ...SHORT,
    });
    expect(res.ok).toBe(false);
    expect(readSignal?.aborted).toBe(true);
  });

  test('hung direct probe: cancelled at its own (shorter) deadline', async () => {
    let directSignal: AbortSignal | undefined;
    const res = await runDbProbe({
      probeRead: async () => { throw new Error('read dead'); },
      probeDirect: (signal) => {
        directSignal = signal;
        return new Promise<never>(() => {});
      },
      ...SHORT,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.verdict).toBe('server_unreachable');
    expect(directSignal?.aborted).toBe(true);
  });

  test('tracked=0 subset: message names untracked template traffic + runbook', async () => {
    const res = await runDbProbe({
      probeRead: async () => { throw new Error('probe timeout'); },
      probeDirect: async () => {},
      getDiagnostics: () => ({
        tracked: { raw: 0, direct: 0, reserved: 0, tx: 0 },
        poolMax: 10,
      }),
      ...FAST,
    });
    if (res.ok) throw new Error('unreachable');
    expect(res.detail).toContain('untracked');
    expect(res.detail).toContain('queue-operations-runbook');
  });

  test('diagnostics absent → verdict still produced (fail-open)', async () => {
    const res = await runDbProbe({
      probeRead: async () => { throw new Error('probe timeout'); },
      probeDirect: async () => {},
      ...FAST,
    });
    if (res.ok) throw new Error('unreachable');
    expect(res.verdict).toBe('pool_starved');
  });

  test('diagnostics THROWING → verdict still produced (fail-open)', async () => {
    const res = await runDbProbe({
      probeRead: async () => { throw new Error('probe timeout'); },
      probeDirect: async () => {},
      getDiagnostics: () => { throw new Error('gauge exploded'); },
      ...FAST,
    });
    if (res.ok) throw new Error('unreachable');
    expect(res.verdict).toBe('pool_starved');
  });
});
