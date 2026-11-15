/**
 * GST-2768 PR 2, Critical review fix 1: a brain that already holds per-session pages for a session gets day pages in
 * their own slug and id namespace, and every legacy page keeps its slug, revision and content. A later per-session
 * ingest of the same session is unaffected too. Repo-less PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

let engine: PGLiteEngine;

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
});

const SID = 'legacy-session-0001';
const TURNS: Array<['user' | 'assistant', string, string]> = [
  ['user', '2026-10-20T10:00:00.000Z', 'first day question'],
  ['assistant', '2026-10-20T10:01:00.000Z', 'first day answer'],
  ['user', '2026-10-21T10:00:00.000Z', 'second day question'],
];

function sessionFile(dir: string): string {
  const path = join(dir, `${SID}.jsonl`);
  const lines = [{ type: 'session', version: 4, id: SID, timestamp: TURNS[0]![1], cwd: '/home/alice-example/project-a' },
    ...TURNS.map(([role, timestamp, text]) => ({ type: 'message', timestamp, message: { role, content: [{ type: 'text', text }] } }))];
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('day pages beside legacy per-session pages (pglite)', () => {
  test('archive writes day pages and leaves every legacy page untouched, in either order of runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-legacy-'));
    try {
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('conversations', 'conversations') ON CONFLICT (id) DO NOTHING");
      const path = sessionFile(dir);
      const ingest = await runTranscriptsIngest(engine, { paths: [path], sourceId: 'conversations' });
      expect(ingest.sessionsImported).toBe(1);
      const legacyBefore = (await archivedPages(engine)).filter(p => p.slug.startsWith('conversations/sessions/'));
      expect(legacyBefore.length).toBe(1);

      await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
      await setArchiveEnabled(engine, true);
      const result = await runTranscriptArchive(engine, {
        mode: 'backfill', from: '2026-10-19', to: '2026-10-22', readers: [staticReader('openclaw', [conversation('openclaw', SID, TURNS)])],
        now: new Date('2026-10-30T00:00:00Z'),
      });
      expect(result.written).toBe(2);
      const after = await archivedPages(engine);
      const legacyAfter = after.filter(p => p.slug.startsWith('conversations/sessions/'));
      expect(legacyAfter).toEqual(legacyBefore);
      const dayIds = after.filter(p => p.slug.startsWith('conversations/openclaw/')).map(p => String(p.frontmatter.id));
      expect(dayIds.length).toBe(2);
      for (const id of dayIds) expect(legacyBefore.map(p => p.frontmatter.id)).not.toContain(id);

      const again = await runTranscriptsIngest(engine, { paths: [path], sourceId: 'conversations' });
      expect(again.pages.imported).toBe(0);
      expect(await archivedPages(engine)).toEqual(after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
