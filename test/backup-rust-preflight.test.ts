/**
 * `gbrain backup create` of a Rust brain refuses what its archive cannot hold before it takes a lock or opens the brain,
 * and the quiesced physical-copy runbook (docs/guides/in-agent-setup.md) works end to end on the Rust layout: copy FORMAT
 * and records.redb of a stopped brain, `backup verify-store` reads the copy without changing it, an isolated home opens it.
 *
 * Oversize inputs are sparse files (apparent size, no disk use). The runbook drill and the verify-store cases need the
 * addon (`bun run rust:build`; GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error). Fails on: a refusal that
 * names doctor instead of verify-store, a refusal that writes a lock or a work folder, a verify that changes a byte of the
 * copy, a verify that calls an unclean, unknown or damaged copy fine, a runbook copy the isolated home cannot read.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateWrite } from '../src/core/agent-install/state.ts';
import { BACKUP_ARCHIVE_MAX_BYTES, hashFile } from '../src/core/backup/archive.ts';
import { managedLayout, rustBackupPreflight, rustPhysicalCopyFix } from '../src/core/backup/preflight.ts';
import { createBackup, verifyRustStoreDir } from '../src/core/backup/rust-snapshot.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { brainDir, makeHome, seedBrain } from './helpers/rust-backup-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let temporary: string;
let count = 0;
const fresh = (name: string): string => join(temporary, `${name}-${++count}`);
const failure = async (promise: Promise<unknown>): Promise<Record<string, any>> => promise.then(() => { throw new Error('unexpectedly succeeded'); }, (error: Error) => error as never);
const filesOf = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).sort().map(name => [name, hashFile(join(dir, name)).sha256]));

beforeAll(() => { temporary = mkdtempSync(join(tmpdir(), 'gbrain-rust-preflight-')); });
afterAll(() => { rmSync(temporary, { recursive: true, force: true }); });

describe('layout and size preflight (no addon needed)', () => {
  test('a flat or symlinked brain directory is unmanaged_database_path and names verify-store, not doctor', async () => {
    const root = fresh('flat'); makeHome(root);
    expect(managedLayout(root, join(root, 'elsewhere', 'brain.rust'), 'brain.rust')).toBe('flat');
    const flat = rustBackupPreflight(root, join(root, 'elsewhere', 'brain.rust'), () => 0)!;
    expect(flat).toMatchObject({ code: 'unmanaged_database_path' });
    const linked = fresh('linked'); makeHome(linked);
    const physical = join(temporary, `volume-${count}`); mkdirSync(physical);
    rmSync(join(linked, '.gbrain'), { recursive: true }); symlinkSync(physical, join(linked, '.gbrain'), 'dir');
    expect(managedLayout(linked, brainDir(linked), 'brain.rust')).toBe('symlinked');
    for (const refusal of [flat, rustBackupPreflight(linked, brainDir(linked), () => 0)!]) {
      expect((refusal as any).fix.argv).toEqual(['gbrain', 'backup', 'verify-store', '<COPY_DIR>', '--json']);
      expect((refusal as any).fix.user_message).toContain('never .gbrain-owner.sock');
      expect((refusal as any).fix.user_message).not.toContain('doctor');
    }
  });

  test('over the real 8 GiB cap, backup_too_large names the Rust runbook; nothing is written, locked or opened', async () => {
    const root = fresh('big'); makeHome(root);
    mkdirSync(brainDir(root), { recursive: true });
    writeFileSync(join(brainDir(root), 'FORMAT'), '{}');
    writeFileSync(join(brainDir(root), 'records.redb'), '');
    truncateSync(join(brainDir(root), 'records.redb'), BACKUP_ARCHIVE_MAX_BYTES - 2 * 1024 * 1024);
    expect(rustBackupPreflight(root, brainDir(root), () => 0)).toBeNull();
    truncateSync(join(brainDir(root), 'records.redb'), BACKUP_ARCHIVE_MAX_BYTES + 1);
    const output = `${root}.gbrain-backup`;
    const error = await failure(createBackup({ output, root, addon: { Brain: class {} } as never }));
    expect(error.code).toBe('backup_too_large');
    expect(error.message).toContain('Rust brain');
    expect(error.detail).toContain(`limit=${BACKUP_ARCHIVE_MAX_BYTES}`);
    expect(error.fix.docs).toContain('quiesced-physical-copy');
    expect(error.fix.verify.argv).toEqual(rustPhysicalCopyFix().verify!.argv);
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(root).filter(name => name.startsWith('.gbrain-backup-'))).toEqual([]);
    expect(readdirSync(join(root, '.gbrain')).filter(name => name.endsWith('.lock') || name.includes('bootstrap'))).toEqual([]);
  });
});

describe('the physical-copy runbook on the Rust layout', () => {
  let addon: RustAddon;
  beforeAll(async () => { if (HAVE_ADDON) addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }); });

  /** Steps 2-3 of the runbook: copy FORMAT and records.redb of the stopped brain into <new-home>/.gbrain/brain.rust, point config.json at the copy. */
  function physicalCopy(root: string): string {
    const home = fresh('copy');
    mkdirSync(join(home, '.gbrain', 'brain.rust'), { recursive: true });
    for (const name of ['FORMAT', 'records.redb']) copyFileSync(join(brainDir(root), name), join(home, '.gbrain', 'brain.rust', name));
    privateWrite(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: join(home, '.gbrain', 'brain.rust') }));
    return join(home, '.gbrain', 'brain.rust');
  }

  withAddon('copy, verify-store (which changes nothing), and an isolated home that reads the copy; the snapshot primitive is never called', async () => {
    const root = fresh('home'); makeHome(root); await seedBrain(addon, root);
    expect(readdirSync(brainDir(root)).sort()).toEqual(['FORMAT', 'records.redb']);
    const copy = physicalCopy(root);
    const before = filesOf(copy);
    const report = await verifyRustStoreDir(copy, addon);
    expect(report).toMatchObject({ verdict: 'ok', mismatches: [] });
    expect(report.generation).toBeGreaterThan(0);
    expect(report.keys).toBeGreaterThan(0);
    expect(filesOf(copy)).toEqual(before);
    const child = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'rust-reopen.ts'), BUILT, copy, 'notes/a', 'zebra'], { cwd: join(import.meta.dir, '..'), stdout: 'pipe' });
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ title: 'Alpha note', hits: ['notes/a'], role: 'owner' });
  }, 60_000);

  withAddon('verify-store refuses a copy of a killed brain and an unknown format, and reports a damaged record file and a missing FORMAT, never as fine', async () => {
    const root = fresh('home'); makeHome(root); await seedBrain(addon, root);
    // A brain killed while open was not closed cleanly: copying it is not the runbook, and verify says so.
    const owner = Bun.spawn(['bun', 'run', join(import.meta.dir, 'helpers', 'rust-owner-child.ts'), BUILT, brainDir(root)], { cwd: join(import.meta.dir, '..'), stdin: 'pipe', stdout: 'pipe' });
    const reader = owner.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
    (owner.stdin as { write(t: string): number }).write('put live/1\n'); (owner.stdin as { flush(): void }).flush();
    await reader.read();
    owner.kill('SIGKILL'); await owner.exited;
    const killed = physicalCopy(root);
    expect((await failure(verifyRustStoreDir(killed, addon))).code).toBe('rust_store_unreadable');

    const clean = physicalCopy((await (async () => { const r = fresh('clean'); makeHome(r); await seedBrain(addon, r); return r; })()));
    const format = JSON.parse(readFileSync(join(clean, 'FORMAT'), 'utf8'));
    writeFileSync(join(clean, 'FORMAT'), JSON.stringify({ ...format, format_version: 999 }));
    expect(await failure(verifyRustStoreDir(clean, addon))).toMatchObject({ code: 'rust_store_unreadable', reason: 'format_unknown' });
    writeFileSync(join(clean, 'FORMAT'), JSON.stringify(format));
    const bytes = readFileSync(join(clean, 'records.redb'));
    for (let at = bytes.length - 6000; at < bytes.length - 100; at += 97) bytes[at] = bytes[at]! ^ 0xff;
    writeFileSync(join(clean, 'records.redb'), bytes);
    expect(await verifyRustStoreDir(clean, addon)).toMatchObject({ verdict: 'integrity', integrity: 'store_corrupt' });
    // A copy with no FORMAT file is not the runbook's layout: the report says so.
    rmSync(join(clean, 'FORMAT'));
    expect(await verifyRustStoreDir(clean, addon)).toMatchObject({ format_file_version: null });
  }, 60_000);
});
