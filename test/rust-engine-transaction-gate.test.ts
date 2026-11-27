/**
 * The Rust engine's writer gate at its two edges: a forced shutdown and a cancelled wait.
 *
 *  - `disconnect` waits a bounded time for an open transaction, then rolls it back. The gate must be freed then, even
 *    when the transaction's callback never returns: a write that waited on it settles, and the reconnected engine
 *    writes at once. Before the fix the gate stayed held by the stranded callback, and every later write waited forever.
 *  - A transaction that waits for the open one rejects `cancelled` as soon as its signal aborts, even when the abort
 *    came before its wait began. When an abort comes while it waits and no transaction is left, it still opens nothing
 *    and its callback never runs.
 *
 * The test needs the addon `bun run rust:build` writes and skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a
 * missing addon an error, as in test/rust-engine-store.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath, type RustBrainDir } from './engine-parity/rust-arm.ts';

const TARGET = detectAddonTarget();
const HAVE_ADDON = TARGET !== null && existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

const NOTE = { type: 'note', title: 'Gate', compiled_truth: 'gate body', timeline: '' } as const;

const brains: RustBrainDir[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const brain of brains.splice(0)) {
    await brain.engine.disconnect().catch(() => undefined);
    removeBrainDir(brain.dir);
  }
});

/** How a promise ends within `ms`: its value, its error code, or `pending`. */
async function within(promise: Promise<unknown>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); });
  const settled = promise.then(() => 'resolved', (error: { code?: string }) => `rejected:${error?.code ?? String(error)}`);
  try { return await Promise.race([settled, timeout]); } finally { clearTimeout(timer); }
}

/**
 * A signal that aborts right after the transaction's first look at it, with its abort event already gone: what happens
 * when a real abort lands between two awaits of the transaction's admission, before the wait adds its listener. A test
 * cannot time a real abort into that gap, so the signal reads unaborted once and aborted from then on.
 */
function abortsAfterFirstRead(): AbortSignal {
  const signal = new AbortController().signal;
  let reads = 0;
  Object.defineProperty(signal, 'aborted', { get: () => ++reads > 1 });
  return signal;
}

/** Opens a transaction whose callback writes one page and then waits until the test releases it. */
async function holdWriter(brain: RustBrainDir, slug: string): Promise<{ tx: Promise<unknown>; release: () => void }> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const tx = brain.engine.transaction(async (engine) => {
    await engine.putPage(slug, NOTE);
    entered();
    await held;
  });
  tx.catch(() => undefined);
  await inside;
  return { tx, release };
}

describe('Rust engine writer gate', () => {
  withAddon('a forced disconnect frees the gate: the waiting write settles and the reconnected engine writes', async () => {
    const brain = await openRustBrain();
    brains.push(brain);
    const { tx, release } = await holdWriter(brain, 'gate/rolled-back');
    const waiting = brain.engine.putPage('gate/waiting', NOTE);
    waiting.catch(() => undefined);
    expect(await within(waiting, 200)).toBe('pending');

    await brain.engine.disconnect();
    expect(await within(waiting, 2_000)).not.toBe('pending');

    await brain.engine.connect({ engine: 'pglite', database_path: brain.dir } as never);
    expect(await within(brain.engine.putPage('gate/after', NOTE), 5_000)).toBe('resolved');
    expect(await brain.engine.getPage('gate/after')).not.toBeNull();
    // The stranded transaction was rolled back, and its callback can do no more work once it resumes.
    expect(await brain.engine.getPage('gate/rolled-back')).toBeNull();
    release();
    expect(await within(tx, 2_000)).toMatch(/^rejected:/);
    expect(await brain.engine.getPage('gate/rolled-back')).toBeNull();
  }, 30_000);

  withAddon('an abort whose event came before the wait began rejects cancelled while the open transaction still runs', async () => {
    const brain = await openRustBrain();
    brains.push(brain);
    const { tx, release } = await holdWriter(brain, 'gate/open');
    let ran = false;
    const waiting = brain.engine.transaction(async (engine) => { ran = true; await engine.putPage('gate/cancelled', NOTE); }, { signal: abortsAfterFirstRead() });
    waiting.catch(() => undefined);
    expect(await within(waiting, 2_000)).toBe('rejected:cancelled');
    release();
    expect(await within(tx, 5_000)).toBe('resolved');
    expect(ran).toBe(false);
    expect(await brain.engine.getPage('gate/cancelled')).toBeNull();
    expect(await brain.engine.getPage('gate/open')).not.toBeNull();
  }, 30_000);

  withAddon('an abort during admission with no open transaction opens nothing and never runs the callback', async () => {
    const brain = await openRustBrain();
    brains.push(brain);
    let ran = false;
    const cancelled = brain.engine.transaction(async (engine) => { ran = true; await engine.putPage('gate/never', NOTE); }, { signal: abortsAfterFirstRead() });
    cancelled.catch(() => undefined);
    expect(await within(cancelled, 5_000)).toBe('rejected:cancelled');
    expect(ran).toBe(false);
    expect(await brain.engine.getPage('gate/never')).toBeNull();
    // The gate is free afterwards.
    expect(await within(brain.engine.putPage('gate/next', NOTE), 5_000)).toBe('resolved');
  }, 30_000);
});
