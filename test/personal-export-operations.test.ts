import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('personal export preview operation is registered with CLI hints', () => {
  const route = operations.find((operation) => operation.name === 'preview_personal_export');
  expect(route?.cliHints?.name).toBe('personal-export-preview');
});

test('personal export preview operation returns allow, deny, and defer disclosures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-export-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const route = operations.find((operation) => operation.name === 'preview_personal_export');

  if (!route) {
    throw new Error('preview_personal_export operation is missing');
  }

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

    const allow = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      query: 'export my personal routine notes',
      requested_scope: 'personal',
    });

    expect((allow as any).selection_reason).toBe('direct_personal_export_preview');
    expect((allow as any).profile_memory_entries.map((entry: any) => entry.id)).toEqual(['profile-exportable']);

    const deny = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      query: 'summarize the architecture docs',
      requested_scope: 'work',
    });

    expect((deny as any).selection_reason).toBe('unsupported_scope_intent');
    expect((deny as any).profile_memory_entries).toEqual([]);

    const defer = await route.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      query: 'help me remember this',
    });

    expect((defer as any).selection_reason).toBe('insufficient_signal');
    expect((defer as any).profile_memory_entries).toEqual([]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
