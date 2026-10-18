/**
 * Fixture for the held-embedding CLI tests (#6803 part 3, #6847): an on-disk
 * PGLite brain made by the real `gbrain init`, large pages held for approval
 * the way the post-upgrade backfill holds them (`upgrade_backfill`), and a
 * local OpenAI-compatible `/v1/embeddings` server standing in for the
 * provider. `dense` bills one token per character (CJK, minified code): four
 * times the chars-per-token basis the run meter assumes.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PAGE_INLINE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { holdPageEmbedding } from '../../src/core/page-embedding-budget.ts';
import { installFixtureChunks } from './page-projection.ts';
import { runCli, type CliResult } from './cli-spawn.ts';

export interface FakeEmbeddings { url: string; calls: number; tokens: number; stop(): void }

export function startFakeEmbeddings(opts: { dense?: boolean; dims?: number } = {}): FakeEmbeddings {
  const fake = { url: '', calls: 0, tokens: 0, stop: () => server.stop(true) };
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith('/embeddings')) return Response.json({ object: 'list', data: [{ id: 'fixture-embedder', object: 'model' }] });
      const body = await req.json() as { input: string | string[]; dimensions?: number };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const chars = inputs.reduce((n, s) => n + s.length, 0);
      const tokens = opts.dense ? chars : Math.ceil(chars / 4);
      fake.calls++;
      fake.tokens += tokens;
      const dims = body.dimensions ?? opts.dims ?? 1024;
      return Response.json({ object: 'list', model: 'fixture-embedder', usage: { prompt_tokens: tokens, total_tokens: tokens },
        data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: new Array(dims).fill(0.01) })) });
    },
  });
  fake.url = `http://127.0.0.1:${server.port}/v1`;
  return fake;
}

export interface HeldBrain { home: string; env: Record<string, string | undefined>; cleanup(): void }

const SCRUB = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY',
  'OLLAMA_BASE_URL', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_SOURCE', 'GBRAIN_DATABASE_URL', 'DATABASE_URL'];

/** The real CLI against the fixture brain (argv without `gbrain`); `env` overlays the brain's env. */
export function gbrain(brain: HeldBrain, args: string[], env: Record<string, string | undefined> = {}): Promise<CliResult> {
  return runCli(args, { home: brain.home, env: { ...brain.env, ...env }, timeoutMs: 120_000 });
}

/** A PGLite brain made by `gbrain init` (keyless), then pointed at `model` at the keyless column's 1024 dimensions, writer management off. */
export async function makeHeldBrain(model: string, env: Record<string, string | undefined>): Promise<HeldBrain> {
  const home = mkdtempSync(join(tmpdir(), 'gb-held-'));
  const brain: HeldBrain = { home, env: { ...Object.fromEntries(SCRUB.map(k => [k, undefined])), ...env }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  const init = await gbrain(brain, ['init', '--pglite', '--no-embedding', '--non-interactive']);
  if (init.exitCode !== 0) throw new Error(`gbrain init failed: ${init.stderr}`);
  const path = join(home, '.gbrain', 'config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  delete cfg.embedding_disabled;
  writeFileSync(path, JSON.stringify({ ...cfg, embedding_model: model, embedding_dimensions: 1024 }));
  // Direct writes (seeding sources, pages and holds in-process) need an unmanaged brain; the embed paths under test are the same.
  await withBrain(brain, engine => engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'));
  return brain;
}

/** The brain's PGLite opened in-process (never while a CLI child holds it). */
export async function withBrain<T>(brain: HeldBrain, fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const cfg = JSON.parse(readFileSync(join(brain.home, '.gbrain', 'config.json'), 'utf8')) as { database_path: string };
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: cfg.database_path } as never);
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

const BODY = 'Weekly notes from acme-example with alice-example. '.repeat(Math.ceil((PAGE_INLINE_MAX_BYTES + 4096) / 51));

/** A large page with `chunks` 2,000-character chunks and no vectors, held `upgrade_backfill` as the post-upgrade backfill leaves it. */
export async function seedHeldPage(engine: BrainEngine, slug: string, sourceId: string, chunks: number): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [sourceId]);
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: BODY }, { sourceId });
  const inputs: ChunkInput[] = Array.from({ length: chunks }, (_, i) => ({ chunk_index: i, chunk_text: `${slug} chunk ${i} `.padEnd(2000, 'acme-example '),
    chunk_source: 'compiled_truth', token_count: 500 }));
  await installFixtureChunks(engine, slug, inputs, { sourceId });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, sourceId]);
  await holdPageEmbedding(engine, Number(row!.id), 'upgrade_backfill');
}

export interface BudgetRow { slug: string; source_id: string; state: string | null; reason: string | null; spent_usd: number; cap_usd: number | null; chunks: number; embedded: number }

/** Every seeded page's ledger row and how many of its chunks carry a vector. */
export function budgetRows(brain: HeldBrain): Promise<BudgetRow[]> {
  return withBrain(brain, async engine => (await engine.executeRaw<BudgetRow>(`SELECT p.slug, p.source_id, b.state, b.reason, b.spent_usd, b.cap_usd,
      (SELECT count(*)::int FROM content_chunks cc WHERE cc.page_id = p.id) AS chunks,
      (SELECT count(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND cc.embedding IS NOT NULL) AS embedded
     FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id WHERE p.deleted_at IS NULL ORDER BY p.slug`))
    .map(r => ({ ...r, spent_usd: Number(r.spent_usd ?? 0), cap_usd: r.cap_usd === null ? null : Number(r.cap_usd), chunks: Number(r.chunks), embedded: Number(r.embedded) })));
}

/** A printed command's argv, without the leading `gbrain`. */
export function argvOf(command: string): string[] {
  const argv = command.trim().split(/\s+/);
  return argv[0] === 'gbrain' ? argv.slice(1) : argv;
}
