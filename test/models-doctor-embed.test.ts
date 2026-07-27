import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * v0.40.x — `gbrain models doctor` embedding reachability probe.
 *
 * `probeEmbeddingReachability` is an internal (non-exported) function with a
 * network side effect, mirroring the existing `probeRerankerReachability`
 * which has no behavioral test either. Rather than export it purely for a
 * test and reconstruct the embed dim-check stub, this pins the three
 * structural invariants codex flagged during plan review (the error-branch
 * classification itself comes from `classifyError`, already covered):
 *
 *   #6 — uses `embed(...)`, NOT `embedQuery` (embedQuery takes no abortSignal)
 *   #7 — a distinct `'embedding_reachability'` ProbeResult.touchpoint member
 *   #8 — gated on probeEmbeddingConfig returning 'ok' (no double-reporting)
 *
 * Source-text assertions, same convention as test/v0_37_gap_fill.serial.test.ts.
 */
describe('models doctor — embedding reachability probe (v0.40.x)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'models.ts'), 'utf-8');

  test("ProbeResult.touchpoint declares 'embedding_reachability' (codex #7)", () => {
    expect(src).toContain("'embedding_reachability'");
    // Distinct from the zero-network config probe's touchpoint.
    expect(src).toContain("'embedding_config'");
  });

  test('probeEmbeddingReachability uses embed() with inputType query + abort signal (codex #6)', () => {
    const fnIdx = src.indexOf('async function probeEmbeddingReachability');
    expect(fnIdx).toBeGreaterThan(0);
    const slice = src.slice(fnIdx, fnIdx + 1500);
    expect(slice).toContain('embed([');
    expect(slice).toContain("inputType: 'query'");
    expect(slice).toContain('abortSignal');
    // Must NOT use embedQuery (no abort signal support — codex #6).
    expect(slice).not.toContain('embedQuery(');
  });

  test('runModels gates embedding reachability on config-probe ok (codex #8)', () => {
    const runIdx = src.indexOf('export async function runModels');
    expect(runIdx).toBeGreaterThan(0);
    const slice = src.slice(runIdx);
    // The config probe result is captured and the reachability call is gated
    // on its status === 'ok' before firing.
    expect(slice).toContain('const embeddingConfig = await probeEmbeddingConfig()');
    expect(slice).toMatch(/embeddingConfig\.status === 'ok'[\s\S]*probeEmbeddingReachability\(\)/);
  });
});
