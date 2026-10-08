/**
 * #6260: extract_atoms reads the gateway stop reason before it trusts a
 * response. A response stopped by the output cap, a refusal or a content
 * filter is never parsed: it is a counted failure (the bounded 3-strike
 * streak), never a zero-yield stamp and never published atoms. `other` and
 * `tool_calls` (some local providers report a normal end as `other`) are
 * parsed, but their empty answer is a counted failure, never a zero-yield
 * stamp.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MAX_DETERMINISTIC_FAILURES } from '../../src/core/cycle/extract-atoms.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from '../helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const HASH = 'c'.repeat(16);
const ATOMS = JSON.stringify([{ title: 'A durable insight', atom_type: 'insight', body: 'The insight body prose.', concepts: [] }]);

function reply(text: string, stopReason: ChatResult['stopReason']): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  } as ChatResult;
}

async function seed(slug: string): Promise<void> {
  await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: 'seed body prose' } as never, { sourceId: 'default' });
}

async function state(slug: string) {
  const [row] = await engine.executeRaw<{ fail_count: number; tombstoned: boolean }>(
    `SELECT scan.fail_count, scan.tombstoned FROM extract_atoms_page_state scan JOIN pages p ON p.id=scan.page_id
      WHERE p.source_id='default' AND p.slug=$1 AND scan.content_hash=p.content_hash`, [slug]);
  return row;
}

async function atomCount(): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE type='atom' AND deleted_at IS NULL`);
  return Number(row?.n ?? 0);
}

function run(slug: string, chat: (o: ChatOpts) => Promise<ChatResult>) {
  return runPhaseExtractAtoms(engine, {
    sourceId: 'default', _transcripts: [],
    _pages: [{ slug, content: 'seed body prose', contentHash: HASH }],
    _chat: chat,
  });
}

describe('extract_atoms stop reasons (#6260)', () => {
  test('length: a complete-looking atom array is not published and the page is not stamped; an end rerun extracts', async () => {
    await seed('note/clipped');
    const first = await run('note/clipped', async () => reply(ATOMS, 'length'));
    expect(first.details.stopped_outputs).toBe(1);
    expect(await atomCount()).toBe(0);
    expect((await state('note/clipped'))?.tombstoned).toBe(false);
    expect((await state('note/clipped'))?.fail_count).toBe(1);
    const second = await run('note/clipped', async () => reply(ATOMS, 'end'));
    expect(second.details.pages_processed).toBe(1);
    expect(await atomCount()).toBe(1);
  });

  test('length: an empty array is never a zero-yield stamp', async () => {
    await seed('note/clipped-empty');
    await run('note/clipped-empty', async () => reply('[]', 'length'));
    expect((await state('note/clipped-empty'))?.tombstoned).toBe(false);
  });

  for (const stop of ['refusal', 'content_filter'] as const) {
    test(`${stop}: counts toward the ${MAX_DETERMINISTIC_FAILURES}-strike bound, then tombstones`, async () => {
      const slug = `note/${stop}`;
      await seed(slug);
      let calls = 0;
      const chat = async () => { calls++; return reply('[]', stop); };
      for (let i = 1; i < MAX_DETERMINISTIC_FAILURES; i++) {
        const r = await run(slug, chat);
        expect(r.details.tombstoned_for_failures).toEqual([]);
        expect((await state(slug))?.fail_count).toBe(i);
      }
      const last = await run(slug, chat);
      expect(last.details.tombstoned_for_failures).toEqual([slug]);
      expect(calls).toBe(MAX_DETERMINISTIC_FAILURES);
    });
  }

  for (const stop of ['other', 'tool_calls'] as const) {
    test(`${stop}: atoms are kept, but an empty answer is a counted failure, not a zero-yield stamp`, async () => {
      await seed(`note/${stop}-empty`);
      const empty = await run(`note/${stop}-empty`, async () => reply('[]', stop));
      expect(empty.details.stopped_outputs).toBe(1);
      expect(await state(`note/${stop}-empty`)).toEqual({ fail_count: 1, tombstoned: false });
      await seed(`note/${stop}-atoms`);
      const full = await run(`note/${stop}-atoms`, async () => reply(ATOMS, stop));
      expect(full.details.pages_processed).toBe(1);
      expect(await atomCount()).toBe(1);
    });
  }

  test('transcripts: a length stop leaves the transcript rediscoverable', async () => {
    const r = await runPhaseExtractAtoms(engine, {
      sourceId: 'default', _pages: [],
      _transcripts: [{ filePath: '/synthetic/2026-01-01-chat.txt', content: 'a chat', contentHash: 'd'.repeat(64) }],
      _chat: async () => reply('[]', 'length'),
    });
    expect(r.details.stopped_outputs).toBe(1);
    expect(r.details.tombstoned_transcripts).toEqual([]);
    const rows = await engine.executeRaw<{ tombstoned: boolean }>(`SELECT tombstoned FROM extract_atoms_transcript_state`);
    expect(rows.every((row) => row.tombstoned === false)).toBe(true);
  });
});
