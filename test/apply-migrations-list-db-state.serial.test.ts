/**
 * #4364 integration: `apply-migrations --list --require-db` against an
 * unreachable Postgres must say so on stdout and exit nonzero. Pre-fix, the
 * pre-flight probe's catch swallowed the connection error, so an unreachable
 * DB printed the identical all-pending plan at exit 0 as a clean one —
 * indistinguishable to operators and CI gates.
 *
 * Serial because it spawns a subprocess and writes a tmpdir. Skippable via
 * `GBRAIN_SKIP_SUBPROCESS_TESTS=1` for fast-loop budget control.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKIP = process.env.GBRAIN_SKIP_SUBPROCESS_TESTS === '1';

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

describe('apply-migrations --list with unreachable postgres (#4364)', () => {
  test.skipIf(SKIP)('--list --require-db reports UNREACHABLE and exits nonzero', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-list-dbstate-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      // Loopback port 1: binding it needs root, so nothing listens there and
      // connect fails fast with ECONNREFUSED — no traffic leaves the box.
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'postgres',
          database_url: 'postgresql://gbrain:gbrain@127.0.0.1:1/gbrain',
        }) + '\n',
      );
      const env = { HOME: home, GBRAIN_HOME: home };

      const res = await runCli(['apply-migrations', '--list', '--require-db'], env, 90_000);
      expect(res.stdout).toContain('UNREACHABLE');
      expect(res.exitCode).not.toBe(0);
      // The plan table still renders — the DB-state line is additive, so the
      // filesystem-side migration plan stays visible for triage.
      expect(res.stdout).toMatch(/pending/);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 180_000);
});
