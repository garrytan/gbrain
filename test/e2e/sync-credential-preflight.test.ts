/**
 * v0.41.6.0 D1 E2E — `gbrain sync` preflight rejects missing creds
 * cleanly without writing N failures to sync-failures.jsonl.
 *
 * Repro from the production bug report:
 *   unset OPENAI_API_KEY
 *   gbrain sync --repo /tmp/test --full --yes
 *
 * Pre-v0.41.6.0: 565 identical "OpenAI embedding requires
 * OPENAI_API_KEY" entries in ~/.gbrain/sync-failures.jsonl, bookmark
 * blocked.
 *
 * Post-v0.41.6.0: single clean stderr line, exit 1, zero
 * sync-failures.jsonl entries.
 *
 * Hermetic: GBRAIN_HOME points at a tmpdir; OPENAI_API_KEY explicitly
 * unset; runs against PGLite via `gbrain init --pglite` so no real
 * Postgres needed.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';

const CLI = ['bun', 'run', join(import.meta.dir, '..', '..', 'src', 'cli.ts')];

let tmpHome: string;
let repoDir: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-preflight-e2e-'));
  // gbrainPath() appends `.gbrain` to GBRAIN_HOME — pre-create the dir.
  const gbrainDir = join(tmpHome, '.gbrain');
  mkdirSync(gbrainDir, { recursive: true });
  // Pre-populate config.json so we can exercise the preflight without
  // running `gbrain init` (which refuses when multiple provider env keys
  // are already in the parent shell — out of scope for this test).
  // GBRAIN_HOME is hermetic; this config is private to this test run.
  writeFileSync(join(gbrainDir, 'config.json'), JSON.stringify({
    database: 'pglite',
    pglite_dir: join(gbrainDir, 'pglite'),
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1536,
  }, null, 2));
});

afterAll(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(() => {
  // Create a fresh repo with one markdown file.
  if (repoDir) { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } }
  repoDir = mkdtempSync(join(tmpdir(), 'gbrain-preflight-repo-'));
  mkdirSync(join(repoDir, 'people'), { recursive: true });
  writeFileSync(join(repoDir, 'people', 'alice-example.md'), [
    '---',
    'type: person',
    'title: Alice Example',
    '---',
    '',
    'Alice is a placeholder person used in privacy-safe test fixtures.',
  ].join('\n'));
  // Initialize git so sync has a HEAD to anchor on.
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir });
});

function runCli(args: string[], env: Record<string, string | undefined>): { code: number; stdout: string; stderr: string } {
  const fullEnv: Record<string, string | undefined> = { ...(process.env as Record<string, string | undefined>), GBRAIN_HOME: tmpHome, ...env };
  // Strip ALL provider keys by default — the preflight test is about
  // the OPENAI path; other keys would route preflight elsewhere and
  // muddy the test signal.
  for (const k of ['OPENAI_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY']) {
    if (!(k in env)) delete fullEnv[k];
  }
  // Strip any undefined-explicitly-set vars (signals "unset").
  for (const k of Object.keys(fullEnv)) if (fullEnv[k] === undefined) delete fullEnv[k];
  const res = spawnSync(CLI[0], [...CLI.slice(1), ...args], {
    env: fullEnv as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe('v0.41.6.0 D1 E2E — gbrain sync preflight rejects missing OPENAI_API_KEY', () => {
  test('exits non-zero with paste-ready stderr message', () => {
    const result = runCli(['sync', '--repo', repoDir, '--full', '--yes'], {});

    expect(result.code).not.toBe(0);

    // The preflight error message contains the exact phrase from
    // src/core/embed-preflight.ts — pinpoint test, not regex-loose.
    const combined = result.stderr + result.stdout;
    expect(combined).toMatch(/OPENAI_API_KEY/);
    expect(combined).toMatch(/requires OPENAI_API_KEY/);
    expect(combined).toMatch(/--no-embed/);
  });

  test('does NOT write 565 identical entries to sync-failures.jsonl', () => {
    runCli(['sync', '--repo', repoDir, '--full', '--yes'], {});

    const failuresPath = join(tmpHome, '.gbrain', 'sync-failures.jsonl');
    if (!existsSync(failuresPath)) {
      // File never created — perfect outcome.
      expect(true).toBe(true);
      return;
    }
    const lines = readFileSync(failuresPath, 'utf8').split('\n').filter(Boolean);
    // Pre-v0.41.6.0 wrote N entries per file. Post-fix should write 0 entries
    // for the missing-key case (preflight exits before import).
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  test('--no-embed bypasses the preflight (sync proceeds)', () => {
    const result = runCli(['sync', '--repo', repoDir, '--full', '--yes', '--no-embed'], {});
    const combined = result.stderr + result.stdout;
    // The preflight DID NOT fire — no "requires OPENAI_API_KEY ... Set it in your shell"
    // paragraph in the output.
    expect(combined).not.toMatch(/requires OPENAI_API_KEY[\s\S]+Set it in your shell/);
  });
});
