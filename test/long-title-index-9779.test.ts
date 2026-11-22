/**
 * #9779 on PGLite: page titles of any length are indexed, saved and migrated,
 * and transcript imports cap the titles they make. The Postgres twin is
 * test/e2e/long-title-index-9779-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { withColdPglite } from './helpers/with-snapshot.ts';
import { renderSessionParts, TRANSCRIPT_TITLE_MAX_CHARS } from '../src/core/transcripts/render.ts';
import type { RedactedSession } from '../src/core/transcripts/render.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { v326 } from '../src/core/schema-migrations/v326-pages-title-lower-hash-index.ts';
import { expectFreshBrainHasTitleIndex, expectReplacementPastV240, expectReplayBuildsNoTitleIndex, expectUpgradeFromBeforeV240, incompressibleTitle } from './helpers/long-title-index.ts';

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

describe('the title index is the migrations\' alone (#9779, PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await withColdPglite(async () => { await engine.connect({}); await engine.initSchema(); });
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); }, 60_000);

  test('a fresh brain has the index, valid', async () => {
    await expectFreshBrainHasTitleIndex(engine);
  });

  test('a boot that replays schema.sql on an existing brain builds no title index', async () => {
    await expectReplayBuildsNoTitleIndex(engine);
  }, 120_000);
});

test('v326 fails, without dropping the old btree, while another session still builds the hash index (#9779)', async () => {
  const statements: string[] = [];
  const engine = {
    kind: 'postgres',
    executeRaw: async (sql: string) => {
      statements.push(sql);
      return sql.includes('pg_stat_progress_create_index') ? [{ valid: false, building: true }] : [];
    },
    runMigration: async (_version: number, sql: string) => { statements.push(sql); },
  } as unknown as BrainEngine;
  await expect(v326.handler!(engine)).rejects.toThrow('idx_pages_title_lower_hash is being built by another session');
  expect(statements.some(sql => sql.includes('DROP INDEX'))).toBe(false);
});

describe('transcript re-imports (#9779, PGLite)', () => {
  let engine: PGLiteEngine;
  let tmp: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    tmp = mkdtempSync(join(tmpdir(), 'gb-long-title-reimport-'));
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(tmp, { recursive: true, force: true }); }, 60_000);

  test('a page written under the cap stays capped, and a page stored with a longer title keeps it', async () => {
    const name = 'alice-example long session '.repeat(20).trim();
    const path = join(tmp, 'conversations.json');
    const importWith = async (messages: number) => {
      writeFileSync(path, JSON.stringify([{ uuid: 'long-title-1', name, created_at: '2026-08-01T10:00:00Z',
        chat_messages: Array.from({ length: messages }, (_, i) => ({
          uuid: `m${i}`, sender: i % 2 ? 'assistant' : 'human', created_at: `2026-08-01T10:00:0${i}Z`, text: `message ${i}` })) }]));
      const result = await runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', format: 'claude-export' });
      expect(result.sessionsImported).toBe(1);
      const rows = await engine.executeRaw<{ slug: string; title: string }>('SELECT slug, title FROM pages WHERE deleted_at IS NULL');
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };
    const first = await importWith(2);
    expect([...first.title].length).toBe(TRANSCRIPT_TITLE_MAX_CHARS);
    expect((await importWith(4)).title).toBe(first.title);
    await engine.executeRaw('UPDATE pages SET title = $1 WHERE slug = $2', [name, first.slug]);
    expect((await importWith(6)).title).toBe(name);
  }, 120_000);
});

describe('split transcript re-imports (#9779, PGLite)', () => {
  let engine: PGLiteEngine;
  let tmp: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('content_sanity.bytes_block', '60000');
    tmp = mkdtempSync(join(tmpdir(), 'gb-long-title-split-'));
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(tmp, { recursive: true, force: true }); }, 60_000);

  test('every part of a split session is titled at most 200 characters with its part suffix, and stays so on re-import', async () => {
    const name = 'bob-example split session '.repeat(20).trim();
    const path = join(tmp, 'conversations.json');
    const importWith = async (messages: number) => {
      writeFileSync(path, JSON.stringify([{ uuid: 'long-title-split-1', name, created_at: '2026-08-01T10:00:00Z',
        chat_messages: Array.from({ length: messages }, (_, i) => ({
          uuid: `m${i}`, sender: i % 2 ? 'assistant' : 'human', created_at: `2026-08-01T10:00:0${i}Z`, text: `message ${i} ` + incompressibleTitle(30_000, 10 + i) })) }]));
      await runTranscriptsIngest(engine, { paths: [path], sourceId: 'default', format: 'claude-export' });
      return engine.executeRaw<{ slug: string; title: string }>('SELECT slug, title FROM pages WHERE deleted_at IS NULL ORDER BY slug');
    };
    const first = await importWith(3);
    expect(first.length).toBeGreaterThan(1);
    first.forEach((row, i) => {
      expect([...row.title].length).toBeLessThanOrEqual(TRANSCRIPT_TITLE_MAX_CHARS);
      expect(row.title.endsWith(` (part ${i + 1})`)).toBe(true);
    });
    const again = await importWith(4);
    expect(again.slice(0, first.length).map(r => r.title)).toEqual(first.map(r => r.title));
    for (const row of again) expect([...row.title].length).toBeLessThanOrEqual(TRANSCRIPT_TITLE_MAX_CHARS);
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
