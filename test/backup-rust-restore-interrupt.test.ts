/**
 * A Rust `gbrain backup restore` that is interrupted publishes nothing and touches no existing brain (src/core/backup/rust-snapshot.ts).
 *
 * Each case runs the real restore in a child process and stops it at one named point, twice: once by an error thrown at that
 * point, once by SIGKILL of the whole process while it is stopped there. The points: part-way through archive extraction,
 * before the restored bytes are verified, inside the Rust quarantine call before and after its transaction commits, before the
 * first move into the target, and after the first move. After each, the target holds no brain (no `.gbrain`, no config, no store
 * outside the private `.restore-*` staging folder, no `ready` receipt), and the old brain (the one the archive came from), a brain
 * the user already had configured (the child's GBRAIN_HOME) and the archive are byte-identical. A retry into a new folder then
 * restores the same archive. Fails if a restore publishes before it verifies or writes into either brain.
 *
 * Needs the addon `bun run rust:build` writes (rust/target/addon); skips without it, and GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes it an error.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { hashFile } from '../src/core/backup/archive.ts';
import { createBackup, restoreBackup, type RustRestoreResult } from '../src/core/backup/rust-snapshot.ts';
import { makeHome, seedBrain } from './helpers/rust-backup-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

const CHILD = join(import.meta.dir, 'helpers', 'rust-restore-interrupt-child.ts');
const POINTS = ['extract', 'verify', 'quarantine-before-commit', 'quarantine-after-commit', 'before-publish', 'mid-publish'] as const;

/** Every path under `dir` (not following links) with its content hash: the whole state of a brain home. */
function tree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const rel = path.slice(base.length);
    if (lstatSync(path).isDirectory()) { out[rel + '/'] = 'dir'; tree(path, base, out); } else out[rel] = hashFile(path).sha256;
  }
  return out;
}

/** The target after an interruption: reserved and private, but no brain a person or a config could point at. */
function expectNothingPublished(into: string, receiptState: string): void {
  const visible = Object.keys(tree(into)).filter(path => !path.startsWith('/.restore-'));
  expect(visible.filter(path => /(^|\/)(\.gbrain|config\.json|FORMAT|records\.redb|brain\.rust)\/?$/.test(path))).toEqual([]);
  expect(JSON.parse(readFileSync(join(into, 'restore-receipt.json'), 'utf8')).state).toBe(receiptState);
}

(HAVE_ADDON ? describe : describe.skip)('an interrupted Rust restore', () => {
  let temporary: string;
  let addon: RustAddon;
  let oldRoot: string;
  let configured: string;
  let archive: string;
  let before: { old: Record<string, string>; configured: Record<string, string>; archive: ReturnType<typeof hashFile> };
  let count = 0;
  const fresh = (name: string): string => join(temporary, `${name}-${++count}`);

  beforeAll(async () => {
    temporary = mkdtempSync(join(tmpdir(), 'gbrain-restore-interrupt-'));
    addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    oldRoot = fresh('old'); makeHome(oldRoot); await seedBrain(addon, oldRoot);
    configured = fresh('configured'); makeHome(configured); await seedBrain(addon, configured);
    archive = join(temporary, 'old.gbrain-backup');
    await createBackup({ output: archive, root: oldRoot, addon });
    before = { old: tree(oldRoot), configured: tree(configured), archive: hashFile(archive) }; // what no restore, finished or not, may change
  }, 120_000);
  afterAll(() => rmSync(temporary, { recursive: true, force: true }));

  for (const point of POINTS) {
    for (const mode of ['throw', 'hang'] as const) {
      test(`${mode === 'throw' ? 'an error' : 'SIGKILL'} at ${point}: nothing is published, both brains and the archive are untouched, a retry restores`, async () => {
        const into = fresh('target');
        const marker = fresh('marker');
        const child = Bun.spawn([process.execPath, CHILD], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GBRAIN_HOME: configured, RESTORE_ARCHIVE: archive, RESTORE_INTO: into,
          RESTORE_ADDON: BUILT, INTERRUPT_POINT: point, INTERRUPT_MODE: mode, INTERRUPT_MARKER: marker } });
        if (mode === 'hang') {
          const deadline = Date.now() + 60_000;
          while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
          expect(existsSync(marker)).toBe(true);
          child.kill('SIGKILL');
        }
        await child.exited;
        const stdout = await new Response(child.stdout).text();
        expect(existsSync(marker)).toBe(true); // the restore reached the point; it did not finish or fail earlier
        if (mode === 'hang') {
          expect(child.signalCode).toBe('SIGKILL');
          expectNothingPublished(into, 'restoring');
        } else {
          expect(JSON.parse(stdout.trim().split('\n').pop()!)).toMatchObject({ outcome: 'threw', reached: true, message: `injected interruption at ${point}` });
          expectNothingPublished(into, 'failed');
        }
        expect({ old: tree(oldRoot), configured: tree(configured), archive: hashFile(archive) }).toEqual(before);

        const retry = await restoreBackup({ archive, into: fresh('retry'), addon }) as RustRestoreResult;
        expect(existsSync(join(retry.root, '.gbrain', 'config.json'))).toBe(true);
        expect({ old: tree(oldRoot), configured: tree(configured), archive: hashFile(archive) }).toEqual(before);
      }, 90_000);
    }
  }
});
