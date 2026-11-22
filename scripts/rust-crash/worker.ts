#!/usr/bin/env bun
/**
 * The Rust crash cell's writer process (scripts/rust-crash/README.md). It opens a Rust brain through the built addon
 * and runs a seeded operation sequence (ops.ts), logging `start <i>` before and `ack <i>` after each operation to the
 * crash point log, the same file the store's crash points (rust/crates/gbrain-store/src/crash_points.rs) append to. The
 * driver SIGKILLs it at a chosen point and checks what the brain kept.
 *
 *   bun scripts/rust-crash/worker.ts <brain dir> <repo dir> <seed> <count> <log> [engine pglite] [freeze-after-ack <i>]
 *       [seam <fault point>:<n>] [plant early-ack]
 *
 * It also logs `seam <point>` each time a persistence fault point (src/core/persistence/fault-points.ts) is reached, and
 * freezes at the n-th time `seam` names. `engine pglite` runs the same sequence on a PGLite datastore instead (the control
 * arm: the store's own crash points exist only on Rust).
 *
 * Environment: GBRAIN_RUST_ENGINE_ADDON (the addon), GBRAIN_HOME (a scratch home), and the store's
 * GBRAIN_TEST_RUST_CRASH_LOG / GBRAIN_TEST_RUST_CRASH_AT. Exit 0 after `done`; 3 when an operation fails.
 */
import { appendFileSync } from 'node:fs';
import type { BrainEngine } from '../../src/core/engine.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { generate, runOp } from './ops.ts';

const [brain, repo, seedText, countText, log, ...rest] = process.argv.slice(2);
if (!brain || !repo || !seedText || !countText || !log) {
  console.error('usage: worker.ts <brain dir> <repo dir> <seed> <count> <log> [freeze-after-ack <i>] [plant early-ack]');
  process.exit(2);
}
const option = (name: string): string | undefined => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
};
const freezeAfter = option('freeze-after-ack');
const plant = option('plant');
const seam = option('seam');
const engineKind = option('engine') ?? 'rust';
// Synchronous appends: a line is in the file before the next step starts, so the driver never sees an ack that a
// process death could still take back.
const note = (line: string) => appendFileSync(log, `${line}\n`);

const seamAt = seam ? { point: seam.slice(0, seam.lastIndexOf(':')), n: Number(seam.slice(seam.lastIndexOf(':') + 1)) } : null;
const seamCounts = new Map<string, number>();
installFaultHook(async point => {
  const n = (seamCounts.get(point) ?? 0) + 1;
  seamCounts.set(point, n);
  note(`seam ${point} ${n}`);
  if (seamAt && seamAt.point === point && seamAt.n === n) {
    note(`freeze seam ${point} ${n}`);
    await new Promise(() => {});
  }
});

let engine: BrainEngine;
if (engineKind === 'pglite') {
  const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
  engine = new PGLiteEngine();
  await engine.connect({ database_path: brain } as never);
} else {
  const { loadRustEngineAddon } = await import('../../src/core/rust-engine/addon-loader.ts');
  const { openRustEngine } = await import('../../src/core/rust-engine.ts');
  const loaded = await loadRustEngineAddon();
  if (!loaded.ok) {
    console.error(`the Rust addon did not load: ${loaded.message}`);
    process.exit(2);
  }
  engine = openRustEngine({ addon: loaded.addon, databasePath: brain }) as unknown as BrainEngine;
  await engine.connect({ engine: 'rust', database_path: brain } as never);
}
await engine.initSchema();
// The shortest publication ceiling an operator may set (60 s; the default is 5 min). A request killed inside its
// publication transaction is taken over only when its claim lease (the ceiling plus about 65 s) ends, so this keeps
// that wait near 2 minutes in the cell. It is the same operator setting on every engine.
await engine.setConfig('persistence.publication_ceiling_ms', '60000');
note('open');
const ops = generate(Number(seedText), Number(countText));
for (let i = 0; i < ops.length; i++) {
  note(`start ${i}`);
  // The planted bug for the fail-first check: acknowledge before the write runs.
  if (plant === 'early-ack') note(`ack ${i}`);
  try {
    await runOp({ engine, repo }, ops[i]!, i);
  } catch (error) {
    note(`error ${i} ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 400)}`);
    process.exit(3);
  }
  if (plant !== 'early-ack') note(`ack ${i}`);
  if (freezeAfter !== undefined && Number(freezeAfter) === i) {
    note(`freeze ack ${i}`);
    await new Promise(() => {});
  }
}
await engine.disconnect();
note('done');
process.exit(0);
