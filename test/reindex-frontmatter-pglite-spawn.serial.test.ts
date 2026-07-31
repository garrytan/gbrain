/**
 * #1963 regression test: `gbrain reindex-frontmatter` (and `gbrain backfill
 * <kind>`, same class) on a PGLite brain.
 *
 * Pre-fix, cli.ts's dispatch connected the primary engine (taking the PGLite
 * data-dir lock), then `reindexFrontmatterCli` / `runBackfillCommand` built
 * and connected a SECOND engine on the same data dir. `acquireLock` never
 * reaps a live PID — and the named holder was this very process — so the
 * command spun the full 30s lock timeout and exited 1 with "Timed out waiting
 * for PGLite data-dir lock", 100% of the time on PGLite. The fix passes the
 * already-connected engine through instead of double-connecting.
 *
 * Spawn-level on purpose: the bug lives in the CLI dispatch seam, which
 * in-process unit tests of `runReindexFrontmatter` (see
 * reindex-frontmatter-connect.test.ts) can never reach.
 *
 * Single-test design mirrors apply-migrations-pglite-spawn.serial.test.ts:
 * each `bun run src/cli.ts` spawn pays a cold-start cost on CI, so one test
 * walks the whole lifecycle. Serial because it spawns subprocesses + writes a
 * tmpdir.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Scrub inherited GBRAIN_* so a developer's shell config (embedding model,
  // pace mode, …) can't change what the spawned CLI does.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GBRAIN_')),
  ) as Record<string, string>;
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env: { ...base, ...env },
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

describe('reindex-frontmatter + backfill on PGLite (#1963 double-connect)', () => {
  test('init → import → reindex-frontmatter --yes → backfill effective_date --dry-run (all exit 0, no lock timeout)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-1963-'));
    const notes = mkdtempSync(join(tmpdir(), 'gbrain-1963-notes-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          database_path: join(home, '.gbrain', 'brain.pglite'),
          embedding_dimensions: 1536,
        }) + '\n',
      );
      for (let i = 1; i <= 3; i++) {
        writeFileSync(
          join(notes, `note${i}.md`),
          `---\neffective_date: 2025-01-0${i}\n---\n# note ${i}\n\nbody ${i}\n`,
        );
      }
      const env = { HOME: home, GBRAIN_HOME: home };

      const init = await runCli(['init', '--migrate-only'], env, 120_000);
      if (init.exitCode !== 0) {
        console.error('--- init stdout ---\n' + init.stdout);
        console.error('--- init stderr ---\n' + init.stderr);
      }
      expect(init.exitCode).toBe(0);

      const imp = await runCli(['import', notes, '--no-embed'], env, 120_000);
      if (imp.exitCode !== 0) {
        console.error('--- import stdout ---\n' + imp.stdout);
        console.error('--- import stderr ---\n' + imp.stderr);
      }
      expect(imp.exitCode).toBe(0);

      // Pre-fix: exits 1 after the 30s PGLite lock timeout, naming ITSELF as
      // the holder. Post-fix: reuses cli.ts's connected engine and succeeds.
      const reindex = await runCli(['reindex-frontmatter', '--yes', '--json'], env, 120_000);
      const reindexOut = reindex.stdout + reindex.stderr;
      if (reindex.exitCode !== 0) {
        console.error('--- reindex-frontmatter stdout ---\n' + reindex.stdout);
        console.error('--- reindex-frontmatter stderr ---\n' + reindex.stderr);
      }
      expect(reindexOut).not.toMatch(/Timed out waiting for PGLite/);
      expect(reindex.exitCode).toBe(0);
      expect(reindex.stdout).toMatch(/"status":\s*"ok"/);

      // `gbrain backfill <kind>` had the identical double-connect. dry-run
      // still connects, so pre-fix it hit the same 30s timeout.
      const backfill = await runCli(['backfill', 'effective_date', '--dry-run'], env, 120_000);
      const backfillOut = backfill.stdout + backfill.stderr;
      if (backfill.exitCode !== 0) {
        console.error('--- backfill stdout ---\n' + backfill.stdout);
        console.error('--- backfill stderr ---\n' + backfill.stderr);
      }
      expect(backfillOut).not.toMatch(/Timed out waiting for PGLite/);
      expect(backfill.exitCode).toBe(0);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
      try { rmSync(notes, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 480_000);
});
