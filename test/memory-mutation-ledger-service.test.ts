import { expect, test } from 'bun:test';
import {
  recordMemoryMutationEvent,
  type MemoryMutationEventServiceInput,
} from '../src/core/services/memory-mutation-ledger-service.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MemoryMutationEventInput } from '../src/core/types.ts';

function createCapturingEngine() {
  const calls: MemoryMutationEventInput[] = [];
  const engine = {
    createMemoryMutationEvent: async (input: MemoryMutationEventInput) => {
      calls.push(input);
      return {
        ...input,
        target_id: input.target_id,
        scope_id: input.scope_id ?? null,
        source_refs: input.source_refs,
        expected_target_snapshot_hash: input.expected_target_snapshot_hash ?? null,
        current_target_snapshot_hash: input.current_target_snapshot_hash ?? null,
        conflict_info: input.conflict_info ?? null,
        dry_run: input.dry_run ?? false,
        metadata: input.metadata ?? {},
        redaction_visibility: input.redaction_visibility ?? 'visible',
        created_at: new Date(input.created_at ?? '2026-04-25T01:00:00.000Z'),
        decided_at: null,
        applied_at: null,
      };
    },
  } as unknown as BrainEngine;

  return { engine, calls };
}

test('recordMemoryMutationEvent normalizes required ledger event fields', async () => {
  const { engine, calls } = createCapturingEngine();

  const event = await recordMemoryMutationEvent(engine, {
    session_id: 'session-service',
    realm_id: 'realm-service',
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    target_id: ' concepts/service-ledger ',
    source_refs: [' Source: service test '],
    result: 'applied',
  });

  expect(event.id.length).toBeGreaterThan(10);
  expect(calls[0].target_id).toBe('concepts/service-ledger');
  expect(calls[0].source_refs).toEqual(['Source: service test']);
  expect(calls[0].dry_run).toBe(false);
});

test('recordMemoryMutationEvent rejects missing target provenance and dry-run mismatches', async () => {
  const { engine } = createCapturingEngine();
  const base: MemoryMutationEventServiceInput = {
    session_id: 'session-service',
    realm_id: 'realm-service',
    actor: 'agent',
    operation: 'put_page',
    target_kind: 'page',
    target_id: 'concepts/service-ledger',
    source_refs: ['Source: service test'],
    result: 'applied',
  };

  await expect(recordMemoryMutationEvent(engine, { ...base, target_id: '' })).rejects.toThrow(/target_id/i);
  await expect(recordMemoryMutationEvent(engine, { ...base, source_refs: [] })).rejects.toThrow(/source_refs/i);
  await expect(recordMemoryMutationEvent(engine, { ...base, source_refs: ['   '] })).rejects.toThrow(/source_refs/i);
  await expect(recordMemoryMutationEvent(engine, { ...base, result: 'dry_run', dry_run: false })).rejects.toThrow(/dry_run/i);
  await expect(recordMemoryMutationEvent(engine, { ...base, result: 'applied', dry_run: true })).rejects.toThrow(/dry_run/i);
});
