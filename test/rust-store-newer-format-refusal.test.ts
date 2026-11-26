/**
 * A brain whose store was upgraded by a newer gbrain, then opened by an older addon, is refused by name and left as it is.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: when the brain's FORMAT names a store format this addon does not list (`addon.formatVersions`), connect
 *    refuses with `rust_store_unreadable` (reason `format_unknown`). The message names the brain's format and says it is
 *    newer; the suggestion says to upgrade gbrain; nothing in the brain directory changes.
 *  - Regression: an older addon that opened a newer store and wrote to it (or answered from it) would corrupt or misread
 *    the brain. This is the shadow-release case: a shadow build carries a fixed addon, and a later gbrain may upgrade the
 *    store format (PR 10277 moves it from 8 to 9).
 *  - Why existing coverage misses it: rust/crates/gbrain-store/tests/lifecycle.rs pins the store-level refusal, but no TS
 *    test pins what a user of the engine sees (code, reason, message, suggestion) or that the records file is untouched.
 *  - Seam: the brain's FORMAT file is rewritten to the addon's newest format plus one, the same state a newer gbrain leaves.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import type { OperationError } from '../src/core/ops/contract.ts';

const TARGET = detectAddonTarget();
const BUILT = process.env.GBRAIN_RUST_ENGINE_ADDON
  ?? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Every file under `dir` with its bytes, so a test can prove nothing was written. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(path, readFileSync(path).toString('base64'));
    }
  };
  walk(dir);
  return out;
}

test.skipIf(!HAVE_ADDON)('an older addon refuses a brain in a newer store format by name, and writes nothing', async () => {
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-newer-format-'));
  dirs.push(dir);

  const first = openRustEngine({ addon, databasePath: dir });
  await first.connect({ engine: 'pglite', database_path: dir } as never);
  await first.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'Body.', timeline: '' });
  await first.disconnect();

  const formatPath = readdirSync(dir, { recursive: true }).map(String).find(p => p.endsWith('FORMAT'));
  expect(formatPath, 'the store writes a FORMAT file').toBeDefined();
  const formatFile = join(dir, formatPath!);
  const newest = Math.max(...(addon.formatVersions as number[]));
  const newer = newest + 1;
  const text = readFileSync(formatFile, 'utf8');
  const upgraded = text.replace(new RegExp(`"format_version":\\s*${newest}\\b`), `"format_version": ${newer}`);
  expect(upgraded).not.toBe(text);
  writeFileSync(formatFile, upgraded);
  const before = snapshot(dir);

  const second = openRustEngine({ addon, databasePath: dir });
  let error: OperationError | undefined;
  try {
    await second.connect({ engine: 'pglite', database_path: dir } as never);
  } catch (e) {
    error = e as OperationError;
  } finally {
    await second.disconnect().catch(() => undefined);
  }

  expect(error, 'connect refuses').toBeDefined();
  expect(error!.code).toBe('rust_store_unreadable');
  expect(error!.reason).toBe('format_unknown');
  expect(error!.message).toContain(`store format ${newer}`);
  expect(error!.message).toContain('newer');
  expect(error!.message).toContain('nothing was changed');
  expect(error!.suggestion ?? '').toContain('upgrade gbrain');
  expect(snapshot(dir), 'no file in the brain directory changed').toEqual(before);
});
