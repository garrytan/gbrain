/**
 * The `gbrain backup` command on a Rust brain: create and restore through the CLI, the one JSON envelope and the
 * non-TTY stderr of a refusal, and `verify-store`. Serial: it sets GBRAIN_HOME and the addon path.
 * Needs the addon (`bun run rust:build`); GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBackupCli } from '../src/commands/backup.ts';
import { _resetCliOptionsForTest } from '../src/core/cli-options.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { brainDir, forgeArchive, makeHome, queueWrite, seedBrain } from './helpers/rust-backup-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

/** Runs the CLI with stdout (console.log and fd 1) and stderr captured. */
async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const out: string[] = []; const err: string[] = [];
  const realWriteSync = fs.writeSync;
  const fdSpy = spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: Buffer, off = 0, len?: number) => {
    if (fd !== 1) return (realWriteSync as (...a: unknown[]) => number)(fd, buf, off, len);
    const end = len === undefined ? buf.length : off + len;
    out.push(Buffer.from(buf).subarray(off, end).toString('utf8'));
    return end - off;
  }) as never);
  const log = console.log; const origStderr = process.stderr.write;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ') + '\n'); };
  (process.stderr as { write: unknown }).write = (chunk: unknown) => { err.push(String(chunk)); return true; };
  try {
    const result = await runBackupCli(args, async () => { throw new Error('backup create and restore never connect through the thunk'); });
    return { exitCode: result.exitCode, stdout: out.join(''), stderr: err.join('') };
  } finally { console.log = log; (process.stderr as { write: unknown }).write = origStderr; fdSpy.mockRestore(); }
}

let temporary: string;
let addon: RustAddon;
const saved = { home: process.env.GBRAIN_HOME, addon: process.env.GBRAIN_RUST_ENGINE_ADDON };
beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'gbrain-rust-cli-'));
  if (HAVE_ADDON) { process.env.GBRAIN_RUST_ENGINE_ADDON = BUILT; addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }); }
});
afterEach(() => { _resetCliOptionsForTest(); });
afterAll(() => {
  for (const [key, value] of [['GBRAIN_HOME', saved.home], ['GBRAIN_RUST_ENGINE_ADDON', saved.addon]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(temporary, { recursive: true, force: true });
});

(HAVE_ADDON ? describe : describe.skip)('gbrain backup on a Rust brain', () => {
  test('create then restore: human output names what was revoked and the fix; --json is one document', async () => {
    const root = join(temporary, 'home'); makeHome(root); await seedBrain(addon, root);
    process.env.GBRAIN_HOME = root;
    const archive = join(temporary, 'a.gbrain-backup');
    const created = await cli(['create', '--output', archive, '--json']);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout.trim())).toMatchObject({ ok: true, archive, restore_blockers: [], manifest: { kind: 'gbrain-rust', format_version: 1 } });
    const human = await cli(['restore', archive, '--into', join(temporary, 'r1')]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('Restored memory:');
    expect(human.stdout).toContain('1 unfinished jobs quarantined');
    expect(human.stdout).toContain('Revoked by this restore: 1 local writer registration(s)');
    expect(human.stdout).toContain('Re-issue access');
    expect(human.stdout).toContain('Brain id changed by this restore:');
    const json = await cli(['restore', archive, '--into', join(temporary, 'r2'), '--json']);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout.trim())).toMatchObject({ ok: true, quarantined_jobs: 1, revoked: { oauth_clients: ['c1'] } });
    const again = await cli(['restore', archive, '--into', join(temporary, 'r2'), '--json']);
    expect(again.exitCode).toBe(1);
    expect(JSON.parse(again.stdout.trim())).toMatchObject({ ok: false, reason: 'restore_target_exists' });
  }, 120_000);

  test('a refused restore: exit 1, a stable code, reason and docs in one JSON envelope, and a human stderr a person can act on', async () => {
    const root = join(temporary, 'busy'); makeHome(root); await seedBrain(addon, root, queueWrite);
    const archive = join(temporary, 'busy.gbrain-backup');
    await forgeArchive(addon, root, archive);
    const json = await cli(['restore', archive, '--into', join(temporary, 'busy-1'), '--json']);
    expect(json.exitCode).toBe(1);
    const doc = JSON.parse(json.stdout.trim());
    expect(doc).toMatchObject({ ok: false, code: 'restore_step_unsupported', reason: 'restore_step_unsupported', refusal_reason: 'pending_requests' });
    expect(doc.docs).toEndWith('docs/guides/troubleshooting.md#restore-step-unsupported');
    expect(doc.message).toContain('Nothing was published');
    expect(doc.fix.argv).toEqual(['gbrain', 'backup', 'create', '--output', '<NEW_ARCHIVE>']);
    expect(json.stdout.trim().split('\n')).toHaveLength(1);
    const text = await cli(['restore', archive, '--into', join(temporary, 'busy-2')]);
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain('Error [restore_step_unsupported]');
    expect(text.stderr).toContain('restore_target_exists');
    expect(text.stderr).toContain('give --into a new, absent folder');
    expect(text.stdout).toBe('');
  }, 60_000);

  test('verify-store: ok on a stopped brain copy, exit 1 on a directory it cannot read, usage error on a missing argument', async () => {
    const root = join(temporary, 'vs'); makeHome(root); await seedBrain(addon, root);
    const ok = await cli(['verify-store', brainDir(root), '--json']);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout.trim())).toMatchObject({ ok: true, verdict: 'ok', dir: brainDir(root) });
    const human = await cli(['verify-store', brainDir(root)]);
    expect(human.stdout).toContain(': OK');
    expect(human.stdout).toContain('keyword index:');
    expect(human.stdout).toContain('no file in it changed');
    const empty = join(temporary, 'empty'); fs.mkdirSync(empty);
    const bad = await cli(['verify-store', empty, '--json']);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stdout.trim())).toMatchObject({ ok: false });
    const usage = await cli(['verify-store']);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain('gbrain backup verify-store /absolute/copied/brain.rust');
  }, 60_000);
});
