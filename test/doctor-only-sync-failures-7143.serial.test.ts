/**
 * #7143: `foresights doctor --only sync_failures` run on its own must connect the
 * brain. The check is emitted by a pre-gate entry (stub_guard_24h), and
 * `onlyNeedsEngine` only connects for names past the DB-checks gate or names
 * declared in `engineChecks`, so the standalone run read the local ledger with
 * no engine and said "Durable sync state is unavailable without a database
 * connection" against a reachable brain.
 *
 * Serial: spawns the CLI against a tmpdir PGLite brain.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SKIP = process.env.GBRAIN_TEST_SKIP_SUBPROCESS === '1';

async function runCli(args: string[], env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], { cwd: REPO, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

describe('doctor --only sync_failures connects the brain (#7143)', () => {
  test.skipIf(SKIP)('a standalone run reads the durable state instead of reporting no database connection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-only-syncfail-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite'), embedding_dimensions: 1536 }) + '\n');
      const ledgerDir = join(home, 'sync-failures');
      mkdirSync(ledgerDir, { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(join(ledgerDir, 'sync-failures.jsonl'), JSON.stringify({ source_id: 'default', path: 'notes/alice-example.md', error: 'frontmatter slug does not match the path', code: 'SLUG_MISMATCH', commit: 'abc1234', first_seen: now, ts: now, attempts: 1, state: 'open' }) + '\n');
      const env = { HOME: home, GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: join(home, 'audit'), GBRAIN_SYNC_FAILURES_DIR: ledgerDir };
      expect((await runCli(['init', '--migrate-only'], env)).exitCode).toBe(0);

      const run = await runCli(['doctor', '--only', 'sync_failures', '--json'], env);
      const report = JSON.parse(run.stdout) as { checks: Array<{ name: string; status: string; message: string }> };
      const check = report.checks.find((c) => c.name === 'sync_failures')!;
      expect(check.message).not.toContain('without a database connection');
      expect(check.message).toContain('1 unresolved sync failure');
      expect(report.checks.some((c) => c.name === 'connection' && c.status !== 'ok')).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
