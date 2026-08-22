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
 * .serial: real PGLite + gateway stubbing (docs/TESTING.md R1).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
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
