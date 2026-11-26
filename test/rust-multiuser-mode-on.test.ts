/**
 * The multi-user switch reaches the parity harness's Rust arm (I-0): with GBRAIN_RUST_MULTIUSER=1 set in the run, the
 * brain the arm opens (`openRustBrain`, test/engine-parity/rust-arm.ts) is in multi-user mode, and without it is not.
 * A mode-on parity number is only trusted next to this assertion: the test preload strips GBRAIN_* variables, so a
 * switch set on the command line alone gives a mode-off run.
 *
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustBrain, rustArmAddonPath } from './engine-parity/rust-arm.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const HAVE_ADDON = TARGET !== null && existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

async function armMode(): Promise<boolean> {
  const brain = await openRustBrain();
  try {
    return (brain.engine as unknown as { openStore(member: string): { multiuser: boolean } }).openStore('mode').multiuser;
  } finally {
    await brain.engine.disconnect();
    rmSync(brain.dir, { recursive: true, force: true });
  }
}

withAddon('the parity arm opens its Rust brain in multi-user mode exactly when the switch is on', async () => {
  await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => { expect(await armMode()).toBe(true); });
  await withEnv({ GBRAIN_RUST_MULTIUSER: undefined }, async () => { expect(await armMode()).toBe(false); });
});
