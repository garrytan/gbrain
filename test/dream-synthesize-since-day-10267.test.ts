/**
 * #10267 review: a day-only transcript date covers its whole UTC day, so a session dated on the cutoff day stays a
 * candidate under a mid-day `dream.synthesize.since`, and the day before stays out. Repo-less PGLite and a temp corpus.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { ensureCorpusSpoolDir, wbFileName } from '../src/core/context/corpus-segments.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { discoverConversationPages, discoverTranscripts } from '../src/core/cycle/transcript-discovery.ts';

const sinceMs = Date.parse('2026-09-02T12:00:00Z');
const BODY = 'A synthetic session about acme-example widgets and their rollout plan. '.repeat(4);
let engine: PGLiteEngine;
let corpus: string;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  corpus = mkdtempSync(join(tmpdir(), 'gbrain-since-day-'));
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(corpus, { recursive: true, force: true }); });

test('conversation pages dated on the cutoff day stay candidates; the day before does not', async () => {
  for (const [slug, date] of [['sessions/same-day', '2026-09-02'], ['sessions/day-before', '2026-09-01'], ['sessions/before-noon', '2026-09-02T11:00:00Z']]) {
    await engine.putPage(slug!, { type: 'conversation', title: slug!, compiled_truth: BODY, frontmatter: { date } });
  }
  const found = await discoverConversationPages(engine, { sourceId: 'default', minChars: 20, sinceMs });
  expect(found.map(t => t.basename).sort()).toEqual(['same-day']);
});

test('corpus files named for the cutoff day stay candidates; the day before does not', () => {
  writeFileSync(join(corpus, '2026-09-02-same-day.txt'), BODY);
  writeFileSync(join(corpus, '2026-09-01-day-before.txt'), BODY);
  const found = discoverTranscripts({ corpusDir: corpus, minChars: 20, sinceMs });
  expect(found.map(t => t.basename).sort()).toEqual(['2026-09-02-same-day']);
});

test('under a cutoff an undated file counts by modification time only when gbrain spooled it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-since-undated-'));
  try {
    writeFileSync(join(dir, 'copied-session.txt'), BODY);
    writeFileSync(join(ensureCorpusSpoolDir(dir), wbFileName('spooled-session', '3'.repeat(24), 'default')), BODY);
    const found = discoverTranscripts({ corpusDir: dir, minChars: 20, sinceMs: Date.now() - 60_000 });
    expect(found.map(t => t.basename)).toEqual([expect.stringContaining('spooled-session')]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
