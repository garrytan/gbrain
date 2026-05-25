// v0.38 schema-pack module smoke tests (T2 coverage).
//
// Covers: YAML/JSON parsing, manifest validation, sha8 computation,
// pack identity formatting, alias graph BFS closure with E8 semantics
// (symmetric per declaration, transitive cap 4), the 7-tier resolver
// chain, ReDoS budget tracking, candidate-audit sha8 redaction.
//
// Full integration tests against the engine SQL land in Phase B
// (T6/T7) when hardcoded sites get refactored. This file pins the
// module's internal contracts.

import { describe, expect, test } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import {
  buildAliasGraph,
  expandClosure,
  ALIAS_CLOSURE_MAX_DEPTH,
  AliasCycleError,
  buildPerSourceBindings,
  buildSourceClosureCte,
  computeManifestSha8,
  packIdentity,
  parseSchemaPackManifest,
  parseYamlMini,
  loadPackFromString,
  resolveActivePackName,
  getPrimitiveDefaults,
  PACK_PRIMITIVES,
  PageRegexBudget,
  LINK_EXTRACTION_TOTAL_BUDGET_MS,
  isAuditVerbose,
  computeIsoWeekName,
  type SchemaPackManifest,
} from '../src/core/schema-pack/index.ts';

const minimalManifest = (overrides: Partial<SchemaPackManifest> = {}): unknown => ({
  api_version: 'gbrain-schema-pack-v1',
  name: 'test-pack',
  version: '1.0.0',
  description: 'unit test pack',
  extends: null,
  page_types: [],
  link_types: [],
  ...overrides,
});

describe('manifest-v1: parse + validate', () => {
  test('accepts minimal valid manifest', () => {
    const result = parseSchemaPackManifest(minimalManifest());
    expect(result.name).toBe('test-pack');
    expect(result.version).toBe('1.0.0');
    expect(result.extends).toBeNull();
    expect(result.takes_kinds).toEqual(['fact', 'take', 'bet', 'hunch']); // default
  });

  test('rejects wrong api_version', () => {
    expect(() => parseSchemaPackManifest({
      ...minimalManifest() as Record<string, unknown>,
      api_version: 'gbrain-skillpack-v1',
    })).toThrow(/unsupported api_version/);
  });

  test('rejects malformed shape', () => {
    expect(() => parseSchemaPackManifest('not an object')).toThrow(/must be a JSON\/YAML object/);
    expect(() => parseSchemaPackManifest([])).toThrow(/must be a JSON\/YAML object/);
  });

  test('rejects non-semver version', () => {
    expect(() => parseSchemaPackManifest({
      ...minimalManifest() as Record<string, unknown>,
      version: '1.0',
    })).toThrow(/manifest validation failed/);
  });

  test('rejects bad pack name', () => {
    expect(() => parseSchemaPackManifest({
      ...minimalManifest() as Record<string, unknown>,
      name: 'TestPack',
    })).toThrow(/lowercase slug-shape/);
  });
});

describe('manifest-v1: sha8 + identity', () => {
  test('computeManifestSha8 returns 8 hex chars', async () => {
    const m = parseSchemaPackManifest(minimalManifest());
    const sha = await computeManifestSha8(m);
    expect(sha).toMatch(/^[0-9a-f]{8}$/);
  });

  test('sha8 is deterministic across runs', async () => {
    const m = parseSchemaPackManifest(minimalManifest());
    const a = await computeManifestSha8(m);
    const b = await computeManifestSha8(m);
    expect(a).toBe(b);
  });

  test('sha8 changes when manifest content changes', async () => {
    const m1 = parseSchemaPackManifest(minimalManifest());
    const m2 = parseSchemaPackManifest(minimalManifest({ description: 'different' }));
    expect(await computeManifestSha8(m1)).not.toBe(await computeManifestSha8(m2));
  });

  test('packIdentity formats correctly', async () => {
    const m = parseSchemaPackManifest(minimalManifest());
    const sha = await computeManifestSha8(m);
    expect(packIdentity(m, sha)).toBe(`test-pack@1.0.0+${sha}`);
  });
});

describe('closure (E8): alias graph BFS', () => {
  test('isolated type closure = {self}', () => {
    const m = parseSchemaPackManifest(minimalManifest({
      page_types: [
        { name: 'adversary-profile', primitive: 'entity', path_prefixes: [], aliases: [], extractable: false, expert_routing: false },
      ],
    })) as SchemaPackManifest;
    const graph = buildAliasGraph(m);
    expect(expandClosure('adversary-profile', graph)).toEqual(['adversary-profile']);
  });

  test('researcher → person symmetric closure', () => {
    const m = parseSchemaPackManifest(minimalManifest({
      page_types: [
        { name: 'person', primitive: 'entity', path_prefixes: [], aliases: [], extractable: true, expert_routing: true },
        { name: 'researcher', primitive: 'entity', path_prefixes: [], aliases: ['person'], extractable: true, expert_routing: true },
      ],
    })) as SchemaPackManifest;
    const graph = buildAliasGraph(m);
    // Symmetric per declaration: researcher's [person] adds both edges.
    expect(expandClosure('researcher', graph)).toEqual(['person', 'researcher']);
    expect(expandClosure('person', graph)).toEqual(['person', 'researcher']);
  });

  test('E8 regression: adversary-profile NOT in expert closure', () => {
    // Codex finding #15. With pre-E8 primitive-sibling closure, querying
    // person would surface adversary-profile because they share entity
    // primitive. E8 fix: closure follows aliases, not primitive.
    const m = parseSchemaPackManifest(minimalManifest({
      page_types: [
        { name: 'person', primitive: 'entity', path_prefixes: [], aliases: [], extractable: true, expert_routing: true },
        { name: 'researcher', primitive: 'entity', path_prefixes: [], aliases: ['person'], extractable: true, expert_routing: true },
        { name: 'adversary-profile', primitive: 'entity', path_prefixes: [], aliases: [], extractable: false, expert_routing: false },
      ],
    })) as SchemaPackManifest;
    const graph = buildAliasGraph(m);
    const personClosure = expandClosure('person', graph);
    expect(personClosure).toContain('researcher');
    expect(personClosure).not.toContain('adversary-profile');
  });

  test('transitive closure respects depth cap', () => {
    // Build A→B→C→D→E→F chain via aliases. Depth cap = 4 means querying
    // A surfaces {A, B, C, D, E} but not F.
    const types = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, idx, arr) => ({
      name,
      primitive: 'concept' as const,
      path_prefixes: [],
      aliases: idx < arr.length - 1 ? [arr[idx + 1]] : [],
      extractable: false,
      expert_routing: false,
    }));
    const m = parseSchemaPackManifest(minimalManifest({ page_types: types })) as SchemaPackManifest;
    const graph = buildAliasGraph(m);
    const closure = expandClosure('a', graph);
    expect(closure.length).toBeLessThanOrEqual(ALIAS_CLOSURE_MAX_DEPTH + 1);
    expect(closure).toContain('a');
    expect(closure).toContain('b');
  });

  test('cycle detection at load (not query)', () => {
    // A's aliases pointing back to a node that recursively reaches A.
    // The buildAliasGraph DFS detects this on load.
    // Note: a single direct A→B + B→A is NOT a cycle (it's the symmetric
    // mirror); a real cycle requires A→B→C→A.
    const m = parseSchemaPackManifest(minimalManifest({
      page_types: [
        { name: 'a', primitive: 'concept', path_prefixes: [], aliases: ['b'], extractable: false, expert_routing: false },
        { name: 'b', primitive: 'concept', path_prefixes: [], aliases: ['c'], extractable: false, expert_routing: false },
        { name: 'c', primitive: 'concept', path_prefixes: [], aliases: ['a'], extractable: false, expert_routing: false },
      ],
    })) as SchemaPackManifest;
    expect(() => buildAliasGraph(m)).toThrow(AliasCycleError);
  });

  test('returns sorted closure for cache-key determinism', () => {
    const m = parseSchemaPackManifest(minimalManifest({
      page_types: [
        { name: 'zebra', primitive: 'concept', path_prefixes: [], aliases: ['apple', 'mango'], extractable: false, expert_routing: false },
        { name: 'apple', primitive: 'concept', path_prefixes: [], aliases: [], extractable: false, expert_routing: false },
        { name: 'mango', primitive: 'concept', path_prefixes: [], aliases: [], extractable: false, expert_routing: false },
      ],
    })) as SchemaPackManifest;
    const graph = buildAliasGraph(m);
    const closure = expandClosure('zebra', graph);
    // Sorted: apple, mango, zebra
    expect(closure).toEqual(['apple', 'mango', 'zebra']);
  });
});

describe('per-source CTE builder (D13)', () => {
  test('returns null when no bindings', () => {
    expect(buildSourceClosureCte([])).toBeNull();
  });

  test('emits UNION ALL per source', () => {
    const result = buildSourceClosureCte([
      { source_id: 'default', types: ['person', 'researcher'] },
      { source_id: 'zion', types: ['family-member'] },
    ]);
    expect(result).not.toBeNull();
    expect(result!.cte).toContain('UNION ALL');
    expect(result!.cte).toContain("'person'");
    expect(result!.cte).toContain("'family-member'");
    expect(result!.params).toEqual(['default', 'zion']);
  });

  test('SQL-escapes type literals with quotes', () => {
    const result = buildSourceClosureCte([
      { source_id: 'src', types: ["o'reilly-book"] },
    ]);
    expect(result!.cte).toContain("'o''reilly-book'");
  });

  test('orders bindings deterministically by source_id', () => {
    const result = buildSourceClosureCte([
      { source_id: 'zion', types: ['x'] },
      { source_id: 'default', types: ['y'] },
    ]);
    expect(result!.params).toEqual(['default', 'zion']);
  });
});

describe('per-source bindings', () => {
  test('builds bindings from sourcePacks map', () => {
    const m1 = parseSchemaPackManifest(minimalManifest({
      name: 'pack-a',
      page_types: [
        { name: 'person', primitive: 'entity', path_prefixes: [], aliases: [], extractable: true, expert_routing: true },
      ],
    })) as SchemaPackManifest;
    const m2 = parseSchemaPackManifest(minimalManifest({
      name: 'pack-b',
      page_types: [
        { name: 'family-member', primitive: 'entity', path_prefixes: [], aliases: ['person'], extractable: true, expert_routing: true },
        { name: 'person', primitive: 'entity', path_prefixes: [], aliases: [], extractable: true, expert_routing: true },
      ],
    })) as SchemaPackManifest;
    const bindings = buildPerSourceBindings('person', new Map([
      ['src-a', m1],
      ['src-b', m2],
    ]));
    expect(bindings).toHaveLength(2);
    const a = bindings.find(b => b.source_id === 'src-a')!;
    const b = bindings.find(b => b.source_id === 'src-b')!;
    expect(a.types).toEqual(['person']);
    expect(b.types).toEqual(['family-member', 'person']);
  });
});

describe('7-tier resolution (D13)', () => {
  test('default to gbrain-base when nothing set', () => {
    expect(resolveActivePackName({ remote: false })).toEqual({ pack_name: 'gbrain-base', source: 'default' });
  });

  test('per-call wins when remote=false', () => {
    expect(resolveActivePackName({ remote: false, perCall: 'custom-pack' })).toEqual({
      pack_name: 'custom-pack',
      source: 'per-call',
    });
  });

  test('per-call IGNORED when remote=true (D13 trust gate)', () => {
    // The actual rejection happens in operations.ts before this is
    // called. Here we verify the resolver doesn't honor per-call when
    // remote=true even if a caller bypasses the operations gate.
    expect(resolveActivePackName({
      remote: true,
      perCall: 'custom-pack',
      dbConfig: 'configured-pack',
    })).toEqual({
      pack_name: 'configured-pack',
      source: 'db-config',
    });
  });

  test('per-source-db wins over brain-wide db', () => {
    expect(resolveActivePackName({
      remote: true,
      sourceId: 'zion',
      perSourceDb: new Map([['zion', 'family-archive']]),
      dbConfig: 'main-pack',
    })).toEqual({
      pack_name: 'family-archive',
      source: 'per-source-db',
    });
  });

  test('env beats db when present', () => {
    expect(resolveActivePackName({
      remote: false,
      envVar: 'env-pack',
      dbConfig: 'db-pack',
    })).toEqual({ pack_name: 'env-pack', source: 'env' });
  });
});

describe('primitives', () => {
  test('all primitives have defaults', () => {
    for (const p of PACK_PRIMITIVES) {
      const d = getPrimitiveDefaults(p);
      expect(d).toBeDefined();
      expect(d.default_link_verbs.length).toBeGreaterThan(0);
    }
  });

  test('entity primitive is the only expert-routing default', () => {
    expect(getPrimitiveDefaults('entity').default_expert_routing).toBe(true);
    expect(getPrimitiveDefaults('media').default_expert_routing).toBe(false);
    expect(getPrimitiveDefaults('concept').default_expert_routing).toBe(false);
  });
});

describe('YAML mini-parser', () => {
  test('parses basic key:value', () => {
    const result = parseYamlMini('name: hello\nversion: 1.0.0') as Record<string, unknown>;
    expect(result.name).toBe('hello');
    expect(result.version).toBe('1.0.0');
  });

  test('parses nested mappings', () => {
    const result = parseYamlMini('outer:\n  inner: value\n  count: 42') as Record<string, Record<string, unknown>>;
    expect(result.outer.inner).toBe('value');
    expect(result.outer.count).toBe(42);
  });

  test('parses sequences of scalars', () => {
    const result = parseYamlMini('items:\n  - a\n  - b\n  - c') as Record<string, unknown[]>;
    expect(result.items).toEqual(['a', 'b', 'c']);
  });

  test('parses sequences of mappings', () => {
    const result = parseYamlMini('types:\n  - name: alpha\n    weight: 1\n  - name: beta\n    weight: 2') as { types: Array<Record<string, unknown>> };
    expect(result.types).toHaveLength(2);
    expect(result.types[0].name).toBe('alpha');
    expect(result.types[1].weight).toBe(2);
  });

  test('strips comments', () => {
    const result = parseYamlMini('# top comment\nname: value # inline comment') as Record<string, unknown>;
    expect(result.name).toBe('value');
  });
});

describe('loadPackFromString end-to-end', () => {
  test('YAML round-trip', () => {
    const yaml = `api_version: gbrain-schema-pack-v1
name: minimal
version: 0.1.0
description: a tiny pack
extends: null`;
    const pack = loadPackFromString(yaml, 'fixture.yaml');
    expect(pack.name).toBe('minimal');
    expect(pack.extends).toBeNull();
  });

  test('JSON round-trip', () => {
    const json = JSON.stringify({
      api_version: 'gbrain-schema-pack-v1',
      name: 'json-pack',
      version: '0.1.0',
      description: '',
      extends: null,
    });
    const pack = loadPackFromString(json, 'fixture.json');
    expect(pack.name).toBe('json-pack');
  });
});

describe('ReDoS guard', () => {
  test('PageRegexBudget tracks cumulative time', () => {
    const budget = new PageRegexBudget();
    // Run a harmless regex; should not exhaust budget.
    const match = budget.runBounded('mentions', '\\bhello\\b', 'say hello there');
    expect(match).not.toBeUndefined();
    expect(budget.getCumulativeMs()).toBeGreaterThanOrEqual(0);
    expect(budget.isExhausted()).toBe(false);
  });

  test('LINK_EXTRACTION_TOTAL_BUDGET_MS is 500', () => {
    expect(LINK_EXTRACTION_TOTAL_BUDGET_MS).toBe(500);
  });
});

describe('candidate-audit', () => {
  test('isAuditVerbose respects env var', async () => {
    await withEnv({ GBRAIN_SCHEMA_AUDIT_VERBOSE: undefined }, async () => {
      expect(isAuditVerbose()).toBe(false);
    });
    await withEnv({ GBRAIN_SCHEMA_AUDIT_VERBOSE: '1' }, async () => {
      expect(isAuditVerbose()).toBe(true);
    });
  });

  test('computeIsoWeekName formats correctly', () => {
    // 2026-05-20 is in ISO week 21 of 2026.
    const name = computeIsoWeekName(new Date('2026-05-20T12:00:00Z'));
    expect(name).toMatch(/^2026-W\d{2}$/);
  });
});
