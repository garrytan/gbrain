/**
 * X8 (D18): `gbrain serve --http` drains the session corpus. A stdio serve
 * sweeps at startup and on idle ticks; the HTTP serve never swept, so a turn
 * the serve-side harvest refused (#5557) or a session-end corpus file sat
 * un-extracted until someone ran `gbrain sweep --once` by hand, and retention
 * GC deleted it after 30 days.
 *
 * Hermetic: in-memory PGLite + chat-transport stub; the --http lane runs
 * through the ServeOptions seams (no OAuth server boots).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runServe } from '../src/commands/serve.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { armCorpusDrain, CORPUS_DRAIN_INTERVAL_MS, CORPUS_INGESTED_SUFFIX } from '../src/core/sweep.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

describe('serve --http arms the corpus drain', () => {
  test('armed before runServeHttp with the serve source, cancelled once the lifecycle ends', async () => {
    const order: string[] = [];
    const engine = { disconnect: async () => { order.push('disconnect'); } };
    await runServe(engine as unknown as BrainEngine, ['--http'], {
      exit: () => {},
      log: () => {},
      stallWatchdogMs: 0,
      runServeHttp: async () => { order.push('run'); },
      armCorpusDrain: (_e, o) => {
        order.push(`arm:${o?.sourceId ?? 'default'}`);
        return { tick: async () => {}, cancel: () => { order.push('cancel'); } };
      },
    });
    expect(order.slice(0, 3)).toEqual(['arm:default', 'run', 'cancel']);
  });
});

describe('armCorpusDrain', () => {
  let engine: PGLiteEngine;
  let dir: string;
  let calls = 0;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    await engine.disconnect();
  });
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-corpus-drain-'));
    await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
    calls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      calls++;
      return {
        text: JSON.stringify({ facts: [] }),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:test-stub',
        providerId: 'anthropic',
      };
    });
  });
  afterEach(() => {
    __setChatTransportForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  const timers = () => {
    const armed: Array<{ fn: () => void; ms: number }> = [];
    let cleared = 0;
    return {
      armed,
      cleared: () => cleared,
      setIntervalFn: (fn: () => void, ms: number) => { armed.push({ fn, ms }); return armed.length; },
      clearIntervalFn: () => { cleared++; },
    };
  };

  test('a corpus file left without a sidecar is extracted by the next tick, exactly once, with no new hook', async () => {
    const file = join(dir, 'sess-refused.txt');
    writeFileSync(file, toCorpusText([{ role: 'user', text: 'Our standup moved to 9:30.' }, { role: 'assistant', text: 'Noted.' }]));
    const t = timers();
    const drain = armCorpusDrain(engine, {
      env: {},
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
      sweep: (e) => runMaintenanceSweep(e, { capabilities: KEYED, budgetMs: 60_000 }),
    })!;
    expect(t.armed).toHaveLength(1);
    expect(t.armed[0]!.ms).toBe(CORPUS_DRAIN_INTERVAL_MS);

    await drain.tick();
    expect(calls).toBe(1);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(true);

    await drain.tick();
    expect(calls).toBe(1);
    drain.cancel();
    expect(t.cleared()).toBe(1);
  });

  test('no pending corpus file: the tick spends nothing', async () => {
    let swept = 0;
    const t = timers();
    const drain = armCorpusDrain(engine, { env: {}, ...t, sweep: async () => { swept++; } })!;
    await drain.tick();
    writeFileSync(join(dir, 'done.txt'), 'x');
    writeFileSync(join(dir, 'done.txt' + CORPUS_INGESTED_SUFFIX), '{}');
    await drain.tick();
    expect(swept).toBe(0);
    drain.cancel();
  });

  test('GBRAIN_SWEEP=0 disables it like every other sweep', () => {
    expect(armCorpusDrain(engine, { env: { GBRAIN_SWEEP: '0' } })).toBeNull();
  });
});
