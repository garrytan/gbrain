/**
 * The conversation archive on a writer-claimed (managed) brain, through the real put_page write gate: a day label that
 * used to end in a hyphen (a cron job name cut at 24 characters right after a hyphen) is refused there with
 * slug_hyphen_run. Every archive slug now passes the gate, the day archives, and a dry run names the coordinator write
 * path the real run takes. Same harness as test/transcripts-archive-managed.test.ts; every value is synthetic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeContext } from '../src/cli/main.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

beforeEach(async () => {
  await stopPersistenceConsumer(engine);
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-managed-archive-slug-'));
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await engine.setConfig('brain.audience', 'personal');
  await setArchiveEnabled(engine, true);
  await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
  await withEnv({ GBRAIN_HOME: dir }, () => registerLocalWriter(engine, 'cli'));
  return () => rmSync(dir, { recursive: true, force: true });
});

/** 'aaa-' six times is 24 characters, so the old 24-character cut ended the label in a hyphen. */
const CRON = 'aaa-bbb-ccc-ddd-eee-fff-ggg-hhh';
const readers = () => [staticReader('openclaw', [conversation('openclaw', 'session-cron-1', [
  ['user', '2026-10-01T10:00:00.000Z', 'scheduled prompt'], ['assistant', '2026-10-01T10:01:00.000Z', 'scheduled answer'],
], { chatType: 'direct', verified: true, cronJob: CRON })])];

function archive(dryRun = false) {
  return withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () =>
    runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-02', readers: readers(), dryRun,
      makeContext: source => makeContext(engine, { source, dry_run: false }), now: new Date('2026-10-10T00:00:00Z') }));
}

describe('archive slugs through the managed write gate', () => {
  test('a dry run names the coordinator write path, before the archive source exists', async () => {
    expect((await engine.executeRaw("SELECT 1 FROM sources WHERE id = 'conversations'")).length).toBe(0);
    const preview = await archive(true);
    expect(preview.write_mode).toBe('coordinator');
    expect(preview.planned).toBe(1);
    const run = await archive();
    expect(run.write_mode).toBe(preview.write_mode);
  }, 120_000);

  test('a cron day whose label was cut after a hyphen archives, with no hyphen run in its slug', async () => {
    const result = await archive();
    expect(result.errors).toEqual([]);
    expect(result.days.map(d => [d.day, d.status])).toEqual([['2026-10-01', 'written']]);
    const slugs = (await archivedPages(engine)).map(p => p.slug).filter(s => s.startsWith('conversations/openclaw/'));
    expect(slugs).toHaveLength(1);
    expect(slugs[0]).toMatch(/^conversations\/openclaw\/2026-10-01\/cron-aaa-bbb-ccc-ddd-eee-fff-[0-9a-f]{8}$/);
  }, 120_000);
});
