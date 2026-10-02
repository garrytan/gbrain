/**
 * Secret-scan false-positive budget on the synthetic brain-like fixture
 * (security fix wave CEO-18 thresholds). The fixture comes from
 * scripts/secret-scan-fp-budget.ts, which also measures NEW hits against a
 * base git ref over this repo's src/, docs/ and skills/ (a maintainer tool;
 * the base ref is not available in every CI checkout). Here the thresholds
 * are enforced against the current scanner alone:
 *   - the non-secret part gains no finding in either mode (so no push block,
 *     no dropped context entry, no refused relay, no redaction);
 *   - the secret-bearing part is fully redacted.
 */
import { describe, expect, test } from 'bun:test';
import { buildSyntheticBrainCorpus, newFindings } from '../scripts/secret-scan-fp-budget.ts';
import { redactFindings, scanText } from '../src/core/secret-scan.ts';

const corpus = buildSyntheticBrainCorpus();

describe('synthetic brain-like fixture: the non-secret part', () => {
  for (const doc of corpus.filter((d) => d.kind === 'clean')) {
    test(`${doc.id}: no finding with or without highEntropy, text byte-identical after redaction`, () => {
      expect(scanText(doc.text)).toEqual([]);
      expect(scanText(doc.text, { highEntropy: true })).toEqual([]);
      expect(redactFindings(doc.text, { highEntropy: true }).text).toBe(doc.text);
    });
  }
});

describe('synthetic brain-like fixture: the secret-bearing part', () => {
  for (const doc of corpus.filter((d) => d.kind === 'secret')) {
    test(`${doc.id}: every planted value is redacted`, () => {
      const withEntropy = redactFindings(doc.text, { highEntropy: true }).text;
      const without = redactFindings(doc.text).text;
      for (const v of doc.secrets ?? []) {
        expect(withEntropy.includes(v)).toBe(false);
        expect(without.includes(v)).toBe(false);
      }
      for (const v of doc.assignmentSecrets ?? []) expect(withEntropy.includes(v)).toBe(false);
    });
  }
});

describe('newFindings (the measurement diff)', () => {
  test('a multiset difference on (pattern, fingerprint)', () => {
    const f = (pattern: string, fingerprint: string) => ({ pattern, fingerprint, line: 1 });
    const before = [f('a', '1'), f('a', '1'), f('b', '2')];
    const after = [f('a', '1'), f('a', '1'), f('a', '1'), f('b', '3')];
    expect(newFindings(before, after)).toEqual([f('a', '1'), f('b', '3')]);
  });
});
