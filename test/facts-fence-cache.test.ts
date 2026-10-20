import { describe, expect, test } from 'bun:test';
import { FactsFenceCache } from '../src/core/facts-fence-cache.ts';
import { parseFactsFence, renderFactsTable, type FactsFenceParseResult, type ParsedFact } from '../src/core/facts-fence.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { overlayWithdrawalBody } from '../src/core/facts/withdrawal-overlay.ts';
import { createHash } from 'node:crypto';

const fact: ParsedFact = { rowNum: 1, claim: 'Synthetic claim', kind: 'fact', confidence: 1,
  visibility: 'private', notability: 'medium', active: true };
const parsed = (): FactsFenceParseResult => ({ facts: [{ ...fact }], warnings: [] });

describe('bounded exact-content facts fence cache', () => {
  test('reuses parsing but returns independent mutable facts, arrays and warnings', () => {
    const cache = new FactsFenceCache({ entries: 2, characters: 100, rows: 10, minimum: 1 });
    let calls = 0;
    const parse = () => { calls++; return parsed(); };
    const first = cache.parse('body', parse);
    first.facts[0].claim = 'edited';
    first.facts.push({ ...fact, rowNum: 2 });
    first.warnings.push('edited');
    expect(cache.parse(['bo', 'dy'].join(''), parse)).toEqual(parsed());
    expect(calls).toBe(1);
    cache.parse('changed body', parse);
    expect(calls).toBe(2);
  });

  test('evicts least recently used entries under count, character and row limits', () => {
    for (const limits of [
      { entries: 2, characters: 100, rows: 100, minimum: 1 },
      { entries: 10, characters: 2, rows: 100, minimum: 1 },
      { entries: 10, characters: 100, rows: 2, minimum: 1 },
    ]) {
      const cache = new FactsFenceCache(limits);
      let calls = 0;
      const parse = () => { calls++; return parsed(); };
      for (const body of ['a', 'b', 'a', 'c', 'a']) cache.parse(body, parse);
      expect(calls).toBe(3);
      cache.parse('b', parse);
      expect(calls).toBe(4);
    }
  });

  test('does not retain undersized, oversized, excessive-row or malformed parses', () => {
    const cache = new FactsFenceCache({ entries: 2, characters: 5, rows: 1, minimum: 2 });
    let calls = 0;
    const parse = () => { calls++; return parsed(); };
    for (const body of ['a', 'abcdef']) for (let i = 0; i < 2; i++) cache.parse(body, parse);
    expect(calls).toBe(4);
    for (let i = 0; i < 2; i++) cache.parse('bad', () => { calls++; return { facts: [], warnings: ['malformed'] }; });
    for (let i = 0; i < 2; i++) cache.parse('rows', () => { calls++; return { facts: [fact, fact], warnings: [] }; });
    expect(calls).toBe(8);
  });

  test('a cached real fence preserves privacy and re-applies the current withdrawal ledger', () => {
    const body = renderFactsTable([{ ...fact, claim: 'Synthetic claim '.repeat(2000) },
      { ...fact, rowNum: 2, claim: 'A visible synthetic claim', visibility: 'world' }]);
    const first = parseFactsFence(body);
    first.facts[0].visibility = 'world';
    expect(parseFactsFence(body).facts[0].visibility).toBe('private');
    expect(sanitizeRemoteBody(body)).not.toContain('Synthetic claim ');
    expect(sanitizeRemoteBody(body)).toContain('A visible synthetic claim');
    const claim = parseFactsFence(body).facts[1].claim;
    const withdrawal = { visibility: 'world' as const, fact_hash: createHash('sha256').update(claim).digest('hex'), withdrawn_at: '2026-10-01' };
    expect(overlayWithdrawalBody(body, body, [])).toBe(body);
    const withdrawn = overlayWithdrawalBody(body, body, [withdrawal]);
    expect(parseFactsFence(withdrawn).facts[1].forgotten).toBe(true);
    expect(sanitizeRemoteBody(withdrawn)).not.toContain(claim);
    expect(parseFactsFence(body).facts[1].active).toBe(true);
  });
});
