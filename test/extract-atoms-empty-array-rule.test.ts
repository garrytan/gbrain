/**
 * extract_atoms prompt — explicit zero-yield rule.
 *
 * Metadata-only pages (connector rows, status dumps, boilerplate) gave the
 * model nothing to extract, and the prompt never said what to do then. Local
 * and smaller models responded by inventing 1-3 atoms or by explaining in
 * prose; prose parses as `no JSON array in response`, which is a counted
 * deterministic failure, so the page burned every retry and was tombstoned
 * for no reason. The prompt now tells the model to output exactly `[]` for a
 * content-free transcript, which the parser already treats as an honest
 * zero-yield (ok: true, atoms: []).
 *
 * Pins: the system prompt sent to the model carries the rule. Asserted on
 * the prompt actually sent through the chat seam, not on source text.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms, parseAtomsOutcome } from '../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function okChatResult(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  } as ChatResult;
}

describe('extract_atoms prompt — content-free transcript rule', () => {
  test('the system prompt tells the model to output exactly [] when nothing is extractable', async () => {
    let capturedSystem = '';
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: [{ slug: 'documents/connector-row', content: 'status: open\nowner: alice-example\n', contentHash: 'b'.repeat(16) }],
      _chat: async (opts: ChatOpts) => {
        capturedSystem = String(opts.system ?? '');
        return okChatResult('[]');
      },
    });
    expect(capturedSystem.length).toBeGreaterThan(0); // the seam was hit
    // The rule names the zero-yield shape AND forbids the two failure modes
    // (invented atoms, prose).
    expect(capturedSystem).toMatch(/no extractable idea[\s\S]*output exactly \[\]/);
    expect(capturedSystem).toMatch(/never invent an atom/);
    expect(capturedSystem).toMatch(/never explain in prose/);
  });

  test('[] is an honest zero-yield, not a parse failure (the path the rule steers into)', () => {
    expect(parseAtomsOutcome('[]')).toEqual({ ok: true, atoms: [] });
    // The rule must survive a bracketed preamble too: a model that echoes a
    // `[Source: …]` citation before obeying still yields an honest `[]`.
    expect(parseAtomsOutcome('[Source: x] nothing here.\n[]')).toEqual({ ok: true, atoms: [] });
    // Positive control: the prose the rule prevents IS a failure.
    expect(parseAtomsOutcome('This page has no extractable ideas.')).toEqual({
      ok: false,
      reason: 'no JSON array in response',
    });
  });
});
