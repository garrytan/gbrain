/**
 * G4.1 (wave 16): `correctedEntropy` computes bits and the distinct count in ONE histogram pass. The former
 * implementation (kept below as the reference, verbatim from master) ran `shannonEntropy` and then `new Set(s).size`,
 * a second full pass that was ~80 % of the entropy gate's time on a 4096-char value and the reason
 * test/secret-scan-perf.test.ts's `high_entropy_assignment` segment drifted toward its 300 ms bound under shard load.
 *
 * The optimisation must be an exact equivalence, not a Unicode "fix": the same `for…of` code-point iteration, the
 * same insertion-ordered sum, the same UTF-16 `s.length` denominator. `Object.is` on every sample, including the
 * empty string, one character, astral characters, an unpaired surrogate, and 4096-char high-entropy values.
 * Deterministic: the same strings on every machine.
 */
import { describe, expect, test } from 'bun:test';
import { correctedEntropy, shannonEntropy } from '../src/core/secret-scan.ts';

/** Master's `correctedEntropy`, unchanged. */
function referenceCorrectedEntropy(s: string): number {
  if (s.length === 0) return 0;
  return referenceShannon(s) + (new Set(s).size - 1) / (2 * s.length * Math.LN2);
}
/** Master's `shannonEntropy`, unchanged. */
function referenceShannon(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Deterministic LCG so the corpus is the same everywhere. */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 0x1_0000_0000; };
}

const ALPHABETS = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%<>',
  'abcdefghijklmnopqrstuvwxyz0123456789+/=',
  '0123456789',
  'aé€𝄞😀\u00e9e\u0301', // Latin, BMP non-ASCII, astral (surrogate pairs), composed and decomposed é
  '\ud800\udc00\ud83d\ude00\ud800', // valid pairs plus a lone high surrogate inside the alphabet
];

function corpus(): string[] {
  const out: string[] = ['', 'a', '0', '€', '😀', '\ud800', '\udc00', 'a\ud800b', '😀😀😀', 'aaaaaaaaaaaa', 'ab'.repeat(2048)];
  const rnd = lcg(0x5eed);
  for (let i = 0; i < 300; i++) {
    const alphabet = [...ALPHABETS[i % ALPHABETS.length]!];
    const length = [1, 2, 3, 7, 12, 31, 64, 255, 1024, 4096][i % 10]!;
    let s = '';
    for (let k = 0; k < length; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    out.push(s);
  }
  // The perf fixture's exact values: 4096-char entropic strings for 250 salts.
  const PERF_ALPHABET = ALPHABETS[0]!;
  for (let salt = 0; salt < 250; salt++) out.push(Array.from({ length: 4096 }, (_, k) => PERF_ALPHABET[(k * 7 + salt) % PERF_ALPHABET.length]).join(''));
  return out;
}

describe('correctedEntropy one-pass equivalence', () => {
  const samples = corpus();

  test('the corpus is at least 300 samples and covers the edge shapes', () => {
    expect(samples.length).toBeGreaterThanOrEqual(300);
    expect(samples).toContain('');
    expect(samples).toContain('\ud800');
    expect(samples.some(s => /[\u{10000}-\u{10FFFF}]/u.test(s))).toBe(true);
    expect(samples.filter(s => s.length === 4096).length).toBeGreaterThanOrEqual(250);
  });

  test('byte-identical to the master implementation on every sample (Object.is)', () => {
    for (const s of samples) {
      const got = correctedEntropy(s);
      const want = referenceCorrectedEntropy(s);
      expect(Object.is(got, want), JSON.stringify(s.slice(0, 24))).toBe(true);
    }
  });

  test('shannonEntropy is unchanged and the correction term still uses the UTF-16 length denominator', () => {
    for (const s of samples) {
      expect(Object.is(shannonEntropy(s), referenceShannon(s))).toBe(true);
      if (s.length) expect(Object.is(correctedEntropy(s), shannonEntropy(s) + (new Set(s).size - 1) / (2 * s.length * Math.LN2))).toBe(true);
    }
  });

  test('a lone surrogate counts as one symbol over a UTF-16 length of one, exactly as before', () => {
    expect(correctedEntropy('\ud800')).toBe(referenceCorrectedEntropy('\ud800'));
    expect(correctedEntropy('a\ud800b')).toBe(referenceCorrectedEntropy('a\ud800b'));
    // An astral pair is one symbol but two UTF-16 units, so p = 1/2 and the "entropy" of one symbol reads 0.5 bits:
    // the master quirk, preserved on purpose (a Unicode fix would be a separate behaviour change).
    expect(correctedEntropy('😀')).toBe(0.5);
    expect(correctedEntropy('😀')).toBe(referenceCorrectedEntropy('😀'));
  });
});
