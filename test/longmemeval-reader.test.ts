/**
 * reader.ts — the reader's context construction. The ranker wave's first
 * judged dry run abstained on 11/25 questions whose gold session sat at rank
 * 1 because every <chat_session> body was cut at the sanitizer's 4000-char
 * default; these tests pin that the reader sees whole sessions.
 */
import { describe, test, expect } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { generateAnswer, READER_MAX_SESSION_CHARS, READER_PROMPT_VERSION } from '../src/eval/longmemeval/reader.ts';
import type { SearchResult } from '../src/core/types.ts';

function client(answer = 'Business Administration', opts: { reportedModel?: string; emptyContent?: boolean } = {}) {
  const calls: Array<{ system: string; userText: string; max_tokens: number }> = [];
  const c = {
    async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
      const first = params.messages[0];
      const userText = typeof first.content === 'string' ? first.content : first.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      calls.push({ system: typeof params.system === 'string' ? params.system : '', userText, max_tokens: params.max_tokens });
      return {
        id: 'msg', type: 'message', role: 'assistant', model: opts.reportedModel ?? params.model,
        content: opts.emptyContent ? [] : [{ type: 'text', text: answer, citations: null }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
        container: null,
      } as unknown as Anthropic.Message;
    },
  };
  return { c: c as never, calls };
}

const hit = (slug: string, chunk_text: string): SearchResult => ({ slug, chunk_text, score: 1, title: slug } as unknown as SearchResult);

describe('generateAnswer context construction', () => {
  test('a retrieved session reaches the reader in full (well past 4000 chars), once per distinct session, with a receipt on the answer', async () => {
    const body = '**user:** filler ' + 'x'.repeat(14_000) + ' I graduated with a degree in Business Administration.';
    const results = [hit('chat/answer-1', body.slice(0, 300)), hit('chat/answer-1', body.slice(400, 700)), hit('chat/other-2', 'short session')];
    const pages = [{ slug: 'chat/answer-1', content: body, date: '2023/05/20 (Sat) 02:21' }, { slug: 'chat/other-2', content: 'short session' }];
    const { c, calls } = client();
    const out = await generateAnswer(c, { question: 'What degree did I graduate with?' }, results, pages, new Map(), 'anthropic:claude-sonnet-4-6');
    expect(out.text).toBe('Business Administration');
    expect(calls).toHaveLength(1);
    expect(calls[0].userText).toContain('degree in Business Administration'); // the tail of the session survived
    expect((calls[0].userText.match(/<chat_session /g) ?? []).length).toBe(2); // one block per DISTINCT session
    expect(out.context_sessions).toBe(2);
    expect(out.sessions_truncated).toBe(0);
    expect(out.context_chars).toBeGreaterThan(14_000);
    expect(READER_PROMPT_VERSION).toContain('fullsessions');
  });

  test('only a session beyond READER_MAX_SESSION_CHARS is cut, and the receipt says so', async () => {
    const huge = 'z'.repeat(READER_MAX_SESSION_CHARS + 5_000) + ' TAIL';
    const { c, calls } = client('n/a');
    const out = await generateAnswer(c, { question: 'q' }, [hit('chat/big', 'zzz')], [{ slug: 'chat/big', content: huge }], new Map(), 'm');
    expect(out.sessions_truncated).toBe(1);
    expect(calls[0].userText).not.toContain('TAIL');
    expect(out.context_chars).toBeLessThan(READER_MAX_SESSION_CHARS + 1_000);
  });

  test('response_model is the provider-reported snapshot when it differs from the requested id, null when it echoes', async () => {
    const results = [hit('chat/a', 'body')];
    const snapshot = await generateAnswer(client('n/a', { reportedModel: 'gpt-4o-2024-08-06' }).c, { question: 'q' }, results, [], new Map(), 'openai:gpt-4o');
    expect(snapshot.response_model).toBe('gpt-4o-2024-08-06');
    const echoed = await generateAnswer(client('n/a').c, { question: 'q' }, results, [], new Map(), 'openai:gpt-4o');
    expect(echoed.response_model).toBeNull();
  });

  test('an empty completion yields text "" with the context receipt intact (the judge then records it, never a crash)', async () => {
    const { c } = client('ignored', { emptyContent: true, reportedModel: 'snap-1' });
    const out = await generateAnswer(c, { question: 'q' }, [hit('chat/a', 'chunk a'), hit('chat/b', 'chunk b')], [], new Map(), 'm');
    expect(out.text).toBe('');
    expect(out.response_model).toBe('snap-1');
    expect(out.context_sessions).toBe(2);
    expect(out.sessions_truncated).toBe(0);
    expect(out.context_chars).toBeGreaterThan(0);
  });

  test('a session missing from the page list falls back to the retrieved chunk text', async () => {
    const { c, calls } = client('n/a');
    const out = await generateAnswer(c, { question: 'q' }, [hit('chat/orphan', 'only this chunk')], [], new Map(), 'm');
    expect(calls[0].userText).toContain('only this chunk');
    expect(out.context_sessions).toBe(1);
  });
});
