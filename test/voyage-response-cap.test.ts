/**
 * v0.31.8 — voyage adapter Content-Length pre-check + per-item cap (D2 + D10).
 *
 * Pre-fix: voyageCompatFetch in src/core/ai/gateway.ts called
 * `await resp.clone().json()` BEFORE iterating embeddings. A malicious or
 * compromised Voyage response of arbitrary size was fully parsed into the
 * JS heap before any cap could fire. The fix adds two layers:
 *
 *   Layer 1 (PRIMARY): Content-Length header pre-check, fires BEFORE
 *           `resp.clone().json()` so the JSON.parse OOM vector is gated.
 *   Layer 2 (defense-in-depth): per-embedding base64 length check inside
 *           the iteration; catches the rare case where Layer 1 was skipped
 *           because the response uses chunked encoding (no Content-Length).
 *
 * The cap is 256 MB — sized as "unambiguously not legitimate" (the
 * realistic upper bound is voyage-3-large × 16K embeddings ≈ 200 MB raw).
 *
 * Tests are structural source-string assertions (matches the doctor.test.ts
 * style) because voyageCompatFetch is a closed-over helper inside the
 * recipe instantiation path and isn't exported. Behavioral coverage of the
 * voyage adapter lives in the existing E2E tests that hit a live Voyage
 * endpoint; these regression guards pin the SHAPE so a silent revert
 * (e.g. moving the cap below the resp.clone().json() call) fails loudly.
 */

import { describe, test, expect } from 'bun:test';

describe('v0.31.8 — voyage Content-Length pre-check + per-item cap', () => {
  test('MAX_VOYAGE_RESPONSE_BYTES constant is declared at 256 MB (D2 sizing)', async () => {
    const source = await Bun.file(new URL('../src/core/ai/gateway.ts', import.meta.url)).text();
    // 256 * 1024 * 1024 == 268435456. Either form is acceptable; assert
    // both so a silent re-tighten to 64 MB or 128 MB fails this test.
    expect(source).toContain('MAX_VOYAGE_RESPONSE_BYTES');
    expect(source).toMatch(/MAX_VOYAGE_RESPONSE_BYTES\s*=\s*256\s*\*\s*1024\s*\*\s*1024/);
  });

  test('Layer 1: Content-Length pre-check fires BEFORE resp.clone().json() (D10 OOM defense)', async () => {
    const source = await Bun.file(new URL('../src/core/ai/gateway.ts', import.meta.url)).text();
    // Anchor relative to the post-fetch handler block. The function declaration
    // contains an OUTBOUND request body section earlier; we want to verify
    // the INBOUND ordering (everything after `await fetch(input, init)`).
    const fetchCallIdx = source.indexOf('const resp = await fetch(input, init);');
    expect(fetchCallIdx).toBeGreaterThan(0);
    const inboundBlock = source.slice(fetchCallIdx, fetchCallIdx + 6000);

    // Pre-check string. Use the actual code shape from gateway.ts so the test
    // doesn't pin to comment text.
    const preCheckIdx = inboundBlock.indexOf("resp.headers.get('content-length')");
    // Use the full lvalue assignment so the match doesn't accidentally hit
    // comment text that mentions `await resp.clone().json()` for context.
    const jsonParseIdx = inboundBlock.indexOf('const json: any = await resp.clone().json()');
    expect(preCheckIdx).toBeGreaterThan(0);
    expect(jsonParseIdx).toBeGreaterThan(0);
    // The pre-check MUST appear before the JSON parse — otherwise the OOM
    // defense is theatrical (the original codex OV8 finding). This is the
    // critical structural invariant for D10.
    expect(preCheckIdx).toBeLessThan(jsonParseIdx);
  });

  test('Layer 1 throws on Content-Length over the cap (not silent return)', async () => {
    const source = await Bun.file(new URL('../src/core/ai/gateway.ts', import.meta.url)).text();
    // The cap check must use `throw new Error(...)` so the embed flow's
    // retry/backoff sees a failure, NOT a silent pass-through.
    expect(source).toMatch(/exceeds[^`]*MAX_VOYAGE_RESPONSE_BYTES[^`]*bytes/);
    expect(source).toMatch(/throw new Error\([\s\S]{0,200}Voyage response Content-Length/);
  });

  test('Layer 2: per-embedding base64 cap fires inside the json.data iteration', async () => {
    const source = await Bun.file(new URL('../src/core/ai/gateway.ts', import.meta.url)).text();
    // Defense-in-depth: even when Content-Length header is missing
    // (chunked encoding), each embedding string is bounded.
    expect(source).toMatch(/item\.embedding\.length\s*\*\s*0\.75/);
    expect(source).toMatch(/throw new Error\([\s\S]{0,200}Voyage embedding base64/);
  });

  test('comment thread documents both layers + the cap-sizing decision', async () => {
    const source = await Bun.file(new URL('../src/core/ai/gateway.ts', import.meta.url)).text();
    // Anti-regression: the comment thread is part of the contract. If a
    // refactor strips them, future maintainers won't know why the order
    // matters or why the cap is 256 MB.
    expect(source).toContain('Layer 1');
    expect(source).toContain('Layer 2');
    expect(source).toMatch(/16K embeddings/);
  });
});
