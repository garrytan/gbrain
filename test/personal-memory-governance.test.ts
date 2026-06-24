import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

// Workstream B3: upsert_profile_memory_entry / record_personal_episode must not accept a
// non-personal scope, and the deletes must scope-check the target and record a ledger row.

function op(name: string) {
  const found = operations.find((operation) => operation.name === name);
  if (!found) throw new Error(`missing operation: ${name}`);
  return found;
}

describe('personal memory write/delete governance (B3)', () => {
  let engine: SQLiteEngine;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-gov-'));
    engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
  });

  afterEach(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ engine, config: {} as any, logger: console, dryRun: false });

  test('upsert_profile_memory_entry rejects a work:* scope_id', async () => {
    await expect(op('upsert_profile_memory_entry').handler(ctx(), {
      scope_id: 'work:acme',
      subject: 'roadmap',
      content: 'Q3 roadmap details.',
      profile_type: 'stable_fact',
      source_ref: 'User, direct message, 2026-06-22 10:00 AM KST',
    })).rejects.toThrow(/personal: scope/);
    expect(await engine.listProfileMemoryEntries({ subject: 'roadmap' })).toEqual([]);
  });

  test('record_personal_episode rejects a work:* scope_id', async () => {
    await expect(op('record_personal_episode').handler(ctx(), {
      scope_id: 'work:acme',
      title: 'standup',
      start_time: '2026-06-22T01:00:00.000Z',
      source_kind: 'meeting',
      summary: 'Team standup notes.',
      source_ref: 'User, direct message, 2026-06-22 10:00 AM KST',
    })).rejects.toThrow(/personal: scope/);
  });

  test('delete_profile_memory_entry rejects a cross-scope (non-personal) entry', async () => {
    // Seed a work-scoped entry directly on the engine, bypassing the governed op.
    const seeded = await engine.upsertProfileMemoryEntry({
      id: 'work-profile-1',
      scope_id: 'work:acme',
      profile_type: 'stable_fact',
      subject: 'roadmap',
      content: 'Q3 roadmap details.',
      source_refs: ['system seed'],
      sensitivity: 'personal',
      export_status: 'private_only',
      last_confirmed_at: null,
      superseded_by: null,
    });
    await expect(op('delete_profile_memory_entry').handler(ctx(), { id: seeded.id }))
      .rejects.toThrow(/personal: scope/);
    expect(await engine.getProfileMemoryEntry(seeded.id)).not.toBeNull();
  });

  test('delete_personal_episode_entry rejects a cross-scope (non-personal) entry', async () => {
    const seeded = await engine.createPersonalEpisodeEntry({
      id: 'work-episode-1',
      scope_id: 'work:acme',
      title: 'standup',
      start_time: '2026-06-22T01:00:00.000Z',
      end_time: null,
      source_kind: 'meeting',
      summary: 'Team standup notes.',
      source_refs: ['system seed'],
      candidate_ids: [],
    });
    await expect(op('delete_personal_episode_entry').handler(ctx(), { id: seeded.id }))
      .rejects.toThrow(/personal: scope/);
    expect(await engine.getPersonalEpisodeEntry(seeded.id)).not.toBeNull();
  });

  test('delete_profile_memory_entry records a mutation-ledger row before deleting', async () => {
    const created = await op('upsert_profile_memory_entry').handler(ctx(), {
      id: 'personal-profile-1',
      subject: 'morning routine',
      content: 'Wake at 7 AM, review priorities.',
      profile_type: 'routine',
      source_ref: 'User, direct message, 2026-06-22 10:00 AM KST',
    }) as any;

    const result = await op('delete_profile_memory_entry').handler(ctx(), { id: created.id }) as any;
    expect(result.status).toBe('deleted');
    expect(await engine.getProfileMemoryEntry(created.id)).toBeNull();

    const ledger = await engine.listMemoryMutationEvents({ operation: 'delete_profile_memory_entry' });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      operation: 'delete_profile_memory_entry',
      target_kind: 'profile_memory',
      target_id: created.id,
      scope_id: 'personal:default',
      result: 'applied',
    });
  });

  test('delete_profile_memory_entry does not record applied ledger when the delete fails', async () => {
    const events: unknown[] = [];
    const failingEngine = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(failingEngine),
      getProfileMemoryEntry: async () => ({
        id: 'personal-profile-fails-delete',
        scope_id: 'personal:default',
        source_refs: ['system seed'],
      }),
      createMemoryMutationEvent: async (event: unknown) => {
        events.push(event);
        return event;
      },
      deleteProfileMemoryEntry: async () => {
        throw new Error('delete failed');
      },
    };

    await expect(op('delete_profile_memory_entry').handler(
      { engine: failingEngine as any, config: {} as any, logger: console, dryRun: false },
      { id: 'personal-profile-fails-delete' },
    )).rejects.toThrow('delete failed');

    expect(events).toEqual([]);
  });
});
