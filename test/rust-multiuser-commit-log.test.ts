/**
 * Multi-user mode's commit log and commit positions on a real Rust brain (rust/docs/store/commit-log.md,
 * src/core/rust-engine/store.ts, rust/crates/gbrain-napi/src/families/transactions.rs).
 *
 * - Off (no GBRAIN_RUST_MULTIUSER): the engine never reports `commit_log`, even with the sub-switch set.
 * - On with `GBRAIN_RUST_COMMIT_LOG=1`: the store keeps the log and the engine reports `commit_log`.
 * - The engine's `transaction(fn)` still returns the callback's value, so nothing agent-visible shows a commit
 *   position (positions themselves are pinned by rust/crates/gbrain-store/tests/commit_log.rs).
 *
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { withEnv } from './helpers/with-env.ts';

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

async function open(): Promise<{ engine: RustEngine; dir: string }> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-log-'));
  dirs.push(dir);
  const engine = openRustEngine({ addon, databasePath: dir });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: dir } as never);
  return { engine, dir };
}

/** The commit log format, as the addon exports it (format::LOG_FORMAT_VERSION; pinned only in tests/format_registry.rs). */
function logFormatVersion(): number {
  const exported = (addon as { logFormatVersion?: unknown } | undefined)?.logFormatVersion;
  expect(typeof exported, 'the addon does not export logFormatVersion').toBe('number');
  return exported as number;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OFF = { GBRAIN_RUST_MULTIUSER: undefined, GBRAIN_RUST_COMMIT_LOG: '1', GBRAIN_RUST_WRITE_ORIGIN: '1' };
const ON = { GBRAIN_RUST_MULTIUSER: '1', GBRAIN_RUST_COMMIT_LOG: '1', GBRAIN_RUST_WRITE_ORIGIN: undefined };

describe('Rust multi-user commit log', () => {
  withAddon('off: sub-switches alone change nothing, and the brain keeps its base format', async () => {
    await withEnv(OFF, async () => {
      const { engine, dir } = await open();
      expect(engine.capabilities.has('commit_log')).toBe(false);
      expect(engine.openStore('test').commitLog).toBe(false);
      expect(engine.openStore('test').multiuser).toBe(false);
      const format = JSON.parse(readFileSync(join(dir, 'FORMAT'), 'utf8'));
      expect(format.log).toBeUndefined();
      expect(format.format_version, 'a brain opened with the mode off is not on the log format').not.toBe(logFormatVersion());
    });
  });

  withAddon('on: the store keeps a log, and a transaction commit resolves its position', async () => {
    await withEnv(ON, async () => {
      const { engine, dir } = await open();
      expect(engine.capabilities.has('commit_log')).toBe(true);
      const format = JSON.parse(readFileSync(join(dir, 'FORMAT'), 'utf8'));
      expect(format.format_version).toBe(logFormatVersion());
      expect(format.log.since).toEqual({ sequence: expect.any(Number), index: 0 });
      // The engine's transaction returns the callback's value, never a position.
      expect(await engine.transaction(async () => 'value')).toBe('value');
    });
  });
});
