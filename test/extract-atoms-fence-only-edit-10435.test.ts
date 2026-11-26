/**
 * #10435: a takes-fence edit changes the page's content_hash but not the text
 * extract_atoms reads (publicBody). The next run must not pay for the same input
 * again, and a real prose change must still be extracted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const prose = 'The team decided to measure every launch against clear exit criteria before shipping. '.repeat(12);
const fence = (rows: string) => `\n\n<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n${rows}<!--- gbrain:takes:end -->\n`;
const row = (n: number) => `| ${n} | Launch criteria matter ${n} | take | brain | 0.5 | 2026-01-01 | test |\n`;

function stubChat() {
  const calls: string[] = [];
  const chat = async (opts: ChatOpts): Promise<ChatResult> => {
    const last = opts.messages[opts.messages.length - 1];
    calls.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
    const text = JSON.stringify([{ title: 'Measure every launch', body: 'Measure every launch against clear exit criteria.', atom_type: 'insight' }]);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { calls, chat };
}

describe('extract_atoms ignores fence-only page edits (#10435)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

  test('a takes-fence edit is not re-extracted; a prose edit is', async () => {
    const sourceId = 'fence-only';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const slug = 'notes/launch-criteria';
    await engine.putPage(slug, { type: 'note', title: 'Launch criteria', compiled_truth: prose + fence(row(1)), timeline: '' }, { sourceId });
    const first = stubChat();
    await runPhaseExtractAtoms(engine, { sourceId, _chat: first.chat, _transcripts: [] });
    expect(first.calls).toHaveLength(1);

    await engine.putPage(slug, { type: 'note', title: 'Launch criteria', compiled_truth: prose + fence(row(1) + row(2)), timeline: '' }, { sourceId });
    const second = stubChat();
    await runPhaseExtractAtoms(engine, { sourceId, _chat: second.chat, _transcripts: [] });
    expect(second.calls).toHaveLength(0);

    await engine.putPage(slug, { type: 'note', title: 'Launch criteria', compiled_truth: prose + ' A new decision about rollout.' + fence(row(1) + row(2)), timeline: '' }, { sourceId });
    const third = stubChat();
    await runPhaseExtractAtoms(engine, { sourceId, _chat: third.chat, _transcripts: [] });
    expect(third.calls).toHaveLength(1);
  }, 120_000);
});
