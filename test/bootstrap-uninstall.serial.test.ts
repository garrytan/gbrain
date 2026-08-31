/**
 * `bootstrap uninstall` confinement tests [G2, S3#5, A2, CX2-12].
 *
 * Pins the ownership + confinement contract: receipt-keyed removal (exactly
 * created_paths, containment-checked), foreign files + global config survive,
 * refuse-without-receipt, the deleteBrain gate on brain_created_by_bootstrap,
 * the GBRAIN_HOME guard, symlinked-home rejection (lstat), and the read-only
 * live-serve lock probe (the engine is never opened).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { permsEnforced } from './helpers/fs-perms.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeLivePgliteHolder,
  resolveBrainDataDir,
  uninstallWorkspace,
} from '../src/core/bootstrap/uninstall.ts';
import { BootstrapError } from '../src/core/bootstrap/lock.ts';
import { readReceipt, writeReceipt, type InstallReceipt } from '../src/core/bootstrap/format.ts';

let ws: string;
let home: string;
let savedGbrainHome: string | undefined;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'gbrain-uninstall-ws-'));
  home = mkdtempSync(join(tmpdir(), 'gbrain-uninstall-home-'));
  savedGbrainHome = process.env.GBRAIN_HOME;
  delete process.env.GBRAIN_HOME;
});

afterEach(() => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  rmSync(ws, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A realistic gbrain home: global config, a brain, clones, foreign files,
 * bootstrap telemetry, and one bootstrap-created path (hook wiring). */
function seedHome(receiptOverrides: Partial<InstallReceipt> = {}): { hooksDir: string; receipt: InstallReceipt } {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }), 'utf8');
  mkdirSync(join(home, 'brain.pglite'), { recursive: true });
  writeFileSync(join(home, 'brain.pglite', 'PG_VERSION'), '16', 'utf8');
  mkdirSync(join(home, 'clones', 'other'), { recursive: true });
  writeFileSync(join(home, 'clones', 'other', 'keep.txt'), 'foreign clone', 'utf8');
  writeFileSync(join(home, 'foreign.txt'), 'not bootstrap-created', 'utf8');
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeFileSync(join(home, 'bootstrap', 'install.jsonl'), '{"phase":"render","outcome":"ok"}\n', 'utf8');
  const hooksDir = join(home, 'integrations', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'heartbeat.jsonl'), '{}\n', 'utf8');
  const receipt: InstallReceipt = {
    receipt_version: 1,
    workspace_dir: ws,
    source_id: 'workspace',
    agent_name: 'Test Agent',
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: '0.0.0-test',
    brain_created_by_bootstrap: false,
    created_paths: [hooksDir],
    registrations: [{ host: 'claude-code', scope: 'project', detail: 'mcp gbrain' }],
    ...receiptOverrides,
  };
  writeReceipt(home, receipt);
  return { hooksDir, receipt };
}

async function expectRefusal(p: Promise<unknown>, code: string): Promise<BootstrapError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BootstrapError);
    expect((e as BootstrapError).code).toBe(code as BootstrapError['code']);
    return e as BootstrapError;
  }
  throw new Error(`expected ${code} refusal, got success`);
}

describe('uninstallWorkspace', () => {
  test('removes exactly receipt.created_paths; config.json, clones, foreign files, and the brain survive', async () => {
    const { hooksDir } = seedHome();
    const result = await uninstallWorkspace(ws, { gbrainHomeDir: home });

    expect(result.removed_paths).toEqual([hooksDir]);
    expect(existsSync(hooksDir)).toBe(false);
    // Everything bootstrap did NOT create survives [CX2-12].
    expect(existsSync(join(home, 'config.json'))).toBe(true);
    expect(existsSync(join(home, 'clones', 'other', 'keep.txt'))).toBe(true);
    expect(existsSync(join(home, 'foreign.txt'))).toBe(true);
    expect(existsSync(join(home, 'brain.pglite'))).toBe(true);
    // Telemetry survives a plain uninstall; only the receipt is consumed.
    expect(existsSync(join(home, 'bootstrap', 'install.jsonl'))).toBe(true);
    expect(readReceipt(home)).toBeNull();
    expect(result.receipt_removed).toBe(true);
    expect(result.brain_deleted).toBe(false);
    // Host registrations come back as structured removal requests.
    expect(result.registration_removals).toEqual([{ host: 'claude-code', scope: 'project', detail: 'mcp gbrain' }]);
  });

  test('no receipt → NO_RECEIPT refusal ("nothing bootstrap-created on this machine")', async () => {
    // Home exists but was never bootstrapped.
    writeFileSync(join(home, 'config.json'), '{}', 'utf8');
    const err = await expectRefusal(uninstallWorkspace(ws, { gbrainHomeDir: home }), 'NO_RECEIPT');
    expect(err.message).toContain('nothing bootstrap-created');
  });

  test('missing home entirely → NO_RECEIPT refusal', async () => {
    await expectRefusal(uninstallWorkspace(ws, { gbrainHomeDir: join(home, 'nope') }), 'NO_RECEIPT');
  });

  test('receipt for a different workspace → RECEIPT_MISMATCH, nothing removed', async () => {
    const { hooksDir } = seedHome({ workspace_dir: join(tmpdir(), 'some-other-ws') });
    await expectRefusal(uninstallWorkspace(ws, { gbrainHomeDir: home }), 'RECEIPT_MISMATCH');
    expect(existsSync(hooksDir)).toBe(true);
  });

  test('deleteBrain on brain_created_by_bootstrap:false → DELETE_BRAIN_REFUSED, nothing removed [G2]', async () => {
    const { hooksDir } = seedHome({ brain_created_by_bootstrap: false });
    await expectRefusal(uninstallWorkspace(ws, { gbrainHomeDir: home, deleteBrain: true }), 'DELETE_BRAIN_REFUSED');
    // The gate fires BEFORE any removal.
    expect(existsSync(hooksDir)).toBe(true);
    expect(readReceipt(home)).not.toBeNull();
  });

  test('deleteBrain + confirm(true): brain + bootstrap/ + receipt go; global config + clones survive [CX2-12]', async () => {
    seedHome({ brain_created_by_bootstrap: true });
    const messages: string[] = [];
    const result = await uninstallWorkspace(ws, {
      gbrainHomeDir: home,
      deleteBrain: true,
      confirm: async (msg) => {
        messages.push(msg);
        return true;
      },
    });
    expect(result.brain_deleted).toBe(true);
    expect(existsSync(join(home, 'brain.pglite'))).toBe(false);
    expect(existsSync(join(home, 'bootstrap'))).toBe(false);
    // NEVER wholesale: the home itself and everything foreign survives.
    expect(existsSync(join(home, 'config.json'))).toBe(true);
    expect(existsSync(join(home, 'clones', 'other', 'keep.txt'))).toBe(true);
    // The confirm message enumerated what we know without opening an engine.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('workspace');
    expect(messages[0]).toContain(join(home, 'brain.pglite'));
    // Facts export offered first — facts are not derived state.
    expect(result.steps.map((s) => s.kind)).toContain('facts_export_offer');
  });

  test('deleteBrain + confirm(false): brain survives, rest of the uninstall proceeds', async () => {
    const { hooksDir } = seedHome({ brain_created_by_bootstrap: true });
    const result = await uninstallWorkspace(ws, {
      gbrainHomeDir: home,
      deleteBrain: true,
      confirm: async () => false,
    });
    expect(result.brain_deleted).toBe(false);
    expect(existsSync(join(home, 'brain.pglite'))).toBe(true);
    expect(existsSync(hooksDir)).toBe(false); // created_paths still removed
  });

  // skipIf: simulates rm failure via permission bits — unrunnable on hosts
  // that don't enforce them (FUSE/overlay sandboxes, root).
  test.skipIf(!permsEnforced())('deleteBrain rm FAILURE: brain_deleted false, failure reason surfaced, receipt + telemetry kept (retry possible)', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes
    seedHome({ brain_created_by_bootstrap: true });
    // A read-only subdir makes rmSync fail mid-removal (EACCES unlinking inside).
    const protectedDir = join(home, 'brain.pglite', 'protected');
    mkdirSync(protectedDir, { recursive: true });
    writeFileSync(join(protectedDir, 'file.txt'), 'x', 'utf8');
    chmodSync(protectedDir, 0o555);
    try {
      const result = await uninstallWorkspace(ws, {
        gbrainHomeDir: home,
        deleteBrain: true,
        confirm: async () => true,
      });
      // brain_deleted only after rm succeeded AND the dir is gone — neither here.
      expect(result.brain_deleted).toBe(false);
      const failure = result.skipped_paths.find((s) => s.path === join(home, 'brain.pglite'));
      expect(failure?.reason).toContain('brain deletion failed');
      // Receipt + bootstrap/ telemetry survive so `uninstall --delete-brain` can retry.
      expect(result.receipt_removed).toBe(false);
      expect(readReceipt(home)).not.toBeNull();
      expect(existsSync(join(home, 'bootstrap', 'install.jsonl'))).toBe(true);
    } finally {
      chmodSync(protectedDir, 0o755);
    }
  });

  test('deleteBrain containment FAILURE (data dir symlinks out): refused with reason, target survives, receipt kept', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-uninstall-braintarget-'));
    try {
      writeFileSync(join(outside, 'victim.txt'), 'precious', 'utf8');
      seedHome({ brain_created_by_bootstrap: true });
      // Replace the real data dir with a symlink escaping the home.
      rmSync(join(home, 'brain.pglite'), { recursive: true, force: true });
      symlinkSync(outside, join(home, 'brain.pglite'));

      const result = await uninstallWorkspace(ws, {
        gbrainHomeDir: home,
        deleteBrain: true,
        confirm: async () => true,
      });
      expect(result.brain_deleted).toBe(false);
      const failure = result.skipped_paths.find((s) => s.reason.includes('brain deletion skipped'));
      expect(failure?.reason).toContain('outside');
      expect(existsSync(join(outside, 'victim.txt'))).toBe(true);
      expect(result.receipt_removed).toBe(false);
      expect(readReceipt(home)).not.toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('deleteBrain without a confirm fn is fail-closed: brain survives', async () => {
    seedHome({ brain_created_by_bootstrap: true });
    const result = await uninstallWorkspace(ws, { gbrainHomeDir: home, deleteBrain: true });
    expect(result.brain_deleted).toBe(false);
    expect(existsSync(join(home, 'brain.pglite'))).toBe(true);
  });

  test('brainStats seam feeds the confirm message (sources + page count)', async () => {
    seedHome({ brain_created_by_bootstrap: true });
    let msg = '';
    await uninstallWorkspace(ws, {
      gbrainHomeDir: home,
      deleteBrain: true,
      brainStats: async () => ({ sources: ['workspace', 'wiki'], pages: 42 }),
      confirm: async (m) => {
        msg = m;
        return false;
      },
    });
    expect(msg).toContain('workspace, wiki');
    expect(msg).toContain('42');
  });

  test('created_path outside home AND workspace → skipped with reason, file survives', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-uninstall-outside-'));
    try {
      const victim = join(outside, 'victim.txt');
      writeFileSync(victim, 'precious', 'utf8');
      const { hooksDir } = seedHome();
      const receipt = readReceipt(home)!;
      writeReceipt(home, { ...receipt, created_paths: [hooksDir, victim] });

      const result = await uninstallWorkspace(ws, { gbrainHomeDir: home });
      expect(result.removed_paths).toEqual([hooksDir]);
      expect(result.skipped_paths).toEqual([{ path: victim, reason: expect.stringContaining('outside') }]);
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('created_path symlinked out of the home → skipped, target survives', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-uninstall-outside-'));
    try {
      const victim = join(outside, 'victim.txt');
      writeFileSync(victim, 'precious', 'utf8');
      seedHome();
      const link = join(home, 'escape-link');
      symlinkSync(victim, link);
      const receipt = readReceipt(home)!;
      writeReceipt(home, { ...receipt, created_paths: [link] });

      const result = await uninstallWorkspace(ws, { gbrainHomeDir: home });
      expect(result.removed_paths).toEqual([]);
      expect(result.skipped_paths[0]?.reason).toContain('outside');
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('absent created_path → skipped as already absent (idempotent re-run)', async () => {
    const { hooksDir } = seedHome();
    rmSync(hooksDir, { recursive: true, force: true });
    const result = await uninstallWorkspace(ws, { gbrainHomeDir: home });
    expect(result.removed_paths).toEqual([]);
    expect(result.skipped_paths).toEqual([{ path: hooksDir, reason: 'already absent' }]);
  });

  test('GBRAIN_HOME set without homeExplicit → HOME_GUARD [S3#5]', async () => {
    seedHome();
    process.env.GBRAIN_HOME = ws;
    const err = await expectRefusal(uninstallWorkspace(ws, { gbrainHomeDir: home }), 'HOME_GUARD');
    expect(err.message).toContain('GBRAIN_HOME');
  });

  test('GBRAIN_HOME + homeExplicit but home outside the workspace → HOME_GUARD', async () => {
    seedHome();
    process.env.GBRAIN_HOME = ws;
    await expectRefusal(uninstallWorkspace(ws, { gbrainHomeDir: home, homeExplicit: true }), 'HOME_GUARD');
  });

  test('GBRAIN_HOME + homeExplicit but missing gbrain-home signature → HOME_GUARD', async () => {
    // Isolated-style home inside the workspace, but with no config.json/brain.
    const isolated = join(ws, '.gbrain');
    mkdirSync(join(isolated, 'bootstrap'), { recursive: true });
    writeReceipt(isolated, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Test Agent',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: '0.0.0-test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
    });
    process.env.GBRAIN_HOME = ws;
    await expectRefusal(uninstallWorkspace(ws, { gbrainHomeDir: isolated, homeExplicit: true }), 'HOME_GUARD');
  });

  test('GBRAIN_HOME + homeExplicit + contained + signature → proceeds', async () => {
    const isolated = join(ws, '.gbrain');
    mkdirSync(join(isolated, 'brain.pglite'), { recursive: true });
    mkdirSync(join(isolated, 'bootstrap'), { recursive: true });
    writeFileSync(join(isolated, 'config.json'), '{"engine":"pglite"}', 'utf8');
    writeReceipt(isolated, {
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Test Agent',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: '0.0.0-test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
    });
    process.env.GBRAIN_HOME = ws;
    const result = await uninstallWorkspace(ws, { gbrainHomeDir: isolated, homeExplicit: true });
    expect(result.receipt_removed).toBe(true);
  });

  test('symlinked home rejected via lstat', async () => {
    seedHome();
    const linkHome = join(mkdtempSync(join(tmpdir(), 'gbrain-uninstall-link-')), 'home-link');
    symlinkSync(home, linkHome);
    try {
      const err = await expectRefusal(uninstallWorkspace(ws, { gbrainHomeDir: linkHome }), 'HOME_GUARD');
      expect(err.message).toContain('symlink');
    } finally {
      rmSync(join(linkHome, '..'), { recursive: true, force: true });
    }
  });

  test('live serve holding the PGLite lock → LIVE_SERVE, "close your agent sessions first"', async () => {
    seedHome();
    const lockDir = join(home, 'brain.pglite', '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({ pid: process.pid, acquired_at: Date.now(), refreshed_at: Date.now(), command: 'serve', subcommand: 'serve' }),
      'utf8',
    );
    const err = await expectRefusal(uninstallWorkspace(ws, { gbrainHomeDir: home }), 'LIVE_SERVE');
    expect(err.message).toContain('close your agent sessions first');
    expect(err.details.pid).toBe(process.pid);
  });

  test('dead holder\'s stale lock does not block uninstall', async () => {
    seedHome();
    const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
    const lockDir = join(home, 'brain.pglite', '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({ pid: proc.pid, acquired_at: Date.now(), command: 'serve', subcommand: 'serve' }),
      'utf8',
    );
    const result = await uninstallWorkspace(ws, { gbrainHomeDir: home });
    expect(result.receipt_removed).toBe(true);
  });
});

describe('probeLivePgliteHolder', () => {
  test('classifies a live non-serve holder as live but not serve', () => {
    const dataDir = join(home, 'brain.pglite');
    mkdirSync(join(dataDir, '.gbrain-lock'), { recursive: true });
    writeFileSync(
      join(dataDir, '.gbrain-lock', 'lock'),
      JSON.stringify({ pid: process.pid, command: 'embed --stale', subcommand: 'embed' }),
      'utf8',
    );
    expect(probeLivePgliteHolder(dataDir)).toEqual({ pid: process.pid, serve: false });
  });

  test('legacy lock without subcommand falls back to command-string parsing', () => {
    const dataDir = join(home, 'brain.pglite');
    mkdirSync(join(dataDir, '.gbrain-lock'), { recursive: true });
    writeFileSync(
      join(dataDir, '.gbrain-lock', 'lock'),
      JSON.stringify({ pid: process.pid, command: 'gbrain serve' }),
      'utf8',
    );
    expect(probeLivePgliteHolder(dataDir)).toEqual({ pid: process.pid, serve: true });
  });

  test('absent or unreadable lock → null', () => {
    expect(probeLivePgliteHolder(join(home, 'brain.pglite'))).toBeNull();
    const dataDir = join(home, 'brain.pglite');
    mkdirSync(join(dataDir, '.gbrain-lock'), { recursive: true });
    writeFileSync(join(dataDir, '.gbrain-lock', 'lock'), 'not json', 'utf8');
    expect(probeLivePgliteHolder(dataDir)).toBeNull();
  });
});

describe('resolveBrainDataDir', () => {
  test('uses config.json database_path when contained in the home', () => {
    mkdirSync(join(home, 'custom.pglite'), { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ database_path: join(home, 'custom.pglite') }), 'utf8');
    expect(resolveBrainDataDir(home)).toBe(join(home, 'custom.pglite'));
  });

  test('falls back to <home>/brain.pglite when database_path escapes the home', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ database_path: '/somewhere/else.pglite' }), 'utf8');
    expect(resolveBrainDataDir(home)).toBe(join(home, 'brain.pglite'));
  });

  test('falls back when config.json is absent', () => {
    expect(resolveBrainDataDir(home)).toBe(join(home, 'brain.pglite'));
  });
});
