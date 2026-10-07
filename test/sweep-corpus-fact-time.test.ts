/**
 * #6159 — the sweep's corpus pass dates facts by the session file's write
 * time, not by when the (possibly late) sweep ran.
 *
 * Protects: a backdated session file yields facts whose valid_from is the
 * file's day, and the extractor is told that day as the observation date;
 * a file time that cannot be trusted (in the future, or before 2000) falls
 * back to extraction time; the file time stays out of the managed batch key
 * (persistence/facts-maintenance.ts digests validFrom, not turnAt), so it
 * never re-keys a window already tried.
 * Fails when: the corpus pass stamps facts at extraction time again.
 * Hermetic in-memory PGLite + chat-transport stub (sweep.test.ts harness).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { corpusFactTime } from '../src/core/context/corpus-windows.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};
const DAY = 86_400_000;

let engine: PGLiteEngine;
let dir: string;
let prompts: string[];
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-fact-time-'));
  tmpDirs.push(dir);
  await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
  prompts = [];
  __setChatTransportForTests(async (request): Promise<ChatResult> => {
    const content = String(request.messages[0].content);
    prompts.push(content);
    const tag = content.match(/KITEMARK (\w+)/)?.[1];
    const facts = tag
      ? [{ fact: `Keeps the ${tag} checklist in the team wiki`, kind: 'preference', entity: null, confidence: 0.9, notability: 'high' }]
      : [];
    return { text: JSON.stringify({ facts }), blocks: [], stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:test-stub', providerId: 'anthropic' };
  });
});
afterEach(() => { __setChatTransportForTests(null); });

const sweep = () => runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED, budgetMs: 120_000, batchLimit: 20 });
const session = (name: string, mtime: Date): void => {
  const file = join(dir, name);
  writeFileSync(file, toCorpusText([{ role: 'user', text: `KITEMARK ${name.replace(/\W.*/, '')} I keep that checklist in the team wiki.` }]));
  utimesSync(file, mtime, mtime);
};
const factDates = async () => (await engine.executeRaw<{ valid_from: Date }>(
  "SELECT valid_from FROM facts WHERE source = 'sweep:corpus'")).map((r) => new Date(r.valid_from));

describe('corpus fact time (#6159)', () => {
  test('a session file written 8 days ago yields facts dated that day, and the extractor is told so', async () => {
    const written = new Date(Date.now() - 8 * DAY);
    session('backdated.txt', written);
    await sweep();
    const dates = await factDates();
    expect(dates).toHaveLength(1);
    expect(Math.abs(dates[0].getTime() - written.getTime())).toBeLessThan(2_000);
    expect(prompts.join('\n')).toContain(`Observation date: ${written.toISOString().slice(0, 10)}`);
  });

  test('an untrusted file time (future, or before 2000) dates facts at extraction', async () => {
    session('future.txt', new Date(Date.now() + 3 * DAY));
    session('ancient.txt', new Date('1990-01-01T00:00:00Z'));
    const before = Date.now();
    await sweep();
    const dates = await factDates();
    expect(dates).toHaveLength(2);
    for (const d of dates) expect(d.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  });

  test('corpusFactTime accepts a sane file time and rejects the rest with a reason', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(corpusFactTime(now - DAY, now)).toEqual({ at: new Date(now - DAY) });
    expect(corpusFactTime(now + 30_000, now)).toEqual({ at: new Date(now + 30_000) });
    expect(corpusFactTime(now + 61_000, now)).toEqual({ rejected: 'future' });
    expect(corpusFactTime(Date.parse('1999-12-31T23:59:59Z'), now)).toEqual({ rejected: 'before_2000' });
    expect(corpusFactTime(Number.NaN, now)).toEqual({ rejected: 'invalid' });
  });
});
