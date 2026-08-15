/**
 * v0.41.31 (F1) — importFromContent stamps pages.embedding_signature when it
 * embeds inline.
 *
 * The inline import/sync path (importFromContent) writes embeddings without
 * going through embed.ts/embed-stale.ts. Before the F1 fix it never stamped
 * the signature, so non-federated/inline brains kept NULL signatures forever
 * → grandfathered → `embed --stale` never re-embedded them after a model swap
 * (the headline feature silently inert). This pins the stamp.
 *
 * Serial: stubs the gateway embed transport (process-global module state).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { currentEmbeddingSignature } from '../src/core/embedding.ts';

let engine: PGLiteEngine;
let colDim: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`,
  );
  colDim = Number(rows[0]?.dim);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: colDim,
    env: { OPENAI_API_KEY: 'sk-test-import-stamp' },
  });
  // Fake transport (AI SDK embedMany shape): receives { values }, returns
  // one zero-vector (sized to the column) per input value.
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => Array(colDim).fill(0)),
    usage: { tokens: 0 },
  }) as any);
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

async function signatureOf(slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ embedding_signature: string | null }>(
    `SELECT embedding_signature FROM pages WHERE slug = $1 AND source_id = 'default'`,
    [slug],
  );
  return rows[0]?.embedding_signature ?? null;
}

describe('importFromContent embedding_signature stamping (F1)', () => {
  test('embeds inline → stamps the current signature', async () => {
    await importFromContent(engine, 'concepts/stamped', '# Stamped\n\nsome body content to chunk and embed.', {});
    expect(await signatureOf('concepts/stamped')).toBe(currentEmbeddingSignature());
  });

  test('--no-embed → leaves signature NULL (grandfathered, not stale)', async () => {
    await importFromContent(engine, 'concepts/unstamped', '# Unstamped\n\nbody content.', { noEmbed: true });
    expect(await signatureOf('concepts/unstamped')).toBeNull();
  });
});
