import { expect, test } from 'bun:test';
import { AtomBatchTransport } from '../src/core/cycle/extract-atoms-batch.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
const reply = (text: string, stopReason = 'end') => ({ text, stopReason } as ChatResult);
const work = Array.from({ length: 8 }, (_, i) => ({ i }));
const input = (item: { i: number }) => ({ key: String(item.i), system: 'extract independently', message: 'source-' + item.i });
test('a wrong count discards the entire envelope and uses one original single call per input', async () => {
  const items = work.slice(0, 2); const calls: ChatOpts[] = [];
  const batch = new AtomBatchTransport(items, 2, async x => input(x), async opts => {
    calls.push(opts);
    if (calls.length === 1) return reply('{"results":[{"id":"case-0","atoms":[{"title":"DISCARD THIS"}]}]}');
    return reply(JSON.stringify({ atoms: [{ title: opts.messages[0]!.content }] }));
  }, { model: 'claude-cli:claude-haiku-5-5', maxTokens: 4096 });
  for (const item of items) expect(JSON.parse((await batch.read(item, input(item))).text).atoms[0].title).toBe(input(item).message);
  expect(calls).toHaveLength(3);
  for (const call of calls.slice(1)) {
    expect(call.maxTokens).toBe(4096); expect(call.model).toBe('claude-cli:claude-haiku-5-5');
    expect(call.responseSchema?.name).toBe('atoms_extraction');
  }
});
test('a budget or provider refusal during the single fallback leaves no partially cached group', async () => {
  const items = work.slice(0, 2); let calls = 0;
  const batch = new AtomBatchTransport(items, 2, async x => input(x), async () => {
    calls++;
    if (calls === 1) return reply('{"results":[]}');
    if (calls === 2) return reply('{"atoms":[]}');
    throw new Error('guarded-call-refused');
  }, {});
  await expect(batch.read(items[0]!, input(items[0]!))).rejects.toThrow('guarded-call-refused');
  expect(calls).toBe(3);
  await expect(batch.read(items[0]!, input(items[0]!))).rejects.toThrow('guarded-call-refused');
  expect(calls).toBe(4);
});
test('duplicate identities and truncated batch output are still refused without a fallback', async () => {
  for (const result of [reply('{"results":[{"id":"case-0","atoms":[]},{"id":"case-0","atoms":[]}]}'), reply('{}', 'length')]) {
    let calls = 0;
    const batch = new AtomBatchTransport(work, 2, async x => input(x), async () => { calls++; return result; }, {});
    await expect(batch.read(work[0]!, input(work[0]!))).rejects.toThrow(); expect(calls).toBe(1);
  }
});

test('real extraction publishes each separately grounded input after a wrong-count batch', async () => {
  const wrongCount = true;
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  try {
    await engine.setConfig('cycle.extract_atoms.batch_size', '2');
    await engine.setConfig('models.dream.extract_atoms', 'claude-cli:claude-haiku-5-5');
    let calls = 0;
    const outcome = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [],
      _transcripts: [
        { filePath: '/synthetic/2026-01-01-first.txt', content: 'Copper lantern belongs to the first input.', contentHash: 'a'.repeat(64) },
        { filePath: '/synthetic/2026-01-02-second.txt', content: 'Blue harbor belongs to the second input.', contentHash: 'b'.repeat(64) }],
      _chat: async opts => {
        calls++;
        const results = [
          { id: 'case-0', atoms: [{ title: 'Copper lantern', atom_type: 'insight', body: 'Copper lantern belongs to the first input.', source_quote: 'Copper lantern belongs to the first input.' }] },
          { id: 'case-1', atoms: [{ title: 'Blue harbor', atom_type: 'insight', body: 'Blue harbor belongs to the second input.', source_quote: 'Blue harbor belongs to the second input.' }] }];
        const value = wrongCount ? (calls === 1 ? { results: [] } : { atoms: results[String(opts.messages[0]!.content).includes('Copper lantern') ? 0 : 1]!.atoms }) : { results };
        return { ...reply(JSON.stringify(value)),
          model: 'claude-cli:claude-haiku-5-5', providerId: 'claude-cli', blocks: [],
          usage: { input_tokens: 20, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult;
      } });
    expect(calls).toBe(wrongCount ? 3 : 1); expect(outcome.details?.atoms_extracted).toBe(2);
    const rows = await engine.executeRaw<{ frontmatter: { source_quote: string } }>("SELECT frontmatter FROM pages WHERE type='atom' AND deleted_at IS NULL");
    expect(rows.map(x => x.frontmatter.source_quote).sort()).toEqual([
      'Blue harbor belongs to the second input.', 'Copper lantern belongs to the first input.']);
    expect(outcome.details?.failures).toEqual([]);
  } finally { await engine.disconnect(); }
});

