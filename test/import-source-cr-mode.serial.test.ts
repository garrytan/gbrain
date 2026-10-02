/**
 * #3885 — the inline import path (capture / put_page / reindex --markdown)
 * must load the REAL source row when resolving the contextual-retrieval
 * mode, so a stored `gbrain sources set-cr-mode <id> <mode>` applies.
 *
 * Pre-fix: import-file.ts hardcoded a source stub with
 * `contextual_retrieval_mode: null / trust_frontmatter_overrides: false`,
 * so a per-source 'none' override was ignored and the global bundle
 * (balanced → title) silently won.
 *
 * #5621: legacy --no-embed imports (large syncs, connector sources) stamp
 * the same resolved mode, so the later embed pass wraps them as well.
 *
 * .serial: real PGLite + gateway stubbing (docs/TESTING.md R1).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFile, importFromContent } from '../src/core/import-file.ts';
import { embedStaleForSource, type EmbedStaleOpts } from '../src/core/embed-stale.ts';
import { titleTierCorpusGeneration } from '../src/core/contextual-retrieval-service.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';

const STUB_DIMS = 1536;

let engine: PGLiteEngine;
const embedderInputs: string[][] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: STUB_DIMS,
    env: { OPENAI_API_KEY: 'sk-test-fake-key-for-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => {
    embedderInputs.push([...values]);
    return {
      embeddings: values.map(() => new Array<number>(STUB_DIMS).fill(0.001)),
      usage: { tokens: 0 },
    } as any;
  });

  // Two registered sources: one with a stored per-source CR override,
  // one without (falls through to the global bundle).
  await engine.executeRaw(
    `INSERT INTO sources (id, name, contextual_retrieval_mode) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET contextual_retrieval_mode = EXCLUDED.contextual_retrieval_mode`,
    ['vault-off', 'Vault Off', 'none'],
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, contextual_retrieval_mode) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET contextual_retrieval_mode = EXCLUDED.contextual_retrieval_mode`,
    ['vault-syn', 'Vault Synopsis', 'per_chunk_synopsis'],
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    ['vault-plain', 'Vault Plain'],
  );
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(() => {
  embedderInputs.length = 0;
});

const CONTENT = `---
title: "CR Mode Probe"
type: note
---

A body long enough to produce at least one chunk of prose for the
contextual-retrieval wrapper decision to matter at embed time.
`;

async function stampedMode(slug: string, sourceId: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ contextual_retrieval_mode: string | null }>(
    `SELECT contextual_retrieval_mode FROM pages WHERE slug = $1 AND source_id = $2`,
    [slug, sourceId],
  );
  expect(rows.length).toBe(1);
  return rows[0].contextual_retrieval_mode;
}

describe('#3885 stored per-source CR mode applies on the inline import path', () => {
  test("source override 'none' beats the global bundle (balanced → title)", async () => {
    await importFromContent(engine, 'notes/probe-off', CONTENT, { sourceId: 'vault-off' });
    expect(await stampedMode('notes/probe-off', 'vault-off')).toBe('none');
    // With mode 'none', the embedder saw the RAW chunk text — no title wrap.
    const flat = embedderInputs.flat();
    expect(flat.length).toBeGreaterThan(0);
    for (const input of flat) {
      expect(input).not.toContain('CR Mode Probe');
    }
  }, 60_000);

  test('source WITHOUT an override keeps the global bundle (title tier wrap)', async () => {
    await importFromContent(engine, 'notes/probe-plain', CONTENT, { sourceId: 'vault-plain' });
    expect(await stampedMode('notes/probe-plain', 'vault-plain')).toBe('title');
    const flat = embedderInputs.flat();
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.some((input) => input.includes('CR Mode Probe'))).toBe(true);
  }, 60_000);

  test("source override 'per_chunk_synopsis' keeps the deliberate inline downgrade to 'title'", async () => {
    await importFromContent(engine, 'notes/probe-syn', CONTENT, { sourceId: 'vault-syn' });
    // Inline import never runs per-chunk synopsis (Minion backfill does);
    // the downgrade to the free title tier is deliberate and stays.
    expect(await stampedMode('notes/probe-syn', 'vault-syn')).toBe('title');
  }, 60_000);
});

describe('#5621 noEmbed imports record the wrapping convention for the later embed pass', () => {
  const WRAPPED = '<context>CR Mode Probe';
  const deferred = (tag: string) => CONTENT.replace('A body', `A ${tag} body`);
  const paragraph = (tag: string) => Array.from({ length: 250 }, (_, i) => `${tag}${i}`).join(' ') + '.';
  const probePage = (...paragraphs: string[]) =>
    `---\ntitle: "CR Mode Probe"\ntype: note\n---\n\n${paragraphs.join('\n\n')}\n`;
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cr-defer-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function plainSource(id: string): Promise<string> {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [id]);
    return id;
  }

  async function stampedState(slug: string, sourceId: string) {
    const rows = await engine.executeRaw<{ contextual_retrieval_mode: string | null; corpus_generation: string | null }>(
      `SELECT contextual_retrieval_mode, corpus_generation FROM pages WHERE slug = $1 AND source_id = $2`,
      [slug, sourceId],
    );
    expect(rows.length).toBe(1);
    return rows[0];
  }

  async function drain(sourceId: string, extra: EmbedStaleOpts = {}): Promise<string[]> {
    const seen: string[] = [];
    await embedStaleForSource(engine, sourceId, {
      ...extra,
      embedFn: async (texts) => {
        seen.push(...texts);
        return texts.map(() => new Float32Array(STUB_DIMS).fill(0.001));
      },
    });
    return seen;
  }

  /** The sync / Google / GitHub entry point: importFile with embedding deferred. */
  async function importSynced(sourceId: string, relativePath: string, content: string): Promise<string> {
    const file = join(dir, `${sourceId}-${relativePath.split('/').pop() ?? 'page.md'}`);
    writeFileSync(file, content);
    const result = await importFile(engine, file, relativePath, { sourceId, noEmbed: true });
    expect(result.status).toBe('imported');
    return result.slug;
  }

  /** A page left NULL and embedded raw, the shape every noEmbed import had before #5621. */
  async function legacyEmbeddedPage(slug: string, sourceId: string, content: string): Promise<void> {
    await importFromContent(engine, slug, content, { sourceId, noEmbed: true });
    await engine.executeRaw(
      `UPDATE pages SET contextual_retrieval_mode = NULL, corpus_generation = NULL WHERE slug = $1 AND source_id = $2`,
      [slug, sourceId],
    );
    const seen = await drain(sourceId);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((text) => text.startsWith('<context>'))).toBe(false);
  }

  test('noEmbed import stamps the resolved title tier without calling the provider', async () => {
    await importFromContent(engine, 'notes/defer-plain', deferred('plain'), { sourceId: 'vault-plain', noEmbed: true });
    expect(embedderInputs).toHaveLength(0);
    expect(await stampedState('notes/defer-plain', 'vault-plain')).toEqual({
      contextual_retrieval_mode: 'title',
      corpus_generation: titleTierCorpusGeneration(),
    });
  }, 60_000);

  test("noEmbed import honors a source override of 'none'", async () => {
    await importFromContent(engine, 'notes/defer-off', deferred('off'), { sourceId: 'vault-off', noEmbed: true });
    expect(await stampedState('notes/defer-off', 'vault-off')).toEqual({
      contextual_retrieval_mode: 'none',
      corpus_generation: null,
    });
  }, 60_000);

  test("noEmbed import demotes a per_chunk_synopsis source to the title tier", async () => {
    const slug = await importSynced('vault-syn', 'notes/deferred-syn.md', deferred('synopsis'));
    expect(embedderInputs).toHaveLength(0);
    expect(await stampedState(slug, 'vault-syn')).toEqual({
      contextual_retrieval_mode: 'title',
      corpus_generation: titleTierCorpusGeneration(),
    });
    const seen = await drain('vault-syn');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((text) => text.startsWith(WRAPPED))).toBe(true);
  }, 60_000);

  test('a failed source read fails the noEmbed import instead of stamping the global mode', async () => {
    const slug = 'notes/defer-read-fault';
    const original = engine.executeRaw;
    let faults = 0;
    // Keep `this`: transaction engines inherit this property, and routing
    // their reads back to the outer engine would deadlock PGLite.
    engine.executeRaw = async function (this: PGLiteEngine, sql: string, params?: unknown[]) {
      if (faults === 0 && sql.includes('trust_frontmatter_overrides') && sql.includes('FROM sources WHERE id')) {
        faults++;
        throw new Error('source read reset');
      }
      return original.call(this, sql, params);
    } as typeof engine.executeRaw;
    try {
      await expect(importFromContent(engine, slug, deferred('fault'), { sourceId: 'vault-off', noEmbed: true }))
        .rejects.toThrow('source read reset');
    } finally {
      engine.executeRaw = original;
    }
    expect(faults).toBe(1);
    const rows = await engine.executeRaw(`SELECT 1 FROM pages WHERE slug = $1 AND source_id = 'vault-off'`, [slug]);
    expect(rows).toHaveLength(0);
  }, 60_000);

  test('a file synced with noEmbed is embedded title-wrapped by the stale drain', async () => {
    const sourceId = await plainSource('vault-drain');
    const slug = await importSynced(sourceId, 'notes/deferred.md', deferred('synced'));
    expect(embedderInputs).toHaveLength(0);
    const seen = await drain(sourceId);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((text) => text.startsWith(WRAPPED))).toBe(true);
    expect((await stampedState(slug, sourceId)).contextual_retrieval_mode).toBe('title');
  }, 60_000);

  test('a changed noEmbed re-import leaves no unwrapped vector under the new stamp', async () => {
    const sourceId = await plainSource('vault-changed');
    const slug = 'notes/defer-changed';
    await legacyEmbeddedPage(slug, sourceId, probePage(paragraph('a'), paragraph('b'), paragraph('c')));
    const before = await engine.getChunks(slug, { sourceId });
    expect(before.length).toBeGreaterThanOrEqual(3);

    await importFromContent(engine, slug, probePage(paragraph('a'), paragraph('b'), paragraph('edited')), {
      sourceId,
      noEmbed: true,
    });
    expect((await stampedState(slug, sourceId)).contextual_retrieval_mode).toBe('title');
    const chunks = await engine.getChunks(slug, { sourceId });
    // Unchanged paragraphs keep their chunk_text; their raw vectors must still go.
    expect(chunks.some((chunk) => before.some((old) => old.chunk_text === chunk.chunk_text))).toBe(true);
    expect(chunks.every((chunk) => chunk.embedding_is_null === true)).toBe(true);

    const seen = await drain(sourceId);
    expect(seen).toHaveLength(chunks.length);
    expect(seen.every((text) => text.startsWith(WRAPPED))).toBe(true);
  }, 60_000);

  test('unchanged content keeps its legacy convention: the backlog stays reindex work', async () => {
    const sourceId = await plainSource('vault-unchanged');
    const slug = 'notes/defer-unchanged';
    await legacyEmbeddedPage(slug, sourceId, deferred('unchanged'));

    const result = await importFromContent(engine, slug, deferred('unchanged'), { sourceId, noEmbed: true });
    expect(result.status).toBe('skipped');
    expect(await stampedState(slug, sourceId)).toEqual({ contextual_retrieval_mode: null, corpus_generation: null });
    const chunks = await engine.getChunks(slug, { sourceId });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.embedding_is_null === false)).toBe(true);
  }, 60_000);

  test('a page whose chunks straddle a drain batch is wrapped on both sides of the boundary', async () => {
    const sourceId = await plainSource('vault-straddle');
    const slug = await importSynced(sourceId, 'notes/straddle.md', probePage(paragraph('x'), paragraph('y'), paragraph('z')));
    const chunks = await engine.getChunks(slug, { sourceId });
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const seen = await drain(sourceId, { concurrency: 1, batchSize: 2 });
    expect(seen).toHaveLength(chunks.length);
    expect(seen.every((text) => text.startsWith(WRAPPED))).toBe(true);
    expect((await stampedState(slug, sourceId)).contextual_retrieval_mode).toBe('title');
    expect((await engine.getChunks(slug, { sourceId })).every((chunk) => chunk.embedding_is_null === false)).toBe(true);
  }, 60_000);

  test('a code import keeps the raw convention', async () => {
    const sourceId = await plainSource('vault-code');
    const slug = await importSynced(sourceId, 'src/probe.ts', 'export function probe(value: number): number {\n  return value * 2;\n}\n');
    const seen = await drain(sourceId);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((text) => text.includes('<context>'))).toBe(false);
    expect((await stampedState(slug, sourceId)).contextual_retrieval_mode).toBeNull();
  }, 60_000);

  test('a changed re-import during a drain supersedes the raw vectors it was computing', async () => {
    const sourceId = await plainSource('vault-race');
    const slug = 'notes/defer-race';
    await importFromContent(engine, slug, deferred('race'), { sourceId, noEmbed: true });
    await engine.executeRaw(
      `UPDATE pages SET contextual_retrieval_mode = NULL, corpus_generation = NULL WHERE slug = $1 AND source_id = $2`,
      [slug, sourceId],
    );

    let reimported = false;
    const raw: string[] = [];
    await embedStaleForSource(engine, sourceId, {
      embedFn: async (texts) => {
        raw.push(...texts);
        if (!reimported) {
          reimported = true;
          await importFromContent(engine, slug, deferred('race edited'), { sourceId, noEmbed: true });
        }
        return texts.map(() => new Float32Array(STUB_DIMS).fill(0.001));
      },
    });
    expect(reimported).toBe(true);
    expect(raw.some((text) => text.startsWith('<context>'))).toBe(false);
    expect((await stampedState(slug, sourceId)).contextual_retrieval_mode).toBe('title');
    expect((await engine.getChunks(slug, { sourceId })).every((chunk) => chunk.embedding_is_null === true)).toBe(true);

    const seen = await drain(sourceId);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((text) => text.startsWith(WRAPPED))).toBe(true);
  }, 60_000);
});
