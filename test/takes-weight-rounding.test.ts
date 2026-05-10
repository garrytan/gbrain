/**
 * Verify: weight normalization at engine layer.
 *
 * Cross-modal eval over 100K takes flagged false precision (e.g. 0.74, 0.82)
 * as calibration accuracy that doesn't exist. The engine layer rounds to a
 * 0.05 grid on every write — addTakesBatch + updateTake in both engines.
 *
 * Imports the real helper (single source of truth) so the test cannot drift
 * from the engine path. Both engines call `normalizeWeightForStorage(raw)`
 * at all 4 takes write sites.
 */
import { describe, it, expect } from 'bun:test';
import { normalizeWeightForStorage } from '../src/core/takes-fence.ts';

// Convenience: extract the numeric weight for the existing positive-path tests.
function roundWeight(w: number | null | undefined): number {
  return normalizeWeightForStorage(w).weight;
}

describe('takes weight normalization (v0.32+ Codex #8 hardening)', () => {
  describe('rounding to 0.05 grid', () => {
    it('rounds 0.74 to 0.75', () => {
      expect(roundWeight(0.74)).toBe(0.75);
    });

    it('rounds 0.82 to 0.80', () => {
      expect(roundWeight(0.82)).toBe(0.80);
    });

    it('preserves exact 0.05 boundaries', () => {
      for (const w of [0, 0.05, 0.10, 0.25, 0.50, 0.75, 0.85, 0.95, 1.0]) {
        expect(roundWeight(w)).toBe(w);
      }
    });

    it('rounds up at midpoint (0.025 → 0.05, 0.075 → 0.10)', () => {
      expect(roundWeight(0.025)).toBe(0.05);
      expect(roundWeight(0.075)).toBe(0.10);
    });

    it('handles edge near 0.5', () => {
      expect(roundWeight(0.47)).toBe(0.45);
      expect(roundWeight(0.48)).toBe(0.50);
      expect(roundWeight(0.52)).toBe(0.50);
      expect(roundWeight(0.53)).toBe(0.55);
    });
  });

  describe('clamping out-of-range', () => {
    it('clamps below zero', () => {
      const r = normalizeWeightForStorage(-0.1);
      expect(r.weight).toBe(0);
      expect(r.clamped).toBe(true);
    });

    it('clamps above one', () => {
      const r = normalizeWeightForStorage(1.3);
      expect(r.weight).toBe(1.0);
      expect(r.clamped).toBe(true);
    });

    it('does not flag in-range values as clamped', () => {
      expect(normalizeWeightForStorage(0.5).clamped).toBe(false);
      expect(normalizeWeightForStorage(0.0).clamped).toBe(false);
      expect(normalizeWeightForStorage(1.0).clamped).toBe(false);
    });

    it('does not flag mere rounding as clamped', () => {
      // 0.74 rounds to 0.75 but is NOT out of range; clamped must stay false.
      expect(normalizeWeightForStorage(0.74).clamped).toBe(false);
      expect(normalizeWeightForStorage(0.82).clamped).toBe(false);
    });
  });

  describe('NaN + Infinity guards (Codex #8)', () => {
    it('NaN → 0.5 + clamped=true', () => {
      const r = normalizeWeightForStorage(NaN);
      expect(r.weight).toBe(0.5);
      expect(r.clamped).toBe(true);
    });

    it('Infinity → 1.0 (via clamp) — guarded as not-finite first, falls to default 0.5', () => {
      const r = normalizeWeightForStorage(Infinity);
      // Codex #8 contract: !Number.isFinite catches Infinity AND NaN; both
      // route to 0.5. This is the safe default; 1.0 would lie about the
      // input being "maximum confidence."
      expect(r.weight).toBe(0.5);
      expect(r.clamped).toBe(true);
    });

    it('-Infinity → 0.5 (same not-finite path)', () => {
      const r = normalizeWeightForStorage(-Infinity);
      expect(r.weight).toBe(0.5);
      expect(r.clamped).toBe(true);
    });

    it('regression: pre-v0.32 code did Math.round(NaN * 20) / 20 = NaN, which would write NaN to the DB', () => {
      // The bug this guard fixes: without Number.isFinite check, NaN survives
      // the (w < 0 || w > 1) check (NaN comparisons are always false) and
      // becomes Math.round(NaN * 20) / 20 = NaN, written through to the DB.
      expect(Number.isFinite(normalizeWeightForStorage(NaN).weight)).toBe(true);
      expect(Number.isFinite(normalizeWeightForStorage(Infinity).weight)).toBe(true);
    });
  });

  describe('null/undefined handling', () => {
    it('undefined → 0.5 with clamped=false (default fence weight)', () => {
      const r = normalizeWeightForStorage(undefined);
      expect(r.weight).toBe(0.5);
      expect(r.clamped).toBe(false);
    });

    it('null → 0.5 with clamped=false', () => {
      const r = normalizeWeightForStorage(null);
      expect(r.weight).toBe(0.5);
      expect(r.clamped).toBe(false);
    });
  });

  describe('updateTake site coverage (Codex #8 — was unhardened in original PR)', () => {
    // The plan caught that updateTake() in both engines had the same NaN hole
    // as addTakesBatch(). Now both call normalizeWeightForStorage. These cases
    // assert the contract is identical at every write site.
    it('updateTake: NaN input → 0.5, clamped=true', () => {
      const r = normalizeWeightForStorage(NaN);
      expect(r.weight).toBe(0.5);
      expect(r.clamped).toBe(true);
    });

    it('updateTake: 0.74 input → 0.75 (rounds, not clamped)', () => {
      const r = normalizeWeightForStorage(0.74);
      expect(r.weight).toBe(0.75);
      expect(r.clamped).toBe(false);
    });

    it('updateTake: out-of-range input gets the same treatment as addTakesBatch', () => {
      expect(normalizeWeightForStorage(2.5).weight).toBe(1.0);
      expect(normalizeWeightForStorage(-3).weight).toBe(0.0);
    });
  });
});
