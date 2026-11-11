import { scanDeadline } from './budget.ts';
import { currentStatementDeadline } from '../../core/statement-deadline.ts';

/** #8990: past this many bytes of stdout a local probe is killed and reads as absent (execFile's old maxBuffer). */
export const LOCAL_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * #8979: a local probe's stdout, or null when it fails, outlives its bound or prints more than
 * LOCAL_PROBE_MAX_OUTPUT_BYTES. The bound is `ownTimeoutMs` (5 s by default), clipped to the entry deadline less the
 * report reserve; `entryDeadlineAt` is read when the entry starts. It runs asynchronously and is killed with SIGKILL at
 * its bound (on POSIX its whole process group, so a wrapper's children die too), so a probe that hangs never blocks the
 * event loop or outlives the entry's deadline. A probe the entry deadline cut short marks the entry's scope expired, so
 * its checks report unknown instead of absent. `windowsShell: false` runs the file without cmd.exe on Windows (git takes
 * paths that may hold spaces).
 */
export async function localProbe(
  entryDeadlineAt: number | undefined, file: string, args: string[], { ownTimeoutMs = 5_000, windowsShell = true } = {},
): Promise<string | null> {
  const scope = currentStatementDeadline();
  const ownEnd = Date.now() + ownTimeoutMs;
  const end = scanDeadline({ entryDeadlineAt }, ownTimeoutMs);
  const cutShort = () => { if (scope && end < ownEnd) scope.expired = true; return null; };
  const timeout = end - Date.now();
  if (timeout <= 0) return cutShort();
  const { spawn } = await import('../../core/spawn.ts');
  const posix = process.platform !== 'win32';
  return new Promise((resolve) => {
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- file and args come from doctor's own call sites (npm root -g, which -a gbrain, crontab -l, git -C <receipt workspace>); the shell is Windows-only and off for git (windowsShell: false), where npm resolves to npm.cmd, as with the execFile it replaced; trusted local CLI only
    const child = spawn(file, args, { shell: !posix && windowsShell, detached: posix, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (value: string | null) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const kill = () => {
      try { if (posix && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
      child.stdout?.destroy();
      child.unref();
    };
    const timer = setTimeout(() => {
      if (done) return;
      kill();
      finish(cutShort());
    }, timeout);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= LOCAL_PROBE_MAX_OUTPUT_BYTES) { chunks.push(chunk); return; }
      kill();
      finish(null);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
  });
}
