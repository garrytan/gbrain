/**
 * Codex review #1 regression guard: cross-modal-eval/json-repair MUST
 * re-export both `parseModelJSON` (the function) AND the type exports
 * `ParsedScore` + `ParsedModelResult`. The original v0.32 plan only had
 * `parseModelJSON` in the shim, which would have compile-broken
 * src/core/cross-modal-eval/aggregate.ts:19's type import.
 *
 * If anyone deletes the `export type` line in the shim (or renames the
 * source-of-truth file in eval-shared/), this test fails first.
 */
import { describe, test, expect } from 'bun:test';

// Both imports below MUST resolve via the shim path. The TS compiler is
// the primary guard here (this is what the shim's missing-type-export
// would have failed); the runtime expects also pin the function shape.
import { parseModelJSON } from '../src/core/cross-modal-eval/json-repair.ts';
import type {
  ParsedScore,
  ParsedModelResult,
} from '../src/core/cross-modal-eval/json-repair.ts';

// Direct import from the moved location too — both paths must work.
import { parseModelJSON as parseModelJSON_shared } from '../src/core/eval-shared/json-repair.ts';
import type {
  ParsedScore as ParsedScore_shared,
  ParsedModelResult as ParsedModelResult_shared,
} from '../src/core/eval-shared/json-repair.ts';

describe('json-repair shim (codex review #1)', () => {
  test('parseModelJSON is callable via the shim path', () => {
    const json = '{"scores":{"a":{"score":7}},"improvements":["x"]}';
    const r = parseModelJSON(json);
    expect(r.scores.a.score).toBe(7);
  });

  test('parseModelJSON via shim and via shared module are the same function', () => {
    expect(parseModelJSON).toBe(parseModelJSON_shared);
  });

  test('ParsedScore type is exported from the shim', () => {
    const s: ParsedScore = { score: 7 };
    expect(s.score).toBe(7);
  });

  test('ParsedModelResult type is exported from the shim', () => {
    const r: ParsedModelResult = {
      scores: { a: { score: 7 } },
      improvements: [],
    };
    expect(r.scores.a.score).toBe(7);
  });

  test('shared module exports the same types', () => {
    // Type-only assertion: the value is fine, but the assignment compile-checks
    // that the types are mutually assignable (they're the same definition).
    const s: ParsedScore_shared = { score: 9 };
    const r: ParsedModelResult_shared = {
      scores: { a: s },
      improvements: [],
    };
    expect(r.scores.a.score).toBe(9);
  });
});
