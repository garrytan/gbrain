/**
 * scripts/run-eval-canary.ts — hermetic CLI retrieval-quality canary.
 *
 * Boots a throwaway PGLite brain under a temp GBRAIN_HOME, seeds the qrels
 * fixture corpus, then spawns the REAL gbrain CLI to run the qrels
 * correctness gate with the deterministic embedder (basis-vector query
 * embeddings). No API keys, no network, no writes to the personal brain,
 * no writes to tracked files in check mode.
 *
 * Seeding is the "V2" shape (feasibility-spike finding, BINDING): the
 * expected-top1 page carries its query text in the `timeline` column too,
 * because page-grain FTS (`pages.search_vector`) indexes title(A) +
 * timeline(C) ONLY — `compiled_truth` is deliberately unindexed. With
 * V1-style seeding (query text in compiled_truth only) the title arm votes
 * only for the sibling page and expected_top1 is structurally 0.0.
 *
 * Modes:
 *   default       check mode (CI): assert exit 0 + floors, print a one-line
 *                 summary, clean up. Writes nothing to tracked files.
 *   record mode   (pass the record flag) everything above PLUS append one
 *                 EvalRunRecord-shaped JSONL line to
 *                 <repo>/.gbrain-evals/eval-results.jsonl (the eval ledger).
 *
 * Honest scope: this gates the hybrid ranking pipeline (keyword/title/alias
 * arms + RRF against gold qrels) with synthetic vectors. Semantic-embedding
 * regressions remain the keyed eval suites' job.
 *
 * Budget: ≤60s under a saturated pool (two PGLite boots). If it breaches
 * ~100s under contention, move the verify entry into the serial-tests CI
 * job instead (same fallback as the chronicle eval).
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { basisEmbedding, parseLegacyQrels } from '../src/eval/deterministic-embed.ts';
import type { LegacyQrelsQuery } from '../src/eval/deterministic-embed.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QRELS_PATH = join(ROOT, 'test', 'fixtures', 'eval-baselines', 'qrels-search.json');

// The embedding space the throwaway brain is pinned to. The gateway must be
// configured with this BEFORE initSchema (the schema's vector(dims) columns
// derive from gateway config at initSchema time — config read only, no key
// needed), and the brain's GBRAIN_HOME config.json pins the same model+dims
// so the CLI subprocess resolves 1536 too.
const EMBEDDING_MODEL = 'openai:text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 1536;

// Env the child must NOT inherit: engine reroutes (a stray DATABASE_URL
// flips the engine to postgres; a brain id reroutes to a mount), embedding
// overrides (would fight the pinned 1536 space), and provider keys (the
// canary must behave identically keyed and keyless — determinism by
// construction, not by the parent's shell profile).
const CHILD_ENV_STRIP = [
  'DATABASE_URL',
  'GBRAIN_DATABASE_URL',
  'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE',
  'GBRAIN_EMBEDDING_MODEL',
  'GBRAIN_EMBEDDING_DIMENSIONS',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ZEROENTROPY_API_KEY',
  'VOYAGE_API_KEY',
  'OPENROUTER_API_KEY',
  'DASHSCOPE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
];

// The legacy qrels parser lives with the embedder builder — one parser for
// the shape (re-exported here for the test that drives this runner).
export { parseLegacyQrels };
export type { LegacyQrelsQuery };

/**
 * Seed the V2 canary corpus. For each query's relevant slugs:
 *   - putPage typed by prefix (person/company/note), title = slug tail;
 *     the expected-top1 page carries the primary text in BOTH
 *     compiled_truth and timeline (the V2 amendment — timeline is what
 *     page-grain FTS indexes); siblings carry "Mentioned in context of
 *     <query>" in timeline.
 *   - upsertChunks with the same fixture text, basisEmbedding at the
 *     query's dim, token_count 10, chunk_source compiled_truth/timeline.
 */
export async function seedCanaryCorpus(engine: BrainEngine, queries: LegacyQrelsQuery[]): Promise<void> {
  const seenSlugs = new Set<string>();
  for (const q of queries) {
    for (const slug of q.relevant_slugs) {
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      const isExpected = slug === q.first_relevant_slug;
      const primaryText = `Primary content about ${q.query}`;
      const mentionText = `Mentioned in context of ${q.query}`;
      const type = slug.startsWith('people/')
        ? 'person'
        : slug.startsWith('companies/')
          ? 'company'
          : 'note';
      await engine.putPage(slug, {
        type,
        title: slug.split('/').pop() ?? slug,
        compiled_truth: isExpected ? primaryText : '',
        // V2: the expected page's query text goes in timeline too — that is
        // the page-grain-FTS-indexed column (title A + timeline C).
        timeline: isExpected ? primaryText : mentionText,
      });
      const chunk: ChunkInput = {
        chunk_index: 0,
        chunk_text: isExpected ? primaryText : mentionText,
        chunk_source: isExpected ? 'compiled_truth' : 'timeline',
        embedding: basisEmbedding(q.embedding_dim, EMBEDDING_DIMENSIONS),
        token_count: 10,
      };
      await engine.upsertChunks(slug, [chunk]);
    }
  }
}

interface GateJson {
  verdict: 'pass' | 'fail';
  correctness_gate: {
    ran: boolean;
    summary?: {
      k: number;
      queries_total: number;
      queries_run: number;
      queries_errored: number;
      mean_recall_at_k: number;
      first_relevant_hit_rate: number;
      expected_top1_hit_rate: number;
      expected_top1_denominator: number;
    };
    thresholds?: {
      recall_at_k: number;
      first_relevant_hit: number;
      expected_top1: number;
    };
    breaches?: Array<Record<string, unknown>>;
  };
}

function shortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<number> {
  const recordMode = process.argv.includes('--record');
  const startedAt = Date.now();
  const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-eval-canary-'));
  // Keep the RUNNER's own gbrain home inside the sandbox too, so nothing in
  // the seeding path can read or write the operator's real ~/.gbrain.
  process.env.GBRAIN_HOME = tmpHome;
  try {
    const gbrainDir = join(tmpHome, '.gbrain');
    mkdirSync(gbrainDir, { recursive: true });
    const dbPath = join(gbrainDir, 'brain.pglite');
    writeFileSync(
      join(gbrainDir, 'config.json'),
      JSON.stringify(
        {
          engine: 'pglite',
          database_path: dbPath,
          embedding_model: EMBEDDING_MODEL,
          embedding_dimensions: EMBEDDING_DIMENSIONS,
        },
        null,
        2,
      ) + '\n',
    );

    // Gateway config BEFORE initSchema (dims gotcha above). Empty env
    // snapshot: no key is consulted, and none is needed for schema sizing.
    const { configureGateway } = await import('../src/core/ai/gateway.ts');
    configureGateway({
      embedding_model: EMBEDDING_MODEL,
      embedding_dimensions: EMBEDDING_DIMENSIONS,
      env: {},
    });

    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    await engine.initSchema();
    const qrelsRaw = readFileSync(QRELS_PATH, 'utf-8');
    await seedCanaryCorpus(engine, parseLegacyQrels(qrelsRaw));
    // PGLite is single-writer: release the brain before the CLI child opens it.
    await engine.disconnect();

    const childEnv: Record<string, string | undefined> = { ...process.env };
    for (const k of CHILD_ENV_STRIP) delete childEnv[k];
    childEnv.GBRAIN_HOME = tmpHome;

    // Spawn the REAL CLI. cwd is the temp home (not the repo) so repo-local
    // dotfiles and Bun-auto-loaded .env files can't reroute the brain.
    const child = spawnSync(
      process.execPath,
      [
        join(ROOT, 'src', 'cli.ts'), 'eval', 'gate', '--qrels', QRELS_PATH, '--embedder', 'deterministic', '--json',
        // v0.46.8: the corpus grew concept-paraphrase queries (q13/q14) and
        // the pre-wave observed rate was 10/12 — raise the expected_top1
        // floor from the loose default (0.50) to 0.85 so a single-query
        // top-1 regression (incl. a concept-weight regression) actually
        // FAILS the gate instead of coasting on the old floor.
        '--threshold-expected-top1', '0.85',
      ],
      {
        cwd: tmpHome,
        env: childEnv as NodeJS.ProcessEnv,
        encoding: 'utf-8',
        timeout: 110_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );

    if (child.error) {
      process.stderr.write(`[eval-canary] FAIL: could not spawn the CLI: ${child.error.message}\n`);
      return 1;
    }
    if (child.status !== 0) {
      process.stderr.write(`[eval-canary] FAIL: gate exit=${child.status ?? 'null(timeout/signal)'}\n`);
      process.stderr.write(`[eval-canary] gate stdout tail:\n${(child.stdout ?? '').slice(-2000)}\n`);
      process.stderr.write(`[eval-canary] gate stderr tail:\n${(child.stderr ?? '').slice(-2000)}\n`);
      return 1;
    }

    // Parse the gate's JSON envelope (stdout carries only the envelope; any
    // engine warnings go to stderr).
    const stdout = child.stdout ?? '';
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) {
      process.stderr.write(`[eval-canary] FAIL: no JSON found on gate stdout:\n${stdout.slice(-2000)}\n`);
      return 1;
    }
    const gate = JSON.parse(stdout.slice(jsonStart)) as GateJson;
    const summary = gate.correctness_gate.summary;
    const floors = gate.correctness_gate.thresholds;
    if (gate.verdict !== 'pass' || !summary || !floors) {
      process.stderr.write(`[eval-canary] FAIL: verdict=${gate.verdict} summary=${JSON.stringify(summary)}\n`);
      return 1;
    }
    // Exit 0 already implies floors held; assert explicitly anyway so a
    // future exit-code regression in the gate can't silently pass the canary.
    const breaches: string[] = [];
    if (summary.queries_errored > 0) breaches.push(`queries_errored=${summary.queries_errored}`);
    if (summary.mean_recall_at_k < floors.recall_at_k) breaches.push(`recall ${summary.mean_recall_at_k} < ${floors.recall_at_k}`);
    if (summary.first_relevant_hit_rate < floors.first_relevant_hit) breaches.push(`first_relevant ${summary.first_relevant_hit_rate} < ${floors.first_relevant_hit}`);
    if (summary.expected_top1_denominator > 0 && summary.expected_top1_hit_rate < floors.expected_top1) {
      breaches.push(`expected_top1 ${summary.expected_top1_hit_rate} < ${floors.expected_top1}`);
    }
    if (breaches.length > 0) {
      process.stderr.write(`[eval-canary] FAIL: ${breaches.join('; ')}\n`);
      return 1;
    }

    const commit = shortSha();
    const durationMs = Date.now() - startedAt;
    process.stdout.write(
      `[eval-canary] PASS commit=${commit}` +
      ` mean_recall_at_k=${summary.mean_recall_at_k.toFixed(4)}` +
      ` first_relevant_hit_rate=${summary.first_relevant_hit_rate.toFixed(4)}` +
      ` expected_top1_hit_rate=${summary.expected_top1_hit_rate.toFixed(4)}` +
      ` floors=${floors.recall_at_k}/${floors.first_relevant_hit}/${floors.expected_top1}` +
      ` k=${summary.k} queries=${summary.queries_run}/${summary.queries_total}` +
      ` duration_ms=${durationMs}\n`,
    );

    if (recordMode) {
      // EvalRunRecord-shaped ledger line (matches src/commands/eval-run-all.ts;
      // suite widened to the canary's own name, mode 'n/a' per the
      // search-mode-independent convention).
      const record = {
        schema_version: 3,
        run_id: `${commit}-retrieval-canary-na-0`,
        ran_at: new Date().toISOString(),
        suite: 'retrieval-canary',
        mode: 'n/a',
        commit,
        seed: 0,
        params: {
          qrels: 'test/fixtures/eval-baselines/qrels-search.json',
          embedder: 'deterministic',
          k: summary.k,
          metrics: {
            mean_recall_at_k: summary.mean_recall_at_k,
            first_relevant_hit_rate: summary.first_relevant_hit_rate,
            expected_top1_hit_rate: summary.expected_top1_hit_rate,
            expected_top1_denominator: summary.expected_top1_denominator,
            queries_run: summary.queries_run,
            queries_total: summary.queries_total,
          },
          floors: {
            recall_at_k: floors.recall_at_k,
            first_relevant_hit: floors.first_relevant_hit,
            expected_top1: floors.expected_top1,
          },
        },
        status: 'completed',
        duration_ms: durationMs,
      };
      const ledgerDir = join(ROOT, '.gbrain-evals');
      mkdirSync(ledgerDir, { recursive: true });
      const ledgerPath = join(ledgerDir, 'eval-results.jsonl');
      appendFileSync(ledgerPath, JSON.stringify(record) + '\n', 'utf-8');
      process.stdout.write(`[eval-canary] recorded → ${ledgerPath}\n`);
    }

    return 0;
  } catch (err) {
    process.stderr.write(`[eval-canary] FAIL: ${(err as Error).stack ?? (err as Error).message}\n`);
    return 1;
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await main());
}
