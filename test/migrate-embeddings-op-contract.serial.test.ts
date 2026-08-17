/**
 * `migrate_embeddings` OP-path contract pins (the flatten seam).
 *
 * The op handler (src/core/operations.ts) consumes the SAME orchestrator as
 * the CLI (planMigrationFlow/executeMigrationFlow in
 * src/commands/migrate-embeddings.ts) and flattens MigrationFlowResult's
 * tagged union into the op's historical envelope. These tests pin that
 * flatten so a refactor of either surface can't silently change the shapes
 * MCP/op consumers key on:
 *
 *   1. Remote guard: ctx.remote !== false throws (belt-and-braces on top of
 *      localOnly) — admin scope + localOnly pinned too.
 *   2. refused_env: GBRAIN_EMBEDDING_* pointing at a DIFFERENT model than the
 *      target flattens to {status:'refused', reason:'env_override', warning,
 *      plan} and leaves NO migration marker behind.
 *   3. retarget flatten: a live different-target marker refuses a live run as
 *      {status:'refused', reason:'retarget_required', inflight, plan}
 *      (same reason string as the CLI's --json envelope); dry_run bypasses
 *      the plan-stage refusal and returns 'planned'.
 *   4. locked flatten: a held GLOBAL_MIGRATION_LOCK_ID surfaces as
 *      {status:'locked', holder, detail, plan} — the SAME shape as the CLI
 *      --json envelope, so remote callers keep the holder discriminator
 *      (migration vs embed_backfill) and can pick the right remediation.
 *   5. verified skip: a converged brain returns {status:'skipped_no_work',
 *      plan, verified:{complete:true}} on the second call, with ZERO embed
 *      spend.
 *
 * Every envelope must also survive JSON.stringify round-trip (op results
 * travel over MCP as JSON — a non-serializable payload is a contract bug).
 *
 * Serial: temp GBRAIN_HOME + fake embedding transport for the file's
 * lifecycle. CRITICAL harness rule: after EVERY configureGateway/resetGateway
 * the fake transport must be re-installed or tests hit the real API
 * (configureGateway itself preserves transports; resetGateway wipes them).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { GLOBAL_MIGRATION_LOCK_ID } from '../src/commands/migrate-embeddings.ts';
import {
  MIGRATION_STATE_KEY,
  readMigrationState,
  type MigrationState,
  type EnvOverrideWarning,
} from '../src/core/embedding-migration.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';

const FROM_MODEL = 'zeroentropyai:zembed-1';
const FROM_DIMS = 1280;
const TO_MODEL = 'openai:text-embedding-3-small';
const TO_DIMS = 1536;

const op = operationsByName['migrate_embeddings']!;

let engine: PGLiteEngine;
let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};
let currentDims = FROM_DIMS;
let embeddedTexts: string[] = [];

function installTransport(): void {
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    for (const v of values) {
      if (!v.includes('probe')) embeddedTexts.push(v);
    }
    return {
      embeddings: values.map(() => new Array(currentDims).fill(0).map((_, i) => Math.sin(i) * 0.01 + 0.001)),
      usage: { tokens: values.length * 4 },
    } as never;
  });
}

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: false,
    ...over,
  } as OperationContext;
}

/** Op results travel over MCP as JSON — pin serializability cheaply. */
function expectJsonRoundTrip(res: unknown): void {
  const s = JSON.stringify(res);
  expect(typeof s).toBe('string');
  const parsed = JSON.parse(s) as { status?: string };
  expect(parsed.status).toBe((res as { status: string }).status);
}

interface OpEnvelope {
  status: string;
  reason?: string;
  holder?: string;
  detail?: string;
  warning?: EnvOverrideWarning;
  inflight?: MigrationState;
  plan?: { to_model: string; to_dims: number };
  verified?: { complete: boolean; blockers: string[] };
  embedded?: number;
  remaining?: number;
  verify_search?: { status: string };
}

async function runOp(params: Record<string, unknown>): Promise<OpEnvelope> {
  return (await op.handler(ctx(), params)) as OpEnvelope;
}

beforeAll(async () => {
  for (const k of [
    'GBRAIN_HOME', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS',
    'OPENAI_API_KEY', 'ZEROENTROPY_API_KEY', 'VOYAGE_API_KEY', 'DATABASE_URL',
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-op-contract-'));
  process.env.GBRAIN_HOME = tmpHome;
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    embedding_model: FROM_MODEL,
    embedding_dimensions: FROM_DIMS,
    zeroentropy_api_key: 'ze-test-fake',
    openai_api_key: 'sk-test-fake',
  }, null, 2));

  resetGateway();
  configureGateway({
    embedding_model: FROM_MODEL,
    embedding_dimensions: FROM_DIMS,
    env: { ZEROENTROPY_API_KEY: 'ze-test-fake', OPENAI_API_KEY: 'sk-test-fake' },
  });
  installTransport();

  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: FROM_DIMS } as never);
  await engine.initSchema();

  // Seed a small brain embedded at the FROM provider so the live run has
  // real invalidation + drain work.
  for (const slug of ['op-a', 'op-b']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nbody of ${slug}` });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: `chunk of ${slug}`, chunk_source: 'compiled_truth', token_count: 4 },
    ]);
  }
  await runEmbedCore(engine, { stale: true, quiet: true });
}, 60000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(tmpHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('migrate_embeddings op envelope contract', () => {
  test('admin scope + localOnly + remote belt-and-braces guard', async () => {
    expect(op.scope).toBe('admin');
    expect(op.localOnly).toBe(true);
    // Belt-and-braces on top of localOnly: anything not strictly
    // remote:false throws before the orchestrator is even imported.
    await expect(
      op.handler(ctx({ remote: true }), { to: TO_MODEL, dim: TO_DIMS }),
    ).rejects.toThrow(/local-only/);
  }, 30000);

  test('refused_env: env pointing at a different model flattens to refused/env_override with warning + plan', async () => {
    process.env.GBRAIN_EMBEDDING_MODEL = FROM_MODEL; // != TO_MODEL
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(FROM_DIMS); // != TO_DIMS
    currentDims = TO_DIMS; // the pre-apply live probe embeds at TARGET width
    try {
      const res = await runOp({ to: TO_MODEL, dim: TO_DIMS, yes: true });
      expect(res.status).toBe('refused');
      expect(res.reason).toBe('env_override');
      expect(res.warning?.triggered).toBe(true);
      const varNames = (res.warning?.vars ?? []).map((v) => v.name);
      expect(varNames).toContain('GBRAIN_EMBEDDING_MODEL');
      expect(varNames).toContain('GBRAIN_EMBEDDING_DIMENSIONS');
      expect(res.plan?.to_model).toBe(TO_MODEL);
      expect(res.plan?.to_dims).toBe(TO_DIMS);
      expectJsonRoundTrip(res);
      // The env refusal fires BEFORE the marker write — a refused run must
      // not leave a resumable migration marker behind.
      const marker = await readMigrationState(engine);
      expect(marker.state).toBeNull();
    } finally {
      delete process.env.GBRAIN_EMBEDDING_MODEL;
      delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
      currentDims = FROM_DIMS;
    }
  }, 30000);

  test('retarget flatten: live different-target marker refuses as refused/retarget_required; dry_run bypasses to planned', async () => {
    await engine.setConfig(MIGRATION_STATE_KEY, JSON.stringify({
      version: 2,
      to_model: 'voyage:voyage-4',
      to_dims: 1024,
      from_model: FROM_MODEL,
      from_dims: FROM_DIMS,
      started_at: '2026-08-01T00:00:00.000Z',
    } satisfies MigrationState));
    try {
      // Live-run intent WITHOUT retarget: refused at the plan stage (mirrors
      // the CLI ordering — retarget decision precedes any skip/execute).
      const refused = await runOp({ to: TO_MODEL, dim: TO_DIMS, yes: true });
      expect(refused.status).toBe('refused');
      expect(refused.reason).toBe('retarget_required');
      expect(refused.inflight?.to_model).toBe('voyage:voyage-4');
      expect(refused.inflight?.to_dims).toBe(1024);
      expect(refused.plan?.to_model).toBe(TO_MODEL);
      expectJsonRoundTrip(refused);

      // Marker untouched by the refusal.
      const marker = await readMigrationState(engine);
      expect(marker.state?.to_model).toBe('voyage:voyage-4');

      // dry_run explicitly bypasses the plan-stage retarget refusal
      // (`p.dry_run !== true` in the guard) and renders the plan instead.
      const dry = await runOp({ to: TO_MODEL, dim: TO_DIMS, dry_run: true });
      expect(dry.status).toBe('planned');
      expect(dry.plan?.to_model).toBe(TO_MODEL);
      expectJsonRoundTrip(dry);
    } finally {
      await engine.unsetConfig(MIGRATION_STATE_KEY);
    }
  }, 30000);

  test("locked flatten: held global migration lock reports status:'locked' with the holder discriminator", async () => {
    // Hold the brain-wide migration lock as a live foreign holder. The op's
    // executeMigrationFlow tryAcquire sees a live row and yields 'locked',
    // which the op surfaces with the SAME shape as the CLI --json envelope —
    // the holder discriminator is what tells a remote caller whether to wait
    // out another migration or an embed backfill.
    const held = await tryAcquireDbLock(engine, GLOBAL_MIGRATION_LOCK_ID, 60);
    expect(held).not.toBeNull();
    try {
      const res = await runOp({ to: TO_MODEL, dim: TO_DIMS, yes: true });
      expect(res.status).toBe('locked');
      expect(res.holder).toBe('migration');
      expect(res.detail).toContain('migration lock');
      expect(res.plan?.to_model).toBe(TO_MODEL);
      expectJsonRoundTrip(res);
    } finally {
      await held!.release();
    }
  }, 30000);

  test('live run completes; second call returns skipped_no_work with the verify payload and zero embed spend', async () => {
    currentDims = TO_DIMS;
    embeddedTexts = [];
    const completed = await runOp({ to: TO_MODEL, dim: TO_DIMS, yes: true });
    expect(completed.status).toBe('completed');
    expect(completed.remaining).toBe(0);
    expect(Number(completed.embedded)).toBeGreaterThan(0);
    expect(completed.verify_search?.status).toBeDefined();
    expect(completed.plan?.to_model).toBe(TO_MODEL);
    expectJsonRoundTrip(completed);
    expect(embeddedTexts.length).toBeGreaterThan(0); // real drain work happened
    // Completion clears the marker.
    const marker = await readMigrationState(engine);
    expect(marker.state).toBeNull();

    // Converged brain: the DB-verified skip fires on the second call — no
    // work, no spend, verify payload attached.
    embeddedTexts = [];
    const skipped = await runOp({ to: TO_MODEL, dim: TO_DIMS, yes: true });
    expect(skipped.status).toBe('skipped_no_work');
    expect(skipped.verified?.complete).toBe(true);
    expect(skipped.plan?.to_model).toBe(TO_MODEL);
    expectJsonRoundTrip(skipped);
    expect(embeddedTexts.length).toBe(0);
  }, 60000);
});
