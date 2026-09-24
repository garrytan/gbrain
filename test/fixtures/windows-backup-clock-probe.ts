import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectNewBackupPath } from '../../src/core/backup/private-path.ts';

if (process.platform !== 'win32') throw new Error('This diagnostic requires native Windows.');

const owned = mkdtempSync(join(tmpdir(), 'gbrain-backup-clock-probe-'));
const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = readFileSync(join(import.meta.dir, 'windows-backup-dotnet-inspect.ps1'), 'utf8');
const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
const options: ExecFileSyncOptionsWithStringEncoding = { encoding: 'utf8', timeout: 15_000, windowsHide: true, input: Buffer.alloc(0), stdio: ['pipe', 'pipe', 'pipe'] };
const inspect = (path: string) => {
  const result = JSON.parse(execFileSync(executable, args, { ...options, env: { ...process.env, GBRAIN_TEST_ACL_PATH: path } }));
  return typeof result?.user === 'string' && /^S-\d+(?:-\d+)+$/.test(result.user)
    && result.owner === result.user && result.protected === true && Array.isArray(result.rules)
    && JSON.stringify(result.rules.map((rule: { sid: string }) => rule.sid).sort()) === JSON.stringify([...new Set([result.user, 'S-1-5-18'])].sort())
    && result.rules.every((rule: { inherited: boolean; allow: string; rights: number; inheritance: number; propagation: number }) =>
      rule.inherited === false && rule.allow === 'Allow' && rule.rights === 0x1f01ff && rule.inheritance === 3 && rule.propagation === 0);
};
let failed = false;
try {
  const reference = join(owned, 'reference');
  mkdirSync(reference);
  protectNewBackupPath(reference, 'directory');
  if (!inspect(reference)) throw new Error('Initial private-directory verification failed.');
  for (const operation of ['inspection', 'protection'] as const) {
    let trial = 0;
    for (const idleMs of [0, 16_000, 16_000, 0]) {
      trial++;
      const path = operation === 'inspection' ? reference : join(owned, `protection-${trial}`);
      if (operation === 'protection') mkdirSync(path);
      const before = lstatSync(path, { bigint: true });
      const warm = execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Console]::Write('primed')"], options);
      if (warm !== 'primed') throw new Error('Synchronous loop priming failed.');
      const idleStarted = performance.now();
      await Bun.sleep(idleMs);
      const idleObservedMs = Math.round(performance.now() - idleStarted);
      const started = performance.now();
      const wallStarted = Date.now();
      let outcome = 'completed';
      let code: string | null = null;
      let signal: string | null = null;
      let status: number | null = null;
      let stdoutBytes: number | null = null;
      let stderrBytes: number | null = null;
      let validAcl: boolean | null = null;
      try {
        if (operation === 'inspection') validAcl = inspect(path);
        else protectNewBackupPath(path, 'directory');
      } catch (error) {
        outcome = 'failed';
        const value = error as { code?: unknown; signal?: unknown; status?: unknown; stdout?: unknown; stderr?: unknown };
        code = value?.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : value?.code === 'private_backup_path_unavailable' ? 'private_backup_path_unavailable' : 'other';
        signal = value?.signal === 'SIGTERM' || value?.signal === 'SIGKILL' ? value.signal : value?.signal == null ? null : 'other';
        status = typeof value?.status === 'number' && Number.isInteger(value.status) ? value.status : null;
        const bytes = (output: unknown) => typeof output === 'string' ? Buffer.byteLength(output) : output instanceof Uint8Array ? output.byteLength : null;
        stdoutBytes = bytes(value?.stdout);
        stderrBytes = bytes(value?.stderr);
      }
      const elapsedMs = Math.round(performance.now() - started);
      const wallElapsedMs = Date.now() - wallStarted;
      if (operation === 'protection' && outcome === 'completed') {
        try { validAcl = inspect(path); }
        catch { validAcl = false; }
      }
      const after = lstatSync(path, { bigint: true });
      const sameIdentity = before.dev === after.dev && before.ino === after.ino && before.birthtimeNs === after.birthtimeNs;
      const empty = after.isDirectory() && readdirSync(path).length === 0;
      process.stdout.write(`WINDOWS_BACKUP_CLOCK ${JSON.stringify({ operation, trial, idleMs, idleObservedMs, runtime: Bun.version, runtimeRevision: Bun.revision, arch: process.arch,
        outcome, code, signal, status, stdoutBytes, stderrBytes, elapsedMs, wallElapsedMs, validAcl, sameIdentity, empty })}\n`);
      if (outcome !== 'completed' || !validAcl || !sameIdentity || !empty) failed = true;
    }
  }
} catch {
  failed = true;
  process.stderr.write('WINDOWS_BACKUP_CLOCK incomplete experiment\n');
} finally {
  try { rmSync(owned, { recursive: true, force: true }); }
  catch { failed = true; process.stderr.write('WINDOWS_BACKUP_CLOCK cleanup failed\n'); }
}
process.exitCode = failed ? 1 : 0;
