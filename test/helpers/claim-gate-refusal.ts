import { expect } from 'bun:test';
import { CLAIM_RELEASE_PATH_MEMBER } from '../../src/core/persistence/claim-release-gate.ts';

/** The exact refusal `assertClaimReleasable` gives a real `writer_claim` on an engine without raw SQL (the Rust engine). */
export function expectClaimGateRefusal(error: unknown): void {
  const e = error as { code?: unknown; reason?: unknown; detail?: unknown };
  expect({ code: e.code, reason: e.reason, detail: e.detail }).toEqual({
    code: 'engine_capability_missing', reason: 'raw_sql',
    detail: `member=${CLAIM_RELEASE_PATH_MEMBER} capability=raw_sql outcome=none written=nothing`,
  });
}
