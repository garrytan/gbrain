/**
 * Relational-query parser unit tests.
 *
 * Covers the four archetypes, the no-match path, the precision-first
 * false-positive guard, schema-pack vocab extension, subset validation, and
 * the length bound (ReDoS surface).
 */

import { describe, test, expect } from 'bun:test';
import {
  parseRelationalQuery,
  validateVocab,
  KNOWN_LINK_TYPES,
  type RelationVocab,
} from '../src/core/search/relational-intent.ts';

describe('parseRelationalQuery — archetypes', () => {
  test('who_rel: who invested in widget-co', () => {
    const r = parseRelationalQuery('who invested in widget-co');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('who_rel');
    expect(r!.seeds).toEqual(['widget-co']);
    expect(r!.linkTypes).toEqual(['invested_in', 'led_round']);
    expect(r!.direction).toBe('in');
  });

  test('who_rel: who founded acme (article stripped)', () => {
    const r = parseRelationalQuery('who founded the acme corporation?');
    expect(r!.kind).toBe('who_rel');
    expect(r!.seeds).toEqual(['acme corporation']);
    expect(r!.linkTypes).toEqual(['founded']);
  });

  test('who_at: who at acme works on payments', () => {
    const r = parseRelationalQuery('who at acme works on payments');
    expect(r!.kind).toBe('who_at');
    expect(r!.seeds).toEqual(['acme']);
    expect(r!.linkTypes).toEqual(['works_at']);
    expect(r!.direction).toBe('in');
  });

  test('intro: who introduced me to alice-example (type-agnostic)', () => {
    const r = parseRelationalQuery('who introduced me to alice-example?');
    expect(r!.kind).toBe('intro');
    expect(r!.seeds).toEqual(['alice-example']);
    expect(r!.linkTypes).toBeNull();
    expect(r!.direction).toBe('both');
  });

  test('connects: what connects fund-a and fund-b (two seeds)', () => {
    const r = parseRelationalQuery('what connects fund-a and fund-b');
    expect(r!.kind).toBe('connects');
    expect(r!.seeds).toEqual(['fund-a', 'fund-b']);
    expect(r!.linkTypes).toBeNull();
    expect(r!.direction).toBe('both');
  });

  test('connects: how are X and Y related', () => {
    const r = parseRelationalQuery('how are widget-co and acme related');
    expect(r!.kind).toBe('connects');
    expect(r!.seeds).toEqual(['widget-co', 'acme']);
  });

  test('outgoing: what did alice invest in', () => {
    const r = parseRelationalQuery('what did alice invest in');
    expect(r!.kind).toBe('who_rel');
    expect(r!.seeds).toEqual(['alice']);
    expect(r!.direction).toBe('out');
  });
});

describe('parseRelationalQuery — work-management domain', () => {
  test('who_rel: who is assigned to tasks/ship-the-thing', () => {
    const r = parseRelationalQuery('who is assigned to tasks/ship-the-thing');
    expect(r!.kind).toBe('who_rel');
    expect(r!.seeds).toEqual(['tasks/ship-the-thing']);
    expect(r!.linkTypes).toEqual(['assigned_to']);
    expect(r!.direction).toBe('out');
  });

  test('who_rel: who manages alice-example', () => {
    const r = parseRelationalQuery('who manages alice-example');
    expect(r!.linkTypes).toEqual(['managed_by']);
    expect(r!.direction).toBe('out');
  });

  test('who_rel: who owns goals/obj-1', () => {
    const r = parseRelationalQuery('who owns goals/obj-1');
    expect(r!.linkTypes).toEqual(['owned_by']);
    expect(r!.direction).toBe('out');
  });

  test('who_rel: who reports to bob-example (inbound)', () => {
    const r = parseRelationalQuery('who reports to bob-example');
    expect(r!.linkTypes).toEqual(['managed_by']);
    expect(r!.direction).toBe('in');
  });

  test('outgoing: what tasks does alice-example have', () => {
    const r = parseRelationalQuery('what tasks does alice-example have');
    expect(r!.linkTypes).toEqual(['assigned_to']);
    expect(r!.seeds).toEqual(['alice-example']);
    expect(r!.direction).toBe('in');
  });

  test('outgoing: the noun is tracker-agnostic (issues, tickets, work items)', () => {
    for (const q of [
      'what issues is bob-example assigned to',
      'what tickets does bob-example have',
      'what work items does bob-example have',
    ]) {
      expect(parseRelationalQuery(q)!.linkTypes).toEqual(['assigned_to']);
    }
  });

  test('outgoing: what is alice-example working on', () => {
    const r = parseRelationalQuery('what is alice-example working on');
    expect(r!.linkTypes).toEqual(['assigned_to']);
    expect(r!.direction).toBe('in');
  });

  test('outgoing: who does alice-example report to', () => {
    const r = parseRelationalQuery('who does alice-example report to');
    expect(r!.linkTypes).toEqual(['managed_by']);
    expect(r!.direction).toBe('out');
  });
});

describe('parseRelationalQuery — Vietnamese bank (first non-English set)', () => {
  test('seed-leading assignment question: "<person> đang có những task gì?"', () => {
    const r = parseRelationalQuery('Đào đang có những task gì?');
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('who_rel');
    expect(r!.seeds).toEqual(['Đào']);
    expect(r!.linkTypes).toEqual(['assigned_to']);
    expect(r!.direction).toBe('in');
  });

  test('verb and noun variants (làm / phụ trách, việc / công việc)', () => {
    expect(parseRelationalQuery('Đào Nguyễn đang làm việc gì')!.seeds).toEqual(['Đào Nguyễn']);
    expect(parseRelationalQuery('Đào phụ trách những công việc gì')!.linkTypes).toEqual(['assigned_to']);
  });

  test('reverse direction: "ai đang phụ trách <task>"', () => {
    const r = parseRelationalQuery('ai đang phụ trách tasks/ship-the-thing');
    expect(r!.linkTypes).toEqual(['assigned_to']);
    expect(r!.direction).toBe('out');
  });

  test('org hierarchy in both directions', () => {
    expect(parseRelationalQuery('ai quản lý Đào')!.direction).toBe('out');
    expect(parseRelationalQuery('Đào báo cáo cho ai')!.direction).toBe('out');
    expect(parseRelationalQuery('ai báo cáo cho Đào')!.direction).toBe('in');
    for (const q of ['ai quản lý Đào', 'Đào báo cáo cho ai', 'ai báo cáo cho Đào']) {
      expect(parseRelationalQuery(q)!.linkTypes).toEqual(['managed_by']);
    }
  });

  test('a non-relational Vietnamese content query still returns null', () => {
    expect(parseRelationalQuery('tóm tắt cuộc họp offsite')).toBeNull();
  });
});

describe('parseRelationalQuery — precision-first / no-match', () => {
  test('non-relational content query → null', () => {
    expect(parseRelationalQuery('what is the capital structure of a seed round')).toBeNull();
    expect(parseRelationalQuery('notes from the offsite')).toBeNull();
    expect(parseRelationalQuery('summarize the q3 board deck')).toBeNull();
  });

  test('false-positive: "who invested TIME in learning Rust" does NOT match', () => {
    // "invested time in" is not "invested in" — adjacency guard.
    expect(parseRelationalQuery('who invested time in learning Rust')).toBeNull();
  });

  test('pronoun / stopword seed is rejected', () => {
    expect(parseRelationalQuery('who invested in it')).toBeNull();
    expect(parseRelationalQuery('who founded them?')).toBeNull();
  });

  test('empty / overlong input → null', () => {
    expect(parseRelationalQuery('')).toBeNull();
    expect(parseRelationalQuery('who invested in ' + 'x'.repeat(600))).toBeNull();
  });
});

describe('schema-pack vocab extension (D2=B)', () => {
  const vocab: RelationVocab = {
    extraVerbs: [{ verb: 'related to|associated with', linkTypes: ['related_to'], direction: 'both' }],
  };

  test('extra verb extends detection', () => {
    expect(parseRelationalQuery('who related to widget-co', vocab)!.linkTypes).toEqual(['related_to']);
    // same query without the pack does NOT match the extra verb
    expect(parseRelationalQuery('who related to widget-co')).toBeNull();
  });

  test('validateVocab passes for known types', () => {
    expect(() => validateVocab(vocab)).not.toThrow();
  });

  test('validateVocab throws on unknown link_type', () => {
    expect(() =>
      validateVocab({ extraVerbs: [{ verb: 'pwns', linkTypes: ['not_a_real_edge'], direction: 'in' }] }),
    ).toThrow(/unknown link_type/);
  });
});

describe('default bank emits only known link types (no drift)', () => {
  test('every parsed linkType is a subset of KNOWN_LINK_TYPES', () => {
    const queries = [
      'who invested in widget-co',
      'who founded acme',
      'who advises bob-example',
      'who works at acme',
      'who at acme leads payments',
      'what did alice invest in',
      'where does alice work',
      'who is assigned to tasks/ship-the-thing',
      'who manages alice-example',
      'who owns goals/obj-1',
      'who reports to bob-example',
      'what tasks does alice-example have',
      'who does alice-example report to',
      'Đào đang có những task gì',
      'ai quản lý Đào',
    ];
    for (const q of queries) {
      const r = parseRelationalQuery(q);
      if (!r || r.linkTypes === null) continue;
      for (const lt of r.linkTypes) {
        expect(KNOWN_LINK_TYPES.has(lt)).toBe(true);
      }
    }
  });
});
