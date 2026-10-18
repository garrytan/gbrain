/**
 * Byte identity of the ledger's canonical serialization (docs/designs/BELIEF_LEDGER.md
 * section 13, item 21). Every stored value hash, claim hash and state hash
 * depends on `canonicalJson`'s bytes, so the fast path must equal the original
 * implementation (kept here as the reference) on seeded random values and on
 * every edge case it handles, and the state hash must equal the original's.
 * The forced probe: deliberately broken variants differ on the same corpus.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson, valueHash } from '../src/core/belief/keys.ts';
import { stateHashOf } from '../src/core/belief/ledger.ts';
import { factValue, takeValue, type Subject } from '../src/core/belief/subjects.ts';
import type { RawFact, RawPage, RawTake } from '../src/core/belief/state.ts';

/** The implementation before the fast path, verbatim. */
function referenceJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(referenceJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${referenceJson(v)}`).join(',')}}`;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** The state hash before the fast path, verbatim but for the serializer. */
function referenceStateHash(page: RawPage | null, lifetime: string | null, subjects: Subject[]): string {
  const live = page && !page.deleted;
  return sha(referenceJson({
    page: page ? { lifetime, deleted: page.deleted, revision: page.revision, visible: page.visible, tier: page.tier } : null,
    subjects: subjects.filter(s => live || s.dbOnly).map(s => [s.kind, s.key, s.vhash, s.tier]).sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1)),
  }));
}

function rng(seed: number) {
  return () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000;
}
const KEYS = ['a', 'B', 'b', 'aa', 'A', '_', '10', '2', '0', '-1', '01', 'é', 'e\u0301', 'Ω', '日本', '😀', '\ud83d', '', ' ', '"', '\\', '\n', '\u0000', 'claim', 'kind',
  'value', 'valid_from', 'claim_value', 'z', 'constructor', 'toString', 'hasOwnProperty'];
const STRINGS = ['', 'x', 'Acme raised a seed round', 'quote " and \\ backslash', 'line\nbreak\ttab\r', '\u0000\u0001\u001f', 'é e\u0301 Ω 日本語 😀',
  'lone \ud800 surrogate', '\u2028\u2029', '</script>', '  spaced  '];
const NUMBERS = [0, -0, 1, -1, 0.1, 1e21, 1e-7, 123456789012345680000, Number.MAX_SAFE_INTEGER, 2 ** 53 + 2, -3.5, NaN, Infinity, -Infinity, 0.5, 4.35];
function randomValue(next: () => number, depth: number): unknown {
  const r = next();
  if (depth > 3 || r < 0.45) {
    const p = next();
    return p < 0.3 ? STRINGS[Math.floor(next() * STRINGS.length)] : p < 0.55 ? NUMBERS[Math.floor(next() * NUMBERS.length)] : p < 0.65 ? next() < 0.5
      : p < 0.8 ? null : p < 0.9 ? undefined : new Date(Math.floor(next() * 2e12));
  }
  if (r < 0.7) {
    const arr: unknown[] = Array.from({ length: Math.floor(next() * 5) }, () => randomValue(next, depth + 1));
    if (next() < 0.15) arr[arr.length + 1] = 'after a hole';
    return arr;
  }
  const obj: Record<string, unknown> = next() < 0.2 ? JSON.parse('{"__proto__": 1}') : {};
  for (let i = Math.floor(next() * 7); i > 0; i--) obj[KEYS[Math.floor(next() * KEYS.length)]!] = randomValue(next, depth + 1);
  return obj;
}
const corpus = (() => {
  const next = rng(0x5eed1e55);
  const edge: unknown[] = [null, undefined, true, false, 0, -0, NaN, Infinity, 1e21, 0.1, '', 'é', '\ud800', [], {}, [undefined], [null], [, 1], [1, , 3],
    { b: 1, a: 2 }, { a: undefined, b: null }, { '10': 1, '2': 2, a: 3, A: 4 }, { é: 1, 'e\u0301': 2, z: 3 }, { nested: { z: [{ b: 1, a: [2, { d: 4, c: 3 }] }] } },
    new Date(0), [new Date(1)], { d: new Date(2) }, JSON.parse('{"__proto__": {"b": 1, "a": 2}}'), Object.assign(Object.create({ inherited: 1 }), { own: 2 }),
    { sorted: 1, unsorted: 2, a: 3 }, ['a', ['b', ['c', []]]], { '': '', ' ': ' ' }, { '\u0000': 1, '\n': 2 }];
  return [...edge, ...Array.from({ length: 3000 }, () => randomValue(next, 0))];
})();

describe('belief ledger canonical JSON', () => {
  test('the fast path equals the original serialization byte for byte', () => {
    const differ = corpus.map((value, i) => [i, value] as const).filter(([, value]) => canonicalJson(value) !== referenceJson(value));
    expect(differ.map(([i]) => i)).toEqual([]);
    expect(canonicalJson(corpus)).toBe(referenceJson(corpus));
  });

  test('forced probe: broken variants differ on the same corpus', () => {
    const unsorted = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
      if (Array.isArray(value)) return `[${value.map(unsorted).join(',')}]`;
      return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${unsorted(v)}`).join(',')}}`;
    };
    const keepsUndefined = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
      if (Array.isArray(value)) return `[${value.map(keepsUndefined).join(',')}]`;
      return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${keepsUndefined(v)}`).join(',')}}`;
    };
    const localeSorted = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
      if (Array.isArray(value)) return `[${value.map(localeSorted).join(',')}]`;
      return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${localeSorted(v)}`).join(',')}}`;
    };
    for (const broken of [unsorted, keepsUndefined, localeSorted]) expect(corpus.some(value => broken(value) !== referenceJson(value))).toBe(true);
  });

  test('fact and take values hash as they did before their keys were reordered', () => {
    const next = rng(0xfac7);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
    const text = () => pick(STRINGS) + pick(['', ' Acme', ' ß', ' 😀']);
    const maybe = <T>(v: T) => next() < 0.5 ? null : v;
    for (let i = 0; i < 500; i++) {
      const f: RawFact = { id: i, entity_slug: maybe('people/alice-example'), sms: maybe('companies/acme-example'), entity_page_id: null, fact: text(), fp: 'fp',
        kind: pick(['fact', 'event', 'preference']), visibility: pick(['world', 'private']), notability: pick(['low', 'medium', 'high']), context: maybe(text()),
        confidence: pick([1, 0.5, 0.25, 0.1]), valid_from: maybe(new Date(Math.floor(next() * 2e12)).toISOString()), valid_until: maybe('2027-01-01T00:00:00.000Z'),
        claim_metric: maybe('mrr'), claim_value: maybe(pick(NUMBERS)), claim_unit: maybe('USD'), claim_period: maybe('monthly'), event_type: maybe('meeting'),
        dimension: null, value: maybe(text()), value_hash: null, row_num: i, tier: 'unknown' };
      const entity = maybe(`L:${i}`), count = pick([1, 1, 2, 3]);
      const before = { fact: f.fact, kind: f.kind, notability: f.notability, context: f.context, confidence: f.confidence, valid_from: f.valid_from,
        valid_until: f.valid_until, claim_metric: f.claim_metric, claim_value: f.claim_value, claim_unit: f.claim_unit, claim_period: f.claim_period,
        event_type: f.event_type, value: f.value, ...(f.sms != null ? { entity } : {}), ...(count > 1 ? { count } : {}) };
      expect(valueHash(factValue(f, entity, count))).toBe(sha(referenceJson(before)));
      const t: RawTake = { id: i, page_id: 1, row_num: i, claim: text(), claim_fp: 'fp', kind: pick(['take', 'bet', 'hunch']), holder: pick(['brain', 'people/alice-example']),
        weight: pick([0.5, 0.75, 1]), since_date: maybe('2026-07'), until_date: maybe('2027'), source: maybe(text()), active: next() < 0.8,
        resolved_at: maybe('2026-09-01T00:00:00.000Z'), resolved_outcome: maybe(next() < 0.5), resolved_value: maybe(pick(NUMBERS)), resolved_unit: maybe('%'),
        resolved_source: maybe(text()), resolved_by: maybe('grader'), resolved_quality: maybe('correct'), tier: 'unknown' };
      const takeBefore = { claim: t.claim, kind: t.kind, holder: t.holder, weight: t.weight, since_date: t.since_date, until_date: t.until_date, source: t.source,
        active: t.active, resolved_at: t.resolved_at, resolved_outcome: t.resolved_outcome, resolved_value: t.resolved_value, resolved_unit: t.resolved_unit,
        resolved_source: t.resolved_source, resolved_by: t.resolved_by, resolved_quality: t.resolved_quality };
      expect(valueHash(takeValue(t))).toBe(sha(referenceJson(takeBefore)));
    }
  });

  test('state hashes equal the original for seeded random subject sets', () => {
    const next = rng(0x57a7e);
    const kinds = ['fact', 'take', 'link', 'link_transition'] as const;
    for (let i = 0; i < 300; i++) {
      const subjects: Subject[] = Array.from({ length: Math.floor(next() * 60) }, (_, j) => {
        const kind = kinds[Math.floor(next() * kinds.length)]!;
        const key = JSON.stringify([kind[0], `L:${Math.floor(next() * 4)}`, Math.floor(next() * 5), STRINGS[Math.floor(next() * STRINGS.length)]]);
        return { kind, key, stream: 's', value: {}, vhash: sha(String(Math.floor(next() * 8))), tier: ['unknown', 'agent_written', ''][Math.floor(next() * 3)]!,
          visibility: 'world', rowIds: [j], rowNum: null, dbOnly: next() < 0.3, claimFp: null, validFrom: null, validUntil: null, label: {} };
      });
      if (next() < 0.3 && subjects.length) subjects.push({ ...subjects[0]! });
      const page: RawPage | null = next() < 0.1 ? null : { id: 1, slug: 's', deleted: next() < 0.2, revision: String(i), content_hash: null, tier: 'unknown',
        visible: next() < 0.8, large: false, incarnation: 'i' };
      const lifetime = page ? `lt-${i}` : null;
      expect(stateHashOf(page, lifetime, subjects)).toBe(referenceStateHash(page, lifetime, subjects));
    }
  });
});
