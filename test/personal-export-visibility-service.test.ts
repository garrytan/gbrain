import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { previewPersonalExport } from '../src/core/services/personal-export-visibility-service.ts';

test('personal export visibility service returns only exportable profile-memory records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-export-visibility-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.upsertProfileMemoryEntry({
      id: 'profile-exportable',
      scope_id: 'personal:default',
      profile_type: 'routine',
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      sensitivity: 'personal',
      export_status: 'exportable',
      last_confirmed_at: new Date('2026-04-22T00:05:00.000Z'),
      superseded_by: null,
    });
    await engine.upsertProfileMemoryEntry({
      id: 'profile-private',
      scope_id: 'personal:default',
      profile_type: 'stable_fact',
      subject: 'home address',
      content: 'Private location record.',
      source_refs: ['User, direct message, 2026-04-22 9:06 AM KST'],
      sensitivity: 'secret',
      export_status: 'private_only',
      last_confirmed_at: null,
      superseded_by: null,
    });
    await engine.createPersonalEpisodeEntry({
      id: 'episode-1',
      scope_id: 'personal:default',
      title: 'Morning reset',
      start_time: new Date('2026-04-22T06:30:00.000Z'),
      end_time: new Date('2026-04-22T07:00:00.000Z'),
      source_kind: 'chat',
      summary: 'Re-established the daily routine after travel.',
      source_refs: ['User, direct message, 2026-04-22 9:07 AM KST'],
      candidate_ids: ['profile-exportable'],
    });

    const result = await previewPersonalExport(engine, {
      query: 'export my personal routine notes',
      requested_scope: 'personal',
    });

    expect(result.selection_reason).toBe('direct_personal_export_preview');
    expect(result.scope_gate.resolved_scope).toBe('personal');
    expect(result.scope_gate.policy).toBe('allow');
    expect(result.profile_memory_entries.map((entry) => entry.id)).toEqual(['profile-exportable']);
    expect(result.personal_episode_entries).toEqual([]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal export visibility service denies work-scoped export requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-export-deny-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await previewPersonalExport(engine, {
      query: 'summarize the architecture docs',
      requested_scope: 'work',
    });

    expect(result.selection_reason).toBe('unsupported_scope_intent');
    expect(result.scope_gate.resolved_scope).toBe('work');
    expect(result.scope_gate.policy).toBe('deny');
    expect(result.profile_memory_entries).toEqual([]);
    expect(result.personal_episode_entries).toEqual([]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal export visibility service defers when scope is not safe enough to infer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-export-defer-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await previewPersonalExport(engine, {
      query: 'help me remember this',
    });

    expect(result.selection_reason).toBe('insufficient_signal');
    expect(result.scope_gate.resolved_scope).toBe('unknown');
    expect(result.scope_gate.policy).toBe('defer');
    expect(result.profile_memory_entries).toEqual([]);
    expect(result.personal_episode_entries).toEqual([]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
