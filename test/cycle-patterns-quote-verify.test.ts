/**
 * The patterns phase grounds quotes on the pattern pages its subagent wrote
 * against the full reflection pages, right after the writes and before
 * provenance stamping. A pattern page an earlier crashed run left without
 * `quote_verified_at` is verified on the next run. Quotes only: a pattern
 * counts its evidence, so numbers are not checked. Opt-in: dream.quote_verify
 * (default off).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { groundPatternPages } from '../src/core/cycle/patterns.ts';
import { CLAIM_SOURCES_KEY, dedupePatternClaimSources, resolveClaimSources } from '../src/core/cycle/pattern-claim-sources.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('dream.quote_verify', 'true');
  for (const [slug, body] of [
    ['wiki/personal/reflections/r1', 'I keep saying "ship smaller pieces" when projects stall.'],
    ['wiki/personal/reflections/r2', 'Again I told myself to ship smaller pieces.'],
  ]) await importFromContent(engine, slug!, `---\ntype: note\ntitle: ${slug}\n---\n${body}\n`, { noEmbed: true, sourceId: 'default' });
  await importFromContent(engine, 'wiki/personal/patterns/small-pieces',
    '---\ntype: note\ntitle: Small pieces\ndream_generated: true\n---\nAcross 2 reflections you repeat "ship smaller pieces".\n\nYou also wrote "never ship on Fridays".\n',
    { noEmbed: true, sourceId: 'default' });
});
afterAll(async () => { await engine.disconnect(); });

describe('patterns quote grounding', () => {
  test('an unverified quote moves to unverified_claims; a leftover page is picked up; counts stay', async () => {
    const reflections = [
      { slug: 'wiki/personal/reflections/r1', title: 'r1', excerpt: '', updatedAt: new Date(), seat: null },
      { slug: 'wiki/personal/reflections/r2', title: 'r2', excerpt: '', updatedAt: new Date(), seat: null },
    ];
    const stats = await groundPatternPages(engine, null, [], reflections, 'wiki/personal/patterns', 'default', '2026-10-04');
    expect(stats).toEqual({ pages: 1, quarantined: 1, repaired: 0 });
    const page = await engine.getPage('wiki/personal/patterns/small-pieces');
    expect(page!.compiled_truth).toContain('Across 2 reflections');
    expect(page!.compiled_truth).not.toContain('never ship on Fridays');
    expect(page!.frontmatter.quote_verified_at).toBe('2026-10-04');
    expect((page!.frontmatter.unverified_claims as unknown[]).length).toBe(1);
    const again = await groundPatternPages(engine, null, [], reflections, 'wiki/personal/patterns', 'default', '2026-10-05');
    expect(again).toEqual({ pages: 0, quarantined: 0, repaired: 0 });
  });

  test('#6236: a quarantined claim references the page\'s shared reflection list instead of carrying it, losslessly', async () => {
    await importFromContent(engine, 'wiki/personal/patterns/fridays',
      '---\ntype: note\ntitle: Fridays\ndream_generated: true\n---\nYou wrote "never ship on Fridays" and "always test first".\n',
      { noEmbed: true, sourceId: 'default' });
    const reflections = ['r1', 'r2'].map(r => ({ slug: `wiki/personal/reflections/${r}`, title: r, excerpt: '', updatedAt: new Date(), seat: null }));
    await groundPatternPages(engine, null, [{ slug: 'wiki/personal/patterns/fridays', source_id: 'default' }], reflections, 'wiki/personal/patterns', 'default', '2026-10-06');
    const fm = (await engine.getPage('wiki/personal/patterns/fridays'))!.frontmatter as Record<string, unknown>;
    const claims = fm.unverified_claims as Array<{ sources: string[] }>;
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim.sources).toHaveLength(1);
      expect(resolveClaimSources(fm, claim)).toEqual(reflections.map(r => r.slug));
    }
    expect(Object.keys(fm[CLAIM_SOURCES_KEY] as object)).toHaveLength(1);
  });

  test('#6236: a page written with inline reflection lists is de-duplicated before the child runs, body untouched', async () => {
    const list = Array.from({ length: 100 }, (_, i) => `wiki/personal/reflections/x${i}`);
    const claims = Array.from({ length: 5 }, (_, i) => `  - text: claim ${i}\n    reason: quote_not_in_source\n    sources:\n${list.map(p => `      - ${p}`).join('\n')}`).join('\n');
    await importFromContent(engine, 'wiki/personal/patterns/legacy',
      `---\ntype: note\ntitle: Legacy\ndream_generated: true\nquote_verified_at: '2026-10-01'\nunverified_claims:\n${claims}\n---\nA legacy pattern body.\n`,
      { noEmbed: true, sourceId: 'default' });
    const before = (await engine.getPage('wiki/personal/patterns/legacy'))!;
    const result = await dedupePatternClaimSources(engine, null, 'wiki/personal/patterns', 'default');
    expect(result.rewritten).toEqual(['wiki/personal/patterns/legacy']);
    expect(result.held).toEqual([]);
    const after = (await engine.getPage('wiki/personal/patterns/legacy'))!;
    expect(after.compiled_truth).toBe(before.compiled_truth);
    const fm = after.frontmatter as Record<string, unknown>;
    for (const claim of fm.unverified_claims as Array<{ sources: string[] }>) expect(resolveClaimSources(fm, claim)).toEqual(list);
    expect(JSON.stringify(fm).length).toBeLessThan(JSON.stringify(before.frontmatter).length / 3);
    expect((await dedupePatternClaimSources(engine, null, 'wiki/personal/patterns', 'default')).rewritten).toEqual([]);
  });
});
