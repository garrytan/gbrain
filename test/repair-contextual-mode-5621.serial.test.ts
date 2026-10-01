/**
 * #5621: `gbrain repair contextual-mode` stamps the contextual retrieval mode
 * on existing markdown pages that were imported without one, exactly as a
 * fresh import would, and re-embeds only pages whose embedding input changes.
 *
 * Legacy pages are reproduced by importing with contextual retrieval off
 * (raw vectors, 'none'-tier input hashes) and clearing the stamp, which is
 * the state a pre-fix `--no-embed` import or a pre-stamp brain leaves.
 *
 * Installs the process-global gateway transport seam (always fake), so this
 * stays a `.serial.test.ts`. Runs on PGLite, and on Postgres through
 * test/e2e/repair-contextual-mode-5621-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runRepair, resolveRepairScope } from '../src/core/repair/core.ts';
import { contextualModeRepair } from '../src/core/repair/contextual-mode.ts';
import { checkContextualRetrievalCoverage } from '../src/commands/doctor/checks/calibration.ts';
import { titleTierCorpusGeneration } from '../src/core/contextual-retrieval-service.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
let inputs: string[][] = [];
let home: string;
const savedHome = process.env.GBRAIN_HOME;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-repair-cr-'));
  process.env.GBRAIN_HOME = home;
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    inputs.push([...values]);
    return { embeddings: values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: 0 } };
  }) as never);
});

afterAll(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
  if (savedHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => { inputs = []; });

for (const kind of testBackends()) describe(`#5621 gbrain repair contextual-mode (${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({ embedding_dimensions: DIMS } as never); await engine.initSchema(); }
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('plain', 'Plain') ON CONFLICT (id) DO NOTHING");
    await engine.executeRaw("INSERT INTO sources (id, name, contextual_retrieval_mode) VALUES ('off', 'Off', 'none') ON CONFLICT (id) DO NOTHING");
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });

  const ctx = () => ({ engine, config: { engine: engine.kind }, remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
  const body = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${`A paragraph about ${title}. `.repeat(20)}\n`;
  async function legacyPage(source: string, slug: string, title: string, opts: { noEmbed?: boolean } = {}) {
    await engine.setConfig('search.contextual_retrieval_disabled', 'true');
    await importFromContent(engine, slug, body(title), { sourceId: source, noEmbed: opts.noEmbed });
    await engine.setConfig('search.contextual_retrieval_disabled', 'false');
    await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL, corpus_generation=NULL WHERE source_id=$1 AND slug=$2', [source, slug]);
  }
  const page = async (source: string, slug: string) => (await engine.executeRaw<{ mode: string | null; generation: string | null }>(
    'SELECT contextual_retrieval_mode AS mode, corpus_generation AS generation FROM pages WHERE source_id=$1 AND slug=$2', [source, slug]))[0];
  const vectors = async (source: string, slug: string) => (await engine.executeRaw<{ v: string | null; h: string | null }>(
    `SELECT c.embedding::text AS v, c.embedding_input_hash AS h FROM content_chunks c JOIN pages p ON p.id=c.page_id
      WHERE p.source_id=$1 AND p.slug=$2 ORDER BY c.chunk_index`, [source, slug]));
  const run = async (apply: boolean, embed = true) => runRepair(ctx(), contextualModeRepair, await resolveRepairScope(engine),
    { apply, embed, embeddingModel: MODEL });

  test('stamps like a fresh import; unchanged inputs queue no re-embed, changed inputs re-embed once; a second run changes nothing', async () => {
    await legacyPage('plain', 'notes/raw-embedded', 'Raw Embedded Example');
    await legacyPage('off', 'notes/source-off', 'Source Off Example');
    await legacyPage('plain', 'notes/never-embedded', 'Never Embedded Example', { noEmbed: true });
    const offBefore = await vectors('off', 'notes/source-off');
    expect(offBefore.every(row => row.v !== null)).toBe(true);
    inputs = [];

    const before = await checkContextualRetrievalCoverage(engine);
    expect(before.status).toBe('warn');
    expect(before.message).toContain('gbrain repair contextual-mode --apply');
    expect(before.details).toMatchObject({ mode_null_pages: 3, mode_repair: 'contextual-mode' });

    const preview = await run(false);
    expect(preview).toMatchObject({ kind: 'contextual-mode', mode: 'dry_run', affected: 3, applied: 0 });
    expect(preview.apply_command).toBe('gbrain repair contextual-mode --apply');
    expect((await page('plain', 'notes/raw-embedded')).mode).toBeNull();

    const applied = await run(true);
    expect(applied).toMatchObject({ affected: 3, applied: 3, complete: true });
    expect(await page('plain', 'notes/raw-embedded')).toEqual({ mode: 'title', generation: titleTierCorpusGeneration() });
    expect(await page('plain', 'notes/never-embedded')).toEqual({ mode: 'title', generation: titleTierCorpusGeneration() });
    expect(await page('off', 'notes/source-off')).toEqual({ mode: 'none', generation: null });
    // Exactly one re-embed: the raw-embedded page, now title-wrapped.
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.every(text => text.includes('Raw Embedded Example'))).toBe(true);
    expect((await vectors('plain', 'notes/raw-embedded')).every(row => row.v !== null && row.h !== null)).toBe(true);
    // Unchanged input: the same vectors and hashes, no provider call.
    expect(await vectors('off', 'notes/source-off')).toEqual(offBefore);
    expect((await vectors('plain', 'notes/never-embedded')).every(row => row.v === null)).toBe(true);

    expect((await checkContextualRetrievalCoverage(engine)).details).toMatchObject({ mode_null_pages: 0 });
    inputs = [];
    const again = await run(true);
    expect(again).toMatchObject({ affected: 0, applied: 0 });
    expect(inputs).toHaveLength(0);
  });

  test('an embed_skip page keeps its retained vectors and is counted, not stamped', async () => {
    await legacyPage('plain', 'notes/skip-embedding', 'Skip Embedding Example');
    await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"embed_skip": {"reason": "example"}}'::jsonb
      WHERE source_id='plain' AND slug='notes/skip-embedding'`);
    const before = await vectors('plain', 'notes/skip-embedding');
    inputs = [];
    const result = await run(true);
    expect(result.residuals).toMatchObject({ embed_skip: 1 });
    expect(inputs).toHaveLength(0);
    expect((await page('plain', 'notes/skip-embedding')).mode).toBeNull();
    expect(await vectors('plain', 'notes/skip-embedding')).toEqual(before);
    await engine.executeRaw("DELETE FROM pages WHERE source_id='plain' AND slug='notes/skip-embedding'");
  });

  test('--no-embed stamps and clears only the changed vectors without a provider call', async () => {
    await legacyPage('plain', 'notes/no-embed-repair', 'No Embed Repair');
    inputs = [];
    const result = await run(true, false);
    expect(result.applied).toBe(1);
    expect(inputs).toHaveLength(0);
    expect((await page('plain', 'notes/no-embed-repair')).mode).toBe('title');
    expect((await vectors('plain', 'notes/no-embed-repair')).every(row => row.v === null)).toBe(true);
  });
});
