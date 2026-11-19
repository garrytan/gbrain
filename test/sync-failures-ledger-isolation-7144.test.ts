/**
 * #7144: a test run must never write the operator's real sync failure ledger.
 * `bun test` loads bunfig.toml, and with it sync-failures-preload and
 * gbrain-home-preload, only from the directory it starts in: a run started in
 * `test/` or outside the repo has neither GBRAIN_SYNC_FAILURES_DIR nor
 * GBRAIN_HOME, and the broken-fixture sync tests appended their rows to
 * ~/.gbrain/sync-failures.jsonl. Bun sets NODE_ENV=test for every test run, so
 * the ledger falls back to a per-process scratch directory there. Outside a test
 * run (NODE_ENV unset) the ledger stays in the foresights home.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEDGER = fileURLToPath(new URL('../src/core/sync-failure-ledger.ts', import.meta.url));
const script = `const l = await import(${JSON.stringify(LEDGER)}); l.recordFailures('srcE', [{ path: 'notes/bad.md', error: 'SLUG_MISMATCH: frontmatter slug wrong-slug' }], 'c1'); console.log(l.syncFailuresPath());`;

async function record(home: string, nodeEnv: string | undefined): Promise<{ path: string; stderr: string }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home };
  if (nodeEnv) env.NODE_ENV = nodeEnv;
  const proc = Bun.spawn(['bun', '--no-env-file', '-e', script], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(0);
  return { path: stdout.trim(), stderr };
}

describe('sync failure ledger isolation without the test preloads (#7144)', () => {
  test('a test process with no ledger or home override writes a scratch ledger, never ~/.gbrain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-7144-home-'));
    try {
      const { path, stderr } = await record(home, 'test');
      expect(existsSync(join(home, '.gbrain', 'sync-failures.jsonl'))).toBe(false);
      expect(path.startsWith(join(home, '.gbrain'))).toBe(false);
      expect(readFileSync(path, 'utf8')).toContain('notes/bad.md');
      expect(stderr).toContain('not the real one');
      rmSync(join(path, '..'), { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('outside a test run the ledger stays in the foresights home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-7144-home-'));
    try {
      const { path } = await record(home, undefined);
      expect(path).toBe(join(home, '.gbrain', 'sync-failures.jsonl'));
      expect(readFileSync(path, 'utf8')).toContain('notes/bad.md');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
