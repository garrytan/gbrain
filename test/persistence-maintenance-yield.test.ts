/**
 * Forced probe: PGLite queue maintenance returns to the event loop between its steps.
 *
 * Protects: on PGLite every statement runs synchronously and resolves as a microtask, so a chain of statements never
 * lets a timer or stdin read run until the chain ends. The resident owner's first tick runs the compaction pass, the
 * reservation sweep and the queue VACUUM back to back next to the effects drain; on a slow CI runner that one chain held
 * the event loop for 2.2 s (test/persistence-drain-latency.serial.test.ts, bound 2 s). Each step now yields first, and a
 * yield resumes from the timer queue, so a timer that came due runs before the next chain instead of after it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { vacuumPersistenceQueues } from '../src/core/persistence/journal.ts';
import { LAST_COMPACTION_KEY, runCompactionPass } from '../src/core/persistence/compaction-pass.ts';
import { COMPACTED_SWEEP_KEY } from '../src/core/persistence/receipt-true-up.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

/** Runs `work` and returns each engine call it made with the event-loop turn (timer or check phase) it ran in. */
async function turnsOf(work: () => Promise<unknown>): Promise<Array<{ call: string; turn: number }>> {
  let turn = 0, stop = false;
  const immediate = () => { turn++; if (!stop) setImmediate(immediate); };
  const timer = () => { turn++; if (!stop) setTimeout(timer, 0); };
  setImmediate(immediate);
  setTimeout(timer, 0);
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  const seen: Array<{ call: string; turn: number }> = [];
  const target = engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originals = Object.fromEntries(['executeRaw', 'getConfig', 'setConfig'].map(name => [name, target[name]!]));
  for (const [name, original] of Object.entries(originals)) {
    target[name] = function (this: BrainEngine, ...args: unknown[]) {
      seen.push({ call: name === 'executeRaw' ? String(args[0]).trim().split(/\s+/).slice(0, 2).join(' ') : `${name} ${String(args[0])}`, turn });
      return original.apply(this, args);
    };
  }
  try { await work(); } finally { Object.assign(target, originals); stop = true; }
  return seen;
}

test('the queue VACUUM runs in a later event-loop turn than the size check that chose it', async () => {
  await engine.executeRaw("INSERT INTO persistence_counters(key) SELECT 'yield-' || g FROM generate_series(1, 3000) g");
  const calls = await turnsOf(() => vacuumPersistenceQueues(engine));
  const size = calls.find(c => c.call === 'SELECT c.relname')!;
  const vacuum = calls.find(c => c.call.startsWith('VACUUM'))!;
  expect(vacuum).toBeDefined();
  expect(vacuum.turn).toBeGreaterThan(size.turn);
  await engine.executeRaw("DELETE FROM persistence_counters WHERE key LIKE 'yield-%'");
});

test('the compaction pass, the reservation sweep and the pass record each run in their own event-loop turn', async () => {
  const calls = await turnsOf(() => runCompactionPass(engine, { hostId: '00000000-0000-0000-0000-000000000001' }));
  const compact = calls.find(c => c.call === 'SELECT *')!;
  const sweep = calls.find(c => c.call === `getConfig ${COMPACTED_SWEEP_KEY}`)!;
  const record = calls.find(c => c.call === `setConfig ${LAST_COMPACTION_KEY}`)!;
  expect([compact, sweep, record].every(Boolean)).toBe(true);
  expect(sweep.turn).toBeGreaterThan(compact.turn);
  expect(record.turn).toBeGreaterThan(sweep.turn);
});

test('a yield resumes after timers that came due before it, not ahead of them', async () => {
  const { yieldToEventLoop } = await import('../src/core/persistence/journal.ts');
  let fired = false;
  setTimeout(() => { fired = true; }, 0);
  const until = performance.now() + 5;
  while (performance.now() < until) { /* a synchronous statement chain */ }
  await yieldToEventLoop();
  expect(fired).toBe(true);
});

