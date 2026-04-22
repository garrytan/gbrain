import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { getPersonalProfileLookupRoute } from '../src/core/services/personal-profile-lookup-route-service.ts';

test('personal profile lookup route service resolves an exact profile subject', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-profile-route-direct-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.upsertProfileMemoryEntry({
      id: 'profile-1',
      scope_id: 'personal:default',
      profile_type: 'routine',
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      sensitivity: 'personal',
      export_status: 'private_only',
      last_confirmed_at: new Date('2026-04-22T00:05:00.000Z'),
      superseded_by: null,
    });

    const result = await getPersonalProfileLookupRoute(engine, {
      subject: 'daily routine',
    });

    expect(result.selection_reason).toBe('direct_subject_match');
    expect(result.candidate_count).toBe(1);
    expect(result.route?.route_kind).toBe('personal_profile_lookup');
    expect(result.route?.profile_memory_id).toBe('profile-1');
    expect(result.route?.subject).toBe('daily routine');
    expect(result.route?.profile_type).toBe('routine');
    expect(result.route?.retrieval_route).toEqual([
      'profile_memory_record',
      'minimal_personal_supporting_reads',
    ]);
    expect(result.route?.summary_lines).toContain('Personal profile lookup is anchored to exact profile subject daily routine.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal profile lookup route service uses profile_type to disambiguate exact subject matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-profile-route-filtered-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.upsertProfileMemoryEntry({
      id: 'profile-1',
      scope_id: 'personal:default',
      profile_type: 'routine',
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      sensitivity: 'personal',
      export_status: 'private_only',
      last_confirmed_at: null,
      superseded_by: null,
    });
    await engine.upsertProfileMemoryEntry({
      id: 'profile-2',
      scope_id: 'personal:default',
      profile_type: 'preference',
      subject: 'daily routine',
      content: 'Prefer a quiet start before meetings.',
      source_refs: ['User, direct message, 2026-04-22 9:07 AM KST'],
      sensitivity: 'personal',
      export_status: 'private_only',
      last_confirmed_at: null,
      superseded_by: null,
    });

    const filtered = await getPersonalProfileLookupRoute(engine, {
      subject: 'daily routine',
      profile_type: 'routine',
    });

    expect(filtered.selection_reason).toBe('direct_subject_match');
    expect(filtered.candidate_count).toBe(1);
    expect(filtered.route?.profile_memory_id).toBe('profile-1');

    const ambiguous = await getPersonalProfileLookupRoute(engine, {
      subject: 'daily routine',
    });

    expect(ambiguous.selection_reason).toBe('ambiguous_subject_match');
    expect(ambiguous.candidate_count).toBe(2);
    expect(ambiguous.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal profile lookup route service degrades explicitly when the exact subject is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-profile-route-missing-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await getPersonalProfileLookupRoute(engine, {
      subject: 'sleep routine',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.candidate_count).toBe(0);
    expect(result.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
