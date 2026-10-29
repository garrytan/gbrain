/**
 * Value: protects=schemaHistoryDrift reports real catalog drift but tolerates whitespace-only function bodies and paren-only trigger WHEN clauses;
 *   fails_when=the filter swallows a real body, trigger or table difference, or flags a benign reformat, so the history upgrade tests go blind or flaky;
 *   why_new=the upgrade tests only ever see no-drift and never prove the detector can fire; seam=none;
 *   no_claim=real engine catalogs (hand-built snapshots stand in; the upgrade tests cover real brains)
 */
import { describe, expect, test } from 'bun:test';
import type { CatalogSnapshot, CatalogFunction } from './helpers/schema-diff.ts';
import { schemaHistoryDrift, type InstalledSchema } from './helpers/schema-history.ts';

const fn = (bodySha256: string, over: Partial<CatalogFunction> = {}): CatalogFunction => ({
  name: 'touch', identityArguments: '', result: 'trigger', kind: 'f', language: 'plpgsql', volatility: 'v',
  securityDefiner: false, config: [], bodySha256, ...over,
});

function schema(over: { body?: string; sha?: string; fnOver?: Partial<CatalogFunction>; when?: string; columns?: string[] } = {}): InstalledSchema {
  const catalog: CatalogSnapshot = {
    tables: [{
      name: 'items', relkind: 'r', rowSecurity: false, forceRowSecurity: false,
      columns: (over.columns ?? ['id', 'pending']).map((name, i) => ({
        name, ordinal: i + 1, dataType: 'text', udtName: 'text', isNullable: true, columnDefault: null,
      })),
    }],
    viewColumns: [], indexes: [], constraints: [],
    triggers: [{ name: 'items_touch', table: 'items', definition: `CREATE TRIGGER items_touch AFTER UPDATE ON items FOR EACH ROW WHEN ${over.when ?? '((old.a IS DISTINCT FROM new.a) OR (old.b IS DISTINCT FROM new.b))'} EXECUTE FUNCTION touch()` }],
    functions: [fn(over.sha ?? 'sha-a', over.fnOver)],
    views: [], policies: [], grants: [], sequences: [], extensions: [],
  };
  return { catalog, functionBodies: new Map([['touch()', over.body ?? 'BEGIN RETURN NULL; END']]) };
}

describe('schemaHistoryDrift', () => {
  test('identical installs and a whitespace-only function body difference are not drift', () => {
    expect(schemaHistoryDrift(schema(), schema())).toBe('');
    expect(schemaHistoryDrift(schema(), schema({ sha: 'sha-b', body: 'BEGIN\n    RETURN NULL;\n  END' }))).toBe('');
  });

  test('a function whose body content or attributes differ is drift, naming the function', () => {
    expect(schemaHistoryDrift(schema(), schema({ sha: 'sha-b', body: 'BEGIN RETURN NEW; END' }))).toContain('[functions] touch() changed');
    expect(schemaHistoryDrift(schema(), schema({ sha: 'sha-b', fnOver: { securityDefiner: true } }))).toContain('[functions] touch() changed');
  });

  test('a changed function whose body is missing from either body map is drift, not a silent pass', () => {
    const upgraded = schema({ sha: 'sha-b' });
    upgraded.functionBodies.clear();
    expect(schemaHistoryDrift(schema(), upgraded)).toContain('[functions] touch() changed');
  });

  test('a trigger WHEN clause that differs only in parentheses is not drift; a changed expression is', () => {
    expect(schemaHistoryDrift(schema(), schema({ when: '(old.a IS DISTINCT FROM new.a OR old.b IS DISTINCT FROM new.b)' }))).toBe('');
    expect(schemaHistoryDrift(schema(), schema({ when: '((old.a IS DISTINCT FROM new.a) OR (old.c IS DISTINCT FROM new.c))' }))).toContain('[triggers] items.items_touch changed');
  });

  test('a trigger WHEN clause whose arithmetic or call parentheses differ is drift', () => {
    for (const [a, b] of [['((a + b) * c > 0)', '(a + b * c > 0)'], ['(a - (b - c) > 0)', '(a - b - c > 0)'], ['(lower(a) = b)', '(lower(a = b))']]) {
      expect(schemaHistoryDrift(schema({ when: a }), schema({ when: b }))).toContain('[triggers] items.items_touch changed');
    }
  });

  test('a trigger WHEN clause regrouped across AND and OR is drift, not a parentheses-only difference', () => {
    expect(schemaHistoryDrift(
      schema({ when: '(((old.a IS DISTINCT FROM new.a) OR (old.b IS DISTINCT FROM new.b)) AND new.c)' }),
      schema({ when: '((old.a IS DISTINCT FROM new.a) OR ((old.b IS DISTINCT FROM new.b) AND new.c))' }),
    )).toContain('[triggers] items.items_touch changed');
  });

  test('a column the upgraded brain lacks is drift (the #7645 shape)', () => {
    expect(schemaHistoryDrift(schema(), schema({ columns: ['id'] }))).toContain('[tables] items.pending MISSING');
  });
});
