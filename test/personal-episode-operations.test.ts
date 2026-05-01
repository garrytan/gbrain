import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('personal-episode operations are registered with CLI hints', () => {
  const record = operations.find((operation) => operation.name === 'record_personal_episode');
  const get = operations.find((operation) => operation.name === 'get_personal_episode_entry');
  const list = operations.find((operation) => operation.name === 'list_personal_episode_entries');

  expect(record?.cliHints?.name).toBe('personal-episode-record');
  expect(get?.cliHints?.name).toBe('personal-episode-get');
  expect(list?.cliHints?.name).toBe('personal-episode-list');
});

test('personal-episode record rejects writes without source provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-episode-source-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const record = operations.find((operation) => operation.name === 'record_personal_episode');

  if (!record) {
    throw new Error('personal-episode record operation is missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await expect(record.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      title: 'Morning reset',
      summary: 'Re-established the daily routine after travel.',
      source_kind: 'chat',
      start_time: '2026-04-22T06:30:00.000Z',
    })).rejects.toThrow('source_ref is required');

    expect(await engine.listPersonalEpisodeEntries({ title: 'Morning reset' })).toEqual([]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal-episode operations expose dry-run, direct get, and filtered list behavior', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-episode-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const record = operations.find((operation) => operation.name === 'record_personal_episode');
  const get = operations.find((operation) => operation.name === 'get_personal_episode_entry');
  const list = operations.find((operation) => operation.name === 'list_personal_episode_entries');

  if (!record || !get || !list) {
    throw new Error('personal-episode operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const preview = await record.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: true,
    }, {
      title: 'Morning reset',
      summary: 'Re-established the daily routine after travel.',
      source_kind: 'chat',
      start_time: '2026-04-22T06:30:00.000Z',
      source_ref: 'User, dry-run preview, 2026-04-22 9:04 AM KST',
    });

    expect((preview as any).dry_run).toBe(true);
    expect((preview as any).action).toBe('record_personal_episode');
    expect((preview as any).scope_id).toBe('personal:default');

    const created = await record.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'episode-1',
      title: 'Morning reset',
      summary: 'Re-established the daily routine after travel.',
      source_kind: 'chat',
      start_time: '2026-04-22T06:30:00.000Z',
      end_time: '2026-04-22T07:00:00.000Z',
      source_ref: 'User, direct message, 2026-04-22 9:05 AM KST',
      candidate_id: 'profile-1',
    });

    expect((created as any).id).toBe('episode-1');
    expect((created as any).scope_id).toBe('personal:default');
    expect((created as any).title).toBe('Morning reset');
    expect((created as any).candidate_ids).toEqual(['profile-1']);

    const loaded = await get.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'episode-1',
    });

    expect((loaded as any).id).toBe('episode-1');
    expect((loaded as any).summary).toContain('daily routine');

    const listed = await list.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      title: 'Morning reset',
      limit: 10,
    });

    expect((listed as any[]).map((entry) => entry.id)).toEqual(['episode-1']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
