/**
 * GBRA-215 L3: the ingest extractor's pure parts: document windows, the keyless candidate function and the parser.
 */
import { describe, expect, test } from 'bun:test';
import { isJunkName, keylessCandidates, mergeWindows, parseIngestExtraction, windowDocument } from '../src/core/ingest/extract.ts';

describe('windowDocument', () => {
  test('a speakerless document is covered end to end, the last window included', () => {
    const text = 'Filler sentence about nothing in particular. '.repeat(1500) + 'The tail claim sits here.';
    const windows = windowDocument(text);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.at(-1)!.text).toContain('The tail claim sits here.');
    expect(windows.reduce((n, w) => n + w.text.length, 0)).toBeGreaterThanOrEqual(text.trim().length - windows.length * 2);
  });
});

describe('keylessCandidates', () => {
  test('acronyms and one-word companies in company context, without sentence-initial words', () => {
    const names = keylessCandidates('We met the team at ACMX on Tuesday. Later Zentrix Inc. joined the call about pricing.').map(e => e.name);
    expect(names).toContain('ACMX');
    expect(names).toContain('Zentrix');
    expect(names.some(n => n.startsWith('Later'))).toBe(false);
    expect(keylessCandidates('Revenue grew and the CEO said ARR doubled.').map(e => e.name)).not.toContain('ARR');
  });
  test('junk names never become candidates', () => {
    expect(isJunkName('CEO')).toBe(true);
    expect(isJunkName('A')).toBe(true);
    expect(isJunkName('Zentrix')).toBe(false);
  });
});

describe('parseIngestExtraction', () => {
  test('malformed rows are dropped, never guessed', () => {
    const parsed = parseIngestExtraction('noise {"entities":[{"name":"Zentrix","type":"Company"},{"name":""}],"facts":[{"fact":"Zentrix signed a customer.","kind":"event","entities":["Zentrix"],"valid_from":"2026-03-01"},{"kind":"event"}]} trailing')!;
    expect(parsed.entities).toEqual([{ name: 'Zentrix', type: 'company', context: '', source: 'model' }]);
    expect(parsed.facts).toEqual([{ fact: 'Zentrix signed a customer.', kind: 'event', entities: ['Zentrix'], notability: 'medium', valid_from: '2026-03-01' }]);
    expect(parseIngestExtraction('not json')).toBeNull();
  });
  test('claims repeated across windows are kept once; a model type beats a regex guess', () => {
    const merged = mergeWindows([
      { index: 1, chars: 10, spent_usd: 0, entities: [{ name: 'Zentrix', type: 'company', context: '', source: 'model' }], facts: [{ fact: 'Zentrix signed a customer.', kind: 'event', entities: ['Zentrix'], notability: 'high' }] },
      { index: 0, chars: 10, spent_usd: 0, entities: [{ name: 'zentrix', type: 'person', context: '', source: 'regex' }], facts: [{ fact: 'Zentrix signed a customer', kind: 'event', entities: ['Zentrix'], notability: 'high' }] },
    ]);
    expect(merged.facts.length).toBe(1);
    expect(merged.entities).toEqual([{ name: 'Zentrix', type: 'company', context: '', source: 'model' }]);
  });
});
