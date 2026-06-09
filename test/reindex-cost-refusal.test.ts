/**
 * v0.42.11.0 (#1784) — reindex-code cost-refusal format unit tests.
 *
 * The cost gate still REFUSES to spend non-interactively without --yes (exit 2,
 * tested at the CLI layer). This pins the separate FORMAT axis: JSON only when
 * --json is explicit; otherwise a human refusal on stderr. Pure function — no
 * brain, no real cost preview.
 */
import { describe, test, expect } from 'bun:test';
import { buildCostRefusal } from '../src/commands/reindex-code.ts';

const PREVIEW_MSG = 'reindex-code: 42 code page(s), ~12,345 tokens, est. $0.12 on voyage:voyage-code-3.';

describe('buildCostRefusal', () => {
  test('--json → machine-readable envelope on stdout, nothing on stderr', () => {
    const r = buildCostRefusal({
      json: true,
      previewMsg: PREVIEW_MSG,
      preview: { totalPages: 42, totalTokens: 12345 },
      costUsd: 0.12,
      model: 'voyage:voyage-code-3',
    });
    expect(r.stderr).toBeUndefined();
    expect(typeof r.stdout).toBe('string');
    const parsed = JSON.parse(r.stdout!);
    expect(parsed.error).toBeDefined();
    // The structured refusal must still carry the confirmation code + context.
    expect(JSON.stringify(parsed.error)).toContain('cost_preview_requires_yes');
    expect(parsed.costUsd).toBe(0.12);
    expect(parsed.model).toBe('voyage:voyage-code-3');
    expect(parsed.preview).toEqual({ totalPages: 42, totalTokens: 12345 });
  });

  test('no --json → human refusal on stderr, nothing on stdout (not JSON)', () => {
    const r = buildCostRefusal({
      json: false,
      previewMsg: PREVIEW_MSG,
      preview: {},
      costUsd: 0.12,
      model: 'voyage:voyage-code-3',
    });
    expect(r.stdout).toBeUndefined();
    expect(typeof r.stderr).toBe('string');
    // Human text: includes the preview, the refusal reason, and both escape hatches.
    expect(r.stderr).toContain(PREVIEW_MSG);
    expect(r.stderr).toContain('Refusing to re-embed');
    expect(r.stderr).toContain('--yes');
    expect(r.stderr).toContain('--dry-run');
    // Must NOT be a JSON envelope.
    expect(r.stderr!.trimStart().startsWith('{')).toBe(false);
  });
});
