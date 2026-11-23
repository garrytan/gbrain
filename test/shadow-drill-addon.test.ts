/**
 * The shadow restore drill against a real Rust owner (src/shadow/drill.ts; rust/docs/store/snapshot.md).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the claim criterion 10 rests on: a drill copies the shadow's store while
 * the shadow's owner keeps writing, verifies the copy without a normal open, opens it once and leaves nothing behind.
 * (2) Fails when the drill pauses or blocks the owner's writes, when the copy holds a later commit, when a killed CLI's
 * scratch space is deleted (or reads as a pass) while the owner may still be copying, or when the next drill cannot clear
 * it once the owner says the copy ended. (3) The fake-owner tests (test/shadow-drill.test.ts) cannot show any of this: the
 * lifecycle is the addon's. (4) The real addon (`bun run rust:build`), a real owner child process, the real verifier;
 * skips without the addon (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error, as the CI addon job sets).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustEngineAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { runBackupDrill } from '../src/shadow/drill.ts';
import { buildDrillStatus } from '../src/shadow/drill-status.ts';
import { writeEpoch } from './helpers/shadow-drill-fixtures.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

const root = join(import.meta.dir, '..');
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

/** A shadow directory whose store has a live owner child that keeps writing. */
async function shadowWithOwner(): Promise<{ dir: string; initialPages: number; stop(): Promise<number> }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-drill-addon-'));
  const child = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'shadow-drill-owner.ts'), BUILT, dir], { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let out = '';
  void (async () => { for await (const chunk of child.stdout) out += new TextDecoder().decode(chunk); })();
  cleanups.push(() => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
  await until('the owner to be ready', () => /ready \d+/.test(out), 40_000);
  writeEpoch(dir);
  return {
    dir, initialPages: Number(/ready (\d+)/.exec(out)![1]),
    stop: async () => {
      child.stdin.write('stop\n');
      await child.stdin.flush();
      await until('the owner to stop', () => /stopped \d+/.test(out));
      return Number(/stopped (\d+)/.exec(out)![1]);
    },
  };
}
const scratches = (dir: string): string[] => (existsSync(join(dir, 'drills')) ? readdirSync(join(dir, 'drills')).filter(n => n.startsWith('scratch-')) : []);

(HAVE_ADDON ? describe : describe.skip)('the restore drill on a real shadow store', () => {
  test('copies the store while its owner keeps writing, verifies and opens the copy, and leaves nothing behind', async () => {
    const shadow = await shadowWithOwner();
    const record = await runBackupDrill(shadow.dir, {
      loadAddon: () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }),
      snapshotOptions: { batchBytes: 4096, batchDelayMs: 20 },
    });
    expect(record).toMatchObject({ pass: true, reason: null, via: 'owner_ipc', method: 'online_logical', scratch_deleted: true, over_archive_cap: false });
    expect(record.generation).toBeGreaterThan(0);
    expect(record.compared!.tags).toBeGreaterThan(0);
    expect(record.mismatches).toEqual([]);
    expect(record.post_open!.pages).toBeGreaterThanOrEqual(shadow.initialPages);
    expect(record.post_open!.keyword_state).toBe('complete');
    expect(record.post_open!.search_hits).toBeGreaterThan(0);
    expect(record.free_bytes_low_water!).toBeLessThanOrEqual(record.free_bytes_initial!);
    expect(JSON.parse(readFileSync(join(shadow.dir, 'drills', 'backup.json'), 'utf8')).drill_id).toBe(record.drill_id);
    expect(scratches(shadow.dir)).toEqual([]);
    expect(buildDrillStatus(shadow.dir).drills.backup_restore_passed).toBe(true);
    // The owner was never paused: it kept writing through the copy and took pages after it.
    const total = await shadow.stop();
    expect(total).toBeGreaterThan(shadow.initialPages);
  }, 90_000);

  test('a killed CLI leaves cleanup_pending until the owner ends the copy; the next drill then clears it', async () => {
    const shadow = await shadowWithOwner();
    const cli = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'shadow-drill-cli.ts'), BUILT, shadow.dir, '150', '4096'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    cleanups.push(() => { cli.kill('SIGKILL'); });
    await until('the copy to start', () => scratches(shadow.dir).some(n => existsSync(join(shadow.dir, 'drills', n, 'restored', 'records.redb'))), 40_000);
    cli.kill('SIGKILL');
    await cli.exited;
    // Right after the kill the drill left its pending record, and status is not a pass whatever the owner is doing.
    expect(existsSync(join(shadow.dir, 'drills', 'pending.json'))).toBe(true);
    expect(buildDrillStatus(shadow.dir).drills).toMatchObject({ backup_restore_passed: false, backup_state: 'cleanup_pending' });
    // The owner stops the copy for the gone caller and says so; only then does a drill clear it and run.
    let next = await runBackupDrill(shadow.dir, { loadAddon: () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }) });
    const deadline = Date.now() + 30_000;
    while (next.reason === 'cleanup_pending' && Date.now() < deadline) {
      await sleep(100);
      next = await runBackupDrill(shadow.dir, { loadAddon: () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }) });
    }
    expect(next).toMatchObject({ pass: true, scratch_deleted: true });
    expect(scratches(shadow.dir)).toEqual([]);
    expect(existsSync(join(shadow.dir, 'drills', 'pending.json'))).toBe(false);
    expect(buildDrillStatus(shadow.dir).drills.backup_restore_passed).toBe(true);
    await shadow.stop();
  }, 120_000);

  test('a store with no owner running is copied in process', async () => {
    const shadow = await shadowWithOwner();
    await shadow.stop();
    await sleep(500);
    const record = await runBackupDrill(shadow.dir, { loadAddon: () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }) });
    expect(record).toMatchObject({ pass: true, via: 'in_process', scratch_deleted: true });
  }, 90_000);
});
