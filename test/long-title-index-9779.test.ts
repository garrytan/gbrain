/**
 * #9779 on PGLite: page titles of any length are indexed, saved and migrated,
 * and transcript imports cap the titles they make. The Postgres twin is
 * test/e2e/long-title-index-9779-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { withColdPglite } from './helpers/with-snapshot.ts';
import { renderSessionParts, TRANSCRIPT_TITLE_MAX_CHARS } from '../src/core/transcripts/render.ts';
import type { RedactedSession } from '../src/core/transcripts/render.ts';
import { expectReplacementPastV240, expectUpgradeFromBeforeV240, incompressibleTitle } from './helpers/long-title-index.ts';

// Each scenario rewinds the schema version, so each gets its own brain, connected
// cold: a snapshot-restored brain does not replay migrations after a rewind.
describe('long page titles before v240 (#9779, PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await withColdPglite(async () => { await engine.connect({}); await engine.initSchema(); });
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); }, 60_000);

  test('a brain before v240 holding 3,000-byte and 100 KB titles upgrades, and the pages are found by title through the index', async () => {
    await expectUpgradeFromBeforeV240(engine);
  }, 120_000);
});

describe('long page titles past v240 (#9779, PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await withColdPglite(async () => { await engine.connect({}); await engine.initSchema(); });
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); }, 60_000);

  test('a brain with the old title btree gets the hash index, then saves a 3,000-byte title; a rerun changes nothing', async () => {
    await expectReplacementPastV240(engine);
  }, 120_000);
});

describe('transcript titles (#9779)', () => {
  const session = (title: string): RedactedSession => ({
    session: {
      meta: { harness: 'claude-code', sessionId: 'session-alice-example-0001', title, startedAt: '2026-01-02T03:04:05Z' },
      messages: [{ role: 'user', timestamp: '2026-01-02T03:04:05Z', text: 'Hello.' }],
    },
    imperativesFlagged: 0,
    redactionCount: 0,
  } as unknown as RedactedSession);
  const titleOf = (opts: { existing?: boolean }, title: string) =>
    parseMarkdown(renderSessionParts(session(title), { sourcePath: '', ...opts }).parts[0]!.content).title;

  test('a new page gets at most 200 characters, cut at a codepoint and ending in an ellipsis', () => {
    const long = '😀' + incompressibleTitle(5_000, 4).replace(/ /g, 'x');
    const title = titleOf({}, long);
    expect([...title].length).toBe(TRANSCRIPT_TITLE_MAX_CHARS);
    expect(title.endsWith('…')).toBe(true);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(titleOf({}, 'Short session title')).toBe('Short session title');
  });

  test('a session whose page already exists keeps its title as given', () => {
    const long = incompressibleTitle(5_000, 5).replace(/ /g, 'x');
    expect(titleOf({ existing: true }, long)).toBe(long);
  });
});
