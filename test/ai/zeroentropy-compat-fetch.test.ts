/**
 * v0.33.3.0 — structural source-shape assertions for zeroEntropyCompatFetch.
 *
 * Mirrors the test/voyage-response-cap.test.ts pattern: the shim is a
 * closed-over helper inside the embedding instantiation path and isn't
 * exported. Behavioral coverage of ZE flows happens in the gateway/embed
 * tests (with __setEmbedTransportForTests stubbing); these structural
 * pins guard the SHAPE of the shim so a silent revert fails loudly.
 *
 * Pins:
 *  - URL path rewrite `/embeddings` → `/models/embed`.
 *  - Body inject: input_type default to 'document'; encoding_format forced
 *    to 'float' (don't trust SDK default per CDX2-F2).
 *  - Response rewrite: `{results: [{embedding}]}` → `{data: [{embedding,
 *    index}]}`.
 *  - usage.prompt_tokens injection (CDX2-F1 — AI SDK schema requires it
 *    when usage is present; Voyage's shim already had to do this).
 *  - OOM caps: MAX_ZEROENTROPY_RESPONSE_BYTES=256MB; Layer 1
 *    Content-Length, Layer 2 per-embedding size.
 *  - instantiateEmbedding branch: `recipe.id === 'zeroentropyai'` →
 *    `zeroEntropyCompatFetch`.
 */

import { describe, test, expect } from 'bun:test';

const GATEWAY_PATH = new URL('../../src/core/ai/gateway.ts', import.meta.url);

describe('zeroEntropyCompatFetch — shim structural shape', () => {
  test('declared at module scope alongside voyageCompatFetch', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    expect(src).toMatch(/const zeroEntropyCompatFetch\s*=\s*\(async \(input: RequestInfo \| URL/);
  });

  test('cast through unknown to typeof fetch (Bun preconnect compat)', async () => {
    // The Voyage shim has the same trick — without `as unknown as typeof
    // fetch` the function-arrow type loses Bun's `preconnect` method
    // signature. Pinning here prevents a future refactor from removing
    // the cast and re-introducing the tsc TS2741 failure documented in
    // gateway.ts:556 comments.
    const src = await Bun.file(GATEWAY_PATH).text();
    expect(src).toMatch(/\}\)\s*as unknown as typeof fetch;[\s\S]{0,200}async function resolveEmbeddingProvider/);
  });

  test('URL rewrite: /embeddings → /models/embed (CDX1-F2)', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    // The rewrite logic must:
    //  - normalize input via toString() so URL/string/Request all work
    //  - replace exact suffix `/embeddings` with `/models/embed`
    expect(src).toMatch(/u\.pathname\.endsWith\(['"]\/embeddings['"]\)/);
    expect(src).toMatch(/\/models\/embed/);
    // Negative: must NOT have a `/v1/v1/` form (that would be the
    // pre-fix double-prefix bug).
    expect(src).not.toContain('/v1/v1/');
  });

  test('body injects input_type default "document"', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    // The wrapper defaults input_type to 'document' when caller didn't
    // thread one (matches the document-side correctness for sync /
    // import / embed CLI paths).
    expect(src).toMatch(/parsed\.input_type\s*===\s*undefined/);
    expect(src).toMatch(/parsed\.input_type\s*=\s*['"]document['"]/);
  });

  test('body forces encoding_format=float (CDX2-F2)', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    // Don't trust SDK default; refuse base64 to keep response rewriter
    // simple (no base64 decode path needed).
    expect(src).toMatch(/parsed\.encoding_format\s*!==\s*['"]float['"]/);
    expect(src).toMatch(/parsed\.encoding_format\s*=\s*['"]float['"]/);
  });

  test('response shape rewrite: results → data with index stamped', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    // The wrapper converts ZE's {results: [{embedding}]} to
    // {data: [{embedding, index}]} for the SDK's openai-compat parser.
    expect(src).toMatch(/json\.data\s*=\s*json\.results\.map\(/);
    expect(src).toMatch(/embedding:\s*r\?\.embedding/);
    expect(src).toMatch(/index:\s*i/);
    expect(src).toMatch(/delete json\.results/);
  });

  test('usage.prompt_tokens injected from total_tokens (CDX2-F1)', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    // AI SDK schema requires prompt_tokens when usage is present. Voyage's
    // shim had the same fix at gateway.ts:655.
    expect(src).toMatch(/json\.usage\.prompt_tokens\s*===\s*undefined/);
    expect(src).toMatch(/json\.usage\.prompt_tokens\s*=\s*\n?\s*typeof json\.usage\.total_tokens\s*===\s*['"]number['"]/);
  });
});

describe('zeroEntropyCompatFetch — OOM caps', () => {
  test('MAX_ZEROENTROPY_RESPONSE_BYTES declared at 256 MB (matches Voyage sizing)', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    expect(src).toContain('MAX_ZEROENTROPY_RESPONSE_BYTES');
    expect(src).toMatch(/MAX_ZEROENTROPY_RESPONSE_BYTES\s*=\s*256\s*\*\s*1024\s*\*\s*1024/);
  });

  test('Layer 1: Content-Length pre-check before resp.clone().json()', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    // Find the zeroEntropyCompatFetch block bounds, then assert ordering
    // within it (mirroring the voyage cap test pattern).
    const zeFetchStart = src.indexOf('const zeroEntropyCompatFetch');
    expect(zeFetchStart).toBeGreaterThan(0);
    const block = src.slice(zeFetchStart, zeFetchStart + 8000);

    const preCheckIdx = block.indexOf("resp.headers.get('content-length')");
    const jsonParseIdx = block.indexOf('await resp.clone().json()');
    expect(preCheckIdx).toBeGreaterThan(0);
    expect(jsonParseIdx).toBeGreaterThan(0);
    // The pre-check MUST appear before the JSON parse — Voyage's lesson
    // (codex OV8 finding): without the ordering, the OOM defense is
    // theatrical.
    expect(preCheckIdx).toBeLessThan(jsonParseIdx);
  });

  test('Layer 1 throws ZeroEntropyResponseTooLargeError (not silent return)', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    expect(src).toMatch(/throw new ZeroEntropyResponseTooLargeError\([\s\S]{0,200}Content-Length/);
  });

  test('Layer 2: per-embedding size cap inside results iteration', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    // ZE returns float[] arrays (not base64 like Voyage). The cap counts
    // elements × 4 bytes (Float32 width).
    expect(src).toMatch(/item\.embedding\.length\s*\*\s*4/);
    expect(src).toMatch(/throw new ZeroEntropyResponseTooLargeError\([\s\S]{0,200}embedding exceeds/);
  });

  test('inbound try/catch rethrows ZeroEntropyResponseTooLargeError', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    // Same rethrow pattern as Voyage's catch-block: instanceof check
    // ensures OOM-cap throws aren't silently swallowed by the parse-error
    // fallback.
    expect(src).toContain('ZeroEntropyResponseTooLargeError');
    expect(src).toMatch(/if\s*\(\s*err\s+instanceof\s+ZeroEntropyResponseTooLargeError\s*\)\s*throw\s+err/);
  });
});

describe('instantiateEmbedding wiring', () => {
  test('recipe.id === "zeroentropyai" branch installs zeroEntropyCompatFetch', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    // Pinned: the ternary at gateway.ts that picks the right fetch wrapper
    // for openai-compat recipes. Without this branch, the shim is dead code.
    expect(src).toMatch(/recipe\.id\s*===\s*['"]zeroentropyai['"]\s*\?[\s]*zeroEntropyCompatFetch/);
  });

  test('branch lives in the openai-compatible case of instantiateEmbedding', async () => {
    const src = await Bun.file(GATEWAY_PATH).text();
    const fnIdx = src.indexOf('function instantiateEmbedding(');
    const ocIdx = src.indexOf("case 'openai-compatible':", fnIdx);
    const branchIdx = src.indexOf('zeroEntropyCompatFetch', ocIdx);
    expect(fnIdx).toBeGreaterThan(0);
    expect(ocIdx).toBeGreaterThan(0);
    // Branch sits within ~2KB of the case opener (in the fetchWrapper
    // ternary) — a sanity bound on where it lives.
    expect(branchIdx).toBeGreaterThan(ocIdx);
    expect(branchIdx - ocIdx).toBeLessThan(2000);
  });
});
