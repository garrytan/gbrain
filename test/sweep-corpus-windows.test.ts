import { beforeAll, afterAll, beforeEach, afterEach, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { extractCorpusWindows, corpusContentHash } from '../src/core/context/corpus-progress.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let dir: string;
const dirs: string[] = [];
let inputs: string[];
let failAt: number;
const sweep = () => runMaintenanceSweep(engine, {
  sourceId: 'default', budgetMs: 30_000,
  capabilities: { embeddings: { available: false }, extraction: { available: true }, search: 'keyword-only', mode: 'keyed' },
});
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-corpus-windows-'));
  dirs.push(dir);
  await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
  await engine.setConfig('facts.extraction_model', 'ollama:fixture');
  await engine.executeRaw('DELETE FROM facts');
  configureGateway({ env: {} });
  inputs = [];
  failAt = -1;
  __setChatTransportForTests(async (request): Promise<ChatResult> => {
    const content = String(request.messages[0].content);
    const text = content.slice(content.indexOf('<turn>\n') + 7, content.indexOf('\n</turn>'));
    inputs.push(text);
    if (inputs.length === failAt) throw new Error('fixture transport failure');
    const fact = text.includes('TAIL_MARKER') ? 'Prefers a quiet office for focused work.' : 'Prefers tea during morning meetings.';
    return { text: JSON.stringify({ facts: [{ fact, kind: 'preference', entity: null, confidence: 1, notability: 'high' }] }),
      blocks: [], stopReason: 'end', model: 'ollama:fixture', providerId: 'ollama',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } };
  });
});
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });
const head = 'User: ordinary conversation about morning meetings.\n'.repeat(180);

test('extracts the entire long corpus and persists facts beyond the 8000-character head', async () => {
  const raw = head + 'User: TAIL_MARKER I prefer a quiet office for focused work.\n';
  writeFileSync(join(dir, 'session.txt'), raw);
  expect((await sweep()).corpusIngested).toBe(1);
  expect(inputs.length).toBeGreaterThan(1);
  expect(inputs.every(t => t.length <= 8000)).toBe(true);
  expect(inputs.join('\n')).toContain('TAIL_MARKER');
  const facts = await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts');
  expect(facts.some(r => r.fact.includes('quiet office'))).toBe(true);
  const calls = inputs.length;
  await sweep();
  expect(inputs.length).toBe(calls);
});

test('append-only resume extracts only new text after hook invalidates completion', async () => {
  const file = join(dir, 'session.txt');
  writeFileSync(file, head);
  await sweep();
  inputs = [];
  writeFileSync(file, head + 'User: TAIL_MARKER I prefer a quiet office for focused work.\n');
  rmSync(file + '.ingested');
  expect((await sweep()).corpusIngested).toBe(1);
  expect(inputs).toEqual(['User: TAIL_MARKER I prefer a quiet office for focused work.']);
});

test('transport failure retains completed windows but not a terminal sidecar', async () => {
  const file = join(dir, 'session.txt');
  writeFileSync(file, head + 'User: TAIL_MARKER I prefer a quiet office for focused work.\n');
  failAt = 2;
  expect((await sweep()).corpusIngested).toBe(0);
  expect(existsSync(file + '.ingested')).toBe(false);
  const first = inputs[0];
  inputs = [];
  failAt = -1;
  expect(JSON.parse(readFileSync(file + '.progress', 'utf8')).offset).toBeGreaterThan(0);
  expect((await sweep()).corpusIngested).toBe(1);
  expect(inputs).not.toContain(first);
  expect(inputs.join('\n')).toContain('TAIL_MARKER');
});

test('changed prefix invalidates progress rather than skipping replacement content', async () => {
  const file = join(dir, 'session.txt');
  writeFileSync(file, head);
  await sweep();
  inputs = [];
  writeFileSync(file, 'User: TAIL_MARKER replaced transcript with a new quiet office preference.\n');
  rmSync(file + '.ingested');
  await sweep();
  expect(inputs.join('\n')).toContain('replaced transcript');
});

test('a completion marker raced onto a rewritten transcript cannot hide its appended tail', async () => {
  const file = join(dir, 'session.txt');
  writeFileSync(file, head);
  await sweep();
  const oldMarker = readFileSync(file + '.ingested', 'utf8');
  inputs = [];
  writeFileSync(file, head + 'User: TAIL_MARKER I prefer a quiet office for focused work.\n');
  // Model the hook deleting completion, then a sweep writing its stale marker.
  writeFileSync(file + '.ingested', oldMarker);
  expect((await sweep()).corpusIngested).toBe(1);
  expect(inputs).toEqual(['User: TAIL_MARKER I prefer a quiet office for focused work.']);
});

test('Unicode windows preserve every character and never split astral code points', async () => {
  const raw = 'x'.repeat(7999) + '😀' + 'y'.repeat(8000);
  const windows: string[] = [];
  await extractCorpusWindows(join(dir, 'unicode.txt'), raw, 'default', async text => {
    windows.push(text);
    return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [] };
  }, () => false, new AbortController().signal);
  expect(windows.join('')).toBe(raw);
  expect(windows.every(text => text.length <= 8000 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text))).toBe(true);
});

test('budget interruption resumes without repaying a completed window and retains entity links', async () => {
  const file = join(dir, 'budget.txt');
  const raw = 'x'.repeat(16001);
  let calls = 0;
  const extract = async () => {
    calls++;
    return { inserted: 1, duplicate: 0, superseded: 0, fact_ids: [calls], entity_slugs: [`people/example-${calls}`] };
  };
  expect(await extractCorpusWindows(file, raw, 'default', extract, () => calls === 1, new AbortController().signal)).toBeNull();
  expect(calls).toBe(1);
  const result = await extractCorpusWindows(file, raw, 'default', extract, () => false, new AbortController().signal);
  expect(calls).toBe(3);
  expect(result?.inserted).toBe(3);
  expect(result?.entity_slugs).toContain('people/example-1');
});

test('an aborted pipeline window is not checkpointed even when it returns partial results', async () => {
  const file = join(dir, 'abort.txt');
  const control = new AbortController();
  expect(await extractCorpusWindows(file, 'x'.repeat(9000), 'default', async () => {
    control.abort();
    return { inserted: 1, duplicate: 0, superseded: 0, fact_ids: [1], entity_slugs: [] };
  }, () => false, control.signal)).toBeNull();
  expect(existsSync(file + '.progress')).toBe(false);
});

test('a non-transport skip retires only its window, not the remaining transcript', async () => {
  const file = join(dir, 'skip.txt');
  let calls = 0;
  const result = await extractCorpusWindows(file, 'x'.repeat(9000), 'default', async () => {
    calls++;
    return { inserted: calls === 1 ? 0 : 1, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [], ...(calls === 1 ? { skipped_reason: 'refusal' as const } : {}) };
  }, () => false, new AbortController().signal);
  expect(calls).toBe(2);
  expect(result?.inserted).toBe(1);
  expect(result?.skipped_reason).toBe('refusal');
});

test('invalid or foreign-source checkpoints replay safely', async () => {
  const file = join(dir, 'invalid.txt');
  const raw = 'User: new transcript';
  for (const saved of ['null', '{broken', JSON.stringify({ source_id: 'other', offset: raw.length, prefix_hash: corpusContentHash(raw), inserted: 0, duplicate: 0, entity_slugs: [] })]) {
    writeFileSync(file + '.progress', saved);
    const texts: string[] = [];
    await extractCorpusWindows(file, raw, 'default', async text => {
      texts.push(text);
      return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [] };
    }, () => false, new AbortController().signal);
    expect(texts).toEqual([raw]);
  }
});

test('upstream pasted-block filtering runs before windows and preserves new user turns on resume', async () => {
  const file = join(dir, 'paste.txt');
  const raw = '[user]\n' + head + '<pasted_content id="7">\n' + 'PASTED_MARKER third-party text. '.repeat(500) + '</pasted_content id="7">\n';
  writeFileSync(file, raw);
  await sweep();
  expect(inputs.length).toBeGreaterThan(1);
  expect(inputs.join('\n')).not.toContain('PASTED_MARKER');
  expect(readFileSync(file, 'utf8')).toBe(raw);
  inputs = [];
  writeFileSync(file, raw + '\n[user]\nTAIL_MARKER I prefer a quiet office for focused work.\n');
  rmSync(file + '.ingested');
  expect((await sweep()).corpusIngested).toBe(1);
  expect(inputs.join('\n')).toContain('TAIL_MARKER');
  expect(inputs.join('\n')).not.toContain('ordinary conversation');
});
