// #5211 (wave 14 PR3 row P3.8): an atom extract_atoms writes carries
// `dream_generated: true`, so the anti-loop guards that key on that flag
// (extract_atoms' own input exclusion, facts and chronicle eligibility,
// transcript discovery, propose_takes' candidate filter) see the phase's own
// output. Atoms carried `extracted_by` only.
//
// The stamp is one additive line in `src/core/cycle/extract-atoms.ts`, a wave
// 13 hot file: the hunk lives in `~/.capy/work/w14/pr3/stack-hunks/` and
// landed with wave 13 PR3 (#6446) on master.
//
// Protects: the written atom's frontmatter. Fails when: the write site drops
// the flag. Why not existing coverage: no test reads `dream_generated` off an
// atom. Seams: `_transcripts`, `_pages`, `_chat` already exist.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

function chatReturning(atoms: unknown[]): (o: ChatOpts) => Promise<ChatResult> {
  const text = JSON.stringify(atoms);
  return async () => ({
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });
}

const SOURCE = ['Meeting notes, 12 March.', 'The budget is a ceiling and not a target.', 'We agreed to revisit in April.']
  .join('\n').padEnd(600, ' .');

describe('extract_atoms stamps its atoms dream_generated (#5211, P3.8)', () => {
  test('P3.8: a written atom carries dream_generated: true next to extracted_by', async () => {
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/dg1.txt', content: SOURCE, contentHash: 'c3'.repeat(8) }],
      _pages: [],
      _chat: chatReturning([{
        title: 'Budgets are ceilings',
        atom_type: 'insight',
        body: 'A budget caps spend; it is not a goal to reach.',
        source_quote: 'The budget is a ceiling and not a target.',
      }]),
    });
    const pages = await engine.listPages({ type: 'atom', limit: 10 });
    expect(pages.length).toBe(1);
    const atom = (await engine.getPage(pages[0]!.slug, { sourceId: 'default' }))!;
    expect(atom.frontmatter.dream_generated).toBe(true);
    expect(String(atom.frontmatter.extracted_by)).toStartWith('extract_atoms');
  });
});
