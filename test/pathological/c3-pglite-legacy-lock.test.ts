/**
 * GBRA-130 C-3: a legacy `<data-dir>/.gbrain-lock/` left by a crashed
 * pre-kernel gbrain, whose metadata is torn or missing or (on Linux) carries
 * no matching pid_ns+boot_id, used to make every first kernel-v1 acquisition
 * refuse a retryable `pglite_busy` forever; the only exit was deleting the
 * directory by hand.
 *
 * PGLite-only by nature: the lock guards a PGLite data directory, so there is
 * no Postgres arm.
 *
 * Protects: the refusal says why (`pglite_busy` reason
 * `legacy_owner_unverified`, not retryable, class consent, exit 3, fix.next
 * ask_user with the read-only preview); `gbrain pglite-repair --legacy-lock`
 * previews the advisory evidence and plan hash, and the approved apply moves
 * the legacy dir aside, writes the kernel-v1 marker and lets a normal open
 * succeed with every page unchanged. A live holder, a network filesystem and
 * a lock that changed after the preview are still refused.
 * Fails when: the legacy branch goes back to a generic retryable busy, the
 * apply removes a lock a live process holds, or the apply runs on a lock
 * other than the one previewed.
 * Why new: test/pglite-lock.test.ts pins only that ambiguous legacy ownership
 * is refused; nothing covered the exit.
 * Review fixes (F4-F6): a holder that appears while the consent prompt
 * waits is refused after consent (re-inspected, plan hash re-compared); the
 * emitted undo restores the exact prior ownership marker bytes, so an empty or
 * torn marker brings the original refusal back; a filesystem whose locality
 * cannot be read (non-Linux, a failing statfs, an unrecognised type) refuses
 * `filesystem_unverified` instead of passing as local.
 * Seams: the consent prompt (`consentEnv.readLine`) and the host probes
 * (`probe.platform` / `probe.statfs`) of runLegacyLockRepair.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, releaseLock, PgliteBusyError } from '../../src/core/pglite-lock.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPgliteRepair } from '../../src/commands/pglite-repair.ts';
import { runLegacyLockRepair } from '../../src/commands/pglite-repair-legacy-lock.ts';
import { _resetCliExitVerdictForTests } from '../../src/core/cli-force-exit.ts';
import type { ConsentEnv } from '../../src/core/consent.ts';
import type { LegacyLockProbe } from '../../src/core/pglite-legacy-lock.ts';
import { deadPid } from '../helpers/dead-pid.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, renderFix, snapshotItems } from './harness.ts';

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
function temporary(): string { const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-c3-'))); roots.push(root); return root; }
afterEach(async () => {
  _resetCliExitVerdictForTests(); process.exitCode = 0;
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill(9); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type LegacyMode = 'corrupt' | 'missing' | 'dead pid without markers';
const MODES: LegacyMode[] = process.platform === 'linux' ? ['corrupt', 'missing', 'dead pid without markers'] : ['corrupt', 'missing'];

/** A crashed pre-kernel holder: the legacy dir with torn, absent or namespace-less metadata, and no kernel-v1 marker. */
function plantLegacyLock(dataDir: string, mode: LegacyMode | { pid: number }): string {
  const dir = join(dataDir, '.gbrain-lock');
  mkdirSync(dir, { recursive: true });
  rmSync(`${dataDir}.gbrain-owner.json`, { force: true });
  if (mode === 'corrupt') writeFileSync(join(dir, 'lock'), '{corrupt');
  else if (mode === 'dead pid without markers') writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: deadPid(), acquired_at: 1, command: 'gbrain serve' }));
  else if (typeof mode === 'object') writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: mode.pid, acquired_at: 1, command: 'gbrain sync' }));
  return dir;
}

async function refusalOf(dataDir: string): Promise<PgliteBusyError & { fix?: unknown }> {
  let thrown: unknown;
  try { await releaseLock(await acquireLock(dataDir, { timeoutMs: 50 })); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(PgliteBusyError);
  return thrown as PgliteBusyError & { fix?: unknown };
}

async function repair(args: string[], run: () => Promise<number> = () => runPgliteRepair(args)): Promise<{ code: number; json: Record<string, any> }> {
  const logs: string[] = [];
  const log = console.log, err = console.error, write = process.stderr.write;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  console.error = () => {};
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let code: number;
  try { code = await run(); } finally { console.log = log; console.error = err; process.stderr.write = write; }
  const line = [...logs].reverse().find(l => l.trim().startsWith('{'));
  expect({ args, line: line ? 'json' : logs.join('\n') }).toEqual({ args, line: 'json' });
  return { code, json: JSON.parse(line!) };
}
const preview = (dataDir: string) => repair(['--legacy-lock', '--path', dataDir, '--dry-run', '--json']);
const apply = (dataDir: string, hash: string) => repair(['--legacy-lock', '--path', dataDir, '--yes', '--expect', hash, '--json']);
/** The command with its seams: an interactive prompt answered by `readLine`, and injected host probes. */
function repairWith(dataDir: string, opts: { dryRun?: boolean; expect?: string; consentEnv?: ConsentEnv; probe?: LegacyLockProbe }) {
  const args = ['--legacy-lock', '--path', dataDir, ...(opts.expect ? ['--yes', '--expect', opts.expect] : []), '--json'];
  return repair(args, () => runLegacyLockRepair(dataDir, { dryRun: opts.dryRun ?? false, json: true, args, consentEnv: opts.consentEnv, probe: opts.probe }));
}
const removedDirs = (root: string) => readdirSync(root).filter(n => n.includes('.legacy-lock-removed-'));

/** Real `/sbin/mount` output from a macOS 15 arm64 host, plus synthetic network lines. */
const MAC_MOUNT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  '/dev/disk4s1 on /Volumes/Capy 0.4.4-arm64 (hfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by garrytan)',
].join('\n');
const SMB_LINE = '//alice-example@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by alice-example)';
const NFS_LINE = 'nas-example:/export/brain on /Volumes/brain (nfs, nodev, nosuid, mounted by alice-example)';
/** A darwin probe whose `df -P` puts the data dir on `mountPoint` and whose `mount` adds `extraLine`. */
function macProbe(mountPoint: string, extraLine: string | null): LegacyLockProbe {
  const df = `Filesystem   512-blocks       Used  Available Capacity  Mounted on\n/dev/disk3s5 3896910480 1518591512 2313784664    40%    ${mountPoint}\n`;
  return { platform: 'darwin', exec: (file: string) => {
    if (file === '/bin/df') return df;
    if (file === '/sbin/mount') return `${MAC_MOUNT}${extraLine ? `\n${extraLine}` : ''}\n`;
    throw new Error(`unexpected command ${file}`);
  } };
}

/** A child that keeps a file inside the data dir open, as a live pre-kernel gbrain would. */
async function liveHolder(dataDir: string): Promise<Bun.Subprocess> {
  writeFileSync(join(dataDir, 'PG_VERSION'), '17\n');
  const ready = join(dataDir, '..', 'holder-ready');
  const child = Bun.spawn([process.execPath, '-e',
    `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(join(dataDir, 'PG_VERSION'))},'r');fs.writeFileSync(${JSON.stringify(ready)},'1');process.stdin.on('data',()=>{});process.stdin.resume();setInterval(()=>fd,1e6);`],
  { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  children.push(child);
  const deadline = performance.now() + 5000;
  while (!existsSync(ready) && performance.now() < deadline) await delay(5);
  expect(existsSync(ready)).toBe(true);
  return child;
}

describe('C-3 PGLite legacy lock: an unverifiable pre-kernel owner has an exit', () => {
  for (const mode of MODES) {
    test(`a ${mode} legacy lock refuses legacy_owner_unverified with an ask_user preview, not a retryable busy`, async () => {
      const dataDir = join(temporary(), 'store');
      const dir = plantLegacyLock(dataDir, mode);
      const error = await refusalOf(dataDir);
      expect({ code: error.code, reason: error.reason, retryable: error.retryable })
        .toEqual({ code: 'pglite_busy', reason: 'legacy_owner_unverified', retryable: false });
      expectItemFailure({ key: dataDir, code: error.reason, fix: error.fix },
        { key: dataDir, code: 'legacy_owner_unverified', fix: /^gbrain pglite-repair --legacy-lock --path \S+ --dry-run --json$/ });
      expect(renderFix(error.fix)).toBe(`gbrain pglite-repair --legacy-lock --path ${dataDir} --dry-run --json`);
      expect((error.fix as { ask_user?: boolean }).ask_user).toBe(true);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(`${dataDir}.gbrain-owner.json`)).toBe(false);
    });
  }

  test('the CLI envelope is class consent, exit 3, fix.next ask_user with the preview command', async () => {
    const root = temporary(), dataDir = join(root, 'store'), home = join(root, 'home');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }));
    plantLegacyLock(dataDir, 'corrupt');
    const env = { ...process.env, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '' };
    const run = Bun.spawnSync([process.execPath, '--no-env-file', resolve(import.meta.dir, '../../src/cli.ts'), 'stats', '--json'], { env, stdout: 'pipe', stderr: 'pipe' });
    const out = run.stdout.toString();
    const envelope = JSON.parse(out.slice(out.indexOf('{')));
    expect({ exit: run.exitCode, code: envelope.code, reason: envelope.reason, class: envelope.class, retryable: envelope.retryable, next: envelope.fix?.next, command: envelope.fix?.command })
      .toEqual({ exit: 3, code: 'pglite_busy', reason: 'legacy_owner_unverified', class: 'consent', retryable: false, next: 'ask_user',
        command: `gbrain pglite-repair --legacy-lock --path ${dataDir} --dry-run --json` });
    expect(typeof envelope.fix.user_message).toBe('string');
  }, 60_000);

  test('a network filesystem type is recognised so apply refuses there', async () => {
    const { networkFilesystemName } = await import('../../src/core/pglite-legacy-lock.ts');
    expect([0x6969, 0xff534d42, 0xfe534d42, 0x517b, 0x01021997, 0xef53, 0x01021994].map(networkFilesystemName))
      .toEqual(['nfs', 'cifs', 'smb2', 'smb', '9p', null, null]);
  });
});

describe('C-3 pglite-repair --legacy-lock: preview first, then the approved removal', () => {
  const brainRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-c3-brain-')));
  const brainDir = join(brainRoot, 'store');
  let engine: PGLiteEngine;
  let reopened: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    reopened = new PGLiteEngine();
    await engine.connect({ database_path: brainDir });
    await engine.initSchema();
    for (const slug of ['notes/alice-example', 'notes/acme-example', 'notes/fund-a']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}` }, { sourceId: 'default' });
    }
  }, 120_000);
  afterAll(async () => {
    await engine.disconnect();
    await reopened.disconnect();
    rmSync(brainRoot, { recursive: true, force: true });
  });

  test('preview names advisory evidence; apply clears the lock, a normal open succeeds and nothing else changed', async () => {
    const before = await snapshotItems(engine, 'default');
    await engine.disconnect();
    const files = readdirSync(brainDir).filter(n => n !== '.gbrain-lock').sort();
    const dir = plantLegacyLock(brainDir, 'corrupt');
    expect((await refusalOf(brainDir)).reason).toBe('legacy_owner_unverified');

    await withEnv({ GBRAIN_HOME: join(brainRoot, 'home') }, async () => {
      const shown = await preview(brainDir);
      expect(shown.code).toBe(0);
      expect({ action: shown.json.action, verdict: shown.json.legacy_lock?.verdict, reason: shown.json.legacy_lock?.reason, removable: shown.json.removable })
        .toEqual({ action: 'dry-run', verdict: 'unverified', reason: 'metadata_unreadable', removable: true });
      expect(shown.json.evidence.advisory).toBe(true);
      expect(shown.json.evidence.scope).toMatch(/only this host and PID namespace/);
      expect(shown.json.evidence.fd_scan.holders).toEqual([]);
      expect(typeof shown.json.plan_hash).toBe('string');
      expect(shown.json.apply_argv).toEqual(['gbrain', 'pglite-repair', '--legacy-lock', '--path', brainDir, '--yes', '--expect', shown.json.plan_hash]);
      expect(existsSync(dir)).toBe(true);

      const done = await apply(brainDir, shown.json.plan_hash);
      expect({ code: done.code, action: done.json.action }).toEqual({ code: 0, action: 'removed' });
      expect(existsSync(dir)).toBe(false);
      expect(readFileSync(join(done.json.moved_to, '.gbrain-lock', 'lock'), 'utf8')).toBe('{corrupt');
      expect(JSON.parse(readFileSync(`${brainDir}.gbrain-owner.json`, 'utf8')).protocol).toBe('kernel-v1');
      expect(JSON.parse(readFileSync(join(done.json.moved_to, 'receipt.json'), 'utf8')).plan_hash).toBe(shown.json.plan_hash);
      expect(done.json.restore_command).toContain(done.json.moved_to);
    });

    expect(readdirSync(brainDir).sort()).toEqual(files);
    await expectUnitNotAborted(() => reopened.connect({ database_path: brainDir }));
    expectOthersUnchanged(before, await snapshotItems(reopened, 'default'));
    await reopened.disconnect();
  }, 120_000);
});

describe('C-3 pglite-repair --legacy-lock refusals', () => {
  test('a live holder is still refused: the preview names it and apply removes nothing', async () => {
    const root = temporary(), dataDir = join(root, 'store');
    mkdirSync(dataDir, { recursive: true });
    const child = await liveHolder(dataDir);
    const dir = plantLegacyLock(dataDir, { pid: child.pid });
    if (process.platform === 'linux') expect((await refusalOf(dataDir)).reason).toBe('legacy_owner_unverified');
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
      const shown = await preview(dataDir);
      expect({ alive: shown.json.evidence.pid_alive, removable: shown.json.removable, refusal: shown.json.refusal?.reason })
        .toEqual({ alive: true, removable: false, refusal: 'live_holder' });
      if (process.platform === 'linux') expect(shown.json.evidence.fd_scan.holders.map((h: { pid: number }) => h.pid)).toContain(child.pid);
      const refused = await apply(dataDir, shown.json.plan_hash);
      expect({ code: refused.code, error: refused.json.code, reason: refused.json.reason })
        .toEqual({ code: 1, error: 'legacy_lock_removal_refused', reason: 'live_holder' });
      expect(refused.json.fix?.command).toBe(`gbrain pglite-repair --legacy-lock --path ${dataDir} --dry-run --json`);
    });
    expect(readFileSync(join(dir, 'lock'), 'utf8')).toContain(String(child.pid));
    expect(existsSync(`${dataDir}.gbrain-owner.json`)).toBe(false);
  }, 30_000);

  test('a matching-namespace live legacy holder keeps the plain busy refusal', async () => {
    if (process.platform !== 'linux') return;
    const root = temporary(), dataDir = join(root, 'store');
    mkdirSync(dataDir, { recursive: true });
    const child = await liveHolder(dataDir);
    const dir = join(dataDir, '.gbrain-lock');
    mkdirSync(dir);
    writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: child.pid, acquired_at: 1, pid_ns: readlinkSync('/proc/self/ns/pid'),
      boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }));
    const error = await refusalOf(dataDir);
    expect({ reason: error.reason, retryable: error.retryable }).toEqual({ reason: 'timeout', retryable: true });
    expect(existsSync(dir)).toBe(true);
  }, 30_000);

  test('a lock that changed between preview and apply refuses preview_changed and removes nothing', async () => {
    const root = temporary(), dataDir = join(root, 'store');
    const dir = plantLegacyLock(dataDir, 'corrupt');
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
      const shown = await preview(dataDir);
      writeFileSync(join(dir, 'lock'), '{also corrupt');
      const refused = await apply(dataDir, shown.json.plan_hash);
      expect({ code: refused.code, error: refused.json.code }).toEqual({ code: 1, error: 'preview_changed' });
      expect(refused.json.fix?.command).toBe(`gbrain pglite-repair --legacy-lock --path ${dataDir} --dry-run --json`);
    });
    expect(readFileSync(join(dir, 'lock'), 'utf8')).toBe('{also corrupt');
    expect(existsSync(`${dataDir}.gbrain-owner.json`)).toBe(false);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});

describe('C-3 pglite-repair --legacy-lock: review fixes F4-F6', () => {
  test('F4: a pre-kernel holder that appears while the consent prompt waits is refused after consent and the lock is untouched', async () => {
    if (process.platform !== 'linux') return;
    const root = temporary(), dataDir = join(root, 'store');
    const dir = plantLegacyLock(dataDir, 'corrupt');
    let holder: Bun.Subprocess | undefined;
    const consentEnv: ConsentEnv = { interactive: true, readLine: async () => {
      holder = await liveHolder(dataDir);
      writeFileSync(join(dir, 'lock'), JSON.stringify({ pid: holder.pid, acquired_at: Date.now(), command: 'gbrain sync' }));
      return { kind: 'line', text: 'y' };
    } };
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
      const refused = await repairWith(dataDir, { consentEnv });
      expect(holder).toBeDefined();
      expect({ code: refused.code, error: refused.json.code, reason: refused.json.reason, action: refused.json.action })
        .toEqual({ code: 1, error: 'legacy_lock_removal_refused', reason: 'live_holder', action: undefined });
      expect(refused.json.fix?.command).toBe(`gbrain pglite-repair --legacy-lock --path ${dataDir} --dry-run --json`);
    });
    expect(readFileSync(join(dir, 'lock'), 'utf8')).toContain(String(holder!.pid));
    expect(existsSync(`${dataDir}.gbrain-owner.json`)).toBe(false);
    expect(removedDirs(root)).toEqual([]);
  }, 30_000);

  test('F4: a lock that changes while the consent prompt waits refuses preview_changed after consent and removes nothing', async () => {
    const root = temporary(), dataDir = join(root, 'store');
    const dir = plantLegacyLock(dataDir, 'corrupt');
    let asked = 0;
    const consentEnv: ConsentEnv = { interactive: true, readLine: async () => {
      asked++;
      writeFileSync(join(dir, 'lock'), '{torn by a pre-kernel writer');
      return { kind: 'line', text: 'y' };
    } };
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
      const refused = await repairWith(dataDir, { consentEnv });
      expect({ asked, code: refused.code, error: refused.json.code }).toEqual({ asked: 1, code: 1, error: 'preview_changed' });
      expect(refused.json.fix?.command).toBe(`gbrain pglite-repair --legacy-lock --path ${dataDir} --dry-run --json`);
    });
    expect(readFileSync(join(dir, 'lock'), 'utf8')).toBe('{torn by a pre-kernel writer');
    expect(existsSync(`${dataDir}.gbrain-owner.json`)).toBe(false);
    expect(removedDirs(root)).toEqual([]);
  });

  const PRIOR_MARKERS: Array<[string, string | null]> = [['an empty', ''], ['a torn', '{"protocol":"kern'], ['no', null]];
  for (const [label, prior] of PRIOR_MARKERS) {
    test(`F5: with ${label} prior ownership marker, the emitted undo brings back the original refusal`, async () => {
      const root = temporary(), dataDir = join(root, 'store'), marker = `${dataDir}.gbrain-owner.json`;
      plantLegacyLock(dataDir, 'corrupt');
      if (prior !== null) writeFileSync(marker, prior);
      expect((await refusalOf(dataDir)).reason).toBe('legacy_owner_unverified');
      await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
        const shown = await preview(dataDir);
        expect({ verdict: shown.json.legacy_lock?.verdict, reason: shown.json.legacy_lock?.reason, removable: shown.json.removable })
          .toEqual({ verdict: 'unverified', reason: 'metadata_unreadable', removable: true });
        const done = await apply(dataDir, shown.json.plan_hash);
        expect({ code: done.code, action: done.json.action }).toEqual({ code: 0, action: 'removed' });
        expect(JSON.parse(readFileSync(marker, 'utf8')).protocol).toBe('kernel-v1');

        const undo = Bun.spawnSync(['sh', '-c', done.json.restore_command], { stdout: 'pipe', stderr: 'pipe' });
        expect({ exit: undo.exitCode, stderr: undo.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
        expect(prior === null ? existsSync(marker) : readFileSync(marker, 'utf8')).toBe(prior === null ? false : prior);
        const again = await preview(dataDir);
        expect({ legacy: again.json.legacy_lock?.legacy, verdict: again.json.legacy_lock?.verdict, reason: again.json.legacy_lock?.reason })
          .toEqual({ legacy: true, verdict: 'unverified', reason: 'metadata_unreadable' });
        expect(again.json.plan_hash).toBe(shown.json.plan_hash);
      });
      expect(readFileSync(join(dataDir, '.gbrain-lock', 'lock'), 'utf8')).toBe('{corrupt');
      expect((await refusalOf(dataDir)).reason).toBe('legacy_owner_unverified');
    });
  }

  const UNKNOWN_LOCALITY: Array<[string, LegacyLockProbe]> = [
    ['a platform gbrain cannot probe', { platform: 'win32' }],
    ['a macOS smbfs mount', macProbe('/Volumes/share', SMB_LINE)],
    ['a macOS nfs mount', macProbe('/Volumes/brain', NFS_LINE)],
    ['a macOS autofs home', macProbe('/System/Volumes/Data/home', 'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)')],
    ['a macOS apfs mount without the local flag', macProbe('/Volumes/remote', '/dev/disk9s1 on /Volumes/remote (apfs, nodev, nosuid)')],
    ['a macOS local mount of a type gbrain does not know', macProbe('/dev', 'devfs on /dev (devfs, local, nobrowse)')],
    ['a macOS mount point with no mount line', macProbe('/Volumes/gone', null)],
    ['a macOS df output that does not parse', { platform: 'darwin', exec: (file: string) => file === '/bin/df' ? 'df: unexpected\n' : MAC_MOUNT }],
    ['a macOS probe command that fails', { platform: 'darwin', exec: () => { throw new Error('spawn /bin/df ETIMEDOUT'); } }],
    ['a statfs probe that fails', { platform: 'linux', statfs: () => { throw Object.assign(new Error('EIO: i/o error, statfs'), { code: 'EIO' }); } }],
    ['an unrecognised filesystem type', { platform: 'linux', statfs: () => ({ type: 0x12345678 }) }],
  ];
  for (const [label, probe] of UNKNOWN_LOCALITY) {
    test(`F6: ${label} leaves locality unknown, so preview and the approved apply refuse filesystem_unverified`, async () => {
      const root = temporary(), dataDir = join(root, 'store');
      const dir = plantLegacyLock(dataDir, 'corrupt');
      await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
        const shown = await repairWith(dataDir, { dryRun: true, probe });
        expect({ network: shown.json.evidence?.filesystem?.network, removable: shown.json.removable, refusal: shown.json.refusal?.reason, apply: shown.json.apply_argv })
          .toEqual({ network: null, removable: false, refusal: 'filesystem_unverified', apply: undefined });
        const refused = await repairWith(dataDir, { expect: shown.json.plan_hash, probe });
        expect({ code: refused.code, error: refused.json.code, reason: refused.json.reason })
          .toEqual({ code: 1, error: 'legacy_lock_removal_refused', reason: 'filesystem_unverified' });
        expect(refused.json.message).toMatch(/could not confirm that the data dir is on a local filesystem/);
      });
      expect(readFileSync(join(dir, 'lock'), 'utf8')).toBe('{corrupt');
      expect(existsSync(`${dataDir}.gbrain-owner.json`)).toBe(false);
      expect(removedDirs(root)).toEqual([]);
    });
  }

  const MAC_LOCAL: Array<[string, string, string]> = [
    ['the apfs data volume', '/System/Volumes/Data', 'apfs'],
    ['an hfs volume whose mount point has spaces', '/Volumes/Capy 0.4.4-arm64', 'hfs'],
  ];
  for (const [label, mountPoint, type] of MAC_LOCAL) {
    test(`F6 macOS: ${label} mounted local is removable, and the approved apply moves the lock`, async () => {
      const root = temporary(), dataDir = join(root, 'store');
      const dir = plantLegacyLock(dataDir, 'corrupt');
      const calls: Array<[string, string[]]> = [];
      const base = macProbe(mountPoint, null);
      const probe: LegacyLockProbe = { platform: 'darwin', exec: (file, args) => { calls.push([file, [...args]]); return base.exec!(file, args); } };
      await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
        const shown = await repairWith(dataDir, { dryRun: true, probe });
        expect({ type: shown.json.evidence?.filesystem?.type, network: shown.json.evidence?.filesystem?.network, removable: shown.json.removable, refusal: shown.json.refusal })
          .toEqual({ type, network: false, removable: true, refusal: null });
        expect(calls.slice(0, 2)).toEqual([['/bin/df', ['-P', dataDir]], ['/sbin/mount', []]]);
        const done = await repairWith(dataDir, { expect: shown.json.plan_hash, probe });
        expect({ code: done.code, action: done.json.action }).toEqual({ code: 0, action: 'removed' });
      });
      expect(existsSync(dir)).toBe(false);
    });
  }

  test('F6: a recognised local Linux filesystem stays removable', async () => {
    const root = temporary(), dataDir = join(root, 'store');
    plantLegacyLock(dataDir, 'corrupt');
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
      const shown = await repairWith(dataDir, { dryRun: true, probe: { platform: 'linux', statfs: () => ({ type: 0xef53 }) } });
      expect({ type: shown.json.evidence?.filesystem?.type, network: shown.json.evidence?.filesystem?.network, removable: shown.json.removable })
        .toEqual({ type: 'ext4', network: false, removable: true });
    });
  });
});
