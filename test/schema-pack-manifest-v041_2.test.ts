// v0.41 T3 — SchemaPackManifestSchema extensions: phases + calibration_domains.
//
// Pinned contracts:
//   - `phases:` optional, defaults to [], accepts string[] of CyclePhase names
//   - `calibration_domains:` optional, defaults to []
//   - CalibrationDomain entries: {name: snake_case, aggregator: closed enum, page_types: non-empty}
//   - AggregatorKind closed enum exposes 4 v1 algorithms (scalar_brier,
//     weighted_brier, count_based, cluster_summary)
//   - Unknown aggregator rejected at parse time with a clear error path
//   - Unknown domain name shape (e.g. 'Deal-Success' kebab-case) rejected at parse
//   - Backward compat: existing pack manifests without phases/calibration_domains
//     still parse cleanly (defaults to empty arrays)

import { describe, test, expect } from 'bun:test';
import {
  parseSchemaPackManifest,
  AGGREGATOR_KINDS,
  type AggregatorKind,
  type CalibrationDomain,
  type SchemaPackManifest,
} from '../src/core/schema-pack/manifest-v1.ts';

const baseManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  api_version: 'gbrain-schema-pack-v1',
  name: 'test-pack',
  version: '1.0.0',
  description: 'unit test pack for v0.41 schema extensions',
  ...overrides,
});

describe('v0.41 T3: AggregatorKind closed registry', () => {
  test('exposes exactly 4 v1 aggregator kinds', () => {
    expect(AGGREGATOR_KINDS.length).toBe(4);
    expect(AGGREGATOR_KINDS).toEqual([
      'scalar_brier',
      'weighted_brier',
      'count_based',
      'cluster_summary',
    ]);
  });

  test('AggregatorKind type union covers exactly the enum values', () => {
    // Compile-time + runtime test: every AGGREGATOR_KINDS value is a valid AggregatorKind
    for (const k of AGGREGATOR_KINDS) {
      const typed: AggregatorKind = k;
      expect(typeof typed).toBe('string');
    }
  });
});

describe('v0.41 T3: SchemaPackManifestSchema phases field', () => {
  test('phases is undefined when omitted; consumers apply ?? [] at read site', () => {
    const parsed = parseSchemaPackManifest(baseManifest());
    expect(parsed.phases).toBeUndefined();
    // Standard consumer pattern:
    const effective = parsed.phases ?? [];
    expect(effective).toEqual([]);
  });

  test('phases accepts string array of phase names', () => {
    const parsed = parseSchemaPackManifest(
      baseManifest({ phases: ['extract_atoms', 'synthesize_concepts'] }),
    );
    expect(parsed.phases).toEqual(['extract_atoms', 'synthesize_concepts']);
  });

  test('phases rejects non-string entries', () => {
    expect(() =>
      parseSchemaPackManifest(baseManifest({ phases: ['extract_atoms', 42] })),
    ).toThrow();
  });

  test('phases rejects empty-string entries', () => {
    expect(() => parseSchemaPackManifest(baseManifest({ phases: [''] }))).toThrow();
  });

  test('phases rejects non-array shape', () => {
    expect(() => parseSchemaPackManifest(baseManifest({ phases: 'extract_atoms' }))).toThrow();
  });
});

describe('v0.41 T3: SchemaPackManifestSchema calibration_domains field', () => {
  test('calibration_domains is undefined when omitted; consumers apply ?? [] at read site', () => {
    const parsed = parseSchemaPackManifest(baseManifest());
    expect(parsed.calibration_domains).toBeUndefined();
    const effective = parsed.calibration_domains ?? [];
    expect(effective).toEqual([]);
  });

  test('accepts well-formed domain entry', () => {
    const parsed = parseSchemaPackManifest(
      baseManifest({
        calibration_domains: [
          {
            name: 'deal_success',
            aggregator: 'scalar_brier',
            page_types: ['deal'],
          },
        ],
      }),
    );
    expect(parsed.calibration_domains!.length).toBe(1);
    const d = parsed.calibration_domains![0];
    expect(d.name).toBe('deal_success');
    expect(d.aggregator).toBe('scalar_brier');
    expect(d.page_types).toEqual(['deal']);
  });

  test('accepts all 4 aggregator kinds', () => {
    for (const aggregator of AGGREGATOR_KINDS) {
      const parsed = parseSchemaPackManifest(
        baseManifest({
          calibration_domains: [
            { name: `domain_${aggregator}`, aggregator, page_types: ['person'] },
          ],
        }),
      );
      expect(parsed.calibration_domains![0].aggregator).toBe(aggregator);
    }
  });

  test('rejects unknown aggregator value', () => {
    expect(() =>
      parseSchemaPackManifest(
        baseManifest({
          calibration_domains: [
            { name: 'bad_domain', aggregator: 'made_up_algo', page_types: ['deal'] },
          ],
        }),
      ),
    ).toThrow();
  });

  test('rejects kebab-case domain name (must be snake_case)', () => {
    expect(() =>
      parseSchemaPackManifest(
        baseManifest({
          calibration_domains: [
            { name: 'Deal-Success', aggregator: 'scalar_brier', page_types: ['deal'] },
          ],
        }),
      ),
    ).toThrow();
  });

  test('rejects uppercase domain name', () => {
    expect(() =>
      parseSchemaPackManifest(
        baseManifest({
          calibration_domains: [
            { name: 'DealSuccess', aggregator: 'scalar_brier', page_types: ['deal'] },
          ],
        }),
      ),
    ).toThrow();
  });

  test('rejects domain name starting with digit', () => {
    expect(() =>
      parseSchemaPackManifest(
        baseManifest({
          calibration_domains: [
            { name: '1deal', aggregator: 'scalar_brier', page_types: ['deal'] },
          ],
        }),
      ),
    ).toThrow();
  });

  test('rejects empty page_types array (must have at least 1)', () => {
    expect(() =>
      parseSchemaPackManifest(
        baseManifest({
          calibration_domains: [
            { name: 'deal_success', aggregator: 'scalar_brier', page_types: [] },
          ],
        }),
      ),
    ).toThrow();
  });

  test('rejects unknown extra field on domain entry (.strict)', () => {
    expect(() =>
      parseSchemaPackManifest(
        baseManifest({
          calibration_domains: [
            {
              name: 'deal_success',
              aggregator: 'scalar_brier',
              page_types: ['deal'],
              bonus_field: 'not allowed',
            },
          ],
        }),
      ),
    ).toThrow();
  });

  test('accepts multiple page_types per domain', () => {
    const parsed = parseSchemaPackManifest(
      baseManifest({
        calibration_domains: [
          {
            name: 'architecture_calls',
            aggregator: 'scalar_brier',
            page_types: ['code', 'decision'],
          },
        ],
      }),
    );
    expect(parsed.calibration_domains![0].page_types).toEqual(['code', 'decision']);
  });

  test('accepts multiple domain entries per pack', () => {
    const parsed = parseSchemaPackManifest(
      baseManifest({
        calibration_domains: [
          { name: 'deal_success', aggregator: 'scalar_brier', page_types: ['deal'] },
          { name: 'founder_evaluation', aggregator: 'scalar_brier', page_types: ['person'] },
          { name: 'market_call', aggregator: 'weighted_brier', page_types: ['thesis'] },
          { name: 'concept_themes', aggregator: 'cluster_summary', page_types: ['concept'] },
        ],
      }),
    );
    expect(parsed.calibration_domains!.length).toBe(4);
    const byName = Object.fromEntries(parsed.calibration_domains!.map((d: CalibrationDomain) => [d.name, d.aggregator]));
    expect(byName.deal_success).toBe('scalar_brier');
    expect(byName.market_call).toBe('weighted_brier');
    expect(byName.concept_themes).toBe('cluster_summary');
  });
});

describe('v0.41 T3: backward compatibility with v0.38 manifests', () => {
  test('existing minimal manifest without phases/calibration_domains still parses', () => {
    const v038Shape = baseManifest({
      page_types: [
        {
          name: 'thing',
          primitive: 'entity',
          path_prefixes: ['things/'],
          aliases: [],
          extractable: false,
          expert_routing: false,
        },
      ],
    });
    const parsed: SchemaPackManifest = parseSchemaPackManifest(v038Shape);
    expect(parsed.phases).toBeUndefined();
    expect(parsed.calibration_domains).toBeUndefined();
    expect(parsed.page_types.length).toBe(1);
  });

  test('existing manifest with takes_kinds + filing_rules unchanged by extensions', () => {
    const parsed = parseSchemaPackManifest(
      baseManifest({
        takes_kinds: ['fact', 'take', 'bet', 'hunch'],
        filing_rules: [{ kind: 'note', directory: 'notes/', examples: [], description: undefined }],
      }),
    );
    expect(parsed.takes_kinds).toEqual(['fact', 'take', 'bet', 'hunch']);
    expect(parsed.filing_rules.length).toBe(1);
  });
});
