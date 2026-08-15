/**
 * #2576 (bug 2) — link extraction must not silently drop edges for
 * non-whitelisted directories.
 *
 * The hardcoded DIR_PATTERN whitelist gated three reference shapes on the
 * DB-source path (extractPageLinks): markdown links, bare-slug prose refs,
 * and (via the pass-2c flag gate) slash-shaped wikilinks. A brain with an
 * `ops/` directory (or any user-invented dir a custom schema pack declares)
 * had 5 of 6 reference shapes DROPPED with no counter — while identical
 * `people/` references resolved in all 6.
 *
 * Post-fix, extraction emits candidates for ANY dir-shaped path and relies
 * on the page-existence checks every persist path already runs
 * (resolveCandidateSources in extract.ts, put_page's allSlugs filter,
 * addLinksBatch's INNER JOINs). These tests exercise the pure extraction
 * core the DB paths (`extract --stale`, `extract links --source db`,
 * put_page auto-link) all share — every "ops" case below FAILS on master.
 */

import { describe, test, expect } from 'bun:test';
import {
  extractPageLinks,
  extractEntityRefs,
  LINK_EXTRACTOR_VERSION_TS,
  type SlugResolver,
} from '../src/core/link-extraction.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

/** Resolver backed by a fixed slug set, tail-keyed like makeResolver's index. */
function setResolver(slugs: string[]): SlugResolver {
  return {
    resolve: async () => null,
    resolveBasenameMatches: async (name: string) =>
      slugs.filter(s => s.slice(s.lastIndexOf('/') + 1) === name),
  };
}

describe('#2576 bug 2 — non-whitelisted dirs produce candidates (ops/ = people/ parity)', () => {
  test('markdown link into ops/ produces a typed candidate (was: dropped)', async () => {
    const { candidates } = await extractPageLinks(
      'notes/index', '[Pointer](../ops/services/pointer-agent.md) runs the fleet.',
      {}, 'concept', nullResolver, { skipFrontmatter: true },
    );
    const c = candidates.find(x => x.targetSlug === 'ops/services/pointer-agent');
    expect(c).toBeDefined();
    expect(c!.linkSource).toBe('markdown');
    expect(c!.linkType).toBe('mentions');
  });

  test('bare-slug prose ref into ops/ produces a candidate (was: dropped)', async () => {
    const { candidates } = await extractPageLinks(
      'notes/index', 'see ops/services/pointer-agent for details.',
      {}, 'concept', nullResolver, { skipFrontmatter: true },
    );
    expect(candidates.map(c => c.targetSlug)).toContain('ops/services/pointer-agent');
  });

  test('[[ops/...]] wikilink with global_basename OFF produces a typed candidate (was: dropped)', async () => {
    const { candidates } = await extractPageLinks(
      'notes/index', '[[ops/services/pointer-agent]] runs the fleet.',
      {}, 'concept', nullResolver, { skipFrontmatter: true },
    );
    const c = candidates.find(x => x.targetSlug === 'ops/services/pointer-agent');
    expect(c).toBeDefined();
    expect(c!.linkSource).toBe('markdown');
  });

  test('[[ops/...]] with global_basename ON yields ONE typed candidate, not a wikilink_basename demotion', async () => {
    const resolver = setResolver(['ops/services/pointer-agent']);
    const { candidates } = await extractPageLinks(
      'notes/index', '[[ops/services/pointer-agent]] runs the fleet.',
      {}, 'concept', resolver, { skipFrontmatter: true, globalBasename: true },
    );
    const hits = candidates.filter(c => c.targetSlug === 'ops/services/pointer-agent');
    expect(hits).toHaveLength(1);
    expect(hits[0].linkType).toBe('mentions');       // typed, like people/
    expect(hits[0].linkSource).toBe('markdown');     // NOT 'wikilink-resolved'
  });

  test('verb inference works for non-whitelisted dirs (typed edge, not just mentions)', async () => {
    const { candidates } = await extractPageLinks(
      'people/carol', 'Carol founded [Widget Co](../startups/widget-co.md) in 2024.',
      {}, 'person', nullResolver, { skipFrontmatter: true },
    );
    const c = candidates.find(x => x.targetSlug === 'startups/widget-co');
    expect(c).toBeDefined();
    expect(c!.linkType).toBe('founded');
  });

  test('extractEntityRefs surfaces non-whitelisted markdown refs', () => {
    const refs = extractEntityRefs('[Pointer](ops/services/pointer-agent)');
    expect(refs.map(r => r.slug)).toContain('ops/services/pointer-agent');
  });

  // ── regression pins: what must NOT change ─────────────────────────────

  test('suffix rescue is preserved: [[notes/struktura]] still finds vault/notes/struktura (flag ON)', async () => {
    const resolver = setResolver(['vault/notes/struktura', 'wiki/struktura']);
    const { candidates } = await extractPageLinks(
      'concepts/x', 'See [[notes/struktura]].',
      {}, 'concept', resolver, { skipFrontmatter: true, globalBasename: true },
    );
    const rescue = candidates.find(c => c.targetSlug === 'vault/notes/struktura');
    expect(rescue).toBeDefined();
    expect(rescue!.linkType).toBe('wikilink_basename');
    // wiki/struktura does not end with the written path — still excluded.
    expect(candidates.map(c => c.targetSlug)).not.toContain('wiki/struktura');
  });

  test('slash-shaped self-link is never emitted', async () => {
    const { candidates } = await extractPageLinks(
      'ops/runbook', 'See [[ops/runbook]] for the checklist.',
      {}, 'concept', nullResolver, { skipFrontmatter: true },
    );
    expect(candidates).toEqual([]);
  });

  test('bare [[name]] wikilinks (no slash) keep the flag-gated behavior', async () => {
    const resolver = setResolver(['projects/struktura']);
    const off = await extractPageLinks(
      'concepts/x', 'This relates to [[struktura]].',
      {}, 'concept', resolver, { skipFrontmatter: true },
    );
    expect(off.candidates).toEqual([]);
    const on = await extractPageLinks(
      'concepts/x', 'This relates to [[struktura]].',
      {}, 'concept', resolver, { skipFrontmatter: true, globalBasename: true },
    );
    expect(on.candidates.map(c => c.targetSlug)).toEqual(['projects/struktura']);
    expect(on.candidates[0].linkType).toBe('wikilink_basename');
  });

  test('LINK_EXTRACTOR_VERSION_TS was bumped so stamped pages re-extract', () => {
    // Pages stamped by pre-fix sweeps had their non-whitelisted-dir edges
    // silently dropped; the watermark bump re-flags them as stale.
    expect(LINK_EXTRACTOR_VERSION_TS > '2026-07-10T00:00:00Z').toBe(true);
  });
});
