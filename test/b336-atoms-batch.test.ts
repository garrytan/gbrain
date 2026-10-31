import { expect, test } from 'bun:test';
import { AtomBatchTransport, parseAtomBatch, resolveAtomBatchSize, splitAtomInput } from '../src/core/cycle/extract-atoms-batch.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
const reply = (text: string, stopReason = 'end') => ({ text, stopReason } as ChatResult);
const work = Array.from({ length: 8 }, (_, i) => ({ i }));
const input = (item: { i: number }) => ({ key: String(item.i), system: 'extract independently', message: 'source-' + item.i });
test('batching stays off unless explicitly configured with a valid bounded size', () => {
  for (const raw of [null, '', '0', '-1', '9', 'NaN', '2.5']) expect(resolveAtomBatchSize(raw)).toBe(1);
  expect(resolveAtomBatchSize('8')).toBe(8);
});
test('eight inputs make exactly one metered call, preserve every result and per-source identity', async () => {
  const calls: ChatOpts[] = [];
  const batch = new AtomBatchTransport(work, 8, async x => input(x), async opts => {
    calls.push(opts);
    return reply(JSON.stringify({ results: work.map((_, i) => ({ id: 'case-' + i, atoms: [{ title: 'own-' + i }] })).reverse() }));
  }, { model: 'claude-cli:claude-haiku-5-5', maxTokens: 4096 });
  for (const item of work) expect(JSON.parse((await batch.read(item, input(item))).text).atoms[0].title).toBe('own-' + item.i);
  expect(calls.length).toBe(1); expect(calls[0]!.maxTokens).toBe(32768);
  expect(calls[0]!.model).toBe('claude-cli:claude-haiku-5-5');
});
test('missing, duplicate or extra identities fail before any response can mark a source complete', () => {
  for (const results of [[], [{ id: 'a', atoms: [] }], [{ id: 'a', atoms: [] }, { id: 'a', atoms: [] }],
    [{ id: 'a', atoms: [] }, { id: 'foreign', atoms: [] }]])
    expect(() => parseAtomBatch(JSON.stringify({ results }), ['a', 'b'])).toThrow();
  expect(() => parseAtomBatch('not-json', ['a'])).toThrow('atom_batch_malformed_json');
});
test('cached answers cannot cross changed source input and incomplete outputs are never accepted', async () => {
  const batch = new AtomBatchTransport(work, 2, async x => input(x), async () => reply(JSON.stringify({
    results: [{ id: 'case-0', atoms: [] }, { id: 'case-1', atoms: [] }] })), {});
  await batch.read(work[0]!, input(work[0]!));
  expect(batch.read(work[1]!, { ...input(work[1]!), message: 'edited' })).rejects.toThrow('atom_batch_input_changed');
  const stopped = new AtomBatchTransport(work, 2, async x => input(x), async () => reply('{}', 'length'), {});
  expect(stopped.read(work[0]!, input(work[0]!))).rejects.toThrow('atom_batch_output_not_complete');
});
test('aggregate input size is bounded and default single transport keeps its original schema and output cap', async () => {
  let calls = 0;
  const batch = new AtomBatchTransport(work, 8, async x => ({ ...input(x), message: 'x'.repeat(119999) }), async opts => {
    calls++; expect(opts.maxTokens).toBe(4096); expect(opts.responseSchema?.name).toBe('atoms_extraction');
    return reply('{"atoms":[]}');
  }, { maxTokens: 4096 });
  expect((await batch.read(work[0]!, { ...input(work[0]!), message: 'x'.repeat(119999) })).text).toBe('{"atoms":[]}');
  expect(calls).toBe(1);
});

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms, countExtractAtomsBacklog } from '../src/core/cycle/extract-atoms.ts';
test('real extraction publishes separately grounded atoms from one batch transport call', async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  try {
    await engine.setConfig('cycle.extract_atoms.batch_size', '2');
    await engine.setConfig('models.dream.extract_atoms', 'claude-cli:claude-haiku-5-5');
    let calls = 0;
    const outcome = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [],
      _transcripts: [
        { filePath: '/synthetic/2026-01-01-first.txt', content: 'Copper lantern belongs to the first input.', contentHash: 'a'.repeat(64) },
        { filePath: '/synthetic/2026-01-02-second.txt', content: 'Blue harbor belongs to the second input.', contentHash: 'b'.repeat(64) }],
      _chat: async () => {
        calls++;
        return { ...reply(JSON.stringify({ results: [
          { id: 'case-0', atoms: [{ title: 'Copper lantern', atom_type: 'insight', body: 'Copper lantern belongs to the first input.', source_quote: 'Copper lantern belongs to the first input.' }] },
          { id: 'case-1', atoms: [{ title: 'Blue harbor', atom_type: 'insight', body: 'Blue harbor belongs to the second input.', source_quote: 'Blue harbor belongs to the second input.' }] }] })),
          model: 'claude-cli:claude-haiku-5-5', providerId: 'claude-cli', blocks: [],
          usage: { input_tokens: 20, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
      } });
    expect(calls).toBe(1); expect(outcome.details?.atoms_extracted).toBe(2);
    const rows = await engine.executeRaw<{ frontmatter: { source_quote: string } }>("SELECT frontmatter FROM pages WHERE type='atom' AND deleted_at IS NULL");
    expect(rows.map(x => x.frontmatter.source_quote).sort()).toEqual([
      'Blue harbor belongs to the second input.', 'Copper lantern belongs to the first input.']);
    expect(outcome.details?.failures).toEqual([]);
  } finally { await engine.disconnect(); }
});

test('chunk coverage reaches the final character without splitting surrogate pairs', () => {
  const text = 'x'.repeat(255) + '😀' + 'y'.repeat(700);
  const chunks = splitAtomInput(text, 256);
  expect(chunks.join('')).toBe(text);
  expect(chunks.every(x => x.length <= 256 && !/[\uD800-\uDBFF]$/.test(x) && !/^[\uDC00-\uDFFF]/.test(x))).toBe(true);
});
test('long input completion requires every chunk; a bad tail never becomes an empty successful page', async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  try {
    await engine.setConfig('cycle.extract_atoms.chunk_long_inputs', 'true');
    await engine.setConfig('cycle.extract_atoms.max_input_chars', '1000');
    await engine.setConfig('models.dream.extract_atoms', 'claude-cli:claude-haiku-5-5');
    let calls = 0;
    const run = (hash: string, failTail: boolean) => runPhaseExtractAtoms(engine, {
      sourceId: 'default', _pages: [], _transcripts: [{ filePath: '/synthetic/2026-01-01-long-' + hash + '.txt',
        content: 'x'.repeat(2500), contentHash: hash.repeat(64) }],
      _chat: async () => { calls++; return { ...reply(failTail && calls % 3 === 0 ? 'bad tail' : '{"atoms":[]}'),
        model: 'claude-cli:claude-haiku-5-5', providerId: 'claude-cli', blocks: [],
        usage: { input_tokens: 20, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult; }
    });
    await run('c', false); expect(calls).toBe(3);
    const [good] = await engine.executeRaw<{ tombstoned: boolean; partial_input_chars: number | null }>(
      "SELECT tombstoned,partial_input_chars FROM extract_atoms_transcript_state WHERE content_hash=$1", ['c'.repeat(16)]);
    expect(good?.tombstoned).toBe(true); expect(good?.partial_input_chars).toBeNull();
    await run('d', true); expect(calls).toBe(6);
    const [bad] = await engine.executeRaw<{ tombstoned: boolean }>(
      "SELECT tombstoned FROM extract_atoms_transcript_state WHERE content_hash=$1", ['d'.repeat(16)]);
    expect(bad?.tombstoned ?? false).toBe(false);
  } finally { await engine.disconnect(); }
});

import { managedBrain } from './helpers/managed-brain.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
test('a managed partial-only backlog stays visible until full chunk coverage completes', async () => {
  const slug = 'notes/long-partial-only';
  await managedBrain(async ({ engine }) => {
    const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
    const item = { slug, content: page.compiled_truth, contentHash: page.content_hash! };
    let calls = 0;
    const chat = async () => { calls++; return { ...reply('{"atoms":[]}'), blocks: [],
      model: 'claude-cli:claude-haiku-5-5', providerId: 'claude-cli',
      usage: { input_tokens: 20, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult; };
    await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [item], _transcripts: [], _chat: chat });
    await disposePersistenceConsumer(engine); expect(calls).toBe(1);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
    await engine.setConfig('cycle.extract_atoms.chunk_long_inputs', 'true');
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [item], _transcripts: [], _chat: chat });
    await disposePersistenceConsumer(engine); expect(calls).toBe(4);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
    const [state] = await engine.executeRaw<{ tombstoned: boolean; partial_input_chars: number | null }>(
      'SELECT tombstoned,partial_input_chars FROM extract_atoms_page_state WHERE page_id=$1', [page.id]);
    expect(state).toEqual({ tombstoned: true, partial_input_chars: null });
  }, { setup: async ({ engine }) => {
    await engine.setConfig('cycle.extract_atoms.max_input_chars', '1000');
    await engine.setConfig('models.dream.extract_atoms', 'claude-cli:claude-haiku-5-5');
    await engine.putPage(slug, { type: 'meeting', title: 'Long source', compiled_truth: 'x'.repeat(2500), timeline: '' }, { sourceId: 'default' });
  } });
});
