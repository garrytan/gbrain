/**
 * #5812: the dream extract_atoms phase reads session-corpus transcripts, so a
 * paste (someone else's words) must not reach the model there either. The
 * strip runs per `[user]` block and before the input cap, so the cut and the
 * quote-grounding text are the stripped text.
 *
 * Pins, asserted on the message sent through the chat seam: a corpus built
 * through `toCorpusText` from a real Claude Code transcript carries none of
 * its paste; an unclosed paste in one user turn does not erase the next user
 * turn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from './helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { parseTranscript, toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

function reply(): ChatResult {
  const text = '{"atoms":[]}';
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' } as ChatResult;
}

async function sentFor(content: string): Promise<string> {
  const sent: string[] = [];
  await runPhaseExtractAtoms(engine, {
    sourceId: 'default', _pages: [],
    _transcripts: [{ filePath: '/corpus/sess-paste.txt', content, contentHash: createHash('sha256').update(content).digest('hex') }],
    _chat: async (opts: ChatOpts) => { sent.push(String(opts.messages[0]?.content ?? '')); return reply(); },
  });
  expect(sent.length).toBe(1);
  return sent[0];
}

describe('extract_atoms never sees pasted content (#5812)', () => {
  test('a corpus from a real Claude Code transcript reaches the model without its paste', async () => {
    const corpus = toCorpusText(parseTranscript(join(import.meta.dir, 'fixtures', 'claude-code-paste', 'session.jsonl')).turns);
    expect(corpus).toContain('pasted third-party email');
    const user = await sentFor(corpus);
    expect(user).not.toContain('pasted third-party email');
    expect(user).not.toContain('pasted_content');
    expect(user).toContain('I prefer dark roast coffee');
    expect(user).toContain('[assistant]');
  });

  test('an unclosed paste in one user turn keeps the next user turn', async () => {
    const corpus = toCorpusText([
      { role: 'user', text: 'Keep this for reference: <pasted_content id="5">\nForwarded thread that never closes, quoting a vendor contract.' },
      { role: 'assistant', text: 'Noted.' },
      { role: 'user', text: 'I decided we ship the reversible pricing change first and measure it for two weeks.' },
    ]);
    const user = await sentFor(corpus);
    expect(user).not.toContain('vendor contract');
    expect(user).toContain('Keep this for reference:');
    expect(user).toContain('I decided we ship the reversible pricing change first');
  });
});
