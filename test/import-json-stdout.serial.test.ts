/**
 * #3637 regression test: `gbrain import <dir> --json` must leave exactly one
 * JSON document on stdout.
 *
 * Pre-fix, runImport's informational lines in src/commands/import.ts ("Found N
 * markdown files" and its four siblings — --exclude variant, checkpoint resume,
 * parallel workers, checkpoint preserved) went through console.log
 * unconditionally, so stdout under --json read
 * `Found 1 markdown files\n{"status":"success",...}` and JSON.parse failed at
 * character 0. The reported consumer (gstack's memory-ingest, which runs
 * `gbrain import <dir> --no-embed --json` and parses stdout) took the parse
 * failure as "0 imported" while still recording every file as ingested, so the
 * next run skipped them permanently — success reported, nothing imported, no
 * retry.
 *
 * This is the documented contract, not a new one: CLAUDE.md's progress rules
 * say "Stdout stays clean for data output (--json payloads)", and the comment
 * above the progress reporter in import.ts says the same. The existing CI guard
 * scripts/check-progress-to-stdout.sh only greps for
 * `process.stdout.write('\r…)`, so plain console.log lines under --json were
 * never covered.
 *
 * Spawn-level on purpose: the defect is in what reaches the process's stdout,
 * which an in-process call of runImport cannot observe. Brain setup mirrors
 * test/reindex-frontmatter-pglite-spawn.serial.test.ts — PGLite via a written
 * config.json plus `init --migrate-only`, so no embedding provider is needed.
 * Serial because it spawns subprocesses and writes a tmpdir.
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

function seedNotes(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (let i = 1; i <= 2; i++) {
    writeFileSync(join(dir, `note${i}.md`), `# note ${i}\n\nbody ${i}\n`);
  }
  return dir;
}

describe('import --json stdout is parseable JSON (#3637)', () => {
  test('--json puts one JSON document on stdout and the progress lines on stderr; human mode is unchanged', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-3637-'));
    const jsonNotes = seedNotes('gbrain-3637-json-');
    const humanNotes = seedNotes('gbrain-3637-human-');
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
      const env = { HOME: home, GBRAIN_HOME: home };

      const init = await runCli(['init', '--migrate-only'], env, 120_000);
      if (init.exitCode !== 0) {
        console.error('--- init stdout ---\n' + init.stdout);
        console.error('--- init stderr ---\n' + init.stderr);
      }
      expect(init.exitCode).toBe(0);

      // Pre-fix: stdout is "Found 2 markdown files\n{…}" and this JSON.parse
      // throws "Unexpected token 'F'". Post-fix: stdout is the payload alone.
      const json = await runCli(['import', jsonNotes, '--no-embed', '--json'], env, 120_000);
      if (json.exitCode !== 0) {
        console.error('--- import --json stdout ---\n' + json.stdout);
        console.error('--- import --json stderr ---\n' + json.stderr);
      }
      expect(json.exitCode).toBe(0);
      expect(json.stdout.trim().split('\n')).toHaveLength(1);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.status).toBe('success');
      expect(parsed.imported).toBe(2);
      expect(parsed.total_files).toBe(2);
      // The line is relocated, not deleted — an operator watching a terminal
      // still sees it.
      expect(json.stdout).not.toContain('Found 2 markdown files');
      expect(json.stderr).toContain('Found 2 markdown files');

      // Guard the other direction: without --json the human line stays on
      // stdout, so this fix cannot be "fixed" by deleting the output.
      const human = await runCli(['import', humanNotes, '--no-embed'], env, 120_000);
      if (human.exitCode !== 0) {
        console.error('--- import stdout ---\n' + human.stdout);
        console.error('--- import stderr ---\n' + human.stderr);
      }
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain('Found 2 markdown files');
      expect(human.stdout).toContain('Import complete');
    } finally {
      for (const d of [home, jsonNotes, humanNotes]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }, 480_000);
});
