/**
 * v0.19.0 Layer 6 E2 — incremental chunking test.
 *
 * Verifies importCodeFile reuses existing embeddings for unchanged
 * chunks on re-import, only embedding truly new/changed chunks. This
 * is the cost-saving behavior users experience as "daily autopilot
 * costs cents not dollars".
 *
 * Strategy: mock embedBatch to track how many unique texts get
 * embedded across two imports of slightly-different versions of the
 * same file. First import embeds everything; second import embeds
 * only the changed chunk.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('importCodeFile — incremental chunking', () => {
  test('re-importing same content skips embedding entirely', async () => {
    const filePath = 'src/test/pure-same.ts';
    const src = `export function unchanged() {
  let sum = 0;
  for (let i = 0; i < 100; i++) { sum += i; }
  if (sum < 0) return 0;
  if (sum > 1000000) return 1000000;
  return sum;
}`;

    // First import: embedding disabled so we just check the shape.
    const r1 = await importCodeFile(engine, filePath, src, { noEmbed: true });
    expect(r1.status).toBe('imported');
    // Second import with identical content: content_hash matches, skipped.
    const r2 = await importCodeFile(engine, filePath, src, { noEmbed: true });
    expect(r2.status).toBe('skipped');
    expect(r2.chunks).toBe(0);
  });

  test('editing one function preserves unchanged chunks in DB', async () => {
    const filePath = 'src/test/mixed-edit.ts';
    // Each function needs to be large enough that small-sibling merging
    // doesn't collapse them into one chunk (threshold is 40% of
    // chunkSizeTokens default 300 = 120 tokens per chunk).
    const srcV1 = `export function alpha(a: number[], b: number[], c: number[]): number {
  let sum = 0;
  for (const x of a) { sum += x; }
  for (const x of b) { sum += x * 2; }
  for (const x of c) { sum += x * 3; }
  if (sum < 0) return 0;
  if (sum > 1_000_000) return 1_000_000;
  if (a.length === b.length) return sum * 2;
  if (b.length === c.length) return sum * 3;
  if (a.length + b.length + c.length < 100) return sum;
  return sum / (a.length + b.length + c.length);
}

export function beta(x: number[], y: number[], z: number[]): number {
  let sum = 0;
  for (const v of x) { sum += v * 2; }
  for (const v of y) { sum += v * 4; }
  for (const v of z) { sum += v * 6; }
  if (sum < 0) return 0;
  if (sum > 2_000_000) return 2_000_000;
  if (x.length === y.length) return sum * 3;
  if (y.length === z.length) return sum * 5;
  if (x.length + y.length + z.length < 200) return sum;
  return sum / (x.length + y.length + z.length);
}

export function gamma(p: number[], q: number[], r: number[]): number {
  let sum = 0;
  for (const v of p) { sum += v * 3; }
  for (const v of q) { sum += v * 6; }
  for (const v of r) { sum += v * 9; }
  if (sum < 0) return 0;
  if (sum > 3_000_000) return 3_000_000;
  if (p.length === q.length) return sum * 4;
  if (q.length === r.length) return sum * 7;
  if (p.length + q.length + r.length < 300) return sum;
  return sum / (p.length + q.length + r.length);
}`;
    await importCodeFile(engine, filePath, srcV1, { noEmbed: true });
    const v1Slug = 'src-test-mixed-edit-ts';
    const chunksV1 = await engine.getChunks(v1Slug);
    expect(chunksV1.length).toBeGreaterThan(0);

    // Edit ONLY beta's inner constants — alpha and gamma chunks remain identical.
    const srcV2 = srcV1.replace('v * 2; }\n  for (const v of y) { sum += v * 4', 'v * 2; }\n  for (const v of y) { sum += v * 7');
    await importCodeFile(engine, filePath, srcV2, { noEmbed: true });
    const chunksV2 = await engine.getChunks(v1Slug);
    expect(chunksV2.length).toBe(chunksV1.length);

    // The chunk containing "alpha" should be byte-identical between v1 and v2.
    const alphaV1 = chunksV1.find(c => c.chunk_text.includes('alpha'));
    const alphaV2 = chunksV2.find(c => c.chunk_text.includes('alpha'));
    expect(alphaV1).toBeDefined();
    expect(alphaV2).toBeDefined();
    expect(alphaV2!.chunk_text).toBe(alphaV1!.chunk_text);

    // The beta chunk should have changed text.
    const betaV1 = chunksV1.find(c => c.chunk_text.includes('function beta'));
    const betaV2 = chunksV2.find(c => c.chunk_text.includes('function beta'));
    expect(betaV1).toBeDefined();
    expect(betaV2).toBeDefined();
    expect(betaV2!.chunk_text).not.toBe(betaV1!.chunk_text);
  });

  // Regression: #2544 dropped `cc.embedding` from getChunks' column list, so
  // `matched.embedding` was always undefined and the reuse cache silently died.
  // Every other test here passes `noEmbed`, so nothing caught it. This one
  // embeds for real, and inserting comment lines above the symbols moves only
  // the line numbers in each chunk header — every body stays byte-identical.
  test('inserting lines above unchanged symbols reuses stored embeddings', async () => {
    const filePath = 'src/test/reuse-after-shift.ts';
    const bodies = `export function alpha(a: number[], b: number[], c: number[]): number {
  let sum = 0;
  for (const x of a) { sum += x; }
  for (const x of b) { sum += x * 2; }
  for (const x of c) { sum += x * 3; }
  if (sum < 0) return 0;
  if (sum > 1_000_000) return 1_000_000;
  if (a.length === b.length) return sum * 2;
  if (b.length === c.length) return sum * 3;
  return sum / (a.length + b.length + c.length);
}

export function beta(x: number[], y: number[], z: number[]): number {
  let sum = 0;
  for (const v of x) { sum += v * 2; }
  for (const v of y) { sum += v * 4; }
  for (const v of z) { sum += v * 6; }
  if (sum < 0) return 0;
  if (sum > 2_000_000) return 2_000_000;
  if (x.length === y.length) return sum * 3;
  if (y.length === z.length) return sum * 5;
  return sum / (x.length + y.length + z.length);
}

export function gamma(p: number[], q: number[], r: number[]): number {
  let sum = 0;
  for (const v of p) { sum += v * 3; }
  for (const v of q) { sum += v * 6; }
  for (const v of r) { sum += v * 9; }
  if (sum < 0) return 0;
  if (sum > 3_000_000) return 3_000_000;
  if (p.length === q.length) return sum * 4;
  if (q.length === r.length) return sum * 7;
  return sum / (p.length + q.length + r.length);
}`;
    const slug = 'src-test-reuse-after-shift-ts';

    await importCodeFile(engine, filePath, bodies, { noEmbed: true });
    const seeded = await engine.getChunks(slug);
    expect(seeded.length).toBeGreaterThan(1);

    // Derive the vector width from the column itself — the configured model
    // resizes it (1280 here, not schema.sql's declared 1536).
    const [dimRow] = await engine.executeRaw<{ atttypmod: number }>(
      `SELECT atttypmod FROM pg_attribute
        WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`,
    );
    const dims = dimRow!.atttypmod;
    expect(dims).toBeGreaterThan(0);

    // Seed one distinguishable vector per chunk, chunk_text preserved verbatim.
    await engine.upsertChunks(slug, seeded.map((c, i) => ({
      chunk_index: c.chunk_index,
      chunk_text: c.chunk_text,
      chunk_source: c.chunk_source,
      embedding: new Float32Array(dims).fill((i + 1) / 10),
      token_count: c.token_count ?? undefined,
      language: c.language ?? undefined,
      symbol_name: c.symbol_name ?? undefined,
      symbol_type: c.symbol_type ?? undefined,
      start_line: c.start_line ?? undefined,
      end_line: c.end_line ?? undefined,
    })));
    const before = await engine.getChunksWithEmbeddings(slug);
    expect(before.every((c) => c.embedding !== null)).toBe(true);

    // Two comment lines at the top: no new symbol, so every body is unchanged
    // and only the `[TypeScript] path:N-M symbol` headers shift.
    const shifted = `// added line one\n// added line two\n${bodies}`;
    // Keys cleared so a reuse regression fails loudly instead of hitting a
    // real provider; embedBatch would throw and leave embedding NULL.
    await withEnv({
      OPENAI_API_KEY: undefined,
      ZEROENTROPY_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
    }, async () => {
      const r = await importCodeFile(engine, filePath, shifted, {});
      expect(r.status).toBe('imported');
    });

    // Every seeded vector survived byte-for-byte => embedBatch was never
    // consulted. upsertChunks takes EXCLUDED.embedding whenever chunk_text
    // changed (and it did — the headers moved), so a miss would NULL these out.
    const after = await engine.getChunksWithEmbeddings(slug);
    expect(after.length).toBe(before.length);
    for (const c of after) {
      const src = before.find((b) => b.chunk_index === c.chunk_index);
      expect(c.embedding).not.toBeNull();
      expect(Array.from(c.embedding!)).toEqual(Array.from(src!.embedding!));
    }
    // getChunks still hides vectors by default — the #2544 egress fix stands.
    expect((await engine.getChunks(slug)).every((c) => !c.embedding)).toBe(true);
  });

  test('new file import embeds all chunks (nothing to reuse)', async () => {
    const filePath = 'src/test/fresh.ts';
    const src = `export function only() {
  let x = 0;
  for (let i = 0; i < 100; i++) { x += i; }
  if (x < 0) return 0;
  if (x > 1000) return 1000;
  return x;
}`;
    const r = await importCodeFile(engine, filePath, src, { noEmbed: true });
    expect(r.status).toBe('imported');
    expect(r.chunks).toBeGreaterThan(0);
  });
});
