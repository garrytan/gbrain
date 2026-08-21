/**
 * #4287 — dimension-mismatched writes must fail LOUDLY with a NAMED error.
 *
 * The embedding-plane-split shape: the gateway's configured width matches
 * what the provider returns (so the gateway's own dim self-check passes),
 * but the `content_chunks.embedding` column was built at a different width.
 * Every put then rolls back with pgvector's bare "expected N dimensions,
 * not M" — no code, no statement that the page was NOT stored, no fix.
 *
 * Pins:
 *   - decorateEmbeddingDimError maps that message to a named OperationError
 *     (`embedding_plane_split`) carrying the consequence + recovery command,
 *     and passes every other error through untouched.
 *   - importFromContent surfaces the decorated error end-to-end and the page
 *     write is rolled back (nothing persisted).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { decorateEmbeddingDimError } from '../src/core/embedding-dim-check.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let colDim: number;
let emitDim: number;

beforeAll(async () => {
  // Column is created at the gateway-unconfigured default width; the split is
  // manufactured AFTER init by configuring the gateway at a different width
  // whose transport agrees with it (so only the DB knows better — the #4287
  // trigger, where no config plane names the emitted width's mismatch).
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'
        AND attnum > 0 AND NOT attisdropped`,
  );
  colDim = Number(rows[0]?.dim);
  emitDim = colDim === 24 ? 32 : 24;

  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: emitDim,
    env: { OPENAI_API_KEY: 'sk-test-fake' },
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => new Array(emitDim).fill(0.01)),
    usage: { tokens: values.length * 4 },
  }) as never);
}, 30000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('decorateEmbeddingDimError', () => {
  test('maps the pgvector message to a named OperationError with consequence + fix', () => {
    const decorated = decorateEmbeddingDimError(new Error('expected 1024 dimensions, not 1280'), 'my-page');
    expect(decorated).toBeInstanceOf(OperationError);
    const op = decorated as OperationError;
    expect(op.code).toBe('embedding_plane_split');
    expect(op.message).toContain("page 'my-page' was NOT written");
    expect(op.message).toContain('1280d vectors');
    expect(op.message).toContain('column is 1024d');
    expect(op.suggestion).toContain('gbrain migrate embeddings');
    expect(op.suggestion).toContain('--dim 1280');
  });

  test('passes every other error through untouched', () => {
    const plain = new Error('connection refused');
    expect(decorateEmbeddingDimError(plain, 'x')).toBe(plain);
    const notErr = 'string failure';
    expect(decorateEmbeddingDimError(notErr, 'x')).toBe(notErr);
  });

  test('S2: names the actual failing column when known, plane-agnostic otherwise', () => {
    const named = decorateEmbeddingDimError(
      new Error('expected 8 dimensions, not 24'),
      'p',
      'embedding_voyage',
    ) as OperationError;
    expect(named.message).toContain('content_chunks.embedding_voyage column is 8d');
    const agnostic = decorateEmbeddingDimError(
      new Error('expected 8 dimensions, not 24'),
      'p',
    ) as OperationError;
    expect(agnostic.message).toContain('active embedding column is 8d');
    expect(agnostic.message).not.toContain('content_chunks.embedding');
  });
});

describe('importFromContent on a split embedding plane (#4287)', () => {
  test('throws the named error and rolls the page back', async () => {
    const err = await importFromContent(
      engine,
      'plane/probe',
      '# Probe\n\nSome content that will be embedded.\n',
      {},
    ).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(OperationError);
    const op = err as OperationError;
    expect(op.code).toBe('embedding_plane_split');
    expect(op.message).toContain(`expected ${colDim} dimensions, not ${emitDim}`);
    expect(op.message).toContain("page 'plane/probe' was NOT written");
    expect(op.suggestion).toContain(`--dim ${emitDim}`);

    // Rolled back: nothing persisted (the issue's `get` returned
    // page_not_found while `put` had "succeeded" with exit 0).
    expect(await engine.getPage('plane/probe')).toBeNull();
  });
});
