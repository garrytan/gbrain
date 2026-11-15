/**
 * GST-2768 PR 2 (planned PR 3 test, moved here by the review split): adopt-legacy reads an old archive folder's day
 * files, lists the days it covers per harness, and with --apply marks them covered so backfill writes only the
 * missing days. The dry run writes nothing, and the old files are never changed. Repo-less PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_TIMEZONE_KEY, adoptLegacyArchive, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { archivedPages, conversation, ledgerRows, staticReader } from './helpers/transcript-archive.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'archive-adopt-'));
  mkdirSync(join(dir, 'claude-code'));
  writeFileSync(join(dir, '2026-10-01.md'), '# chats of the day\n');
  writeFileSync(join(dir, 'claude-code', '2026-10-02-session.md'), '# a claude code day\n');
  writeFileSync(join(dir, 'notes.md'), '---\ndate: 2026-10-03\nharness: claude-code\n---\n# dated by frontmatter\n');
  writeFileSync(join(dir, 'readme.txt'), 'not a day file');
});

const sessions = () => staticReader('claude-code', ['01', '02', '03', '04', '05'].map(d =>
  conversation('claude-code', `session-${d}`, [['user', `2026-10-${d}T12:00:00.000Z`, `work on the ${d}th`]])));

describe('adopt-legacy (pglite)', () => {
  test('dry run lists covered days and writes nothing; apply marks them; backfill skips them and writes the rest', async () => {
    try {
      await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
      await setArchiveEnabled(engine, true);
      const mtime = statSync(join(dir, 'notes.md')).mtimeMs;
      const configBefore = await ledgerRows(engine);
      const preview = await adoptLegacyArchive(engine, { dir, apply: false });
      expect(preview.applied).toBe(false);
      expect(preview.covered).toEqual([
        { harness: '*', day: '2026-10-01', file: '2026-10-01.md' },
        { harness: 'claude-code', day: '2026-10-02', file: 'claude-code/2026-10-02-session.md' },
        { harness: 'claude-code', day: '2026-10-03', file: 'notes.md' },
      ]);
      expect(await ledgerRows(engine)).toEqual(configBefore);

      const applied = await adoptLegacyArchive(engine, { dir, apply: true });
      expect(applied.applied).toBe(true);
      const result = await runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-05', readers: [sessions()], now: new Date('2026-10-20T00:00:00Z') });
      expect(result.days.filter(d => d.status === 'skipped_legacy').map(d => d.day).sort()).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
      expect((await archivedPages(engine)).filter(p => p.slug.startsWith('conversations/claude-code/')).map(p => p.slug.split('/')[2])).toEqual(['2026-10-04', '2026-10-05']);
      expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('dated by frontmatter');
      expect(statSync(join(dir, 'notes.md')).mtimeMs).toBe(mtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
