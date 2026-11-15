/**
 * GST-2768 PR 3 (decision A): the one-time upgrade notice for the conversation archive default. Its row is
 * behavior-changes.d/transcript_archive_default_gst2768.md, delivered by the existing behavior_changes notice and its
 * per-channel markers (no new sentinel): an existing brain sees it once, with the off command; a shared brain reads
 * the offer (the on command) and the notice never turns anything on. PGLite.
 *
 * Before a release dates the row, the test adds it to the loaded table for the duration of the file (dated at the
 * newest disclosed release, so the notice id is unchanged) and removes it afterwards; once a release has dated it, the
 * table already holds it and the test adds nothing. The release also folds the changelog fragment into CHANGELOG.md,
 * so the marker is read from whichever of the two holds it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  BEHAVIOR_CHANGES, BEHAVIOR_NOTICE_SINCE, __resetBehaviorNoticeForTests, takeLocalBehaviorNotice,
} from '../src/core/behavior-change-notice.ts';
import { ARCHIVE_ENABLED_KEY } from '../src/core/transcripts/archive.ts';
import { resolveArchiveEnabled } from '../src/core/transcripts/archive-default.ts';
import { withEnv } from './helpers/with-env.ts';

const ID = 'transcript_archive_default_gst2768';
const ROOT = join(import.meta.dir, '..');
const text = readFileSync(join(ROOT, 'behavior-changes.d', ID + '.md'), 'utf8').trim();
const table = BEHAVIOR_CHANGES as Array<{ since: string; id?: string; text: unknown }>;
const NO_CHAIN = { GBRAIN_CHAT_FALLBACK_CHAIN: undefined, GBRAIN_CHAT_FALLBACK_ON_REFUSAL: undefined };

let engine: PGLiteEngine;
let pushed = false;

function upgradedHome(brainKey: string): string {
  const home = mkdtempSync(join(tmpdir(), 'archive-notice-'));
  const dir = join(home, '.gbrain', 'notices', 'behavior-changes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, brainKey + '.baseline'), '0.59.0.0\n');
  return home;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  if (!table.some(row => row.id === ID)) {
    table.push({ since: BEHAVIOR_NOTICE_SINCE, id: ID, text });
    pushed = true;
  }
});

afterAll(async () => {
  if (pushed) {
    const at = table.findIndex(row => row.id === ID);
    if (at >= 0) table.splice(at, 1);
  }
  await engine.disconnect();
});

describe('the conversation archive upgrade notice', () => {
  test('the row says what is archived, where, what leaves the machine, the held backfill and the off command', () => {
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).not.toContain('\n');
    for (const phrase of ['gbrain transcripts archive off', 'conversations', 'gbrain embed --held --dry-run', 'keyless', 'gbrain transcripts archive on']) expect(text).toContain(phrase);
    const fragmentPath = join(ROOT, 'changelog.d', 'transcript-archive-default.md');
    const entry = readFileSync(existsSync(fragmentPath) ? fragmentPath : join(ROOT, 'CHANGELOG.md'), 'utf8');
    expect(entry).toContain('<!-- behavior-change: ' + ID + ' -->');
  });

  test('an upgraded brain sees it once, with the off command', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const home = upgradedHome('archive-personal');
    await withEnv({ GBRAIN_HOME: home, ...NO_CHAIN }, async () => {
      __resetBehaviorNoticeForTests();
      const first = await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'archive-personal' });
      expect(first?.code).toBe('behavior_changes');
      expect(first!.why).toContain('gbrain transcripts archive off');
      expect(await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'archive-personal' })).toBeNull();
      __resetBehaviorNoticeForTests();
      expect(await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'archive-personal' })).toBeNull();
    });
    expect((await resolveArchiveEnabled(engine, { config: null })).enabled).toBe(true);
  }, 60_000);

  test('a shared brain reads the offer and is not turned on', async () => {
    await engine.setConfig('brain.audience', 'shared');
    const home = upgradedHome('archive-shared');
    await withEnv({ GBRAIN_HOME: home, ...NO_CHAIN }, async () => {
      __resetBehaviorNoticeForTests();
      const notice = await takeLocalBehaviorNotice(engine, 'cli', { cfg: null, brainKey: 'archive-shared' });
      expect(notice!.why).toMatch(/shared[^.]*gbrain transcripts archive on/);
    });
    expect(await resolveArchiveEnabled(engine, { config: null })).toMatchObject({ enabled: false, offered: true });
    expect(await engine.getConfig(ARCHIVE_ENABLED_KEY)).toBeNull();
  }, 60_000);
});
