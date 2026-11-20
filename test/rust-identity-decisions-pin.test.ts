/**
 * Pins why the Rust engine may answer `listIdentityDecisions` with the empty read
 * (src/core/rust-engine/store-members/entity-identities.ts).
 *
 * The Rust store keeps no duplicate decisions (`entity_identity_reviews`): `applyIdentityDecisions`, the only member that
 * writes them, refuses with `engine_capability_missing`, and the shadow seed copies no identity relation. So an empty
 * read is the true answer, and sync's identity hook (commands/sync/perform.ts -> syncIdentityDecisions) and doctor's
 * entity_duplicates line can run on a Rust brain.
 *
 * The empty read is only true while the write refuses. When a later lane types `applyIdentityDecisions` for Rust, the
 * first test below fails: that lane must also type `listIdentityDecisions` (read the stored rows, not the empty answer)
 * and then move this file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, RustEngine } from '../src/core/rust-engine.ts';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let addon: RustAddon | undefined;
const dirs: string[] = [];
const engines: RustEngine[] = [];

async function open(): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-identity-pin-'));
  dirs.push(dir);
  const engine = openRustEngine({ addon, databasePath: dir });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: dir } as never);
  return engine;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Rust identity decisions: the empty read holds only while the write refuses', () => {
  test('applyIdentityDecisions is not a store member, so a later lane that serves it meets this file', () => {
    expect(Object.hasOwn(STORE_MEMBERS, 'applyIdentityDecisions')).toBe(false);
    expect(Object.hasOwn(STORE_MEMBERS, 'listIdentityDecisions')).toBe(true);
  });

  withAddon('applyIdentityDecisions refuses with engine_capability_missing while listIdentityDecisions answers empty', async () => {
    const engine = await open();
    const refusal = await engine.applyIdentityDecisions({}).then(() => undefined, (error: unknown) => error as { code?: string });
    expect(refusal?.code).toBe('engine_capability_missing');
    expect(await engine.listIdentityDecisions()).toEqual({ decisions: [], pending: [], revision: '' });
  });
});
