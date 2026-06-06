import { describe, expect, test } from 'bun:test';
import { listRetrievableAssertionsForEngine } from '../src/core/assertions/assertion-retrieval-store.ts';

describe('assertion retrieval scope safety', () => {
  test('filters SQL assertions by scope before planning retrieval', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const engine = {
      db: {
        query: async (sql: string, params: unknown[] = []) => {
          seen.push({ sql, params });
          return {
            rows: [{
              id: 'assertion-work',
              scope_id: 'workspace:default',
              policy_version: 'policy:v1',
              authority_scope: 'work',
              claim_type: 'architecture_claim',
              target_type: 'curated_note',
              target_id: 'systems/mbrain',
              target_slug: 'systems/mbrain',
              property: 'runtime',
              value_json: { text: 'Markdown remains canonical.' },
              normalized_claim: 'Markdown remains canonical.',
              authority_summary: {},
              confidence: 0.9,
              evidence_count: 1,
              authority_state: 'canonical',
              lifecycle_state: 'active',
              valid_from: null,
              valid_until: null,
              supersedes_assertion_id: null,
              superseded_by_assertion_id: null,
              conflict_set_id: null,
              created_at: '2026-06-06T00:00:00.000Z',
              updated_at: '2026-06-06T00:00:00.000Z',
            }],
          };
        },
      },
    } as any;

    const result = await listRetrievableAssertionsForEngine(engine, {
      scope_id: 'workspace:default',
      target_slug: 'systems/mbrain',
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.assertion.scope_id).toBe('workspace:default');
    expect(seen[0]!.sql).toContain('scope_id = $');
    expect(seen[0]!.params).toContain('workspace:default');
    expect(seen[0]!.params).toContain('systems/mbrain');
  });

  test('rejects frontier-style lookup without explicit scope id', async () => {
    const engine = { db: { query: async () => ({ rows: [] }) } } as any;

    await expect(listRetrievableAssertionsForEngine(engine, {
      frontier: true,
    })).rejects.toThrow('scope_id is required for assertion frontier retrieval');
  });
});
