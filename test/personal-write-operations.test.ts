import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operations } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('safe personal write operations are registered with CLI hints', () => {
  const profileWrite = operations.find((operation) => operation.name === 'write_profile_memory_entry');
  const episodeWrite = operations.find((operation) => operation.name === 'write_personal_episode_entry');

  expect(profileWrite?.cliHints?.name).toBe('profile-memory-write');
  expect(episodeWrite?.cliHints?.name).toBe('personal-episode-write');
});

test('safe personal write operations create records only after personal write-target preflight allows them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-write-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  const profileWrite = operations.find((operation) => operation.name === 'write_profile_memory_entry');
  const episodeWrite = operations.find((operation) => operation.name === 'write_personal_episode_entry');

  if (!profileWrite || !episodeWrite) {
    throw new Error('safe personal write operations are missing');
  }

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const profile = await profileWrite.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'profile-1',
      subject: 'daily routine',
      content: 'Wake at 7 AM, review priorities, then write.',
      profile_type: 'routine',
      query: 'remember my daily routine',
      source_ref: 'User, direct message, 2026-04-22 9:05 AM KST',
    });

    expect((profile as any).id).toBe('profile-1');
    expect((await engine.getProfileMemoryEntry('profile-1'))?.subject).toBe('daily routine');

    const deniedProfile = await profileWrite.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'profile-2',
      subject: 'architecture preference',
      content: 'Prefer reading docs before coding.',
      profile_type: 'preference',
      query: 'summarize the architecture docs',
      requested_scope: 'work',
      source_ref: 'User, direct message, 2026-04-22 9:10 AM KST',
    }).catch((error) => error);

    expect((deniedProfile as any).code).toBe('invalid_params');
    expect(await engine.getProfileMemoryEntry('profile-2')).toBeNull();

    const episode = await episodeWrite.handler({
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
      query: 'remember my travel recovery routine',
      source_ref: 'User, direct message, 2026-04-22 9:15 AM KST',
      candidate_id: 'profile-1',
    });

    expect((episode as any).id).toBe('episode-1');
    expect((await engine.getPersonalEpisodeEntry('episode-1'))?.title).toBe('Morning reset');

    const deniedEpisode = await episodeWrite.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      id: 'episode-2',
      title: 'Architecture recap',
      summary: 'Summarized repo architecture notes.',
      source_kind: 'note',
      start_time: '2026-04-22T08:00:00.000Z',
      query: 'summarize the architecture docs',
      requested_scope: 'work',
      source_ref: 'User, direct message, 2026-04-22 9:20 AM KST',
    }).catch((error) => error);

    expect((deniedEpisode as any).code).toBe('invalid_params');
    expect(await engine.getPersonalEpisodeEntry('episode-2')).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
