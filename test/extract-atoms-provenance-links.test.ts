/**
 * #3961 — atom provenance edges in the link graph.
 *
 * extract_atoms writes each atom with `source_slug` frontmatter, but nothing
 * ever materialized that lineage as a link row — `gbrain backlinks
 * <source-page>` showed no trace of the atoms derived from it. The phase now
 * accumulates (source-page → atom) LinkBatchInput rows during the atom loop
 * (link_source='atom-provenance', both endpoints in the phase's source) and
 * flushes them AFTER the completion-receipt flip. Transcript items are
 * skipped — a transcript is a file, not a page, so there is no from-endpoint.
 *
 * PGLite round-trip with a stubbed chat gateway (no model calls).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

const stubChat = (title: string) => async (_o: ChatOpts): Promise<ChatResult> => ({
  text: `[{"title":"${title}","atom_type":"insight","body":"Enterprise buyers want tangible prototypes, not renders."}]`,
  blocks: [{ type: 'text', text: '' }],
  stopReason: 'end',
  usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5',
  providerId: 'anthropic',
});

describe('atom provenance backlinks (#3961)', () => {
  test('page-kind items get source-page → atom edges, visible as backlinks', async () => {
    await engine.putPage('writings/essay-one', {
      type: 'note', title: 'Essay One',
      compiled_truth: 'A long essay with extractable claims.', timeline: '',
    });

    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: 'writings/essay-one', content: 'A long essay with extractable claims.', contentHash: 'feedbeeffeedbeef' }],
      _chat: stubChat('Prototypes beat renders'),
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(1);

    // Outgoing edge on the source page, provenance-tagged.
    const links = await engine.getLinks('writings/essay-one');
    const provenance = links.filter(l => l.link_source === 'atom-provenance');
    expect(provenance).toHaveLength(1);
    expect(provenance[0]!.to_slug).toContain('prototypes-beat-renders');

    // And the atom's backlinks point home.
    const backs = await engine.getBacklinks(provenance[0]!.to_slug);
    expect(backs.some(l => l.from_slug === 'writings/essay-one' && l.link_source === 'atom-provenance')).toBe(true);
  });

  test('re-running the same item upserts, never duplicates the edge', async () => {
    // Same content hash re-run: deterministic atom slugs upsert; the batch
    // write's ON CONFLICT dedupes the edge.
    await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: 'writings/essay-one', content: 'A long essay with extractable claims.', contentHash: 'feedbeeffeedbee2' }],
      _chat: stubChat('Prototypes beat renders'),
    });
    const links = await engine.getLinks('writings/essay-one');
    expect(links.filter(l => l.link_source === 'atom-provenance')).toHaveLength(1);
  });

  test('transcript items create NO provenance edges (files are not pages)', async () => {
    const before = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM links WHERE link_source = 'atom-provenance'`,
    );
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/fake/meeting.txt', content: 'transcript content here', contentHash: 'abc123def4567890' }],
      _pages: [],
      _chat: stubChat('Transcript atom'),
    });
    expect(result.status).toBe('ok');
    const after = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM links WHERE link_source = 'atom-provenance'`,
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
