/**
 * #5888 — the capture-lane dedup policy, branch by branch.
 *
 * Protects: corrections and changed numbers are never treated as duplicates,
 * capture lanes never drop by cosine (shadow count only), explicit lanes keep
 * their 0.95 rule, every capture lane maps one conversation to one key, and
 * the cross-entity naming rule matches whole names only.
 * Fails when: the guard is dropped, a capture lane regains a cosine drop, or
 * the corpus sweep's `sweep:corpus:<file>` key no longer matches the writeback
 * session id. Pure functions, no engine.
 */
import { describe, expect, test } from 'bun:test';
import {
  canonicalConversationKey, claimNamesEntity, claimsDiverge, cosineVerdict, isCaptureLane,
} from '../../src/core/facts/capture-dedup.ts';

describe('cosineVerdict', () => {
  const same = 'Alice Example is moving to NYC';
  test.each([
    ['explicit lane at 0.95 is a duplicate', 'mcp:extract_facts', 0.95, same, same, 'duplicate'],
    ['explicit lane at 0.949 is distinct', 'mcp:extract_facts', 0.949, same, same, 'distinct'],
    ['explicit lane keeps its rule for a negation pair', 'sync:import', 0.97, same, 'Alice Example is not moving to NYC', 'duplicate'],
    ['writeback at 0.99 is only a near duplicate', 'hook:writeback', 0.99, same, 'Alice Example relocates to NYC', 'near_duplicate'],
    ['corpus sweep at 0.93 is a near duplicate', 'sweep:corpus', 0.93, same, 'Alice Example relocates to NYC', 'near_duplicate'],
    ['compact harvest at 0.919 is distinct', 'hook:compact', 0.919, same, 'Alice Example relocates to NYC', 'distinct'],
    ['negation pair at 0.97 is distinct', 'hook:writeback', 0.97, same, 'Alice Example is not moving to NYC', 'distinct'],
    ['"no longer" pair is distinct', 'hook:writeback', 0.97, 'Bob Example works at Acme Example', 'Bob Example no longer works at Acme Example', 'distinct'],
    ['changed amount at 0.97 is distinct', 'hook:writeback', 0.97, 'MRR is $50k', 'MRR is $60k', 'distinct'],
    ['changed month is distinct', 'sweep:corpus', 0.97, 'The renewal closes in November', 'The renewal closes in December', 'distinct'],
    ['changed date is distinct', 'hook:compact', 0.97, 'Launch is on 2026-10-02', 'Launch is on 2026-10-09', 'distinct'],
  ] as const)('%s', (_label, lane, score, a, b, verdict) => {
    // 0.95: voyage-4@1024's calibrated explicit-lane threshold (supersession-threshold.ts).
    expect(cosineVerdict(lane, score, a, b, 0.95)).toBe(verdict);
  });

  test('an uncalibrated embedding model (null threshold) never makes an explicit-lane duplicate', () => {
    expect(cosineVerdict('mcp:extract_facts', 0.999, same, same, null)).toBe('distinct');
    expect(cosineVerdict('hook:writeback', 0.99, same, 'Alice Example relocates to NYC', null)).toBe('near_duplicate');
  });
});

describe('claimsDiverge', () => {
  test('identical guard tokens with different wording do not diverge', () => {
    expect(claimsDiverge('MRR is $50k as of March', 'Monthly revenue reached $50k as of March')).toBe(false);
  });
  test('a curly-apostrophe contraction counts as a negation', () => {
    expect(claimsDiverge('Dana Example drinks coffee', 'Dana Example doesn’t drink coffee')).toBe(true);
  });
  test('a changed number word diverges', () => {
    expect(claimsDiverge('Bob Example has two kids', 'Bob Example has three kids')).toBe(true);
  });
  test('a plural weekday matches its singular', () => {
    expect(claimsDiverge('Widget Co ships releases on Tuesdays', 'Widget Co releases ship every Tuesday')).toBe(false);
  });
  test('a word containing "no" is not a negation', () => {
    expect(claimsDiverge('Dana Example knows Rust', 'Dana Example knows Rust well')).toBe(false);
  });
});

describe('canonicalConversationKey', () => {
  test.each([
    ['sess-1', 'sess-1'],
    ['sweep:corpus:sess-1.txt', 'sess-1'],
    ['sweep:corpus:sess-1.seg-0123456789ab.txt', 'sess-1'],
    ['sweep:corpus:sess-1.wb-0123456789ab.src-default.txt', 'sess-1'],
    [null, null],
    ['', null],
  ] as const)('%p → %p', (input, key) => {
    expect(canonicalConversationKey(input)).toBe(key);
  });
});

test('capture lanes are exactly writeback, corpus sweep and compact harvest', () => {
  expect(['hook:writeback', 'sweep:corpus', 'hook:compact', 'mcp:extract_facts', 'user told me', null].map(isCaptureLane))
    .toEqual([true, true, true, false, false, false]);
});

describe('claimNamesEntity', () => {
  test('a title inside the claim names the entity', () => {
    expect(claimNamesEntity('Alice Example will lead the renewal', ['Alice Example'])).toBe(true);
  });
  test('a name embedded in a longer word does not', () => {
    expect(claimNamesEntity('Acmeexample shipped', ['Acme Example', 'acme'])).toBe(false);
  });
  test('a subject-relative claim names nobody', () => {
    expect(claimNamesEntity('Prefers email', ['Alice Example', 'Bob Example'])).toBe(false);
  });
  test('an alias names the entity', () => {
    expect(claimNamesEntity('The ACME team signed', ['acme'])).toBe(true);
  });
});
