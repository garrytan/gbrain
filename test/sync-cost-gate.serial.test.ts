/**
 * `gbrain sync` cost-gate wiring regressions (PGLite).
 *
 * Pure shouldBlockSync / willEmbedSynchronously / parseUsdLimit logic is pinned
 * in test/sync-cost-preview.test.ts. THIS file pins the end-to-end wiring in
 * runSync's --all AND single-source paths:
 *
 *   R-1 (headline): PGLite's serial fallback is inline, never a fictional
 *        deferred-to-worker path.
 *   R-2 (v0.42.42.0, #2139): PGLite sync --all, non-TTY, above floor
 *        → imports without wedging and reports an explicit manual drain;
 *        no undrainable embed-backfill row is written.
 *   R-3: chunker drift → full-tree CEILING estimate, auto-defers (not exit 2).
 *   + posture tokenmax, off-switch, format split (#1784/D3A), single-source gate.
 *
 * Serial-quarantined: stubs process.exit + console.log (process-global).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { partitionMissingPathSources } from '../src/commands/sync.ts';
import {
  resolveSyncAllEmbedPlan,
  resolveSyncEmbedBackfill,
} from '../src/core/sync-embed-backfill.ts';
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
let repoPathTwo: string;
let headSha: string;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '140';
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
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

  repoPathTwo = mkdtempSync(join(tmpdir(), 'gbrain-costgate-two-'));
  execSync('git init', { cwd: repoPathTwo, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repoPathTwo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repoPathTwo, stdio: 'pipe' });
  mkdirSync(join(repoPathTwo, 'topics'), { recursive: true });
  writeFileSync(
    join(repoPathTwo, 'topics/bar.md'),
    ['---', 'type: concept', 'title: Bar', '---', '', 'second source content to estimate.'].join('\n'),
  );
  execSync('git add -A && git commit -m initial', { cwd: repoPathTwo, stdio: 'pipe' });
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
  if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  if (repoPathTwo) rmSync(repoPathTwo, { recursive: true, force: true });
});

/** Run runSync(args) with process.exit + console.log captured. */
async function runSyncCaptured(
  args: string[],
  targetEngine: BrainEngine = engine,
): Promise<{ exitCode: number | undefined; stdout: string }> {
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
    await runSync(targetEngine, args);
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    process.exit = origExit;
    console.log = origLog;
  }
  return { exitCode, stdout: out.join('\n') };
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function expectNoEmbedBackfillRow(): Promise<void> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM minion_jobs WHERE name = 'embed-backfill'`,
  );
  expect(Number(rows[0]?.n ?? 0)).toBe(0);
}

function asWorkerBacked(target: PGLiteEngine): BrainEngine {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let statement = strings[0] ?? '';
    for (let i = 0; i < values.length; i++) {
      statement += `$${i + 1}${strings[i + 1] ?? ''}`;
    }
    const db = (target as unknown as {
      db: { query: (text: string, params: unknown[]) => Promise<{ rows: unknown[] }> };
    }).db;
    return (await db.query(statement, values)).rows;
  };
  return new Proxy(target, {
    get(inner, prop) {
      if (prop === 'kind') return 'postgres';
      if (prop === 'sql') return sql;
      const value = Reflect.get(inner, prop, inner);
      return typeof value === 'function' ? value.bind(inner) : value;
    },
  }) as unknown as BrainEngine;
}

function commitLargeIncrementalDrop(): void {
  for (let i = 0; i < 101; i++) {
    writeFileSync(
      join(repoPath, `topics/large-${i}.md`),
      ['---', 'type: concept', `title: Large ${i}`, '---', '', `large incremental page ${i}`].join('\n'),
    );
  }
  execSync('git add -A && git commit -m "large incremental drop"', { cwd: repoPath, stdio: 'pipe' });
}

describe('v0.41.31 — sync --all cost gate wiring', () => {
  test('worker-backed v2 with one runnable source still defers and queues backfill', async () => {
    const workerBackedEngine = asWorkerBacked(engine);
    await runSources(workerBackedEngine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`,
      [headSha, String(CHUNKER_VERSION)],
    );

    const [source] = await engine.executeRaw<{
      id: string;
      local_path: string | null;
      config: Record<string, unknown>;
      last_commit: string | null;
      chunker_version: string | null;
    }>(
      `SELECT id, local_path, config, last_commit, chunker_version FROM sources WHERE id = 'vault'`,
    );
    const repoTwoHead = execSync('git rev-parse HEAD', { cwd: repoPathTwo, stdio: 'pipe' }).toString().trim();
    const candidates = [
      source,
      {
        id: 'disabled', local_path: repoPathTwo, config: { syncEnabled: false },
        last_commit: repoTwoHead, chunker_version: String(CHUNKER_VERSION),
      },
      {
        id: 'missing', local_path: join(repoPath, 'definitely-missing'), config: {},
        last_commit: null, chunker_version: String(CHUNKER_VERSION),
      },
    ];
    const active = candidates.filter((candidate) => candidate.config.syncEnabled !== false);
    const filtered = partitionMissingPathSources(active, existsSync);
    expect(filtered.runnable.map((candidate) => candidate.id)).toEqual(['vault']);
    expect(filtered.missing.map((candidate) => candidate.id)).toEqual(['missing']);
    const plan = await resolveSyncAllEmbedPlan(workerBackedEngine, filtered.runnable, {
      v2Enabled: true,
      serialFlag: false,
      noEmbed: false,
      noAutoEmbed: false,
      dryRun: false,
      jsonOut: true,
      yesFlag: false,
      full: false,
      includeGitignored: false,
    });

    expect(plan).toMatchObject({
      stop: false,
      deferEligible: true,
      fanOutEligible: false,
      effectiveNoEmbed: true,
      shouldBackfill: true,
    });
    const outcome = await resolveSyncEmbedBackfill(workerBackedEngine, 'vault', {
      reason: 'sync_all',
      autoSubmitDisabled: false,
    });
    expect(outcome.status).toBe('queued');
    const rows = await engine.executeRaw<{ name: string; status: string }>(
      `SELECT name, status FROM minion_jobs WHERE name = 'embed-backfill'`,
    );
    expect(rows).toEqual([{ name: 'embed-backfill', status: 'waiting' }]);
  }, 60_000);

  test('worker-backed v2 serial large incremental deferral still queues backfill', async () => {
    const workerBackedEngine = asWorkerBacked(engine);
    await runSources(workerBackedEngine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`,
      [headSha, String(CHUNKER_VERSION)],
    );
    await engine.setConfig('sync.federated_v2', 'true');
    await engine.setConfig('sync.cost_gate_min_usd', '1000');
    commitLargeIncrementalDrop();

    const { exitCode, stdout } = await runSyncCaptured(
      ['--all', '--serial', '--json', '--no-pull'],
      workerBackedEngine,
    );

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"below_floor"');
    const final = jsonLines(stdout).find((line) => line.schema_version === 1 && Array.isArray(line.sources));
    expect(final).toBeDefined();
    expect(final!.sources).toEqual([
      expect.objectContaining({
        source_id: 'vault',
        sync_status: 'synced',
        added: 101,
        embedded: 0,
        embed_backfill: expect.objectContaining({ status: 'queued' }),
      }),
    ]);
    const rows = await engine.executeRaw<{ name: string; status: string }>(
      `SELECT name, status FROM minion_jobs WHERE name = 'embed-backfill' ORDER BY id`,
    );
    expect(rows).toEqual([{ name: 'embed-backfill', status: 'waiting' }]);
  }, 120_000);

  test('worker-backed v2 serial large incremental no-auto reports manual drain without a row', async () => {
    const workerBackedEngine = asWorkerBacked(engine);
    await runSources(workerBackedEngine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`,
      [headSha, String(CHUNKER_VERSION)],
    );
    await engine.setConfig('sync.federated_v2', 'true');
    await engine.setConfig('sync.cost_gate_min_usd', '1000');
    commitLargeIncrementalDrop();

    const { exitCode, stdout } = await runSyncCaptured(
      ['--all', '--serial', '--no-auto-embed', '--json', '--no-pull'],
      workerBackedEngine,
    );

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"below_floor"');
    const final = jsonLines(stdout).find((line) => line.schema_version === 1 && Array.isArray(line.sources));
    expect(final).toBeDefined();
    expect(final!.sources).toEqual([
      expect.objectContaining({
        source_id: 'vault',
        sync_status: 'synced',
        added: 101,
        embedded: 0,
        embed_backfill: {
          status: 'manual_drain_required',
          reason: 'auto_submit_disabled',
          command: 'gbrain embed --stale --source vault',
        },
      }),
    ]);
    await expectNoEmbedBackfillRow();
  }, 120_000);

  test('worker-backed v2-off serial large incremental deferral preserves pre-v2 no-backfill behavior', async () => {
    const workerBackedEngine = asWorkerBacked(engine);
    await runSources(workerBackedEngine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`,
      [headSha, String(CHUNKER_VERSION)],
    );
    await engine.setConfig('sync.federated_v2', 'false');
    await engine.setConfig('sync.cost_gate_min_usd', '1000');
    commitLargeIncrementalDrop();

    const { exitCode, stdout } = await runSyncCaptured(
      ['--all', '--serial', '--json', '--no-pull'],
      workerBackedEngine,
    );

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"below_floor"');
    const final = jsonLines(stdout).find((line) => line.schema_version === 1 && Array.isArray(line.sources));
    expect(final).toBeDefined();
    const source = (final!.sources as Array<Record<string, unknown>>)[0];
    expect(source).toMatchObject({
      source_id: 'vault',
      sync_status: 'synced',
      added: 101,
      embedded: 0,
    });
    expect(source.embed_backfill).toBeUndefined();
    await expectNoEmbedBackfillRow();
  }, 120_000);

  test('worker-backed --no-auto-embed reports policy refusal without denying queue capability', async () => {
    const workerBackedEngine = asWorkerBacked(engine);
    await runSources(workerBackedEngine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await runSources(workerBackedEngine, ['add', 'vault-two', '--path', repoPathTwo, '--no-federated']);
    const sources = await engine.executeRaw<{
      id: string;
      local_path: string | null;
      config: Record<string, unknown>;
      last_commit: string | null;
      chunker_version: string | null;
    }>(
      `SELECT id, local_path, config, last_commit, chunker_version
         FROM sources WHERE id IN ('vault', 'vault-two') ORDER BY id`,
    );
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
    let plan: Awaited<ReturnType<typeof resolveSyncAllEmbedPlan>>;
    try {
      plan = await resolveSyncAllEmbedPlan(workerBackedEngine, sources, {
        v2Enabled: true,
        serialFlag: false,
        noEmbed: false,
        noAutoEmbed: true,
        dryRun: false,
        jsonOut: true,
        yesFlag: false,
        full: false,
        includeGitignored: false,
      });
    } finally {
      console.log = origLog;
    }

    const notice = jsonLines(out.join('\n')).find((line) => line.gate === 'manual_drain_required');
    expect(notice).toMatchObject({
      status: 'manual_drain_required',
      workerSurface: 'worker_backed',
      reason: 'auto_submit_disabled',
    });
    expect(plan!).toMatchObject({
      deferEligible: true,
      fanOutEligible: true,
      effectiveNoEmbed: true,
      shouldBackfill: true,
    });
    const outcome = await resolveSyncEmbedBackfill(workerBackedEngine, 'vault', {
      reason: 'sync_all',
      autoSubmitDisabled: true,
    });
    expect(outcome).toEqual({
      status: 'manual_drain_required',
      command: 'gbrain embed --stale --source vault',
      reason: 'auto_submit_disabled',
    });
    await expectNoEmbedBackfillRow();
  }, 60_000);

  test('R-1: PGLite serial fallback stays inline and never claims worker deferral', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await runSources(engine, ['add', 'vault-two', '--path', repoPathTwo, '--no-federated']);
    // Make the fan-out a clean no-op: last_commit == HEAD so performSync
    // reports up_to_date (no git pull, no backfill submit).
    const headShaTwo = execSync('git rev-parse HEAD', { cwd: repoPathTwo, stdio: 'pipe' }).toString().trim();
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`,
      [headSha, String(CHUNKER_VERSION)],
    );
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault-two'`,
      [headShaTwo, String(CHUNKER_VERSION)],
    );
    // Seed a stale backlog so the deferred notice has a non-zero figure.
    await engine.putPage('vault/note', { type: 'note', title: 'note', compiled_truth: '# note' }, { sourceId: 'vault' });
    const chunks: ChunkInput[] = [
      { chunk_index: 0, chunk_text: 'x'.repeat(500), chunk_source: 'compiled_truth', token_count: 4, embedding: undefined },
    ];
    await engine.upsertChunks('vault/note', chunks, { sourceId: 'vault' });

    // v2 defaults on, but PGLite has no worker-backed fan-out even with two sources.
    const { exitCode, stdout } = await runSyncCaptured(['--all', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"below_floor"');
    expect(stdout).not.toContain('"gate":"deferred_notice"');
    expect(stdout).not.toContain('backfill job(s) queued');
    await expectNoEmbedBackfillRow();
  }, 60_000);

  test('R-2 (#2139): PGLite sync --all above floor reports manual drain in gate + final JSON and writes no row', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await runSources(engine, ['add', 'vault-two', '--path', repoPathTwo, '--no-federated']);
    // Floor 0 → any nonzero inline cost trips the gate. Source is unsynced
    // (last_commit NULL) → first-sync ceiling > 0 > floor.
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    const { exitCode, stdout } = await runSyncCaptured(['--all', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"manual_drain_required"');
    expect(stdout).toContain('gbrain embed --stale --source vault');
    expect(stdout).toContain('gbrain embed --stale --source vault-two');
    expect(stdout).not.toContain('"gate":"confirmation_required"');
    const final = jsonLines(stdout).find((line) => line.schema_version === 1 && Array.isArray(line.sources));
    expect(final).toBeDefined();
    const finalSources = final!.sources as Array<Record<string, unknown>>;
    expect(finalSources).toHaveLength(2);
    expect(finalSources[0]).toMatchObject({
      source_id: 'vault', sync_status: 'first_sync',
      embed_backfill: { status: 'manual_drain_required', command: 'gbrain embed --stale --source vault' },
    });
    expect(finalSources[1]).toMatchObject({
      source_id: 'vault-two', sync_status: 'first_sync',
      embed_backfill: { status: 'manual_drain_required', command: 'gbrain embed --stale --source vault-two' },
    });
    await expectNoEmbedBackfillRow();
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
    expect(stdout).toContain('"gate":"manual_drain_required"');
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
    expect(stdout).not.toContain('"gate":"manual_drain_required"');
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
    expect(stdout).not.toContain('"gate":"manual_drain_required"');
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
    expect(stdout).not.toContain('"gate":"manual_drain_required"');
  }, 60_000);

  test('sync.cost_gate_min_usd=off → floor renders "unlimited", never blocks', async () => {
    stubOfflineEmbed();
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.setConfig('sync.cost_gate_min_usd', 'off');

    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"floorUsd":"unlimited"');
    expect(stdout).not.toContain('"gate":"manual_drain_required"');
  }, 60_000);

  test('format split (#1784/D3A): non-TTY WITHOUT --json emits human text, no JSON envelope', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    // No --json: above floor in a non-TTY PGLite session → manual drain text.
    const { exitCode, stdout } = await runSyncCaptured(['--all', '--serial', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).not.toContain('"gate":'); // no JSON envelope without --json
    expect(stdout.toLowerCase()).toContain('manual drain required');
    expect(stdout).toContain('gbrain embed --stale --source vault');
    expect(stdout).toContain('spend.posture'); // self-describing hint present
  }, 60_000);

  test('single-source PGLite sync reports manual drain in gate + final JSON and writes no row', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.setConfig('sync.cost_gate_min_usd', '0');

    // Single-source (no --all): unsynced → ceiling > 0 → non-TTY auto-defer.
    const { exitCode, stdout } = await runSyncCaptured(['--source', 'vault', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"manual_drain_required"');
    expect(stdout).toContain('gbrain embed --stale --source vault');
    const final = jsonLines(stdout).find((line) => line.schema_version === 1 && line.source_id === 'vault');
    expect(final).toMatchObject({
      sync_status: 'first_sync',
      embed_backfill: {
        status: 'manual_drain_required',
        command: 'gbrain embed --stale --source vault',
      },
    });
    await expectNoEmbedBackfillRow();
  }, 60_000);

  test('single-source PGLite large incremental deferral reports manual drain in final JSON without a row', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`,
      [headSha, String(CHUNKER_VERSION)],
    );
    await engine.setConfig('sync.cost_gate_min_usd', '1000');
    commitLargeIncrementalDrop();

    const { exitCode, stdout } = await runSyncCaptured(['--source', 'vault', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"below_floor"');
    const final = jsonLines(stdout).find((line) => line.schema_version === 1 && line.source_id === 'vault');
    expect(final).toMatchObject({
      sync_status: 'synced',
      added: 101,
      embedded: 0,
      embed_backfill: {
        status: 'manual_drain_required',
        command: 'gbrain embed --stale --source vault',
      },
    });
    await expectNoEmbedBackfillRow();
  }, 120_000);

  test('PGLite sync --all large incremental deferral reports per-source manual drain without a row', async () => {
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1, chunker_version = $2 WHERE id = 'vault'`,
      [headSha, String(CHUNKER_VERSION)],
    );
    await engine.setConfig('sync.cost_gate_min_usd', '1000');
    commitLargeIncrementalDrop();

    const { exitCode, stdout } = await runSyncCaptured(['--all', '--json', '--no-pull']);

    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('"gate":"below_floor"');
    const final = jsonLines(stdout).find((line) => line.schema_version === 1 && Array.isArray(line.sources));
    expect(final).toBeDefined();
    expect(final!.sources).toEqual([
      expect.objectContaining({
        source_id: 'vault',
        sync_status: 'synced',
        added: 101,
        embedded: 0,
        embed_backfill: {
          status: 'manual_drain_required',
          command: 'gbrain embed --stale --source vault',
          reason: 'no_worker_surface',
        },
      }),
    ]);
    await expectNoEmbedBackfillRow();
  }, 120_000);
});
