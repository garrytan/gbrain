/**
 * Wave B PR 2 fix lane C2 (D1): conversation facts finish on a segmented page
 * over the window cap whose `raw_transcript` sidecar does not resolve.
 *
 * 1. Protects: such a page parses its own body (the newest window). Once the
 *    run inserts its first fact the prior-fact admission guard would empty the
 *    parser input, so the version token must not hash that input: the
 *    end-of-page recheck finds the page unchanged, the run writes its terminal
 *    row (pages_failed 0), and the next run skips the page as completed
 *    without reading a segment.
 * 2. Fails when: the token hashes the guarded input (the recheck reports the
 *    page as concurrently edited, pages_failed 1, and every later run skips it
 *    for its prior facts without finishing).
 * 3. Why existing coverage misses it: segmented-conversation-facts.test.ts runs
 *    its over-the-window extraction with an extractor that returns no facts.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set. Seams: a
 * readSegmentTexts spy counts segment reads (a work counter, not time).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let dir: string;
const SLUG = 'conversations/huge-sidecar';

/** A dated chat log of about `bytes`, with long turns so the extractor sees a few thousand windows, not tens of thousands. */
function chat(bytes: number): string {
  const sentence = 'We went over the launch budget, the pricing review and the hiring roadmap again. ';
  const parts: string[] = [];
  let size = 0;
  for (let day = 0; size < bytes; day++) {
    parts.push(`## ${new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toISOString().slice(0, 10)}\n\n`);
    for (let turn = 0; turn < 50; turn++) {
      const line = `**${turn % 2 ? 'Alice Example' : 'Bob Example'}** (${9 + Math.floor(turn / 6)}:${String((turn * 10) % 60).padStart(2, '0')} AM): ${sentence.repeat(36)}day ${day} turn ${turn}.\n\n`;
      parts.push(line);
      size += line.length;
    }
  }
  return parts.join('');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'segmented-sidecar-token-'));
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  const file = join(dir, 'huge-sidecar.md');
  writeFileSync(file, `---\ntype: conversation\ntitle: Huge\ndate: 2025-01-01\nraw_transcript: transcripts/missing-example.txt\n---\n\n${chat(PAGE_MAX_BYTES + 2 * 1024 * 1024)}`);
  for (const engine of engines) {
    await engine.setConfig('pages.segmented_storage', 'on');
    expect(await importFromFile(engine, file, `${SLUG}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
  }
}, 900_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('conversation facts on a segmented page over the window with an unresolved sidecar', () => {
  test('the run finishes after inserting facts, and the next run skips it as completed without reading a segment', async () => {
    const outcomes: unknown[] = [];
    const expected: unknown[] = [];
    for (const [index, engine] of engines.entries()) {
      const [page] = await engine.executeRaw<{ body_storage: string; body_bytes: number }>('SELECT body_storage, body_bytes FROM pages WHERE slug=$1', [SLUG]);
      expect(page!.body_storage).toBe('segmented');
      expect(Number(page!.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
      let calls = 0;
      const first = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [SLUG], sleepMs: 0, segmentLimit: 1_000_000,
        extractor: async () => (++calls === 1
          ? [{ fact: 'Alice Example owns the launch budget', kind: 'fact', entity_slug: null, source: 'cli:extract-conversation-facts' }]
          : []) as never });
      const original = engine.readSegmentTexts.bind(engine);
      let segmentReads = 0;
      engine.readSegmentTexts = (async (sourceId: string, shas: Uint8Array[]) => { segmentReads += shas.length; return original(sourceId, shas); }) as BrainEngine['readSegmentTexts'];
      let second: Awaited<ReturnType<typeof runExtractConversationFactsCore>>;
      let secondCalls = 0;
      try {
        second = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [SLUG], sleepMs: 0, segmentLimit: 1_000_000,
          extractor: async () => { secondCalls++; return []; } });
      } finally {
        delete (engine as { readSegmentTexts?: unknown }).readSegmentTexts;
      }
      outcomes.push({ engine: index, firstCalledExtractor: calls > 1, first: { failed: first.pages_failed, processed: first.pages_processed, inserted: first.facts_inserted },
        second: { failed: second.pages_failed, completed: second.pages_skipped_completed, tooLarge: second.pages_skipped_too_large, calls: secondCalls, segmentReads } });
      expected.push({ engine: index, firstCalledExtractor: true, first: { failed: 0, processed: 1, inserted: 1 },
        second: { failed: 0, completed: 1, tooLarge: 0, calls: 0, segmentReads: 0 } });
    }
    expect(outcomes).toEqual(expected);
  }, 1_800_000);
});
