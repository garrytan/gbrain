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
  test('same-date pages with the same atom title retain independent atoms and provenance (#4733)', async () => {
    const sources = [
      {
        slug: 'writings/2026-08-29-alpha-brief',
        content: 'Alpha source body with an independently attributable claim.',
        contentHash: '1111111111111111aaaaaaaaaaaaaaaa',
        quote: 'Alpha keeps its exact source quote.',
      },
      {
        slug: 'research/2026-08-29-beta-brief',
        content: 'Beta source body with a separately attributable claim.',
        contentHash: '2222222222222222bbbbbbbbbbbbbbbb',
        quote: 'Beta keeps its exact source quote.',
      },
    ] as const;

    for (const source of sources) {
      await engine.putPage(source.slug, {
        type: 'note',
        title: source.slug,
        compiled_truth: source.content,
        timeline: '',
      });
    }

    const collisionChat = async (opts: ChatOpts): Promise<ChatResult> => {
      const prompt = String(opts.messages[0]?.content ?? '');
      const source = sources.find(candidate => prompt.includes(`Source: ${candidate.slug}`));
      if (!source) throw new Error(`unexpected extraction prompt: ${prompt.slice(0, 120)}`);
      return {
        text: JSON.stringify([{
          title: 'Shared collision title',
          atom_type: 'insight',
          body: `Atom derived from ${source.slug}.`,
          source_quote: source.quote,
        }]),
        blocks: [{ type: 'text', text: '' }],
        stopReason: 'end',
        usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    };

    const pages = sources.map(source => ({
      slug: source.slug,
      content: source.content,
      contentHash: source.contentHash,
    }));
    const first = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: pages,
      _chat: collisionChat,
    });
    expect(first.status).toBe('ok');
    expect(first.details?.atoms_extracted).toBe(2);

    // `_pages` is an explicit test seam that bypasses production discovery's
    // source-hash skip, so this deliberately forces the retry write path.
    // It must not add a second atom or provenance edge.
    const retry = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: pages,
      _chat: collisionChat,
    });
    expect(retry.status).toBe('ok');
    expect(retry.details?.atoms_extracted).toBe(2);

    const atomSlugs: string[] = [];
    for (const source of sources) {
      const links = (await engine.getLinks(source.slug))
        .filter(link => link.link_source === 'atom-provenance');
      expect(links).toHaveLength(1);

      const atomSlug = links[0]!.to_slug;
      atomSlugs.push(atomSlug);
      const atom = await engine.getPage(atomSlug, { sourceId: 'default' });
      expect(atom).not.toBeNull();
      expect(atom!.frontmatter.source_slug).toBe(source.slug);
      expect(atom!.frontmatter.source_hash).toBe(source.contentHash.slice(0, 16));
      expect(atom!.frontmatter.source_quote).toBe(source.quote);

      const matchingBacklinks = (await engine.getBacklinks(atomSlug))
        .filter(link => link.from_slug === source.slug && link.link_source === 'atom-provenance');
      expect(matchingBacklinks).toHaveLength(1);
    }
    expect(new Set(atomSlugs).size).toBe(2);
  });

  test('refuses to overwrite an atom whose stored source binding differs (#4733)', async () => {
    const source = {
      slug: 'writings/2026-08-30-binding-guard',
      content: 'A source page used to verify fail-closed atom imports.',
      contentHash: '3333333333333333cccccccccccccccc',
    };
    await engine.putPage(source.slug, {
      type: 'note',
      title: 'Binding guard source',
      compiled_truth: source.content,
      timeline: '',
    });

    const first = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [source],
      _chat: stubChat('Binding guard atom'),
    });
    expect(first.status).toBe('ok');

    const provenance = (await engine.getLinks(source.slug))
      .filter(link => link.link_source === 'atom-provenance');
    expect(provenance).toHaveLength(1);
    const atomSlug = provenance[0]!.to_slug;

    const conflictingBindings = [
      {
        sourceSlug: 'research/2026-08-30-foreign-page',
        sourceHash: source.contentHash.slice(0, 16),
      },
      {
        sourceSlug: source.slug,
        sourceHash: 'ffffffffffffffff',
      },
    ];
    for (const conflicting of conflictingBindings) {
      await engine.executeRaw(
        `UPDATE pages
            SET frontmatter = frontmatter
              || jsonb_build_object('source_slug', $1::text)
              || jsonb_build_object('source_hash', $2::text)
          WHERE source_id = 'default' AND slug = $3`,
        [conflicting.sourceSlug, conflicting.sourceHash, atomSlug],
      );

      const retry = await runPhaseExtractAtoms(engine, {
        _transcripts: [],
        _pages: [source],
        _chat: stubChat('Binding guard atom'),
      });
      expect(retry.status).toBe('warn');
      expect(retry.details?.atoms_extracted).toBe(0);
      expect(retry.details?.failures).toEqual([
        expect.objectContaining({
          source: source.slug,
          error: expect.stringContaining('atom identity conflict'),
        }),
      ]);

      const preserved = await engine.getPage(atomSlug, { sourceId: 'default' });
      expect(preserved!.frontmatter.source_slug).toBe(conflicting.sourceSlug);
      expect(preserved!.frontmatter.source_hash).toBe(conflicting.sourceHash);
    }
  });

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
