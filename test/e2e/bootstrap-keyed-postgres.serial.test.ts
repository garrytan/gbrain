/**
 * GAP 6 — keyed mode + Postgres bootstrap coverage.
 *
 * Every other bootstrap test pins the KEYLESS posture (embeddings.available:
 * false) against embedded PGLite with DATABASE_URL stripped. Nothing proved
 * that (a) a keyed brain actually does SEMANTIC recall that BM25 can't, that
 * (b) a real chat key drives auto fact-extraction the keyless path can't, or
 * that (c) the bootstrap verify probes run on a real Postgres/Supabase engine
 * instead of only PGLite. This file closes all three, each env-gated with
 * `skipIf` so a CI run without secrets stays green while the path runs for
 * real when the key / DATABASE_URL is present.
 *
 * Serial: mutates process.env.GBRAIN_HOME and the process-global AI gateway.
 * Deliberately does NOT strip DATABASE_URL (the Postgres describe needs it).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

import { addSource } from '../../src/core/sources-ops.ts';
import { loadCorpusPages } from '../helpers/bootstrap-corpus.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { runSchemaTransition } from '../../src/core/retrieval-upgrade-planner.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { extractTakesFromPages } from '../../src/core/extract-takes-from-pages.ts';
import {
  configureGateway,
  resetGateway,
  __unconfigureGatewayForTests,
} from '../../src/core/ai/gateway.ts';
import {
  verifyWorkspace,
  VERIFY_PROBE_SLUG,
  VERIFY_PROBE_ENTITY_SLUG,
  VERIFY_MAGIC_TOKEN,
} from '../../src/core/bootstrap/verify.ts';
import type { CapabilityReport } from '../../src/core/capability.ts';

// Cold-path opt-out (conservative): runs runSchemaTransition (embedding-width
// schema migration) on top of a fresh engine — the base must be cold-built.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

const OPENAI = process.env.OPENAI_API_KEY;
const VOYAGE = process.env.VOYAGE_API_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};

/** Resolve the embedding provider the same way `gbrain init` would from env.
 * OpenAI (1536d) matches the committed `embedding` column width, so no schema
 * transition is needed; Voyage (1024d) requires resizing the column exactly
 * the way the provider-agnostic migration does. */
function resolveEmbedProvider():
  | { model: string; dims: number; env: Record<string, string>; cfg: Record<string, string> }
  | null {
  if (OPENAI) {
    return {
      model: 'openai:text-embedding-3-large',
      dims: 1536,
      env: { OPENAI_API_KEY: OPENAI },
      cfg: { openai_api_key: OPENAI },
    };
  }
  if (VOYAGE) {
    return {
      model: 'voyage:voyage-3-large',
      dims: 1024,
      env: { VOYAGE_API_KEY: VOYAGE },
      cfg: { voyage_api_key: VOYAGE },
    };
  }
  return null;
}

/** Chat provider for the LLM fact-extraction path (embeddings not required). */
function resolveChatProvider():
  | { model: string; env: Record<string, string> }
  | null {
  if (ANTHROPIC) return { model: 'anthropic:claude-haiku-4-5', env: { ANTHROPIC_API_KEY: ANTHROPIC } };
  if (OPENAI) return { model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: OPENAI } };
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// (a) Keyed semantic recall: a PARAPHRASE query (no shared keyword with the
//     target page) recalls the right page via real embeddings — something the
//     keyless BM25 path structurally cannot do (disjoint tokens ⇒ zero lexical
//     hits). The contrast is asserted directly: the keyword arm returns the
//     page NOT AT ALL, the vector arm surfaces it.
// ───────────────────────────────────────────────────────────────────────────
describe.skipIf(!OPENAI && !VOYAGE)('keyed semantic recall (real embeddings)', () => {
  let engine: PGLiteEngine;
  let home: string;
  let root: string;
  let prevHome: string | undefined;
  let embedded = 0;

  beforeAll(async () => {
    const prov = resolveEmbedProvider()!;
    root = mkdtempSync(join(tmpdir(), 'gb-keyed-'));
    home = join(root, '.gbrain');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        engine: 'pglite',
        embedding_model: prov.model,
        embedding_dimensions: prov.dims,
        ...prov.cfg,
      }),
    );
    prevHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = root;

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    // Size the primary embedding column to the provider's width (OpenAI is
    // already 1536; Voyage needs the resize the real migration performs).
    if (prov.dims !== 1536) await runSchemaTransition(engine, prov.dims);
    await addSource(engine, { id: 'workspace', localPath: join(root, 'brain'), force: true });

    // Load the corpus KEYLESS (no gateway yet, so put_page never auto-embeds),
    // then configure the real gateway and run the embed sweep for real.
    mkdirSync(join(root, 'brain'), { recursive: true });
    await loadCorpusPages(engine, { sourceId: 'workspace' });
    configureGateway({ embedding_model: prov.model, embedding_dimensions: prov.dims, env: prov.env });
    const res = await runEmbedCore(engine, { stale: true, sourceId: 'workspace', quiet: true });
    embedded = res.embedded;
  }, 300_000);

  afterAll(async () => {
    try { await engine.disconnect(); } catch { /* noop */ }
    resetGateway();
    if (prevHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  });

  test('the embed sweep actually produced vectors', () => {
    // Guards against a false-green semantic assertion below: if nothing
    // embedded, a "recall" could only be lexical.
    expect(embedded).toBeGreaterThan(0);
  });

  // Each case: a query whose tokens are DISJOINT from the target page so BM25
  // cannot reach it; only a real embedding can. Asserted both ways.
  const cases = [
    {
      name: 'summit-robotics',
      slug: 'companies/summit-robotics',
      paraphrase: 'company making self-guided fulfillment-center machinery',
    },
    {
      name: 'hybrid-retrieval',
      slug: 'concepts/hybrid-retrieval',
      paraphrase: 'combining vector similarity with lexical token matching for lookup',
    },
  ];

  for (const c of cases) {
    test(`paraphrase "${c.paraphrase.slice(0, 32)}…" recalls ${c.name} via vectors, not keywords`, async () => {
      // The keyless arm: pure BM25. Disjoint tokens ⇒ the target is unreachable.
      const kw = await engine.searchKeyword(c.paraphrase, { limit: 10, sourceId: 'workspace' });
      expect(kw.map((r) => r.slug)).not.toContain(c.slug);

      // The keyed arm: real query embedding + vector search surfaces it.
      const results = await hybridSearch(engine, c.paraphrase, {
        limit: 10,
        sourceId: 'workspace',
        mode: 'balanced',
      });
      const slugs = results.map((r) => r.slug);
      expect(slugs).toContain(c.slug);
      // And it ranks as a confident hit, not a tail match.
      expect(slugs.slice(0, 5)).toContain(c.slug);
    }, 120_000);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// (b) Keyed auto fact-extraction: a real chat key drives the takes classifier
//     over concept prose and lands a gradeable claim. The keyless path returns
//     `llm_unavailable` with zero claims — the exact capability a key unlocks.
// ───────────────────────────────────────────────────────────────────────────
describe.skipIf(!OPENAI && !ANTHROPIC)('keyed auto fact-extraction (LLM takes)', () => {
  let engine: PGLiteEngine;
  let home: string;
  let root: string;
  let prevHome: string | undefined;
  const SLUG = 'concepts/keyed-extraction-probe';
  // >200 chars of concept prose carrying clear gradeable claims (facts/takes),
  // so the classifier has something real to extract.
  const PROSE = [
    'Hybrid retrieval systems consistently outperform pure keyword search on',
    'recall-sensitive corpora because dense embeddings capture paraphrase',
    'relationships that sparse lexical matching misses. The reranker stage is',
    'the single highest-leverage component: teams that skip it leave roughly a',
    'third of achievable precision on the table. In 2026 most production memory',
    'stacks will standardize on a reranked hybrid pipeline as the default, and',
    'brains that stay keyword-only will feel noticeably worse to their users.',
  ].join(' ');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gb-extract-'));
    home = join(root, '.gbrain');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'pglite' }));
    prevHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = root;

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage(SLUG, {
      type: 'concept',
      title: 'Keyed Extraction Probe',
      compiled_truth: PROSE,
    });
    // #4473: takes are md-first — the probe page needs a real markdown home
    // (a page with no locatable .md is skipped, never written DB-only).
    const repo = join(root, 'brain');
    mkdirSync(join(repo, 'concepts'), { recursive: true });
    writeFileSync(join(repo, `${SLUG}.md`), `# Keyed Extraction Probe\n\n${PROSE}\n`, 'utf-8');
    await engine.setConfig('sync.repo_path', repo);
  }, 120_000);

  afterAll(async () => {
    try { await engine.disconnect(); } catch { /* noop */ }
    resetGateway();
    if (prevHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  });

  test('keyless → llm_unavailable, zero claims; keyed → a real fact/take lands', async () => {
    // Keyless contrast: no chat gateway ⇒ the sweep cannot extract anything.
    // NOT resetGateway(): since #3554 that re-applies the preload's test
    // baseline, whose factory captures env: { ...process.env } — including
    // the very ANTHROPIC/OPENAI key this describe is gated on (run-e2e.sh
    // keeps provider keys via GBRAIN_TEST_KEEP_PROVIDER_KEYS=1). The gateway
    // would come back chat-available and llm_unavailable could never be true.
    // __unconfigureGatewayForTests() is the #3554 seam for asserting genuine
    // no-gateway behavior; the preload's beforeEach restores the baseline
    // before the next test.
    __unconfigureGatewayForTests();
    const keyless = await extractTakesFromPages(engine, { bootstrapEnabled: true });
    expect(keyless.llm_unavailable).toBe(true);
    expect(keyless.claims_extracted).toBe(0);
    const beforeRows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1`,
      [SLUG],
    );
    expect(beforeRows[0].n).toBe(0);

    // Keyed: configure the real chat model and run the same sweep.
    const chat = resolveChatProvider()!;
    configureGateway({ chat_model: chat.model, env: chat.env });
    const keyed = await extractTakesFromPages(engine, { bootstrapEnabled: true, holder: 'test' });
    expect(keyed.llm_unavailable).toBe(false);
    expect(keyed.claims_extracted).toBeGreaterThan(0);

    // The claim physically landed in the takes table on OUR probe page.
    const rows = await engine.executeRaw<{ claim: string; kind: string }>(
      `SELECT t.claim, t.kind FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1`,
      [SLUG],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.claim.trim().length > 0)).toBe(true);
    expect(rows.every((r) => ['fact', 'take', 'bet', 'hunch'].includes(r.kind))).toBe(true);
  }, 180_000);
});

// ───────────────────────────────────────────────────────────────────────────
// (c) Postgres bootstrap: drive the verify core's roundtrip + graph_floor +
//     magic_moment probes against a REAL Postgres engine. First bootstrap
//     coverage off PGLite — catches PGLite-only assumptions in the probes
//     (tsvector recall, graph-edge materialization, probe cleanup DDL).
// ───────────────────────────────────────────────────────────────────────────
describe.skipIf(!DATABASE_URL)('Postgres bootstrap verify (real Postgres)', () => {
  let engine: PostgresEngine;
  let home: string;
  let root: string;
  let ws: string;
  let prevHome: string | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gb-pg-verify-'));
    home = join(root, '.gbrain');
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'postgres' }));
    ws = mkdtempSync(join(tmpdir(), 'gb-pg-verify-ws-'));
    mkdirSync(join(ws, 'brain'), { recursive: true });
    prevHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = root;

    engine = new PostgresEngine();
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.initSchema();
    // This file runs against the shared e2e DB WITHOUT setupDB's TRUNCATE, so
    // a prior standalone run's `workspace` source row survives and addSource
    // (whose `force` only bypasses git validation, not the id-collision check)
    // would throw source_id_taken. Sweep it first; the FK cascade removes any
    // leftover pages/facts under it.
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'workspace'`, []);
    await addSource(engine, { id: 'workspace', localPath: join(ws, 'brain'), force: true });
  }, 60_000);

  afterAll(async () => {
    // Leave the shared DB clean for the next file / next standalone run.
    try { await engine.executeRaw(`DELETE FROM sources WHERE id = 'workspace'`, []); } catch { /* noop */ }
    try { await engine.disconnect(); } catch { /* noop */ }
    if (prevHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  test('roundtrip + graph_floor + magic_moment pass on Postgres; probes cleaned up', async () => {
    const res = await verifyWorkspace(engine, ws, {
      sourceId: 'workspace',
      gbrainHomeDir: home,
      capabilities: KEYLESS,
      skipHooksSmoke: true,
      sweepBudgetMs: 20_000,
    });

    // The three probes the task targets — each must pass on real Postgres.
    for (const c of res.checks.filter((c) => c.id === 'roundtrip')) expect(c.ok).toBe(true);
    const graph = res.checks.find((c) => c.id === 'graph_floor');
    expect(graph?.ok).toBe(true);
    const magic = res.checks.find((c) => c.id === 'magic_moment');
    expect(magic?.ok).toBe(true);

    // Probe cleanup [G13] must hold on the Postgres DDL path too. Since
    // v0.46.6.0 (#4170, closing #4142) verify's probe cleanup HARD-deletes
    // via the trusted engine primitive — probes are not user content and
    // verify is a trusted local caller; the old soft-delete path left
    // tombstones in user brains until the 72h purge. Assert NO probe rows
    // remain at all, active or tombstoned. (This hunk shipped in #4171
    // still asserting the pre-#4170 soft-delete contract — the merge-base
    // collision flagged in that PR's review thread — and broke the Postgres
    // e2e lane on master; repaired here.)
    const probePages = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND slug IN ($2, $3)`,
      ['workspace', VERIFY_PROBE_SLUG, VERIFY_PROBE_ENTITY_SLUG],
    );
    expect(probePages[0].n).toBe(0);
    const probeFacts = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1 AND source_markdown_slug = $2`,
      ['workspace', VERIFY_PROBE_SLUG],
    );
    expect(probeFacts[0].n).toBe(0);
    // Sanity: the magic-token probe fact did not survive either.
    const tokenFacts = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = $1 AND source_markdown_slug = $2 AND fact LIKE $3`,
      ['workspace', VERIFY_PROBE_SLUG, `%${VERIFY_MAGIC_TOKEN}%`],
    );
    expect(tokenFacts[0].n).toBe(0);
  }, 120_000);
});
