/**
 * extract_atoms never reads a segmented page (git is the parent: on an unmanaged brain extract_atoms writes atom pages
 * to the database through importFromContent before git has them, so it is not extended to a new input). Shared by the
 * PGLite arm (test/large-pages/extract-atoms-segmented-skip.test.ts) and the Postgres arm
 * (test/e2e/extract-atoms-segmented-skip-postgres.test.ts). Fake chat (the phase's _chat seam), counted by prompt.
 *
 * 1. Protects: discovery does not offer a segmented page; the phase makes no model call for it and creates no atom page
 *    from it, while an inline page of the same type in the same run is extracted (the phase did run).
 * 2. Fails when: a segmented page is discovered, prompted or yields an atom page.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AppendBrain } from './append-brain.ts';
import { discoverExtractablePages, runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { chatDays, chatPage } from './conversation-facts-incremental-cases.ts';

export function defineExtractAtomsSegmentedSkipCases(opts: { getBrain: () => AppendBrain }): void {
  test('a segmented page is not offered to extract_atoms and yields no atom page; an inline page in the same run is extracted', async () => {
    const brain = opts.getBrain();
    const segmented = `notes/atoms-segmented-skip-${randomUUID().slice(0, 8)}`;
    const inline = `notes/atoms-inline-control-${randomUUID().slice(0, 8)}`;
    await brain.seed(segmented, chatPage('Segmented meeting', chatDays(5000, 100, 51)).replace('type: conversation', 'type: meeting'));
    await brain.seed(inline, chatPage('Inline meeting', chatDays(5200, 1, 52)).replace('type: conversation', 'type: meeting'));
    expect({ segmented: (await brain.body(segmented)).storage, inline: (await brain.body(inline)).storage }).toEqual({ segmented: 'segmented', inline: 'inline' });

    const offered = (await discoverExtractablePages(brain.engine, 'default')).map(p => p.slug);
    expect({ segmented: offered.includes(segmented), inline: offered.includes(inline) }).toEqual({ segmented: false, inline: true });

    const prompts: string[] = [];
    let n = 0;
    const chat = async (o: ChatOpts): Promise<ChatResult> => {
      prompts.push(o.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n'));
      const title = `probe atom ${++n}`;
      const text = JSON.stringify({ atoms: [{ title, atom_type: 'insight', body: `Body for ${title}.`, source_quote: null, lesson: null, concepts: null, virality_score: null, emotional_register: null }] });
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    };
    for (let run = 0; run < 5; run++) {
      const made = prompts.length;
      await runPhaseExtractAtoms(brain.engine, { sourceId: 'default', _chat: chat, _transcripts: [] });
      if (prompts.length === made) break;
    }
    const atomsOf = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM pages WHERE source_id='default' AND type='atom' AND frontmatter->>'source_slug'=$1", [slug])).length;
    expect({
      segmentedPrompts: prompts.filter(p => p.includes('Source: ' + segmented + '\n')).length,
      segmentedAtoms: await atomsOf(brain.engine, segmented),
      inlinePrompted: prompts.some(p => p.includes('Source: ' + inline + '\n')),
      inlineAtoms: (await atomsOf(brain.engine, inline)) > 0,
    }).toEqual({ segmentedPrompts: 0, segmentedAtoms: 0, inlinePrompted: true, inlineAtoms: true });
  }, 600_000);
}
