import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('personal profile lookup route operation is registered with CLI hints', () => {
  const route = operations.find((operation) => operation.name === 'get_personal_profile_lookup_route');
  expect(route?.cliHints?.name).toBe('personal-profile-lookup-route');
});

test('personal profile lookup route operation returns no-match disclosure and direct route payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-profile-route-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'get_personal_profile_lookup_route');

  if (!route) {
    throw new Error('get_personal_profile_lookup_route operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const noMatch = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      subject: 'sleep routine',
    });

    expect((noMatch as any).selection_reason).toBe('no_match');
    expect((noMatch as any).route).toBeNull();

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

    const direct = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      subject: 'daily routine',
    });

    expect((direct as any).selection_reason).toBe('direct_subject_match');
    expect((direct as any).route?.route_kind).toBe('personal_profile_lookup');
    expect((direct as any).route?.profile_memory_id).toBe('profile-1');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
