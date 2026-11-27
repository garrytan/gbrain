/**
 * The unique violations of the facts table the Rust store raises reach callers as the error Postgres and PGLite raise
 * for them (SQLSTATE 23505, same message), so the CLI text, the --json envelope and the MCP error are the same, and a
 * caller that branches on 23505 sees the Rust engine as it sees the others. Any other constraint stays as it was.
 */
import { describe, expect, test } from 'bun:test';
import { toAgentError } from '../src/core/agent-output.ts';
import { mapStoreError } from '../src/core/rust-engine/store-errors.ts';

const store = (message: string) => Object.assign(new Error(message), { code: 'constraint_violation' });
const unique = (index: string) => `duplicate key value violates unique constraint "${index}"`;
const ctx = { member: 'rehomeEntityFacts' };

describe('the facts unique violations of the Rust store', () => {
  for (const index of ['idx_facts_ontology_stint_dedup', 'idx_facts_fence_key']) {
    test(`${index} is SQLSTATE 23505 with the message Postgres gives`, () => {
      const mapped = mapStoreError(store(unique(index)), ctx) as Error & Record<string, unknown>;
      expect(mapped).toBeInstanceOf(Error);
      expect(mapped.message).toBe(unique(index));
      expect({ code: mapped.code, schema: mapped.schema_name, table: mapped.table_name, constraint: mapped.constraint_name })
        .toEqual({ code: '23505', schema: 'public', table: 'facts', constraint: index });
    });

    test(`${index} gives the CLI, --json and MCP envelope Postgres' error gives`, () => {
      const pg = Object.assign(new Error(unique(index)), { code: '23505', schema_name: 'public', table_name: 'facts', constraint_name: index });
      const mapped = mapStoreError(store(unique(index)), ctx);
      for (const transport of ['cli', 'stdio', 'http'] as const) {
        const at = { transport, op: 'x', mutating: true, outcome: 'unknown', render: { transport }, db: { url: '', brainId: '' } } as never;
        expect(toAgentError(mapped, at)).toEqual(toAgentError(pg, at));
      }
    });
  }

  test('another unique index, another constraint kind and a message of another shape stay as the store raised them', () => {
    for (const message of [unique('sources_pkey'), 'new row for relation "facts" violates check constraint "facts_kind_check"', 'no such constraint']) {
      const error = store(message);
      expect(mapStoreError(error, ctx)).toBe(error);
      expect((error as { code?: string }).code).toBe('constraint_violation');
    }
  });
});

describe('the Rust store code store_missing', () => {
  // Value: protects=a store that must already exist and is not there reaches every caller as brain_missing (reason
  // missing_brain, the user acts), never as an unregistered store code; fails_when=mapStoreError passes store_missing
  // through or maps it to another code; why_new=store_missing is internal and has no registry entry; seam=none;
  // no_claim=the CLI refusal text (test/rust-missing-store-read-commands.test.ts)
  test('maps to brain_missing with reason missing_brain, keeping the store detail', () => {
    const raw = Object.assign(new Error('/x/brain.rust holds no brain (no records.redb); nothing was created'), { code: 'store_missing' });
    const mapped = mapStoreError(raw, { member: 'connect' }) as Error & Record<string, unknown>;
    expect(mapped.code).toBe('brain_missing');
    expect(mapped.reason).toBe('missing_brain');
    expect(String(mapped.message)).toContain('Nothing was created there.');
    expect(String(mapped.detail)).toContain('holds no brain');
  });
});
