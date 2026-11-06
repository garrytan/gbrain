/**
 * Value: protects=--attest-sources parsing: sorted+deduped list, none clears (null), empty and invalid ids refused; fails_when=parseAttestSources stops deduping or sorting, drops the none/empty/id guards or --attest-sources stops being stripped from args;
 * why_new=qm-scope-writes.test.ts drives bindCredential with a ready patch and never the CLI flag parser; seam=none; no_claim=brain checks of the listed sources (applyAttestSources, covered in qm-scope-writes; unit only).
 * Test audit: gstack /ship Step 7 (GST-1113 train).
 */
import { describe, expect, test } from 'bun:test';
import { takeBindingFlags } from '../src/commands/auth-binding.ts';

describe('--attest-sources flag (takeBindingFlags)', () => {
  test('a list is split, deduplicated and sorted, and the flag leaves the remaining args alone', () => {
    const out = takeBindingFlags(['name-a', '--attest-actor', 'qm', '--attest-sources', 'scope-b, scope-a,scope-b', '--json']);
    expect(out.args).toEqual(['name-a', '--json']);
    expect(out.patch).toEqual({ attestActor: 'qm', attestSources: ['scope-a', 'scope-b'] });
  });

  test('the = form and none (clear) parse; none is null, not an empty list', () => {
    expect(takeBindingFlags(['--attest-sources=scope-a']).patch).toEqual({ attestSources: ['scope-a'] });
    expect(takeBindingFlags(['--attest-sources', 'none']).patch).toEqual({ attestSources: null });
  });

  test('a missing value, an empty list and an invalid source id are refused', () => {
    expect(() => takeBindingFlags(['--attest-sources'])).toThrow(/requires a value/);
    expect(() => takeBindingFlags(['--attest-sources', '--json'])).toThrow(/requires a value/);
    expect(() => takeBindingFlags(['--attest-sources', ' , '])).toThrow(/at least one source/);
    expect(() => takeBindingFlags(['--attest-sources', 'Not_Valid'])).toThrow(/Invalid source_id/);
  });
});
