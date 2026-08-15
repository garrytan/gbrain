/**
 * Cross-session "magic moment" — the keyless agent-authored memory contract
 * proven across a REAL engine session boundary (agent-bootstrap GAP 1).
 *
 * The shipped `gbrain bootstrap verify` magic_moment check writes a `## Facts`
 * fence, reconciles it in the SAME connection, and reads it straight back with
 * one SQL statement. That proves the fence parser runs — but it can NOT prove
 * the fact survives a process/connection boundary, that the ZERO-LLM sweep pass
 * actually banks it to disk, or that a keyless BM25 recall (the query op) finds
 * it afterward scoped to the right source. This test closes that gap:
 *
 *   Session 1 (engine A):  init a real on-disk PGLite brain + two sources,
 *                          author a fact through the REAL write path (put_page
 *                          op → `## Facts` fence), run the maintenance sweep's
 *                          zero-LLM fence pass, then DISCONNECT (engine A is
 *                          gone — the session boundary is real, not simulated).
 *   Session 2 (engine B):  a BRAND-NEW engine opens the SAME database_path with
 *                          NO initSchema (the data must already be on disk), and
 *                          we prove three things that the same-connection check
 *                          can't:
 *                            1. persistence — the reconciled fact row survived
 *                               to disk and reopens in a fresh connection.
 *                            2. keyless recall — the `query` op (BM25, no API
 *                               key) returns the fence page BY CONTENT.
 *                            3. source-scope routing — the same recall scoped to
 *                               a DIFFERENT registered source returns nothing.
 *
 * Keyless is forced deterministically (every provider key stripped from the
 * env + a keyless capability report handed to the sweep) so the path under
 * test is exactly the fresh-install / keyless posture, and CI without secrets
 * runs it identically.
 *
 * Serial: cold PGLite init + a real disconnect/reopen cycle; env is
 * save/restored; temp dirs are cleaned no matter what.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEngine } from '../../src/core/engine-factory.ts';
import { addSource } from '../../src/core/sources-ops.ts';
import { runMaintenanceSweep } from '../../src/core/sweep.ts';
import type { CapabilityReport } from '../../src/core/capability.ts';
import { operations, type Operation, type OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

// ── Fixture: a distinctive, wikilink-free fence fact ────────────────────────
// The claim carries rare tokens so a keyless BM25 recall is unambiguous, and no
// `|` so the fence-table markdown parses as a single claim cell.
const PROBE_SLUG = 'wiki/magic-moment-probe';
const MAGIC_PHRASE =
  'The migratory narwhal expedition logged forty-two beacons near the aurora fjord';
const RECALL_QUERY = 'narwhal expedition beacons aurora fjord';

const PROBE_CONTENT = `---
title: Magic Moment Probe
type: concept
---

# Magic Moment Probe

A keyless agent-authored memory probe for the cross-session magic-moment e2e.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${MAGIC_PHRASE} | fact | 1.0 | world | low | | | magic-moment-test | |
<!--- gbrain:facts:end -->
`;

// Keyless posture handed to the sweep so the fence pass runs zero-LLM and the
// corpus-ingest pass never reaches for a network key.
const KEYLESS_CAPS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};

const WORKSPACE_SOURCE = 'workspace';
const OTHER_SOURCE = 'other';

// Every provider key that detectCapabilities / the sweep could observe. Stripped
// so keyless is deterministic (and no accidental live embedding cost/flake).
const PROVIDER_KEYS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ZEROENTROPY_API_KEY', 'OPENROUTER_API_KEY',
  'VOYAGE_API_KEY', 'DASHSCOPE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY',
];
const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', ...PROVIDER_KEYS,
];
const SAVED_ENV: Record<string, string | undefined> = {};

let tmpParent: string;
let home: string;
let dbDir: string;
let wsBrain: string;
let otherBrain: string;
let engineConfig: { engine: 'pglite'; database_path: string };
let session2: BrainEngine;

function findOp(name: string): Operation {
  const op = operations.find((o) => o.name === name);
  if (!op) throw new Error(`op not registered: ${name}`);
  return op;
}

/** Trusted-local ctx (remote:false) so put_page fires its post-hooks and the
 *  query op runs the local hybrid path — mirrors the corpus helper's trustedCtx. */
function trustedCtx(engine: BrainEngine, sourceId: string): OperationContext {
  return {
    engine,
    config: { engine: 'pglite', database_path: dbDir } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  };
}

async function factsMatching(engine: BrainEngine, sourceId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ fact: string }>(
    `SELECT fact FROM facts WHERE source_id = $1 AND visibility = 'world' AND fact LIKE $2`,
    [sourceId, `%${MAGIC_PHRASE}%`],
  );
  return rows.map((r) => r.fact);
}

beforeAll(async () => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  // Ambient-state strip: a dev/CI DATABASE_URL must not flip the sandboxed brain
  // to Postgres, and a real provider key must not turn the keyless path semantic.
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_BRAIN_ID;
  delete process.env.GBRAIN_SOURCE;
  for (const k of PROVIDER_KEYS) delete process.env[k];

  tmpParent = mkdtempSync(join(tmpdir(), 'gb-magic-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  dbDir = join(tmpParent, 'db');
  wsBrain = join(tmpParent, 'ws', 'brain');
  otherBrain = join(tmpParent, 'other', 'brain');
  mkdirSync(wsBrain, { recursive: true });
  mkdirSync(otherBrain, { recursive: true });
  process.env.GBRAIN_HOME = tmpParent;

  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbDir, embedding_dimensions: 1536 }, null, 2),
  );
  engineConfig = { engine: 'pglite', database_path: dbDir };

  // ── SESSION 1 (engine A): author + reconcile + DISCONNECT ────────────────
  const engineA = await createEngine(engineConfig);
  await engineA.connect(engineConfig);
  await engineA.initSchema();
  await addSource(engineA, { id: WORKSPACE_SOURCE, localPath: wsBrain, force: true });
  await addSource(engineA, { id: OTHER_SOURCE, localPath: otherBrain, force: true });

  // Author through the REAL write path: put_page op (remote:false) with a
  // `## Facts` fence — the keyless agent-authored memory route.
  const putPage = findOp('put_page');
  await putPage.handler(trustedCtx(engineA, WORKSPACE_SOURCE), {
    slug: PROBE_SLUG,
    content: PROBE_CONTENT,
  });

  // Reconcile the fence into the facts index via the sweep's ZERO-LLM pass —
  // the exact `gbrain sweep --once` fence path, keyless.
  const report = await runMaintenanceSweep(engineA, {
    sourceId: WORKSPACE_SOURCE,
    budgetMs: 60_000,
    capabilities: KEYLESS_CAPS,
  });
  // Session-1 sanity: the fence really reconciled in THIS connection.
  if (report.factsReconciled < 1) {
    throw new Error(
      `session 1 fence reconciliation failed (factsReconciled=${report.factsReconciled}, ` +
        `skipped=${JSON.stringify(report.skipped)}) — cannot test cross-session recall`,
    );
  }

  // The session boundary: engine A is fully torn down. Session 2 opens a fresh
  // engine against the same on-disk directory.
  await engineA.disconnect();

  // ── SESSION 2 (engine B): fresh engine, SAME db, NO initSchema ───────────
  session2 = await createEngine(engineConfig);
  await session2.connect(engineConfig);
}, 180_000);

afterAll(async () => {
  try {
    await session2?.disconnect();
  } catch {
    /* already down */
  }
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  try {
    rmSync(tmpParent, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('bootstrap magic moment — cross-session keyless recall (serial e2e) [GAP1]', () => {
  test('persistence: the fence-reconciled fact survives to disk and reopens in a fresh engine', async () => {
    // engine A wrote + disconnected; engine B never ran initSchema. If the
    // reconciled row didn't bank to disk, this comes back empty.
    const facts = await factsMatching(session2, WORKSPACE_SOURCE);
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0]).toContain(MAGIC_PHRASE);
  }, 60_000);

  test('keyless recall: the query op (BM25) returns the fence page BY CONTENT across the session boundary', async () => {
    const queryOp = findOp('query');
    const results = (await queryOp.handler(trustedCtx(session2, WORKSPACE_SOURCE), {
      query: RECALL_QUERY,
      limit: 10,
      expand: false,
      source_id: WORKSPACE_SOURCE,
    })) as Array<{ slug: string; chunk_text: string }>;

    // Real content assertion: the fence page comes back AND the recalled chunk
    // carries the authored fact text — not merely "some non-empty result".
    expect(Array.isArray(results)).toBe(true);
    const hit = results.find((r) => r.slug === PROBE_SLUG);
    expect(hit).toBeDefined();
    expect(JSON.stringify(results)).toContain(MAGIC_PHRASE);
  }, 60_000);

  test('source-scope routing: the same recall scoped to a DIFFERENT source returns neither the fact nor the page', async () => {
    // The fact and page live in `workspace`; `other` is registered but empty.
    // A cross-session query scoped to `other` must not leak workspace content.
    const otherFacts = await factsMatching(session2, OTHER_SOURCE);
    expect(otherFacts.length).toBe(0);

    const queryOp = findOp('query');
    const results = (await queryOp.handler(trustedCtx(session2, OTHER_SOURCE), {
      query: RECALL_QUERY,
      limit: 10,
      expand: false,
      source_id: OTHER_SOURCE,
    })) as Array<{ slug: string; chunk_text: string }>;
    expect(results.find((r) => r.slug === PROBE_SLUG)).toBeUndefined();
    expect(JSON.stringify(results)).not.toContain(MAGIC_PHRASE);
  }, 60_000);
});
