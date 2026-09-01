/**
 * #3961 — atom provenance edges in the link graph.
 *
 * extract_atoms writes each atom with `source_slug` frontmatter, but nothing
 * ever materialized that lineage as a link row — `gbrain backlinks
 * <source-page>` showed no trace of the atoms derived from it. The phase now
 * accumulates (source-page → atom) LinkBatchInput rows during the atom loop
 * (link_source='atom-provenance', both endpoints in the phase's source) and
 * flushes them BEFORE the completion-receipt flip (#4733: a failed provenance
 * write leaves the item discoverable for a normal retry instead of stranding
 * a completed page with no edges). Transcript items are skipped — a
 * transcript is a file, not a page, so there is no from-endpoint.
 *
 * Also pins the #4733 atom-identity fix: page-derived atom slugs fold the
 * source-page slug into the identity hash so two same-date source pages
 * emitting the same atom title can't alias one slug, plus the fail-closed
 * binding guard and the upgrade path for pre-#4733 title-only-hash rows.
 *
 * PGLite round-trip with a stubbed chat gateway (no model calls).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
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

describe('atom identity folds the source locator (#4733)', () => {
  test('two same-date source pages emitting the same atom title get DISTINCT atoms', async () => {
    // Quotes are verbatim substrings of each source's own body, so the #4706
    // extraction-time quote verification keeps them AND each atom's quote
    // proves which source it came from.
    const sources = [
      {
        slug: 'writings/2026-08-29-alpha-brief',
        content: 'Alpha source body with an independently attributable claim.',
        contentHash: '1111111111111111',
        quote: 'Alpha source body with an independently attributable claim.',
      },
      {
        slug: 'research/2026-08-29-beta-brief',
        content: 'Beta source body with a separately attributable claim.',
        contentHash: '2222222222222222',
        quote: 'Beta source body with a separately attributable claim.',
      },
    ] as const;
    for (const s of sources) {
      await engine.putPage(s.slug, {
        type: 'note', title: s.slug, compiled_truth: s.content, timeline: '',
      });
    }
    const collisionChat = async (opts: ChatOpts): Promise<ChatResult> => {
      const prompt = String(opts.messages[0]?.content ?? '');
      const s = sources.find(c => prompt.includes(`Source: ${c.slug}`));
      if (!s) throw new Error(`unexpected extraction prompt: ${prompt.slice(0, 120)}`);
      return {
        text: JSON.stringify([{
          title: 'Shared collision title',
          atom_type: 'insight',
          body: `Atom derived from ${s.slug}.`,
          source_quote: s.quote,
        }]),
        blocks: [{ type: 'text', text: '' }],
        stopReason: 'end',
        usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    };
    const pages = sources.map(s => ({ slug: s.slug, content: s.content, contentHash: s.contentHash }));

    const first = await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: pages, _chat: collisionChat });
    expect(first.status).toBe('ok');
    expect(first.details?.atoms_extracted).toBe(2);

    // Retry through the same seam (bypasses the source-hash skip) — must
    // upsert, not add a second atom or edge per source.
    const retry = await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: pages, _chat: collisionChat });
    expect(retry.status).toBe('ok');

    const atomSlugs: string[] = [];
    for (const s of sources) {
      const links = (await engine.getLinks(s.slug)).filter(l => l.link_source === 'atom-provenance');
      expect(links).toHaveLength(1);
      const atomSlug = links[0]!.to_slug;
      atomSlugs.push(atomSlug);
      const atom = await engine.getPage(atomSlug, { sourceId: 'default' });
      expect(atom).not.toBeNull();
      // Pre-#4733 the second import aliased the first slug and overwrote this
      // binding — each atom must keep ITS OWN source binding and quote.
      expect(atom!.frontmatter.source_slug).toBe(s.slug);
      expect(atom!.frontmatter.source_hash).toBe(s.contentHash.slice(0, 16));
      expect(atom!.frontmatter.source_quote).toBe(s.quote);
    }
    expect(new Set(atomSlugs).size).toBe(2);
  });

  test('refuses to overwrite an atom whose stored binding names a DIFFERENT source (fail-closed)', async () => {
    const source = {
      slug: 'writings/2026-08-30-binding-guard',
      content: 'A source page used to verify fail-closed atom imports.',
      contentHash: '3333333333333333',
    };
    await engine.putPage(source.slug, {
      type: 'note', title: 'Binding guard source', compiled_truth: source.content, timeline: '',
    });
    const first = await runPhaseExtractAtoms(engine, {
      _transcripts: [], _pages: [source], _chat: stubChat('Binding guard atom'),
    });
    expect(first.status).toBe('ok');
    const provenance = (await engine.getLinks(source.slug)).filter(l => l.link_source === 'atom-provenance');
    expect(provenance).toHaveLength(1);
    const atomSlug = provenance[0]!.to_slug;

    // Corrupt the stored binding to point at a foreign source page.
    await engine.executeRaw(
      `UPDATE pages
          SET frontmatter = frontmatter || jsonb_build_object('source_slug', $1::text)
        WHERE source_id = 'default' AND slug = $2`,
      ['research/2026-08-30-foreign-page', atomSlug],
    );

    const retry = await runPhaseExtractAtoms(engine, {
      _transcripts: [], _pages: [source], _chat: stubChat('Binding guard atom'),
    });
    expect(retry.status).toBe('warn');
    expect(retry.details?.atoms_extracted).toBe(0);
    expect(retry.details?.failures).toEqual([
      expect.objectContaining({
        source: source.slug,
        error: expect.stringContaining('atom identity conflict'),
      }),
    ]);
    // The existing row is untouched — fail-closed means no overwrite.
    const preserved = await engine.getPage(atomSlug, { sourceId: 'default' });
    expect(preserved!.frontmatter.source_slug).toBe('research/2026-08-30-foreign-page');
  });

  test('upgrade: a pre-#4733 title-only-hash atom with a compatible binding is ADOPTED — re-extraction upserts in place, no duplicate', async () => {
    // Seed a PRE-WAVE atom exactly where the legacy formula put it:
    // atoms/<date>/<stem>-<sha256(title).slice(0,6)>, bound to the SAME
    // source page the re-extraction runs against.
    const title = 'Upgrade shared title';
    const sourceSlug = 'writings/2026-08-28-upgrade-page';
    const legacyHash = createHash('sha256').update(title).digest('hex').slice(0, 6);
    const legacySlug = `atoms/2026-08-28/upgrade-shared-title-${legacyHash}`;
    await engine.putPage(legacySlug, {
      type: 'atom',
      title,
      compiled_truth: 'Pre-wave atom body extracted from version one.',
      timeline: '',
      frontmatter: { source_slug: sourceSlug, source_hash: 'aaaa000011112222', atom_type: 'insight' },
    });
    await engine.putPage(sourceSlug, {
      type: 'note', title: 'Upgrade page', compiled_truth: 'Edited body, version two.', timeline: '',
    });

    // Post-upgrade re-extraction of the (edited) source page: same title.
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: sourceSlug, content: 'Edited body, version two.', contentHash: 'bbbb333344445555' }],
      _chat: stubChat(title),
    });
    expect(result.status).toBe('ok');
    expect(result.details?.failures).toEqual([]);
    expect(result.details?.atoms_extracted).toBe(1);

    // The legacy row was ADOPTED: same slug, binding kept, content refreshed —
    // exactly what a pre-#4733 re-extraction did (reword-still-upserts holds
    // across the upgrade boundary). Never deleted, never repointed elsewhere.
    const legacy = await engine.getPage(legacySlug, { sourceId: 'default' });
    expect(legacy).not.toBeNull();
    expect(legacy!.deleted_at ?? null).toBeNull();
    expect(legacy!.frontmatter.source_slug).toBe(sourceSlug);
    expect(legacy!.frontmatter.source_hash).toBe('bbbb333344445555');

    // NO duplicate on the locator-folded slug — pre-fix, re-extraction found
    // nothing at the new shape and minted a second atom beside the legacy one.
    const newHash = createHash('sha256').update(`${sourceSlug}\0${title}`).digest('hex').slice(0, 8);
    const newSlug = `atoms/2026-08-28/upgrade-shared-title-${newHash}`;
    expect(newSlug).not.toBe(legacySlug);
    expect(await engine.getPage(newSlug, { sourceId: 'default' })).toBeNull();
    const atoms = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages
        WHERE type = 'atom' AND frontmatter->>'source_slug' = $1 AND deleted_at IS NULL`,
      [sourceSlug],
    );
    expect(atoms[0]!.n).toBe(1);
    // Provenance edge points at the adopted legacy slug.
    const links = (await engine.getLinks(sourceSlug)).filter(l => l.link_source === 'atom-provenance');
    expect(links).toHaveLength(1);
    expect(links[0]!.to_slug).toBe(legacySlug);
  });

  test('upgrade: a legacy-slug atom bound to a DIFFERENT source page is NOT adopted — the new-shape slug lands beside it', async () => {
    const title = 'Upgrade foreign title';
    const foreignSource = 'research/2026-08-26-foreign-origin';
    const sourceSlug = 'writings/2026-08-26-adoption-guard-page';
    const legacyHash = createHash('sha256').update(title).digest('hex').slice(0, 6);
    const legacySlug = `atoms/2026-08-26/upgrade-foreign-title-${legacyHash}`;
    await engine.putPage(legacySlug, {
      type: 'atom',
      title,
      compiled_truth: 'Atom that belongs to the foreign source page.',
      timeline: '',
      frontmatter: { source_slug: foreignSource, source_hash: 'ffff000011112222', atom_type: 'insight' },
    });
    await engine.putPage(sourceSlug, {
      type: 'note', title: 'Adoption guard page', compiled_truth: 'A separately owned claim.', timeline: '',
    });

    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: sourceSlug, content: 'A separately owned claim.', contentHash: 'dddd333344445555' }],
      _chat: stubChat(title),
    });
    expect(result.status).toBe('ok');
    expect(result.details?.failures).toEqual([]);
    expect(result.details?.atoms_extracted).toBe(1);

    // The foreign-bound legacy row is untouched (the #4733 collision class).
    const legacy = await engine.getPage(legacySlug, { sourceId: 'default' });
    expect(legacy!.frontmatter.source_slug).toBe(foreignSource);
    expect(legacy!.frontmatter.source_hash).toBe('ffff000011112222');
    // The new atom lands on the locator-folded slug beside it.
    const newHash = createHash('sha256').update(`${sourceSlug}\0${title}`).digest('hex').slice(0, 8);
    const fresh = await engine.getPage(`atoms/2026-08-26/upgrade-foreign-title-${newHash}`, { sourceId: 'default' });
    expect(fresh).not.toBeNull();
    expect(fresh!.frontmatter.source_slug).toBe(sourceSlug);
  });

  test('upgrade: a pre-binding-era legacy atom (no source binding at all) is adopted and gains the binding', async () => {
    const title = 'Upgrade unbound title';
    const sourceSlug = 'writings/2026-08-25-unbound-page';
    const legacyHash = createHash('sha256').update(title).digest('hex').slice(0, 6);
    const legacySlug = `atoms/2026-08-25/upgrade-unbound-title-${legacyHash}`;
    await engine.putPage(legacySlug, {
      type: 'atom',
      title,
      compiled_truth: 'Unbound pre-binding-era atom body.',
      timeline: '',
      frontmatter: { atom_type: 'insight' },
    });
    await engine.putPage(sourceSlug, {
      type: 'note', title: 'Unbound page', compiled_truth: 'The unbound claim, revised.', timeline: '',
    });

    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: sourceSlug, content: 'The unbound claim, revised.', contentHash: 'eeee333344445555' }],
      _chat: stubChat(title),
    });
    expect(result.status).toBe('ok');
    expect(result.details?.failures).toEqual([]);
    expect(result.details?.atoms_extracted).toBe(1);

    const legacy = await engine.getPage(legacySlug, { sourceId: 'default' });
    expect(legacy).not.toBeNull();
    expect(legacy!.frontmatter.source_slug).toBe(sourceSlug); // binding gained
    expect(legacy!.frontmatter.source_hash).toBe('eeee333344445555');
    const newHash = createHash('sha256').update(`${sourceSlug}\0${title}`).digest('hex').slice(0, 8);
    expect(await engine.getPage(`atoms/2026-08-25/upgrade-unbound-title-${newHash}`, { sourceId: 'default' })).toBeNull();
  });

  test('reword-still-upserts survives: same page re-extracted after a body edit updates ONE atom', async () => {
    const sourceSlug = 'writings/2026-08-27-reword-page';
    await engine.putPage(sourceSlug, {
      type: 'note', title: 'Reword page', compiled_truth: 'Original body.', timeline: '',
    });
    await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: sourceSlug, content: 'Original body.', contentHash: 'cafe000000000001' }],
      _chat: stubChat('Reword stable title'),
    });
    // Body edit → new content hash, same title. Must upsert in place (the
    // content hash is deliberately NOT part of atom identity).
    await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: sourceSlug, content: 'Edited body.', contentHash: 'cafe000000000002' }],
      _chat: stubChat('Reword stable title'),
    });
    const atoms = await engine.executeRaw<{ slug: string; source_hash: string }>(
      `SELECT slug, frontmatter->>'source_hash' AS source_hash
         FROM pages WHERE type = 'atom' AND frontmatter->>'source_slug' = $1 AND deleted_at IS NULL`,
      [sourceSlug],
    );
    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.source_hash).toBe('cafe000000000002');
    const links = (await engine.getLinks(sourceSlug)).filter(l => l.link_source === 'atom-provenance');
    expect(links).toHaveLength(1);
  });
});

describe('provenance edges are banked BEFORE the completion flip (#4733)', () => {
  test('a provenance write failure leaves the item discoverable; the retry converges to one edge', async () => {
    const sourceSlug = 'meetings/2026-08-30-provenance-retry';
    const contentHash = '4444444444444444';
    await engine.putPage(sourceSlug, {
      type: 'meeting', title: 'Provenance retry source',
      compiled_truth: 'A retryable source claim with enough detail.', timeline: '',
    });

    const originalAddLinksBatch = engine.addLinksBatch;
    let provenanceWrites = 0;
    engine.addLinksBatch = async (links, opts) => {
      provenanceWrites++;
      if (provenanceWrites === 1) throw new Error('forced provenance write failure');
      return originalAddLinksBatch.call(engine, links, opts);
    };
    try {
      const first = await runPhaseExtractAtoms(engine, {
        _transcripts: [],
        _pages: [{ slug: sourceSlug, content: 'A retryable source claim with enough detail.', contentHash }],
        _chat: stubChat('Retryable provenance atom'),
      });
      // The failure is recorded, NOT swallowed (pre-fix: logged + flip
      // proceeded, stranding a "completed" page with zero edges forever).
      expect(first.status).toBe('warn');
      expect(first.details?.failures).toEqual([
        expect.objectContaining({
          source: sourceSlug,
          error: expect.stringContaining('forced provenance write failure'),
        }),
      ]);
      // No edge banked, and the atom's receipt NEVER flipped: the pending
      // hash keeps the item discoverable for the next run.
      expect((await engine.getLinks(sourceSlug)).filter(l => l.link_source === 'atom-provenance')).toHaveLength(0);
      const pending = await engine.executeRaw<{ source_hash: string }>(
        `SELECT frontmatter->>'source_hash' AS source_hash
           FROM pages WHERE type = 'atom' AND frontmatter->>'source_slug' = $1`,
        [sourceSlug],
      );
      expect(pending).toEqual([{ source_hash: `pending:${contentHash.slice(0, 16)}` }]);

      const retry = await runPhaseExtractAtoms(engine, {
        _transcripts: [],
        _pages: [{ slug: sourceSlug, content: 'A retryable source claim with enough detail.', contentHash }],
        _chat: stubChat('Retryable provenance atom'),
      });
      expect(retry.status).toBe('ok');
      const links = (await engine.getLinks(sourceSlug)).filter(l => l.link_source === 'atom-provenance');
      expect(links).toHaveLength(1);
      const atom = await engine.getPage(links[0]!.to_slug, { sourceId: 'default' });
      expect(atom?.frontmatter.source_hash).toBe(contentHash.slice(0, 16));
    } finally {
      engine.addLinksBatch = originalAddLinksBatch;
    }
  });
});
