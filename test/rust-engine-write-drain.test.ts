/**
 * The Rust engine's writer gate: writes admitted before a transaction finish before the transaction takes the writer.
 *
 * Before the fix a transaction could open while admitted writes still ran (a write with `source_path` reads its source
 * after admission). Each such write then waited in the store for the writer on one of the root store's 4 worker
 * threads, so twelve of them left no thread for a read, and getPage waited until the transaction ended.
 *
 * This file runs alone in its own process on purpose: the race shows on a cold process (the old gate failed it 3 of 3
 * runs there); after other Rust-engine tests have warmed the process, the admitted writes can finish before the
 * transaction opens and the old gate can pass by timing. The test needs the addon `bun run rust:build` writes and skips
 * without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath, type RustBrainDir } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = detectAddonTarget() !== null && existsSync(rustArmAddonPath());
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

describe('Rust engine writer gate: admitted writes', () => {
  withAddon('writes admitted before a transaction finish first, so a read still answers while it is open', async () => {
    const brain = await openRustBrain();
    brains.push(brain);
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      const write = brain.engine.putPage(`gate/w${i}`, { ...NOTE, source_path: `w${i}.md` } as never);
      write.catch(() => undefined);
      writes.push(write);
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    releases.push(release);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const tx = brain.engine.transaction(async (engine) => { await engine.putPage('gate/held', NOTE); entered(); await held; });
    tx.catch(() => undefined);
    expect(await within(inside, 10_000)).toBe('resolved');
    const started = performance.now();
    expect(await within(brain.engine.getPage('gate/none'), 3_000)).toBe('resolved');
    // The control: a read with no transaction open answers in tens of milliseconds (getPage, ~26-40 ms in the gate tests).
    expect(performance.now() - started).toBeLessThan(1_000);
    release();
    expect(await within(tx, 5_000)).toBe('resolved');
    expect((await Promise.allSettled(writes)).map((write) => write.status)).toEqual(Array(12).fill('fulfilled'));
    expect(await brain.engine.getPage('gate/w11')).not.toBeNull();
    expect(await brain.engine.getPage('gate/held')).not.toBeNull();
  }, 60_000);
});
