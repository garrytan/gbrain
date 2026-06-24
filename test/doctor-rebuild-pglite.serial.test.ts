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
    env: { ...process.env, ...env, GBRAIN_PGLITE_SNAPSHOT: '' },
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

describe('gbrain doctor --rebuild-pglite', () => {
  test.skipIf(SKIP)('runs before normal doctor DB connect and emits one JSON envelope', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-rebuild-'));
    try {
      const dotgbrain = join(home, '.gbrain');
      const dbPath = join(dotgbrain, 'brain.pglite');
      mkdirSync(dotgbrain, { recursive: true });
      writeFileSync(join(dotgbrain, 'config.json'), JSON.stringify({
        engine: 'pglite',
        database_path: dbPath,
        embedding_dimensions: 1536,
      }) + '\n');

      const env = {
        HOME: home,
        GBRAIN_HOME: home,
      };

      const init = await runCli(['init', '--migrate-only'], env, 90_000);
      if (init.exitCode !== 0) {
        console.error('--- init stdout ---\n' + init.stdout);
        console.error('--- init stderr ---\n' + init.stderr);
      }
      expect(init.exitCode).toBe(0);

      const rebuild = await runCli(
        ['doctor', '--rebuild-pglite', '--yes', '--no-sync', '--json'],
        env,
        120_000,
      );
      if (rebuild.exitCode !== 0) {
        console.error('--- rebuild stdout ---\n' + rebuild.stdout);
        console.error('--- rebuild stderr ---\n' + rebuild.stderr);
      }
      expect(rebuild.exitCode).toBe(0);

      const parsed = JSON.parse(rebuild.stdout) as {
        status: string;
        brain_path: string;
        backup_path: string;
        synced: boolean;
      };
      expect(parsed.status).toBe('success');
      expect(parsed.brain_path).toBe(dbPath);
      expect(parsed.backup_path).toContain(`${dbPath}.broken-`);
      expect(parsed.synced).toBe(false);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 300_000);
});
