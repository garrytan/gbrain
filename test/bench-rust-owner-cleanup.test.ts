/**
 * scripts/bench-rust-owner.ts removes the brain folder it made, however the run ends.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: after the bench exits, no `gbrain-bench-rust-owner-*` folder is left in the temp root, on a clean run
 *    and on a run that ends with an error.
 *  - Regression: the script called process.exit inside its try block, so its finally block (the folder removal) never
 *    ran and every bench run left a brain folder behind.
 *  - Why existing coverage misses it: test/rust-owner-clients.test.ts calls the bench harness in process, not the
 *    script, so the script's exit path never ran under test.
 *  - Seam: the script runs as a child process with TMPDIR set to a scratch folder this test owns; the clean run needs
 *    the file `bun run rust:build` writes and skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const SCRIPT = join(import.meta.dir, '..', 'scripts', 'bench-rust-owner.ts');
const SCRATCH = mkdtempSync(join(tmpdir(), 'gbrain-bench-cleanup-'));

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

async function runBench(root: string, addon: string, args: string[]) {
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
    env: { ...process.env, TMPDIR: root, GBRAIN_RUST_ENGINE_ADDON: addon },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timeout); }
}

const leftovers = (root: string) => readdirSync(root).filter(name => name.startsWith('gbrain-bench-rust-owner-'));

describe('scripts/bench-rust-owner.ts', () => {
  test.skipIf(!HAVE_ADDON)('a clean run prints its result, exits 0 and leaves no brain folder', async () => {
    const root = mkdtempSync(join(SCRATCH, 'ok-'));
    const run = await runBench(root, BUILT, ['--clients', '2', '--ops', '4']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout.trim().split('\n').pop()!)).toMatchObject({ errorCount: 0 });
    expect(leftovers(root)).toEqual([]);
  }, 120_000);

  test('a run that fails exits non-zero and leaves no brain folder', async () => {
    const root = mkdtempSync(join(SCRATCH, 'bad-'));
    const run = await runBench(root, join(root, 'no-such-addon.node'), ['--clients', '1', '--ops', '2']);
    expect(run.code).not.toBe(0);
    expect(leftovers(root)).toEqual([]);
  }, 120_000);
});
