/**
 * `gbrain sync` cost-gate wiring regressions (PGLite).
 *
 * Pure shouldBlockSync / willEmbedSynchronously / parseUsdLimit logic is pinned
 * in test/sync-cost-preview.test.ts. THIS file pins the end-to-end wiring in
 * runSync's --all AND single-source paths:
 *
 *   R-1 (headline): deferred-embed sync --all, non-TTY, with backlog →
 *        emits gate:'deferred_notice' and NEVER exit 2.
 *   R-2 (v0.42.42.0, #2139): inline sync --all (--serial), non-TTY, above floor
 *        → AUTO-DEFERS (exit 0, gate:'auto_deferred_embeds') and enqueues an
 *        embed-backfill job. The exit-2 wedge is gone.
 *   R-3: chunker drift → full-tree CEILING estimate, auto-defers (not exit 2).
 *   + posture tokenmax, off-switch, format split (#1784/D3A), single-source gate.
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
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';
import type { ChunkInput } from '../src/core/types.ts';

/** Offline embed stub so inline-proceed paths (posture tokenmax) don't network. */
function stubOfflineEmbed(): void {
  __setEmbedTransportForTests(async ({ values }: any) => ({
    embeddings: values.map(() => new Array(1536).fill(0)),
    usage: { tokens: 0 },
  }) as any);
}

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
  __setEmbedTransportForTests(null);
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

  test('R-2 (#2139): inline sync --all (--serial) above floor AUTO-DEFERS (exit 0, never exit 2) + enqueues backfill', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    // Floor 0 → any nonzero inline cost trips the gate. Source is unsynced
    // (last_commit NULL) → first-sync ceiling > 0 > floor.
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    // --serial forces inline even with v2 on. --json → non-TTY path → AUTO-DEFER.
    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"auto_deferred_embeds"');
    expect(stdout).not.toContain('"gate":"confirmation_required"');
    // The run PROCEEDED to import (the wedge is gone) — embeds were deferred,
    // not blocked. (The embed-backfill enqueue wiring + its graceful
    // missing-table tolerance is pinned in embed-backfill-submit.test.ts; the
    // minion_jobs table isn't provisioned in this gate-wiring harness.)
    expect(stdout).toContain('"sync_status":"first_sync"');
  }, 60_000);

  test('R-3 (#2139): chunker drift → full-tree CEILING estimate, auto-defers (not exit 2)', async () => {
    // git unchanged (HEAD==last_commit) but chunker drifted → the source must
    // NOT price $0 (sync would re-chunk + re-embed everything). The estimate is
    // the full-tree ceiling; the gate auto-defers rather than wedging.
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`, [headSha, 'STALE-0']);
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"auto_deferred_embeds"');
    expect(stdout).toContain('"estimateKind":"ceiling"');
  }, 60_000);

  test('R-3 control: git-unchanged + CURRENT chunker → $0 estimate, below floor (no auto-defer)', async () => {
    // Mirrors the executor's up_to_date predicate: HEAD==last_commit AND chunker
    // matches → 0 new tokens → below floor → proceeds without deferring.
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`, [headSha, String(CHUNKER_VERSION)]);
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).not.toContain('"gate":"auto_deferred_embeds"');
    expect(stdout).toContain('"estimateKind":"unchanged"');
  }, 60_000);

  test('headline regression: HEAD==last_commit + DIRTY untracked file → $0, no gate (the false-fire)', async () => {
    // The exact pre-fix false-fire: a busy brain's working tree is never
    // git-clean, but the commits are caught up. The OLD estimator priced the
    // whole tree (158M-token phantom); the new one mirrors execution → $0.
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`, [headSha, String(CHUNKER_VERSION)]);
    // Dirty the tree with an untracked non-syncable scratch file (agents/crons
    // write constantly) — attached-HEAD sync never imports it.
    writeFileSync(join(repoPath, 'scratch.tmp'), 'uncommitted agent scratch');
    writeFileSync(join(repoPath, 'topics/foo.md'), 'uncommitted edit, not staged');
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).not.toContain('"gate":"auto_deferred_embeds"');
    expect(stdout).toContain('"estimateKind":"unchanged"');
  }, 60_000);

  test('spend.posture=tokenmax → proceeds inline, gate:posture_tokenmax (informational)', async () => {
    stubOfflineEmbed(); // inline embed proceeds — keep it off the network.
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.setConfig('sync.cost_gate_min_usd', '0');
    await engine.setConfig('spend.posture', 'tokenmax');

    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"posture_tokenmax"');
    expect(stdout).not.toContain('"gate":"auto_deferred_embeds"');
  }, 60_000);

  test('sync.cost_gate_min_usd=off → floor renders "unlimited", never blocks', async () => {
    stubOfflineEmbed();
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.setConfig('sync.cost_gate_min_usd', 'off');

    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"floorUsd":"unlimited"');
    expect(stdout).not.toContain('"gate":"auto_deferred_embeds"');
  }, 60_000);

  test('format split (#1784/D3A): non-TTY WITHOUT --json emits human text, no JSON envelope', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    // No --json: above floor in a non-TTY session → human auto-defer text.
    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).not.toContain('"gate":'); // no JSON envelope without --json
    expect(stdout.toLowerCase()).toContain('deferring embeds');
    expect(stdout).toContain('spend.posture'); // self-describing hint present
  }, 60_000);

  test('single-source sync gets the same gate (auto-defers above floor, exit 0)', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    // Single-source (no --all): unsynced → ceiling > 0 → non-TTY auto-defer.
    const { exitCode, stdout } = await runSyncCaptured(['--source', 'vault', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"auto_deferred_embeds"');
    // The gate now exists on the single-source path (was ungated before
    // #2139) and proceeds to import rather than blocking.
    expect(stdout.toLowerCase()).toContain('imported');
  }, 60_000);
});
