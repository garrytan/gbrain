/**
 * v0.41.6.0 D1 E2E — `gbrain import` preflight rejects missing creds.
 *
 * Sibling of sync-credential-preflight.test.ts. Closes outside-voice F4:
 * pre-v0.41.6.0, `gbrain import <dir>` per-file embed wrote N identical
 * "missing OPENAI_API_KEY" failures the same way sync did.
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
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-import-preflight-e2e-'));
  const gbrainDir = join(tmpHome, '.gbrain');
  mkdirSync(gbrainDir, { recursive: true });
  writeFileSync(join(gbrainDir, 'config.json'), JSON.stringify({
    database: 'pglite',
    pglite_dir: join(gbrainDir, 'pglite'),
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1536,
  }, null, 2));
});

afterAll(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

beforeEach(() => {
  if (repoDir) { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } }
  repoDir = mkdtempSync(join(tmpdir(), 'gbrain-import-preflight-repo-'));
  mkdirSync(join(repoDir, 'people'), { recursive: true });
  writeFileSync(join(repoDir, 'people', 'alice-example.md'), [
    '---', 'type: person', 'title: Alice Example', '---', '',
    'Alice is a placeholder.',
  ].join('\n'));
});

function runCli(args: string[], env: Record<string, string | undefined>): { code: number; stdout: string; stderr: string } {
  const fullEnv: Record<string, string | undefined> = { ...(process.env as Record<string, string | undefined>), GBRAIN_HOME: tmpHome, ...env };
  for (const k of ['OPENAI_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY']) {
    if (!(k in env)) delete fullEnv[k];
  }
  for (const k of Object.keys(fullEnv)) if (fullEnv[k] === undefined) delete fullEnv[k];
  const res = spawnSync(CLI[0], [...CLI.slice(1), ...args], {
    env: fullEnv as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe('v0.41.6.0 D1 E2E — gbrain import preflight rejects missing OPENAI_API_KEY', () => {
  test('exits non-zero with paste-ready stderr message', () => {
    const result = runCli(['import', repoDir], {});
    expect(result.code).not.toBe(0);
    const combined = result.stderr + result.stdout;
    expect(combined).toMatch(/OPENAI_API_KEY/);
    expect(combined).toMatch(/requires OPENAI_API_KEY/);
    expect(combined).toMatch(/--no-embed/);
  });

  test('--no-embed bypasses the preflight', () => {
    const result = runCli(['import', repoDir, '--no-embed'], {});
    const combined = result.stderr + result.stdout;
    expect(combined).not.toMatch(/requires OPENAI_API_KEY[\s\S]+Set it in your shell/);
  });
});
