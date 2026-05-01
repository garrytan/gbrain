import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('profile-memory operations are registered with CLI hints', () => {
  const upsert = operations.find((operation) => operation.name === 'upsert_profile_memory_entry');
  const get = operations.find((operation) => operation.name === 'get_profile_memory_entry');
  const list = operations.find((operation) => operation.name === 'list_profile_memory_entries');

  expect(upsert?.cliHints?.name).toBe('profile-memory-upsert');
  expect(get?.cliHints?.name).toBe('profile-memory-get');
  expect(list?.cliHints?.name).toBe('profile-memory-list');
});

test('profile-memory upsert rejects writes without source provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-profile-memory-source-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const upsert = operations.find((operation) => operation.name === 'upsert_profile_memory_entry');

  if (!upsert) {
    throw new Error('profile-memory upsert operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await expect(upsert.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      profile_type: 'routine',
    })).rejects.toThrow('source_ref is required');

    expect(await engine.listProfileMemoryEntries({ subject: 'daily routine' })).toEqual([]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile-memory operations expose dry-run, direct get, and filtered list behavior', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-profile-memory-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const upsert = operations.find((operation) => operation.name === 'upsert_profile_memory_entry');
  const get = operations.find((operation) => operation.name === 'get_profile_memory_entry');
  const list = operations.find((operation) => operation.name === 'list_profile_memory_entries');

  if (!upsert || !get || !list) {
    throw new Error('profile-memory operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const preview = await upsert.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: true,
    }, {
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      profile_type: 'routine',
      source_ref: 'User, dry-run preview, 2026-04-22 9:04 AM KST',
    });

    expect((preview as any).dry_run).toBe(true);
    expect((preview as any).action).toBe('upsert_profile_memory_entry');
    expect((preview as any).scope_id).toBe('personal:default');

    const created = await upsert.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'profile-1',
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      profile_type: 'routine',
      source_ref: 'User, direct message, 2026-04-22 9:05 AM KST',
    });

    expect((created as any).id).toBe('profile-1');
    expect((created as any).scope_id).toBe('personal:default');
    expect((created as any).profile_type).toBe('routine');
    expect((created as any).subject).toBe('daily routine');
    expect((created as any).source_refs).toEqual(['User, direct message, 2026-04-22 9:05 AM KST']);

    const loaded = await get.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'profile-1',
    });

    expect((loaded as any).id).toBe('profile-1');
    expect((loaded as any).subject).toBe('daily routine');

    const listed = await list.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      subject: 'daily routine',
      limit: 10,
    });

    expect((listed as any[]).map((entry) => entry.id)).toEqual(['profile-1']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
