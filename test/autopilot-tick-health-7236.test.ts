/**
 * #7236: one autopilot dispatch tick computed the unfiltered content_chunks
 * health aggregate twice: `computeAutopilotPlan` (autopilot-dispatch.ts) and
 * the daemon's `adaptiveInterval` (autopilot-daemon.ts) each called
 * `engine.getHealth()`, and on a large brain each call is a full scan.
 *
 * Protects: a Minions-dispatch tick (the dispatch, then the adaptive interval,
 * exactly as the daemon loop runs them) reads health once and the interval
 * routes on the plan's snapshot; the read is bounded on Postgres by a
 * transaction-local statement_timeout, and a read the server ends there is
 * reported as degraded: the tick is not a failed cycle, does not sleep as
 * healthy and does not double its interval.
 * Fails when: a tick issues a second health aggregate, the interval ignores
 * the tick's snapshot, a timed-out health read throws out of the tick or
 * grades the brain healthy, or the Postgres read waits past its bound.
 * PGLite always; Postgres through test/e2e/autopilot-tick-health-7236-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchAutopilotTick } from '../src/commands/autopilot-dispatch.ts';
import { shouldRunAutopilotFullCycle, shouldSleepHealthyAutopilot } from '../src/commands/autopilot-remediation-policy.ts';
import * as daemon from '../src/commands/autopilot-daemon.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { surfaceFileSource } from './helpers/source-surface.ts';

type Interval = (engine: BrainEngine, baseInterval: number, cycleStart: number, jsonMode: boolean, health?: unknown) => Promise<number>;
const adaptiveInterval = (daemon as unknown as { adaptiveInterval: Interval }).adaptiveInterval;

/** Captures stderr and stdout lines while `run` executes. */
async function captured<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const log = console.log;
  (process.stderr as { write: unknown }).write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { return { value: await run(), lines }; } finally { (process.stderr as { write: unknown }).write = write; console.log = log; }
}

/** Counts every getHealth call on `engine` and on transaction engines derived from it (they inherit the own property). */
function countHealthReads(engine: BrainEngine, fail?: () => Error): { reads: () => number; restore: () => void } {
  let reads = 0;
  const real = Object.getPrototypeOf(engine).getHealth as BrainEngine['getHealth'];
  Object.defineProperty(engine, 'getHealth', {
    configurable: true,
    value: function (this: BrainEngine, ...args: Parameters<BrainEngine['getHealth']>) {
      reads++;
      if (fail) return Promise.reject(fail());
      return real.apply(this, args);
    },
  });
  return { reads: () => reads, restore: () => { delete (engine as unknown as Record<string, unknown>).getHealth; } };
}

/** One Minions-dispatch tick as the daemon loop runs it: the dispatch, then the adaptive interval on its result. */
async function oneTick(engine: BrainEngine, baseInterval = 300) {
  const state = { lastFullCycleAt: Date.now(), freshnessHeads: new Map<string, string>() } as never;
  return captured(async () => {
    const tick = await dispatchAutopilotTick(engine, state, { repoPath: '', baseInterval, jsonMode: true }) as unknown as { cycleOk: boolean; health?: unknown };
    const interval = await adaptiveInterval(engine, baseInterval, Date.now(), true, tick.health);
    return { tick, interval };
  });
}

const statementTimeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

describe('#7236 routing on an unknown score', () => {
  test('a degraded (null) score never sleeps as healthy and does not force the full cycle before the floor', () => {
    expect(shouldSleepHealthyAutopilot(null, 0, 10)).toBe(false);
    expect(shouldRunAutopilotFullCycle({ score: null, planLength: 0, estimatedSeconds: 0, minutesSinceLastFull: 10 })).toBe(false);
    expect(shouldRunAutopilotFullCycle({ score: null, planLength: 0, estimatedSeconds: 0, minutesSinceLastFull: 60 })).toBe(true);
  });
});

for (const kind of testBackends()) {
  describe(`#7236 autopilot tick health read (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-tick-health-'));
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.putPage('notes/alpha-example', { type: 'note', title: 'Alpha example', compiled_truth: 'Alpha example body.' });
    }, 120_000);
    afterAll(async () => { await close?.(); rmSync(home, { recursive: true, force: true }); });

    test('one dispatch tick computes the health aggregate once and the interval routes on that snapshot', async () => {
      await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
        const spy = countHealthReads(engine);
        try {
          const { value, lines } = await oneTick(engine);
          expect(spy.reads()).toBe(1);
          expect(value.tick.cycleOk).toBe(true);
          const cycle = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).find(e => e?.event === 'cycle');
          expect(typeof cycle?.brain_score).toBe('number');
          expect(cycle.brain_score).toBe((value.tick.health as { brain_score: number }).brain_score);
        } finally { spy.restore(); }
      });
    }, 120_000);

    test('a timed-out health aggregate reports degraded: no failed cycle, no healthy sleep, no doubled interval, still one read', async () => {
      await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
        const spy = countHealthReads(engine, statementTimeout);
        try {
          const { value, lines } = await oneTick(engine, 300);
          expect(spy.reads()).toBe(1);
          const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          expect(events.filter(e => e.event === 'health_degraded').map(e => e.sqlstate)).toEqual(['57014']);
          expect(value.tick.cycleOk).toBe(true);
          expect(value.tick.health).toBeNull();
          expect(value.interval).toBe(300);
          expect(events.some(e => e.event === 'skip_healthy')).toBe(false);
          expect(events.find(e => e.event === 'cycle')?.brain_score).toBeNull();
        } finally { spy.restore(); }
      });
    }, 120_000);

    test('a health read error other than a timeout still fails the cycle', async () => {
      await withEnv({ GBRAIN_HOME: home, HOME: home }, async () => {
        const spy = countHealthReads(engine, () => Object.assign(new Error('relation does not exist'), { code: '42P01' }));
        try {
          const { value } = await oneTick(engine, 300);
          expect(value.tick.cycleOk).toBe(false);
        } finally { spy.restore(); }
      });
    }, 120_000);

    if (kind === 'postgres') {
      test('the Postgres health read ends on the server at its bound and reports degraded', async () => {
        const { readTickHealth } = await import('../src/commands/autopilot-health.ts');
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let locked!: () => void;
        const isLocked = new Promise<void>(resolve => { locked = resolve; });
        const holder = engine.transaction(async (tx) => {
          await tx.executeRaw('LOCK TABLE content_chunks IN ACCESS EXCLUSIVE MODE');
          locked();
          await held;
        });
        try {
          await isLocked;
          const startedAt = Date.now();
          const { value, lines } = await captured(() => readTickHealth(engine, true, 300));
          const elapsed = Date.now() - startedAt;
          expect(value).toBeNull();
          expect(elapsed).toBeLessThan(10_000);
          const degraded = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).find(e => e?.event === 'health_degraded');
          expect(['57014', '55P03']).toContain(degraded?.sqlstate);
          expect(degraded?.timeout_ms).toBe(300);
        } finally { release(); await holder; }
        const fresh = await readTickHealth(engine, true, 30_000);
        expect(fresh?.page_count).toBe(1);
      }, 120_000);
    }

    test('the daemon loop hands the dispatch tick\'s health to the adaptive interval', () => {
      const src = surfaceFileSource('autopilot', 'src/commands/autopilot-daemon.ts');
      expect(src.includes('adaptiveInterval(engine, baseInterval, cycleStart, jsonMode, tick.health)')).toBe(true);
    });
  });
}
