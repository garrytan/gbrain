/**
 * v0.41.31 — `gbrain sync --all` cost-gate wiring regressions (PGLite).
 *
 * Pure shouldBlockSync / willEmbedSynchronously logic is pinned in
 * test/sync-cost-preview.test.ts. THIS file pins the end-to-end wiring in
 * runSync's --all path:
 *
 *   R-1 (headline): deferred-embed sync --all, non-TTY, with backlog →
 *        emits gate:'deferred_notice' and NEVER exit 2 (the cron-blocking
 *        bug this release fixes).
 *   R-2 (protection): inline-embed sync --all (--serial), non-TTY, above
 *        floor → still exit 2 with gate:'confirmation_required'.
 *
 * Serial-quarantined: stubs process.exit + console.log (process-global).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';
import type { ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;
let repoPath: string;
let headSha: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  // Configure the gateway with a dummy key so the pre-gate embedding-creds
  // preflight passes (diagnoseEmbedding reads gateway configure-time state,
  // not live env). The gate runs before any real embed call, so no network
  // request is made.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test-costgate' },
  });
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-costgate-'));
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
  mkdirSync(join(repoPath, 'topics'), { recursive: true });
  writeFileSync(
    join(repoPath, 'topics/foo.md'),
    ['---', 'type: concept', 'title: Foo', '---', '', 'some body content to estimate.'].join('\n'),
  );
  execSync('git add -A && git commit -m initial', { cwd: repoPath, stdio: 'pipe' });
  headSha = execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe' }).toString().trim();
});

afterEach(() => {
  resetGateway();
  if (repoPath) rmSync(repoPath, { recursive: true, force: true });
});

/** Run runSync(args) with process.exit + console.log captured. */
async function runSyncCaptured(args: string[]): Promise<{ exitCode: number | undefined; stdout: string }> {
  const { runSync } = await import('../src/commands/sync.ts');
  const origExit = process.exit;
  const origLog = console.log.bind(console);
  const out: string[] = [];
  let exitCode: number | undefined;
  console.log = (...a: unknown[]) => {
    out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  };
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error('__exit__');
  }) as typeof process.exit;
  try {
    await runSync(engine, args);
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    process.exit = origExit;
    console.log = origLog;
  }
  return { exitCode, stdout: out.join('\n') };
}

describe('v0.41.31 — sync --all cost gate wiring', () => {
  test('R-1: deferred sync --all (non-TTY) emits deferred_notice and never exit 2', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    // Make the fan-out a clean no-op: last_commit == HEAD so performSync
    // reports up_to_date (no git pull, no backfill submit).
    await engine.executeRaw(`UPDATE sources SET last_commit = $1 WHERE id = 'vault'`, [headSha]);
    // Seed a stale backlog so the deferred notice has a non-zero figure.
    await engine.putPage('vault/note', { type: 'note', title: 'note', compiled_truth: '# note' }, { sourceId: 'vault' });
    const chunks: ChunkInput[] = [
      { chunk_index: 0, chunk_text: 'x'.repeat(500), chunk_source: 'compiled_truth', token_count: 4, embedding: undefined },
    ];
    await engine.upsertChunks('vault/note', chunks, { sourceId: 'vault' });

    // v2 default ON → deferred. --json → agent path. NO --yes. --no-pull
    // because the synthetic repo has no remote.
    const { exitCode, stdout } = await runSyncCaptured(['--all', '--json', '--no-pull']);

    // The headline assertion: NOT blocked.
    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"deferred_notice"');
  }, 60_000);

  test('R-2: inline sync --all (--serial) above floor still exit 2', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    // Floor 0 → any nonzero inline cost blocks. Source is unsynced
    // (last_commit NULL) so estimateInlineNewTokens sees it as changed →
    // full-tree tokens > 0 → costUsd > 0 > floor.
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    // --serial forces inline even with v2 on. --json → non-TTY exit-2 path.
    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--json', '--no-pull']);

    expect(exitCode).toBe(2);
    expect(stdout).toContain('"gate":"confirmation_required"');
  }, 60_000);

  test('R-3: inline, git-unchanged source but STALE chunker_version still estimates (not $0)', async () => {
    // The unchanged-source short-circuit requires HEAD==last_commit AND clean
    // tree AND chunker_version == current. Here git is unchanged but the
    // chunker drifted, so the source must NOT be treated as 0 — sync would
    // re-chunk + re-embed everything. floor=0 so any nonzero cost blocks.
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`, [headSha, 'STALE-0']);
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--json', '--no-pull']);

    expect(exitCode).toBe(2);
    expect(stdout).toContain('"gate":"confirmation_required"');
  }, 60_000);

  test('R-3 control: inline, git-unchanged + CURRENT chunker_version short-circuits to $0 (no exit 2)', async () => {
    // Same setup but chunker_version matches current → the source IS unchanged
    // → contributes 0 new-content tokens → below floor → proceeds (no block).
    // Proves the short-circuit fires when (and only when) everything matches.
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`, [headSha, String(CHUNKER_VERSION)]);
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).not.toContain('"gate":"confirmation_required"');
  }, 60_000);
});
