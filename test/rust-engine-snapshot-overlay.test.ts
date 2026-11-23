/**
 * The Rust withdrawal overlay folds the fence text as the SQL engines do (FACT_SPACE_CLASS), on the page read
 * (`overlayStoreSnapshot`) and on a segmented page's seal lead (`overlayStoreLead`).
 *
 * Authoring gate (docs/TESTING.md): protects a forgotten claim staying hidden on a Rust brain. A regression is a fold
 * by JavaScript's `\s`, which leaves U+0085 unfolded (a withdrawn claim holding it stays live in the seal lead) and
 * folds U+1680 and U+00A0 (an unrelated claim is struck). The parity case in test/engine-parity/page-withdrawal-overlay.test.ts
 * reads pages only; the seal lead is built inside sealSegmentedPage and has no read-back, so this runs the function itself.
 * No seam: the real overlay over rows the store answers, with the fingerprint a ledger row holds.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { normalizeLoweredClaim } from '../src/core/facts/withdrawal-schema.ts';
import { overlayStoreLead } from '../src/core/rust-engine/snapshot-overlay.ts';
import type { PageWithdrawal } from '../src/core/page-state/types.ts';

const hash = (claim: string) => createHash('sha256').update(normalizeLoweredClaim(claim.toLowerCase())).digest('hex');
const ledger = (claim: string, purged = false): PageWithdrawal =>
  ({ visibility: 'private', fact_hash: hash(claim), withdrawn_at: '2026-03-01T10:00:00.000Z', ...(purged ? { purged: true } : {}) });
const lead = (...claims: string[]) => `Lead.\n\n${renderFactsTable(claims.map((claim, i) => ({
  rowNum: i + 1, claim, kind: 'fact' as const, confidence: 1, visibility: 'private' as const, notability: 'medium' as const, active: true, context: '' })))}\n`;
const rows = (text: string) => text.split('\n').filter(line => /^\| \d+ \|/.test(line));

describe('the seal lead of a segmented page on a Rust brain', () => {
  test('strikes a claim holding U+0085 and leaves claims that differ by U+1680 or U+00A0', () => {
    const text = lead('Walks\u0085to work', 'Drinks\u1680green tea', 'Drinks\u00a0green tea');
    const out = overlayStoreLead(text, { withdrawals: [ledger('Walks to work'), ledger('Drinks green tea')] });
    expect(rows(out).map(line => line.includes('forgotten:'))).toEqual([true, false, false]);
  });

  test('drops a purged claim holding U+0085 named by a subject-* tombstone', () => {
    const text = lead('Walks\u0085to work', 'Prefers the aisle seat');
    const out = overlayStoreLead(text, { withdrawals: [], globalPurgeRows: [ledger('Walks to work', true)] });
    expect(rows(out)).toHaveLength(1);
    expect(out).toContain('Prefers the aisle seat');
  });
});
