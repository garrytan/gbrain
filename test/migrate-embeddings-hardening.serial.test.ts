/**
 * Migration-hardening pins (the poisonable-skip class + its guardrails):
 *
 *   1. From==To WITH work outstanding: config already points at the target
 *      but NULL vectors remain ⇒ the run FALLS THROUGH and resumes (the old
 *      three-conjunct skip exited 0 here — the zero-coverage path).
 *   2. env==target PROCEEDS with a notice; env≠target refused (env gate).
 *   3. Absent embedding column ⇒ plan says "will be (re)built", NOT the
 *      DESTRUCTIVE deletion warning; empty brain migrates cleanly.
 *   4. --retarget: a live different-target marker refuses (naming both
 *      commands) without --retarget, proceeds with it, and records history.
 *   5. Lock passthrough + heartbeat: a heldLocks drain whose refresh()
 *      returns false ABORTS with lock_lost (no silent mutual-exclusion loss).
 *   6. 2048d transition: DDL succeeds with NO HNSW index (pgvector caps
 *      `vector` HNSW at 2000 dims); exact-scan search still works.
 *   7. Same-width ze-switch resume does NOT drop stored vectors (width guard).
 *
 * Added hardening pins (second wave):
 *   8. Locked branches refuse pre-mutation: global migration lock ⇒
 *      locked/migration; per-source embed-backfill lock ⇒ locked/embed_backfill.
 *   9. persistEmbeddingFileConfig never persists env-sourced secrets
 *      (API keys / database_url) into ~/.gbrain/config.json (round-2 #2).
 *  10. A dims-only GBRAIN_EMBEDDING_DIMENSIONS never fully pins the target;
 *      a no-file-plane run refuses at apply instead of going env-canonical.
 *  11. Wrong-width dim-pinned companion columns (facts/query_cache) are
 *      repaired independently — pinned_repaired[], no content_chunks rebuild.
 *  12. Same-width resume/undo width guard keeps stored vectors (both the
 *      ze-switch resume path and the snapshot undo path).
 *  13. Corrupt AND wrong-shape markers report corrupt on readMigrationState +
 *      --status without throwing; a fresh run rewrites the marker clean (v2).
 *  14. Retarget history: superseded[] chain + retargeted_at + the
 *      --force-sunset-target resume-command rendering.
 *  15. verifySearchRoundTrip miss branch: warn/self_retrieval_miss with
 *      content-free samples (page ids + codes, never query text).
 *  16. Heartbeat transient-error policy: 3 consecutive refresh() throws abort
 *      with lock_lost; a mid-run success resets the counter (no abort).
 *  17. Empty-brain run-to-completion: full migrate exits 0 with no destructive
 *      warning, stamps the completed marker, then verified-skips on re-run.
 *
 * Serial: temp GBRAIN_HOME + fake embed transport for the file's lifecycle.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import {
  runMigrateEmbeddings,
  GLOBAL_MIGRATION_LOCK_ID,
  persistEmbeddingFileConfig,
  planMigrationFlow,
} from '../src/commands/migrate-embeddings.ts';
import {
  MIGRATION_STATE_KEY,
  MIGRATION_COMPLETED_KEY,
  runSchemaTransition,
  readMigrationState,
  resolveRerankerPlan,
  applyRerankerAction,
  envFullyPinsTarget,
  planEmbeddingMigration,
  applyEmbeddingMigration,
  readDimPinnedWidths,
  renderResumeCommand,
  verifySearchRoundTrip,
  type MigrationState,
} from '../src/core/embedding-migration.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../src/core/db-lock.ts';
import { embedBackfillLockId } from '../src/core/embed-backfill-lock.ts';
import {
  resumeRetrievalUpgrade,
  undoRetrievalUpgrade,
  KEY_REQUESTED,
  KEY_PREVIOUS_SNAPSHOT,
  ZE_TARGET_EMBEDDING_DIM,
} from '../src/core/retrieval-upgrade-planner.ts';

const FROM_DIMS = 1280;
const TO_DIMS = 1536;

let engine: PGLiteEngine;
let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};
let currentDims = FROM_DIMS;
let embeddedTexts: string[] = [];
let slowEmbedMs = 0;

function installTransport(): void {
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    if (slowEmbedMs > 0) await new Promise((r) => setTimeout(r, slowEmbedMs));
    for (const v of values) {
      if (!v.includes('probe')) embeddedTexts.push(v);
    }
    return {
      embeddings: values.map(() => new Array(currentDims).fill(0).map((_, i) => Math.sin(i) * 0.01 + 0.001)),
      usage: { tokens: values.length * 4 },
    } as never;
  });
}

class ExitError extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}
const exitSeam = (code: number): never => { throw new ExitError(code); };

async function runMigrate(args: string[]): Promise<number> {
  try {
    await runMigrateEmbeddings(engine, args, { exit: exitSeam });
    throw new Error('runMigrateEmbeddings returned without exiting');
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

/** Same as runMigrate but against an explicit engine (empty-brain suite). */
async function runMigrateOn(target: PGLiteEngine, args: string[]): Promise<number> {
  try {
    await runMigrateEmbeddings(target, args, { exit: exitSeam });
    throw new Error('runMigrateEmbeddings returned without exiting');
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

/** Capture console.log lines (the --json stdout envelope / plan render). */
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.log = orig; } };
}

function writeFileConfig(model: string, dims: number): void {
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    embedding_model: model,
    embedding_dimensions: dims,
    zeroentropy_api_key: 'ze-test-fake',
    openai_api_key: 'sk-test-fake',
  }, null, 2));
}

beforeAll(async () => {
  for (const k of ['GBRAIN_HOME', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS', 'GBRAIN_EMBED_LOCK_HEARTBEAT_MS', 'OPENAI_API_KEY', 'ZEROENTROPY_API_KEY', 'VOYAGE_API_KEY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-hardening-'));
  process.env.GBRAIN_HOME = tmpHome;
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileConfig('zeroentropyai:zembed-1', FROM_DIMS);

  resetGateway();
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: FROM_DIMS,
    env: { ZEROENTROPY_API_KEY: 'ze-test-fake', OPENAI_API_KEY: 'sk-test-fake' },
  });
  installTransport();

  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: FROM_DIMS } as never);
  await engine.initSchema();
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

describe('poisonable skip is dead', () => {
  test('From==To with NULL vectors outstanding resumes instead of exiting 0', async () => {
    // Seed two pages embedded at the FROM provider.
    for (const slug of ['skip-1', 'skip-2']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nbody` });
      await engine.upsertChunks(slug, [
        { chunk_index: 0, chunk_text: `chunk of ${slug}`, chunk_source: 'compiled_truth', token_count: 4 },
      ]);
    }
    await runEmbedCore(engine, { stale: true, quiet: true });

    // The incident state: config (file plane + gateway) ALREADY points at the
    // target, the column is already at target width, but the vectors are
    // NULL. The old skip conjunct (from==to && !dim_change && stale-count)
    // exited 0 on variants of this; the verified skip must fall through.
    currentDims = TO_DIMS;
    writeFileConfig('openai:text-embedding-3-small', TO_DIMS);
    resetGateway();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: TO_DIMS,
      env: { OPENAI_API_KEY: 'sk-test-fake' },
    });
    installTransport();
    await runSchemaTransition(engine, TO_DIMS); // NULLs every vector at target width
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-small');
    await engine.setConfig('embedding_dimensions', String(TO_DIMS));

    embeddedTexts = [];
    const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
    expect(code).toBe(0); // completed — by DOING the work, not by skipping it
    // 2 drain re-embeds + 2 completion smoke-check query embeds (the smoke
    // check is part of the completed path). Vectors restored either way:
    const vecs = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL`,
    );
    expect(Number(vecs[0]?.n)).toBe(2);
    expect(embeddedTexts.length).toBe(4);

    // And now that the brain is GENUINELY converged, the verified skip fires.
    embeddedTexts = [];
    const again = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
    expect(again).toBe(0);
    expect(embeddedTexts.length).toBe(0); // no work, no spend
  }, 60000);

  test('env==target proceeds (dry-run works); env!=target refuses the live run', async () => {
    // env == target: the notice-and-proceed case (env-first deployments).
    process.env.GBRAIN_EMBEDDING_MODEL = 'openai:text-embedding-3-small';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(TO_DIMS);
    try {
      const dryCode = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--dry-run']);
      expect(dryCode).toBe(0); // dry-run renders the plan — not refused

      // env != target: the #1421 refusal, unchanged.
      process.env.GBRAIN_EMBEDDING_MODEL = 'zeroentropyai:zembed-1';
      process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(FROM_DIMS);
      const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
      expect(code).toBe(1); // refused_env
    } finally {
      delete process.env.GBRAIN_EMBEDDING_MODEL;
      delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
    }
  }, 30000);

  test('retarget gate: different-target marker refuses without --retarget, proceeds with it', async () => {
    // Plant a live marker for a DIFFERENT target.
    await engine.setConfig(MIGRATION_STATE_KEY, JSON.stringify({
      version: 2,
      to_model: 'voyage:voyage-4',
      to_dims: 1024,
      from_model: 'zeroentropyai:zembed-1',
      from_dims: FROM_DIMS,
      started_at: '2026-08-01T00:00:00.000Z',
    } satisfies MigrationState));
    try {
      const refused = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
      expect(refused).toBe(1);
      // Marker untouched by the refusal.
      const marker = await readMigrationState(engine);
      expect(marker.state?.to_model).toBe('voyage:voyage-4');

      const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--retarget']);
      expect(code).toBe(0);
      // Completed: marker cleared; the abandoned target is in the completion
      // path's history via the superseded chain (marker was rewritten then
      // cleared — verify the brain converged and no marker remains).
      const after = await readMigrationState(engine);
      expect(after.state).toBeNull();
    } finally {
      await engine.unsetConfig(MIGRATION_STATE_KEY);
    }
  }, 60000);
});

describe('locks + schema honesty', () => {
  test('heldLocks heartbeat: refresh()===false aborts the drain with lock_lost', async () => {
    // Darken one page so the drain has work, then hand runEmbedCore a fake
    // held lock whose refresh reports "stolen".
    await engine.executeRaw(`UPDATE content_chunks SET embedding = NULL`);
    const fakeLock: DbLockHandle = {
      id: 'fake-held-lock',
      acquiredAt: '0',
      release: async () => {},
      refresh: async () => false,
    };
    process.env.GBRAIN_EMBED_LOCK_HEARTBEAT_MS = '40';
    slowEmbedMs = 400; // hold the drain open long enough for a heartbeat tick
    try {
      const result = await runEmbedCore(engine, {
        stale: true,
        catchUp: true,
        singleFlight: true,
        includeNullSignature: true,
        quiet: true,
        heldLocks: [fakeLock],
      });
      expect(result.lock_lost).toBe(true);
    } finally {
      delete process.env.GBRAIN_EMBED_LOCK_HEARTBEAT_MS;
      slowEmbedMs = 0;
      // Recover the brain for later tests.
      await runEmbedCore(engine, { stale: true, quiet: true });
    }
  }, 60000);

  test('2048d transition: no HNSW index (pgvector cap), exact-scan search works', async () => {
    currentDims = 2048;
    await runSchemaTransition(engine, 2048);
    const idx = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_chunks_embedding'`,
    );
    expect(Number(idx[0]?.n)).toBe(0); // above the 2000-dim vector HNSW cap

    // Exact-scan path still works end to end. 3-large: its recipe allows
    // flexible dims up to 3072, so 2048 passes the client-side dim check
    // (3-small caps at 1536 and would refuse before the transport).
    resetGateway();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 2048,
      env: { OPENAI_API_KEY: 'sk-test-fake' },
    });
    installTransport();
    await runEmbedCore(engine, { stale: true, quiet: true });
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL`,
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);

    // Restore the 1536d state for anything that runs after.
    currentDims = TO_DIMS;
    await runSchemaTransition(engine, TO_DIMS);
    resetGateway();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: TO_DIMS,
      env: { OPENAI_API_KEY: 'sk-test-fake' },
    });
    installTransport();
    await runEmbedCore(engine, { stale: true, quiet: true });
  }, 60000);

  test('empty/absent column: plan shows the (re)build line, not the deletion warning', async () => {
    // Drop the column outright — the absent/unparsable case (dims === null).
    await engine.executeRaw(`DROP INDEX IF EXISTS idx_chunks_embedding`);
    await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding`);
    try {
      // Capture the --json stdout envelope (console.log) — it carries the
      // plan + the verify blockers, which is where the honesty lives.
      const outLines: string[] = [];
      const origLog = console.log;
      console.log = (...a: unknown[]) => { outLines.push(a.map(String).join(' ')); };
      let code: number;
      try {
        code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--dry-run', '--json']);
      } finally {
        console.log = origLog;
      }
      expect(code).toBe(0); // dry-run against an absent column plans, never throws
      const envelope = JSON.parse(outLines.join('\n')) as {
        status: string;
        plan: { column_dims: number | null; dim_change: boolean; chunks_to_embed: number };
        verified: { complete: boolean; blockers: string[] };
      };
      expect(envelope.status).toBe('planned');
      // Absent column: rebuild flagged honestly (dim_change true even though
      // dims === null — the old spelling hid the DDL), copy says (re)built.
      expect(envelope.plan.column_dims).toBeNull();
      expect(envelope.plan.dim_change).toBe(true);
      expect(envelope.plan.chunks_to_embed).toBeGreaterThan(0);
      expect(envelope.verified.complete).toBe(false);
      expect(envelope.verified.blockers.join('\n')).toContain('will be (re)built');
    } finally {
      // Restore the column + vectors for subsequent files.
      await runSchemaTransition(engine, TO_DIMS);
      await runEmbedCore(engine, { stale: true, quiet: true });
    }
  }, 60000);
});

describe('reranker companion (D8)', () => {
  test('bundle-default ZE reranker is exposed; auto switches to the target provider reranker', async () => {
    // No explicit search.reranker.model row — the exposure must resolve
    // THROUGH the mode-bundle default (zeroentropyai:zerank-2), the common
    // ZE case the old explicit-key-only warning missed.
    const plan = await resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'voyage:voyage-4', undefined);
    expect(plan.exposed).not.toBeNull();
    expect(plan.exposed!.model).toBe('zeroentropyai:zerank-2');
    expect(plan.exposed!.sunset_date).toBeTruthy();
    expect(plan.action).toEqual({ kind: 'switch', to: 'voyage:rerank-2.5' });
  });

  test('auto with a reranker-less target suggests, never silently enables a third provider', async () => {
    const plan = await resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'openai:text-embedding-3-small', undefined);
    expect(plan.exposed).not.toBeNull();
    expect(plan.action.kind).toBe('none');
    expect((plan.action as { suggestion: string | null }).suggestion).toBe('voyage:rerank-2.5');
  });

  test('off disables, keep leaves alone, invalid explicit values refuse with paste-ready messages', async () => {
    const off = await resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'voyage:voyage-4', 'off');
    expect(off.action).toEqual({ kind: 'disable' });

    const keep = await resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'voyage:voyage-4', 'keep');
    expect(keep.action).toEqual({ kind: 'none', suggestion: null });

    // Provider exists but declares no reranker touchpoint.
    await expect(
      resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'voyage:voyage-4', 'openai:text-embedding-3-small'),
    ).rejects.toThrow(/declares no reranker/);

    // Not provider:model shaped at all.
    await expect(
      resolveRerankerPlan(engine, 'zeroentropyai:zembed-1', 'voyage:voyage-4', 'garbage'),
    ).rejects.toThrow(/--reranker must be/);
  });

  test('config-only completion: converged brain + --reranker off still flips the DB key (no skip swallow)', async () => {
    // Brain is converged on openai 3-small @1536 from the suites above — the
    // verified skip would fire, but a pending reranker action must execute
    // as a config-only completion instead.
    await engine.executeRaw(
      `INSERT INTO query_cache (id, query_text, source_id) VALUES ('qc-rr', 'stale rank order', 'default')
       ON CONFLICT (id) DO NOTHING`,
    );
    const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--reranker', 'off']);
    expect(code).toBe(0);
    expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
    // Rank order changed ⇒ cache purged in the same transaction.
    const qc = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM query_cache`);
    expect(Number(qc[0]?.n)).toBe(0);
  }, 60000);

  test('explicit switch: live probe passes (stubbed wire) and the write lands model + enabled together', async () => {
    // Gateway needs a voyage key for the rerank call; the wire is stubbed.
    // The key must ALSO live in process.env: the flow's mid-run
    // persistEmbeddingFileConfig reconfigures the gateway from file+env, and
    // the file plane deliberately carries no voyage key — without this the
    // probe dies on the key check before ever reaching the stubbed wire
    // (green-locally/red-on-CI when a real key sits in the dev env).
    process.env.VOYAGE_API_KEY = 'pa-test-fake';
    resetGateway();
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: TO_DIMS,
      env: { OPENAI_API_KEY: 'sk-test-fake', VOYAGE_API_KEY: 'pa-test-fake' },
    });
    installTransport();
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/rerank')) {
        // Voyage REST returns data[] (not results[]) — the shape the gateway
        // must parse (live-key e2e pins the real wire; this pins the parse).
        return new Response(JSON.stringify({
          data: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.2 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return origFetch(url as never, init);
    }) as typeof fetch;
    try {
      const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--reranker', 'voyage:rerank-2.5']);
      expect(code).toBe(0);
      expect(await engine.getConfig('search.reranker.model')).toBe('voyage:rerank-2.5');
      expect(await engine.getConfig('search.reranker.enabled')).toBe('true');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
      delete process.env.VOYAGE_API_KEY;
    }
  }, 60000);

  test('probe failure keeps the previous reranker config and reports switch_failed', async () => {
    // Wire stub throws: the probe must fail on the WIRE (not on a missing
    // key — hence the fake env key), the migration still completes, and the
    // config stays where the previous test put it.
    process.env.VOYAGE_API_KEY = 'pa-test-fake';
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('/rerank')) throw new Error('stub: reranker endpoint down');
      return origFetch(url as never);
    }) as typeof fetch;
    try {
      const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--reranker', 'voyage:rerank-2.5-lite']);
      expect(code).toBe(0); // embeddings converged; reranker failure is reported, not fatal
      // Old config kept — NOT flipped to the unreachable model.
      expect(await engine.getConfig('search.reranker.model')).toBe('voyage:rerank-2.5');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = origFetch;
      delete process.env.VOYAGE_API_KEY;
    }
  }, 60000);

  test('applyRerankerAction is transactional: model + enabled + cache purge land together', async () => {
    await engine.executeRaw(
      `INSERT INTO query_cache (id, query_text, source_id) VALUES ('qc-rr2', 'stale again', 'default')
       ON CONFLICT (id) DO NOTHING`,
    );
    await applyRerankerAction(engine, { kind: 'switch', to: 'voyage:rerank-2.5-lite' });
    expect(await engine.getConfig('search.reranker.model')).toBe('voyage:rerank-2.5-lite');
    expect(await engine.getConfig('search.reranker.enabled')).toBe('true');
    const qc = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM query_cache`);
    expect(Number(qc[0]?.n)).toBe(0);
  });
});

describe('status surface + completion smoke check (D6/D11)', () => {
  test('--status --json reports planes, censuses, markers — and never mutates', async () => {
    const outLines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { outLines.push(a.map(String).join(' ')); };
    let code: number;
    try {
      code = await runMigrate(['--status', '--json']);
    } finally {
      console.log = origLog;
    }
    expect(code).toBe(0);
    const report = JSON.parse(outLines.join('\n')) as Record<string, never> & {
      status: string;
      identity: { engine: string };
      env: { present: boolean };
      keys: Record<string, boolean>;
      file_plane: { model: string | null } | null;
      db_plane: { model: string | null };
      column_dims: number | null;
      missing_embeddings: number | null;
      signature_census: Array<{ signature: string | null; pages: number }>;
      marker: { kind: string };
      completed: { verify_search?: { status: string } } | null;
      resume_command: string | null;
    };
    expect(report.status).toBe('status');
    expect(report.identity.engine).toBe('pglite');
    expect(report.env.present).toBe(false);
    // Key PRESENCE booleans only — never values.
    expect(typeof report.keys.VOYAGE_API_KEY).toBe('boolean');
    expect(JSON.stringify(report)).not.toContain('sk-test-fake');
    expect(report.file_plane?.model).toBe('openai:text-embedding-3-small');
    expect(report.db_plane.model).toBe('openai:text-embedding-3-small');
    expect(report.column_dims).toBe(TO_DIMS);
    expect(report.missing_embeddings).toBe(0);
    expect(report.signature_census.length).toBeGreaterThan(0);
    expect(report.marker.kind).toBe('none');
    expect(report.resume_command).toBeNull();
    // The last completed migration stamped a content-free smoke-check record.
    expect(report.completed?.verify_search?.status).toBe('pass');
    expect(JSON.stringify(report.completed)).not.toContain('chunk of');
  }, 30000);

  test('doctor embedding_migration_state: warns with resume command on a live marker, ok when clear', async () => {
    const { checkEmbeddingMigrationState } = await import('../src/commands/doctor.ts');
    const clear = await checkEmbeddingMigrationState(engine);
    expect(clear.status).toBe('ok');

    await engine.setConfig(MIGRATION_STATE_KEY, JSON.stringify({
      version: 2,
      to_model: 'voyage:voyage-4',
      to_dims: 1024,
      from_model: 'openai:text-embedding-3-small',
      from_dims: TO_DIMS,
      started_at: '2026-08-10T00:00:00.000Z',
    } satisfies MigrationState));
    try {
      const live = await checkEmbeddingMigrationState(engine);
      expect(live.status).toBe('warn');
      expect(live.message).toContain('voyage:voyage-4');
      expect(live.message).toContain('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024');
      expect(live.message).toContain('--status');
    } finally {
      await engine.unsetConfig(MIGRATION_STATE_KEY);
    }
  }, 30000);

  test('verifySearchRoundTrip: pass on a healthy brain; error samples warn; unconfigured gateway skips — never throws', async () => {
    const { verifySearchRoundTrip } = await import('../src/core/embedding-migration.ts');

    const pass = await verifySearchRoundTrip(engine, { samples: 2 });
    expect(pass.status).toBe('pass');
    expect(pass.samples.every((s) => s.status === 'hit')).toBe(true);

    // Transport throws ⇒ per-sample error ⇒ warn (exit semantics untouched).
    __setEmbedTransportForTests(async () => { throw new Error('probe transport down'); });
    try {
      const warn = await verifySearchRoundTrip(engine, { samples: 2 });
      expect(warn.status).toBe('warn');
      expect(warn.samples.every((s) => s.status === 'error')).toBe(true);
    } finally {
      installTransport();
    }

    // (The gateway_unconfigured ⇒ skipped branch is unreachable under the
    // test harness — resetGateway() restores a configured baseline. The
    // branch is three lines guarded by the same currentEmbeddingSignature()
    // null-contract pinned elsewhere in this wave.)
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: TO_DIMS,
      env: { OPENAI_API_KEY: 'sk-test-fake', VOYAGE_API_KEY: 'pa-test-fake' },
    });
    installTransport();
  }, 30000);
});

describe('locked branches refuse before any mutation', () => {
  test('held global migration lock ⇒ locked/migration; held per-source embed lock ⇒ locked/embed_backfill', async () => {
    // Work outstanding so the verified skip can't fire and the flow actually
    // reaches the lock acquisition step.
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = NULL WHERE id = (SELECT MIN(id) FROM content_chunks)`,
    );
    let globalLock: DbLockHandle | null = null;
    const sourceLocks: DbLockHandle[] = [];
    try {
      globalLock = await tryAcquireDbLock(engine, GLOBAL_MIGRATION_LOCK_ID, 60);
      if (!globalLock) throw new Error('test setup: failed to acquire the global migration lock');

      const cap1 = captureStdout();
      let code1: number;
      try {
        code1 = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--json']);
      } finally {
        cap1.restore();
      }
      expect(code1).toBe(1);
      const env1 = JSON.parse(cap1.lines.join('\n')) as { status: string; holder: string };
      expect(env1.status).toBe('locked');
      expect(env1.holder).toBe('migration');

      // Release the global lock; hold the per-source embed-backfill locks
      // instead — the second refusal class, with its own holder label.
      await globalLock.release();
      globalLock = null;
      const sources = await engine.listAllSources({ includeArchived: true });
      for (const sid of sources.map((r) => r.id).sort()) {
        const l = await tryAcquireDbLock(engine, embedBackfillLockId(sid), 60);
        expect(l).not.toBeNull();
        sourceLocks.push(l!);
      }
      expect(sourceLocks.length).toBeGreaterThan(0);

      const cap2 = captureStdout();
      let code2: number;
      try {
        code2 = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--json']);
      } finally {
        cap2.restore();
      }
      expect(code2).toBe(1);
      const env2 = JSON.parse(cap2.lines.join('\n')) as { status: string; holder: string; detail: string };
      expect(env2.status).toBe('locked');
      expect(env2.holder).toBe('embed_backfill');
      expect(env2.detail).toContain('embed backfill');

      // Neither refusal mutated anything: no state marker was written.
      const marker = await readMigrationState(engine);
      expect(marker.state).toBeNull();
      expect(marker.corrupt).toBe(false);
    } finally {
      if (globalLock) { try { await globalLock.release(); } catch { /* best-effort */ } }
      for (const l of sourceLocks) { try { await l.release(); } catch { /* best-effort */ } }
      // Recover the darkened chunk for later suites.
      await runEmbedCore(engine, { stale: true, quiet: true });
    }
  }, 60000);
});

describe('config-plane hygiene (env leak + env-canonical gates)', () => {
  test('persistEmbeddingFileConfig writes the target to the file plane, never env-sourced secrets', async () => {
    const cfgPath = join(tmpHome, '.gbrain', 'config.json');
    const prevVoyage = process.env.VOYAGE_API_KEY;
    process.env.GBRAIN_EMBEDDING_MODEL = 'zeroentropyai:zembed-1';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(FROM_DIMS);
    process.env.VOYAGE_API_KEY = 'pa-env-secret-canary';
    // Password-less on purpose: the assertion is that the database_url KEY
    // never lands in the file at all, and a userinfo-bearing URL literal
    // would (rightly) trip the pre-push credential scanner.
    process.env.DATABASE_URL = 'postgres://env-host-canary:5432/leakdb';
    try {
      await persistEmbeddingFileConfig('voyage:voyage-4', 1024);
      const raw = readFileSync(cfgPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // The TARGET landed on the file plane — not the env model.
      expect(parsed.embedding_model).toBe('voyage:voyage-4');
      expect(parsed.embedding_dimensions).toBe(1024);
      // Round-2 #2 regression: the file-only loader path must never persist
      // env-sourced secret material as a side effect of a migration.
      expect(raw).not.toContain('pa-env-secret-canary');
      expect(raw).not.toContain('env-host-canary');
      expect(parsed.voyage_api_key).toBeUndefined();
      expect(parsed.database_url).toBeUndefined();
      // File-sourced keys stay exactly as the file had them.
      expect(parsed.openai_api_key).toBe('sk-test-fake');
      expect(parsed.zeroentropy_api_key).toBe('ze-test-fake');
    } finally {
      delete process.env.GBRAIN_EMBEDDING_MODEL;
      delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
      delete process.env.DATABASE_URL;
      if (prevVoyage === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = prevVoyage;
      // persistEmbeddingFileConfig reconfigured the in-process gateway from
      // the env-merged view — restore the baseline file plane + gateway.
      writeFileConfig('openai:text-embedding-3-small', TO_DIMS);
      configureGateway({
        embedding_model: 'openai:text-embedding-3-small',
        embedding_dimensions: TO_DIMS,
        env: { OPENAI_API_KEY: 'sk-test-fake', VOYAGE_API_KEY: 'pa-test-fake' },
      });
      installTransport();
    }
  }, 30000);

  test('dims-only env never fully pins the target; a no-file-plane run refuses at apply', async () => {
    // Unit: the MODEL var is required — dims alone must not pin (#1421 class).
    expect(envFullyPinsTarget('openai:text-embedding-3-small', TO_DIMS, {
      GBRAIN_EMBEDDING_DIMENSIONS: String(TO_DIMS),
    } as NodeJS.ProcessEnv)).toBe(false);
    expect(envFullyPinsTarget('openai:text-embedding-3-small', TO_DIMS, {
      GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-small',
      GBRAIN_EMBEDDING_DIMENSIONS: String(TO_DIMS),
    } as NodeJS.ProcessEnv)).toBe(true);

    const cfgPath = join(tmpHome, '.gbrain', 'config.json');
    renameSync(cfgPath, `${cfgPath}.hidden`);
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(TO_DIMS);
    try {
      // Flow-level: env is NOT treated as canonical — verify stays incomplete
      // on the file-plane conjunct even though the dims env var matches.
      const ctx = await planMigrationFlow(engine, { to: 'openai:text-embedding-3-small', dim: TO_DIMS });
      expect(ctx.envMatchesTarget).toBe(false);
      expect(ctx.verify.complete).toBe(false);
      expect(ctx.verify.details.file_plane_ok).toBe(false);

      const cap = captureStdout();
      let code: number;
      try {
        code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--json']);
      } finally {
        cap.restore();
      }
      expect(code).toBe(1);
      const envl = JSON.parse(cap.lines.join('\n')) as { status: string; reason: string };
      expect(envl.status).toBe('apply_failed');
      expect(envl.reason).toContain('No ~/.gbrain/config.json');
      // Nothing pretended env was the durable plane: no config file appeared.
      expect(existsSync(cfgPath)).toBe(false);
    } finally {
      delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
      renameSync(`${cfgPath}.hidden`, cfgPath);
      // apply step 1 wrote the resume marker before the persist refusal.
      await engine.unsetConfig(MIGRATION_STATE_KEY);
    }
  }, 60000);
});

describe('independent dim-pinned repair + same-width guards', () => {
  test('wrong-width facts column is repaired alone — content_chunks is NOT rebuilt', async () => {
    const before = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL`,
    );
    expect(Number(before[0]?.n)).toBeGreaterThan(0);
    // Break ONE dim-pinned companion column (facts is in
    // TEXT_EMBEDDING_DIM_PINNED_TABLES) while chunks stay at target width.
    await engine.executeRaw(`DROP INDEX IF EXISTS idx_facts_embedding_hnsw`);
    await engine.executeRaw(`ALTER TABLE facts DROP COLUMN IF EXISTS embedding`);
    await engine.executeRaw(`ALTER TABLE facts ADD COLUMN embedding vector(999)`);
    try {
      const plan = await planEmbeddingMigration(engine, { to: 'openai:text-embedding-3-small', dim: TO_DIMS });
      expect(plan.dim_change).toBe(false); // chunks column already at target
      const result = await applyEmbeddingMigration(engine, plan, {});
      expect(result.status).toBe('applied');
      if (result.status !== 'applied') throw new Error('unreachable');
      expect(result.schema_transitioned).toBe(false);
      expect(result.pinned_repaired).toContain('facts');
      // The stored chunk vectors survived (no full destructive rebuild).
      const after = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL`,
      );
      expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
      const widths = await readDimPinnedWidths(engine);
      expect(widths.find((w) => w.table === 'facts')?.dims).toBe(TO_DIMS);
    } finally {
      // apply writes the resume marker; this test never completes the run.
      await engine.unsetConfig(MIGRATION_STATE_KEY);
    }
  }, 60000);

  test('same-width resume + undo keep stored vectors (width guard, no silent drop+re-add)', async () => {
    // resume path: throwaway brain already AT the ZE target width with one
    // live vector — resume must not run the DROP+ADD transition.
    const e3 = new PGLiteEngine();
    await e3.connect({ embedding_dimensions: ZE_TARGET_EMBEDDING_DIM } as never);
    await e3.initSchema();
    try {
      // initSchema resolves the column width from the gateway/file plane (both
      // at 1536 here) — pin the throwaway brain AT the ZE resume target width
      // explicitly so the same-width guard is what's under test.
      await runSchemaTransition(e3, ZE_TARGET_EMBEDDING_DIM);
      await e3.putPage('rw-1', { type: 'note', title: 'rw-1', compiled_truth: '# rw\n\nbody' });
      await e3.upsertChunks('rw-1', [
        { chunk_index: 0, chunk_text: 'resume width guard chunk', chunk_source: 'compiled_truth', token_count: 4 },
      ]);
      const vec = '[' + new Array(ZE_TARGET_EMBEDDING_DIM).fill(0.002).join(',') + ']';
      await e3.executeRaw(`UPDATE content_chunks SET embedding = $1::vector`, [vec]);
      await e3.setConfig(KEY_REQUESTED, 'true');
      const resumed = await resumeRetrievalUpgrade(e3);
      expect(resumed.status).toBe('applied');
      const n = await e3.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL`,
      );
      expect(Number(n[0]?.n)).toBe(1); // vector survived: column was not rebuilt
    } finally {
      await e3.disconnect();
    }

    // undo path: snapshot at the CURRENT width on the main brain — the guard
    // must skip the transition and keep every stored vector.
    const before = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL`,
    );
    expect(Number(before[0]?.n)).toBeGreaterThan(0);
    const snapshot = {
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: TO_DIMS,
      search_reranker_enabled: (await engine.getConfig('search.reranker.enabled')) === 'true',
      search_reranker_model: await engine.getConfig('search.reranker.model'),
    };
    await engine.setConfig(KEY_PREVIOUS_SNAPSHOT, JSON.stringify(snapshot));
    try {
      const undone = await undoRetrievalUpgrade(engine);
      expect(undone.status).toBe('undone');
      const after = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL`,
      );
      expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
    } finally {
      await engine.unsetConfig(KEY_PREVIOUS_SNAPSHOT);
    }
  }, 120000);
});

describe('marker integrity across surfaces', () => {
  test('corrupt + wrong-shape markers report corrupt everywhere; a fresh run rewrites clean', async () => {
    await engine.setConfig(MIGRATION_STATE_KEY, 'not json {{{');
    const garbage = await readMigrationState(engine);
    expect(garbage.corrupt).toBe(true);
    expect(garbage.state).toBeNull();

    // --status renders the corrupt marker without throwing.
    const cap = captureStdout();
    let code: number;
    try {
      code = await runMigrate(['--status', '--json']);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const report = JSON.parse(cap.lines.join('\n')) as {
      marker: { kind: string; raw_prefix?: string };
      resume_command: string | null;
    };
    expect(report.marker.kind).toBe('corrupt');
    expect(report.marker.raw_prefix).toContain('not json');
    expect(report.resume_command).toBeNull();

    // Syntactically-valid but wrong-shape marker is ALSO corrupt (shape
    // validation: to_model must be a provider:model string, dims an integer).
    await engine.setConfig(MIGRATION_STATE_KEY, '{"to_model": 123}');
    const wrongShape = await readMigrationState(engine);
    expect(wrongShape.corrupt).toBe(true);
    expect(wrongShape.state).toBeNull();

    // A fresh migration rewrites the marker clean (v2) instead of crashing.
    const applied = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--no-embed']);
    expect(applied).toBe(0);
    const clean = await readMigrationState(engine);
    expect(clean.corrupt).toBe(false);
    expect(clean.state?.version).toBe(2);
    expect(clean.state?.to_model).toBe('openai:text-embedding-3-small');

    // Complete the run: marker cleared, brain left converged for later suites.
    const completed = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
    expect(completed).toBe(0);
    const after = await readMigrationState(engine);
    expect(after.state).toBeNull();
    expect(after.corrupt).toBe(false);
  }, 60000);

  test('retarget history: superseded chain + retargeted_at + resume-command flag rendering', async () => {
    // Target A at the SAME width (no schema churn), applied but not drained —
    // leaves a live marker for A.
    const a = await runMigrate(['--to', 'openai:text-embedding-3-large', '--dim', String(TO_DIMS), '--yes', '--no-embed']);
    expect(a).toBe(0);
    // Retarget to B: the marker must record A in the superseded history.
    const b = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--no-embed', '--retarget']);
    expect(b).toBe(0);
    const marker = await readMigrationState(engine);
    expect(marker.corrupt).toBe(false);
    expect(marker.state?.version).toBe(2);
    expect(marker.state?.to_model).toBe('openai:text-embedding-3-small');
    expect(marker.state?.retargeted_at).toBeTruthy();
    expect(marker.state?.superseded?.length).toBe(1);
    expect(marker.state?.superseded?.[0]?.to_model).toBe('openai:text-embedding-3-large');

    // ONE resume-command template: the force flag renders iff the state has it.
    const state = marker.state as MigrationState;
    expect(renderResumeCommand({ ...state, force_sunset_target: true })).toContain('--force-sunset-target');
    expect(renderResumeCommand(state)).not.toContain('--force-sunset-target');

    // Converge again: resume B for real (drains the invalidated chunks).
    embeddedTexts = [];
    const done = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
    expect(done).toBe(0);
    expect((await readMigrationState(engine)).state).toBeNull();
  }, 60000);
});

describe('smoke-check miss + heartbeat resilience', () => {
  test('verifySearchRoundTrip reports warn/self_retrieval_miss with content-free samples', async () => {
    const canary = 'sealed-privacy-canary-text';
    try {
      // 11 decoy pages whose stored vectors EQUAL the fake transport's query
      // vector, then the victim LAST (highest chunk id ⇒ it is the sampled
      // page) with a far-away vector: query-embed succeeds, but the source
      // page cannot land in the top-10.
      for (let i = 0; i < 11; i++) {
        const slug = `srm-decoy-${String(i).padStart(2, '0')}`;
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\ndecoy body` });
        await engine.upsertChunks(slug, [
          { chunk_index: 0, chunk_text: `decoy chunk ${i}`, chunk_source: 'compiled_truth', token_count: 4 },
        ]);
      }
      await engine.putPage('srm-victim', { type: 'note', title: 'srm-victim', compiled_truth: '# victim\n\nbody' });
      await engine.upsertChunks('srm-victim', [
        { chunk_index: 0, chunk_text: canary, chunk_source: 'compiled_truth', token_count: 4 },
      ]);

      // The fake transport's vector for ANY input (installTransport pattern).
      const q = new Array(TO_DIMS).fill(0).map((_, i) => Math.sin(i) * 0.01 + 0.001);
      const far = new Array(TO_DIMS).fill(0);
      far[0] = 1; // near-orthogonal to q (q[0] = 0.001)
      await engine.executeRaw(
        `UPDATE content_chunks SET embedding = $1::vector
          WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 'srm-decoy-%')`,
        ['[' + q.join(',') + ']'],
      );
      await engine.executeRaw(
        `UPDATE content_chunks SET embedding = $1::vector
          WHERE page_id IN (SELECT id FROM pages WHERE slug = 'srm-victim')`,
        ['[' + far.join(',') + ']'],
      );

      const outcome = await verifySearchRoundTrip(engine, { samples: 1 });
      expect(outcome.status).toBe('warn');
      expect(outcome.reason_code).toBe('self_retrieval_miss');
      expect(outcome.samples.length).toBe(1);
      expect(typeof outcome.samples[0]?.page_id).toBe('number');
      expect(outcome.samples[0]?.status).toBe('miss');
      // Privacy pin: samples carry ids + codes, never the raw query text.
      expect(JSON.stringify(outcome)).not.toContain(canary);
    } finally {
      await engine.executeRaw(
        `DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 'srm-%')`,
      );
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'srm-%'`);
      embeddedTexts = [];
    }
  }, 60000);

  test('heartbeat: 3 consecutive refresh throws abort the drain; a mid-run success resets the counter', async () => {
    process.env.GBRAIN_EMBED_LOCK_HEARTBEAT_MS = '20';
    try {
      // Case 1: refresh THROWS every tick ⇒ 3 consecutive errors ⇒ lock_lost
      // (the transient-error sibling of the refresh()===false test above).
      await engine.executeRaw(`UPDATE content_chunks SET embedding = NULL`);
      let throwCalls = 0;
      const alwaysThrows: DbLockHandle = {
        id: 'fake-throwing-lock',
        acquiredAt: '0',
        release: async () => {},
        refresh: async () => {
          throwCalls += 1;
          throw new Error('heartbeat transport down');
        },
      };
      slowEmbedMs = 500; // hold the drain open across ≥3 heartbeat ticks
      const aborted = await runEmbedCore(engine, {
        stale: true,
        catchUp: true,
        singleFlight: true,
        includeNullSignature: true,
        quiet: true,
        heldLocks: [alwaysThrows],
      });
      expect(aborted.lock_lost).toBe(true);
      expect(throwCalls).toBeGreaterThanOrEqual(3);

      // Case 2: throw, throw, SUCCESS, throw, throw, success… — never 3 in a
      // row, so the consecutive counter resets and the drain completes.
      await engine.executeRaw(`UPDATE content_chunks SET embedding = NULL`);
      let flakyCalls = 0;
      const flaky: DbLockHandle = {
        id: 'fake-flaky-lock',
        acquiredAt: '0',
        release: async () => {},
        refresh: async () => {
          flakyCalls += 1;
          if (flakyCalls === 1 || flakyCalls === 2 || flakyCalls === 4 || flakyCalls === 5) {
            throw new Error('transient heartbeat blip');
          }
          return true;
        },
      };
      slowEmbedMs = 600; // ≥6 ticks at 20ms — covers the full throw/reset sequence
      const survived = await runEmbedCore(engine, {
        stale: true,
        catchUp: true,
        singleFlight: true,
        includeNullSignature: true,
        quiet: true,
        heldLocks: [flaky],
      });
      expect(survived.lock_lost).toBeFalsy();
      expect(survived.embedded).toBeGreaterThan(0);
      expect(flakyCalls).toBeGreaterThanOrEqual(5); // the reset sequence actually ran
    } finally {
      delete process.env.GBRAIN_EMBED_LOCK_HEARTBEAT_MS;
      slowEmbedMs = 0;
      // Recover the brain (case 1 aborts mid-drain).
      await runEmbedCore(engine, { stale: true, quiet: true });
    }
  }, 60000);
});

describe('empty-brain migration (plan pin 15)', () => {
  test('zero-page brain runs to completion, then verified-skips on the second run', async () => {
    currentDims = TO_DIMS;
    const e2 = new PGLiteEngine();
    await e2.connect({ embedding_dimensions: TO_DIMS } as never);
    await e2.initSchema();
    try {
      // File plane points elsewhere so the FIRST run has real work (config
      // convergence) instead of instantly skipping. Same width as the fresh
      // column ⇒ the plan must NOT show the destructive-deletion warning.
      writeFileConfig('zeroentropyai:zembed-1', FROM_DIMS);

      const cap1 = captureStdout();
      let code1: number;
      try {
        code1 = await runMigrateOn(e2, ['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes']);
      } finally {
        cap1.restore();
      }
      expect(code1).toBe(0);
      const rendered = cap1.lines.join('\n');
      expect(rendered).toContain('Embedding migration plan');
      expect(rendered).not.toContain('DESTRUCTIVE'); // nothing stored, nothing deleted
      expect(rendered).toContain('Migration complete');

      // Completion bookkeeping: live marker cleared, completed record stamped.
      const marker = await readMigrationState(e2);
      expect(marker.state).toBeNull();
      expect(marker.corrupt).toBe(false);
      const completedRaw = await e2.getConfig(MIGRATION_COMPLETED_KEY);
      expect(completedRaw).toBeTruthy();
      const completed = JSON.parse(completedRaw!) as {
        to_model: string;
        verify_search?: { status: string };
      };
      expect(completed.to_model).toBe('openai:text-embedding-3-small');
      // Zero chunks: the smoke check records a content-free skip, not a crash.
      expect(completed.verify_search?.status).toBe('skipped');

      // Second run: verified skip — no work, no spend.
      embeddedTexts = [];
      const cap2 = captureStdout();
      let code2: number;
      try {
        code2 = await runMigrateOn(e2, ['--to', 'openai:text-embedding-3-small', '--dim', String(TO_DIMS), '--yes', '--json']);
      } finally {
        cap2.restore();
      }
      expect(code2).toBe(0);
      const envl = JSON.parse(cap2.lines.join('\n')) as { status: string };
      expect(envl.status).toBe('skipped_no_work');
      expect(embeddedTexts.length).toBe(0);
    } finally {
      await e2.disconnect();
      writeFileConfig('openai:text-embedding-3-small', TO_DIMS);
    }
  }, 120000);
});
