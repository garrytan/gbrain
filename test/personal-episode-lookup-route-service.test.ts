import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { getPersonalEpisodeLookupRoute } from '../src/core/services/personal-episode-lookup-route-service.ts';

test('personal episode lookup route service resolves an exact episode title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-episode-route-direct-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createPersonalEpisodeEntry({
      id: 'episode-1',
      scope_id: 'personal:default',
      title: 'Morning reset',
      start_time: new Date('2026-04-22T06:30:00.000Z'),
      end_time: new Date('2026-04-22T07:00:00.000Z'),
      source_kind: 'chat',
      summary: 'Re-established the daily routine after travel.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      candidate_ids: ['profile-1'],
    });

    const result = await getPersonalEpisodeLookupRoute(engine, {
      title: 'Morning reset',
    });

    expect(result.selection_reason).toBe('direct_title_match');
    expect(result.candidate_count).toBe(1);
    expect(result.route?.route_kind).toBe('personal_episode_lookup');
    expect(result.route?.personal_episode_id).toBe('episode-1');
    expect(result.route?.title).toBe('Morning reset');
    expect(result.route?.source_kind).toBe('chat');
    expect(result.route?.retrieval_route).toEqual([
      'personal_episode_record',
      'minimal_personal_supporting_reads',
    ]);
    expect(result.route?.summary_lines).toContain('Personal episode lookup is anchored to exact episode title Morning reset.');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal episode lookup route service uses source_kind to disambiguate exact title matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-episode-route-filtered-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createPersonalEpisodeEntry({
      id: 'episode-1',
      scope_id: 'personal:default',
      title: 'Morning reset',
      start_time: new Date('2026-04-22T06:30:00.000Z'),
      end_time: new Date('2026-04-22T07:00:00.000Z'),
      source_kind: 'chat',
      summary: 'Re-established the daily routine after travel.',
      source_refs: ['User, direct message, 2026-04-22 9:05 AM KST'],
      candidate_ids: ['profile-1'],
    });
    await engine.createPersonalEpisodeEntry({
      id: 'episode-2',
      scope_id: 'personal:default',
      title: 'Morning reset',
      start_time: new Date('2026-04-22T07:30:00.000Z'),
      end_time: null,
      source_kind: 'note',
      summary: 'Documented the travel recovery routine in the journal.',
      source_refs: ['Journal, personal note, 2026-04-22 10:00 AM KST'],
      candidate_ids: ['profile-1'],
    });

    const filtered = await getPersonalEpisodeLookupRoute(engine, {
      title: 'Morning reset',
      source_kind: 'chat',
    });

    expect(filtered.selection_reason).toBe('direct_title_match');
    expect(filtered.candidate_count).toBe(1);
    expect(filtered.route?.personal_episode_id).toBe('episode-1');

    const ambiguous = await getPersonalEpisodeLookupRoute(engine, {
      title: 'Morning reset',
    });

    expect(ambiguous.selection_reason).toBe('ambiguous_title_match');
    expect(ambiguous.candidate_count).toBe(2);
    expect(ambiguous.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('personal episode lookup route service degrades explicitly when the exact title is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-personal-episode-route-missing-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const result = await getPersonalEpisodeLookupRoute(engine, {
      title: 'Evening reset',
    });

    expect(result.selection_reason).toBe('no_match');
    expect(result.candidate_count).toBe(0);
    expect(result.route).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
