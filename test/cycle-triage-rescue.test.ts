/**
 * F2 — verified-segment rescue for the dream triage gate (eval write-path
 * fix wave). The contract under test: rescue fires ONLY inside the band
 * [floor, threshold), ONLY for allowed content types, ONLY on mechanically
 * verified substantive segments — and the kill switch (min_segments=0)
 * degenerates the gate to the plain threshold check.
 */
import { describe, test, expect } from 'bun:test';
import {
  applyTriageRescue,
  passesTriageGate,
  DEFAULT_RESCUE_CONFIG,
  DEFAULT_RESCUE_FLOOR,
  DEFAULT_RESCUE_MIN_SEGMENTS,
  MIN_RESCUE_SEGMENT_NORM_CHARS,
} from '../src/core/cycle/triage-rescue.ts';

const THRESHOLD = 0.5;

// Two substantive passages (comfortably over the 40-normalized-char bar)
// buried in routine chatter — the Cat 35 buried-signal shape.
const TRANSCRIPT = [
  'user: can you check my calendar for tomorrow',
  'assistant: done, three meetings.',
  'user: actually — I keep coming back to the idea that our retention problem',
  'is really an onboarding problem wearing a trench coat. Nobody churns after',
  'week four; everyone churns in week one.',
  'user: also remind me to buy batteries',
  'user: and I decided we will kill the referral program entirely next quarter',
  'because it cannibalizes organic signups at 3x the cost.',
].join('\n');

const SEG_A = { quote: 'our retention problem is really an onboarding problem wearing a trench coat' };
const SEG_B = { quote: 'we will kill the referral program entirely next quarter because it cannibalizes organic signups' };
const SEG_FABRICATED = { quote: 'we should pivot the whole company to enterprise sales immediately' };
const SEG_SHORT_REAL = { quote: 'buy batteries' }; // verifies, but not substantive

function verdict(over: Partial<{ score: number | null; content_type: string | null; segments: Array<{ quote: string }> }>) {
  return { score: 0.35, content_type: 'mixed', segments: [SEG_A, SEG_B], ...over };
}

describe('applyTriageRescue — fires only on verified buried signal', () => {
  test('band score + allowed type + 2 verified substantive segments → rescue', () => {
    const d = applyTriageRescue(verdict({}), TRANSCRIPT, THRESHOLD, DEFAULT_RESCUE_CONFIG);
    expect(d).toEqual({ pass: true, rescued: true, verified_segments: 2 });
  });

  test('normalized verification: case/curly-quote drift in the judge quote still verifies', () => {
    const drifted = [{ quote: 'Our RETENTION problem is really an onboarding problem wearing a trench coat' }, SEG_B];
    const d = applyTriageRescue(verdict({ segments: drifted }), TRANSCRIPT, THRESHOLD);
    expect(d.rescued).toBe(true);
  });

  test('fabricated segments never rescue', () => {
    const d = applyTriageRescue(verdict({ segments: [SEG_FABRICATED, SEG_FABRICATED] }), TRANSCRIPT, THRESHOLD);
    expect(d).toEqual({ pass: false, rescued: false, verified_segments: 0 });
  });

  test('duplicate segments count once — repetition is not more evidence', () => {
    const d = applyTriageRescue(verdict({ segments: [SEG_A, SEG_A, { quote: SEG_A.quote.toUpperCase() }] }), TRANSCRIPT, THRESHOLD);
    expect(d.verified_segments).toBe(1);
    expect(d.rescued).toBe(false);
  });

  test('short-but-real segments are not substantive evidence', () => {
    const d = applyTriageRescue(verdict({ segments: [SEG_SHORT_REAL, SEG_A] }), TRANSCRIPT, THRESHOLD);
    expect(d.verified_segments).toBe(1); // only SEG_A clears the length bar
    expect(d.rescued).toBe(false);       // 1 < min 2
  });

  test('routine and technical content types never rescue', () => {
    for (const ct of ['routine', 'technical']) {
      const d = applyTriageRescue(verdict({ content_type: ct }), TRANSCRIPT, THRESHOLD);
      expect(d.rescued).toBe(false);
    }
  });

  test('below the floor never rescues; at/above threshold is not the band', () => {
    expect(applyTriageRescue(verdict({ score: 0.29 }), TRANSCRIPT, THRESHOLD).rescued).toBe(false);
    expect(applyTriageRescue(verdict({ score: 0.5 }), TRANSCRIPT, THRESHOLD).rescued).toBe(false);
    expect(applyTriageRescue(verdict({ score: DEFAULT_RESCUE_FLOOR }), TRANSCRIPT, THRESHOLD).rescued).toBe(true); // floor inclusive
  });

  test('kill switch: min_segments=0 disables the band entirely', () => {
    const d = applyTriageRescue(verdict({}), TRANSCRIPT, THRESHOLD, { ...DEFAULT_RESCUE_CONFIG, minSegments: 0 });
    expect(d.rescued).toBe(false);
  });

  test('malformed shapes fail closed, never throw: null score, null/missing/empty segments, bad quotes', () => {
    expect(applyTriageRescue(verdict({ score: null }), TRANSCRIPT, THRESHOLD).rescued).toBe(false);
    expect(applyTriageRescue(verdict({ segments: [] }), TRANSCRIPT, THRESHOLD).rescued).toBe(false);
    expect(applyTriageRescue({ score: 0.35, content_type: 'mixed', segments: null } , TRANSCRIPT, THRESHOLD).rescued).toBe(false);
    expect(applyTriageRescue({ score: 0.35, content_type: 'mixed' }, TRANSCRIPT, THRESHOLD).rescued).toBe(false);
    expect(applyTriageRescue(verdict({ segments: [{ quote: 42 as unknown as string }] }), TRANSCRIPT, THRESHOLD).rescued).toBe(false);
    expect(applyTriageRescue(verdict({ content_type: null }), TRANSCRIPT, THRESHOLD).rescued).toBe(false);
    expect(applyTriageRescue(verdict({}), '', THRESHOLD).rescued).toBe(false); // empty transcript
  });
});

describe('passesTriageGate — THE one gate', () => {
  test('threshold pass never consults the band (rescued=false)', () => {
    const g = passesTriageGate(verdict({ score: 0.9, content_type: 'routine', segments: [] }), TRANSCRIPT, THRESHOLD);
    expect(g).toEqual({ pass: true, rescued: false, verified_segments: 0 });
  });

  test('band pass reports rescued with the verified count', () => {
    const g = passesTriageGate(verdict({}), TRANSCRIPT, THRESHOLD);
    expect(g).toEqual({ pass: true, rescued: true, verified_segments: 2 });
  });

  test('below floor fails outright', () => {
    const g = passesTriageGate(verdict({ score: 0.1 }), TRANSCRIPT, THRESHOLD);
    expect(g.pass).toBe(false);
  });

  test('defaults sanity: floor 0.30, min segments 2, substantive bar 40 chars', () => {
    expect(DEFAULT_RESCUE_FLOOR).toBe(0.30);
    expect(DEFAULT_RESCUE_MIN_SEGMENTS).toBe(2);
    expect(MIN_RESCUE_SEGMENT_NORM_CHARS).toBe(40);
  });
});
