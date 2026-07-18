import { describe, test, expect } from 'bun:test';
import {
  extractEntityRefs,
  extractPageLinks,
  isAnyDirExactPathEnabled,
  makeResolver,
  type SlugResolver,
} from '../src/core/link-extraction.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// ─── Issue #1493: generalized path resolution ─────────────────────
//
// Path-shaped wikilinks ([[dir/name]], [[dir/sub/name]]) whose top-level
// directory is NOT in the DIR_PATTERN whitelist used to be dropped
// silently — no candidate, no unresolved report. They now extract via the
// 2a'/2b' passes (tagged `exactPath: true`) and resolve by EXACT slug
// match against existing pages. On by default
// (link_resolution.any_dir_exact_path); misses are recorded in the
// unresolved report as field='wikilink'.

// ─── extractEntityRefs — passes 2a'/2b' ───────────────────────────

describe('extractEntityRefs — any-dir path-shaped wikilinks (#1493)', () => {
  test('2-segment path outside the whitelist extracts with exactPath flag', () => {
    const refs = extractEntityRefs('See [[janus/foo]] for context.');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('janus/foo');
    expect(refs[0].dir).toBe('janus');
    expect(refs[0].exactPath).toBe(true);
    // NOT the #972 basename pass — that one carries needsResolution.
    expect(refs[0].needsResolution).toBeUndefined();
  });

  test('deep nesting: [[janus/agents/drift-check]]', () => {
    const refs = extractEntityRefs('Owned by [[janus/agents/drift-check]].');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('janus/agents/drift-check');
    expect(refs[0].dir).toBe('janus');
    expect(refs[0].exactPath).toBe(true);
  });

  test('hyphenated directory: [[janus-ui/docs/tier2-agent-plan]]', () => {
    const refs = extractEntityRefs('Plan: [[janus-ui/docs/tier2-agent-plan]].');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('janus-ui/docs/tier2-agent-plan');
    expect(refs[0].dir).toBe('janus-ui');
  });

  test('alias form: [[janus/foo|Display]] keeps target, uses display name', () => {
    const refs = extractEntityRefs('See [[janus/foo|Display]].');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('janus/foo');
    expect(refs[0].name).toBe('Display');
  });

  test('fragment stripped: [[janus/foo#section]]', () => {
    const refs = extractEntityRefs('Jump to [[janus/foo#section]].');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('janus/foo');
  });

  test('.md suffix stripped: [[janus/foo.md]]', () => {
    const refs = extractEntityRefs('See [[janus/foo.md]].');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('janus/foo');
  });

  test('dotted segments survive when not a .md suffix: [[notes/v1.0.0]]', () => {
    const refs = extractEntityRefs('Released [[notes/v1.0.0]].');
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('notes/v1.0.0');
  });

  test('qualified variant: [[src:janus/foo]] carries sourceId + exactPath', () => {
    const refs = extractEntityRefs('See [[src:janus/foo]].');
    expect(refs.length).toBe(1);
    expect(refs[0]).toMatchObject({
      slug: 'janus/foo', dir: 'janus', sourceId: 'src', exactPath: true,
    });
  });

  test('qualified whitelist links still go through the 2a pass unchanged', () => {
    // [[wiki:concepts/ai]] is 2a territory (whitelisted dir) — must not be
    // double-emitted by the new 2a' pass.
    const refs = extractEntityRefs('Ref: [[wiki:concepts/ai]]');
    expect(refs.length).toBe(1);
    expect(refs[0].sourceId).toBe('wiki');
    expect(refs[0].exactPath).toBeUndefined();
  });

  test('wikilinks inside fenced and inline code are ignored', () => {
    const refs = extractEntityRefs(
      '```\n[[janus/in-fence]]\n```\nInline `[[janus/in-tick]]` too.\nReal: [[janus/real]].',
    );
    expect(refs.length).toBe(1);
    expect(refs[0].slug).toBe('janus/real');
  });

  test('URLs are not matched', () => {
    const refs = extractEntityRefs('See [[https://example.com/foo]] and https://example.com/bar.');
    expect(refs.filter(r => r.exactPath)).toEqual([]);
  });

  test('uppercase target is NOT path-shaped (slug grammar is lowercase) — falls to the generic pass', () => {
    // Engine slugs are lowercase (sync.ts slugifySegment). [[Janus/Foo]] is
    // not a canonical slug, so it keeps the pre-#1493 behavior: generic
    // pass 2c (needsResolution — basename resolution or silent drop).
    const refs = extractEntityRefs('See [[Janus/Foo]].');
    expect(refs.length).toBe(1);
    expect(refs[0].exactPath).toBeUndefined();
    expect(refs[0].needsResolution).toBe(true);
    expect(refs[0].slug).toBe('Janus/Foo');
  });

  test('whitelisted dirs keep their existing pass (no exactPath tag)', () => {
    const refs = extractEntityRefs('See [[people/alice]] and [[janus/foo]].');
    const alice = refs.find(r => r.slug === 'people/alice');
    const janus = refs.find(r => r.slug === 'janus/foo');
    expect(alice).toBeDefined();
    expect(alice!.exactPath).toBeUndefined();
    expect(janus).toBeDefined();
    expect(janus!.exactPath).toBe(true);
    expect(refs.length).toBe(2); // no double emission
  });

  test('bare-name #972 pass is unaffected', () => {
    const refs = extractEntityRefs('See [[struktura]] and [[janus/foo]].');
    const bare = refs.find(r => r.slug === 'struktura');
    expect(bare).toBeDefined();
    expect(bare!.needsResolution).toBe(true);
    expect(bare!.exactPath).toBeUndefined();
  });

  test('a path wikilink inside a markdown-link label is inert (mirrors codex P2a)', () => {
    const refs = extractEntityRefs('[see [[janus/foo]]](companies/acme.md)');
    expect(refs.filter(r => r.exactPath)).toEqual([]);
  });
});

// ─── extractPageLinks — exact-slug resolution + unresolved report ──

/** Resolver fixture backed by an explicit slug set (mirrors makeResolver's slugExists). */
function makeExistsResolver(slugs: string[]): SlugResolver {
  const set = new Set(slugs);
  return {
    resolve: async () => null,
    slugExists: async (slug: string) => set.has(slug),
  };
}

describe('extractPageLinks — any-dir exact-path resolution (#1493)', () => {
  test('existing path target emits a candidate like a whitelisted wikilink', async () => {
    const resolver = makeExistsResolver(['janus/agents/drift-check']);
    const { candidates, unresolved } = await extractPageLinks(
      'concepts/x', 'Owned by [[janus/agents/drift-check]].',
      {}, 'concept', resolver,
    );
    expect(candidates.length).toBe(1);
    expect(candidates[0].targetSlug).toBe('janus/agents/drift-check');
    // Same treatment as whitelisted refs: verb-inferred type + markdown
    // provenance (NOT the #972 wikilink_basename/wikilink-resolved pair).
    expect(candidates[0].linkType).toBe('mentions');
    expect(candidates[0].linkSource).toBe('markdown');
    expect(unresolved).toEqual([]);
  });

  test('missing path target is RECORDED as unresolved, never a ghost edge', async () => {
    const resolver = makeExistsResolver([]);
    const { candidates, unresolved } = await extractPageLinks(
      'concepts/x', 'See [[janus/never-existed]].',
      {}, 'concept', resolver,
    );
    expect(candidates).toEqual([]);
    expect(unresolved).toEqual([{ field: 'wikilink', name: 'janus/never-existed' }]);
  });

  test('repeated misses of the same target dedup to one unresolved entry', async () => {
    const resolver = makeExistsResolver([]);
    const { unresolved } = await extractPageLinks(
      'concepts/x', 'See [[janus/gone]] and again [[janus/gone]].',
      {}, 'concept', resolver,
    );
    expect(unresolved).toEqual([{ field: 'wikilink', name: 'janus/gone' }]);
  });

  test('opts.anyDirExactPath false restores the legacy silent drop', async () => {
    const resolver = makeExistsResolver(['janus/foo']);
    const { candidates, unresolved } = await extractPageLinks(
      'concepts/x', 'See [[janus/foo]].',
      {}, 'concept', resolver, { anyDirExactPath: false },
    );
    expect(candidates).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  test('resolver without slugExists emits unverified (caller dead-link filter applies)', async () => {
    // extract --stale runs a nullResolver with no slugExists — candidates
    // must still come out so resolveCandidateSources can endpoint-check
    // them, the same protection whitelisted refs rely on.
    const resolver: SlugResolver = { resolve: async () => null };
    const { candidates, unresolved } = await extractPageLinks(
      'concepts/x', 'See [[janus/foo]].',
      {}, 'concept', resolver,
    );
    expect(candidates.length).toBe(1);
    expect(candidates[0].targetSlug).toBe('janus/foo');
    expect(unresolved).toEqual([]);
  });

  test('qualified path ref skips slugExists (cross-source target) and emits', async () => {
    // [[src:janus/foo]] pins a target that may live in a DIFFERENT source;
    // the resolver's snapshot is scoped to this source, so existence is the
    // caller's cross-source endpoint check — even a resolver that says
    // "does not exist here" must not block it.
    const resolver = makeExistsResolver([]);
    const { candidates, unresolved } = await extractPageLinks(
      'concepts/x', 'See [[src:janus/foo]].',
      {}, 'concept', resolver,
    );
    expect(candidates.length).toBe(1);
    expect(candidates[0].targetSlug).toBe('janus/foo');
    expect(unresolved).toEqual([]);
  });

  test('alias + fragment + .md forms all resolve to the same page', async () => {
    const resolver = makeExistsResolver(['janus/foo']);
    const { candidates } = await extractPageLinks(
      'concepts/x',
      'A [[janus/foo|Display]] B [[janus/foo#section]] C [[janus/foo.md]].',
      {}, 'concept', resolver,
    );
    // Within-page dedup collapses the three mentions to one candidate.
    expect(candidates.length).toBe(1);
    expect(candidates[0].targetSlug).toBe('janus/foo');
  });

  test('whitelisted dirs behave exactly as before (no existence gate at this layer)', async () => {
    // Whitelisted refs are emitted unverified — callers filter. The #1493
    // pass must not change that, even with a resolver that would say no.
    const resolver = makeExistsResolver([]);
    const { candidates, unresolved } = await extractPageLinks(
      'concepts/x', 'See [[people/alice]].',
      {}, 'concept', resolver,
    );
    expect(candidates.length).toBe(1);
    expect(candidates[0].targetSlug).toBe('people/alice');
    expect(unresolved).toEqual([]);
  });

  test('#972 bare-name pass composes: basename resolution still works alongside', async () => {
    const resolver: SlugResolver = {
      resolve: async () => null,
      slugExists: async (slug) => slug === 'janus/foo',
      resolveBasenameMatches: async (name) =>
        name === 'struktura' ? ['projects/struktura'] : [],
    };
    const { candidates } = await extractPageLinks(
      'concepts/x', 'See [[janus/foo]] and [[struktura]].',
      {}, 'concept', resolver, { globalBasename: true },
    );
    const exact = candidates.find(c => c.targetSlug === 'janus/foo');
    const basename = candidates.find(c => c.targetSlug === 'projects/struktura');
    expect(exact).toBeDefined();
    expect(exact!.linkSource).toBe('markdown');
    expect(basename).toBeDefined();
    expect(basename!.linkType).toBe('wikilink_basename');
    expect(basename!.linkSource).toBe('wikilink-resolved');
  });

  test('uppercase path target goes to the generic pass, not exact-path (documented behavior)', async () => {
    // [[Janus/Foo]] is not a canonical slug. With globalBasename off
    // (default) it drops silently exactly as before #1493 — it is NOT
    // recorded as a wikilink miss because it never entered the exact-path
    // pass. (The #2868 line of work covers slugify-before-match.)
    const resolver = makeExistsResolver(['janus/foo']);
    const { candidates, unresolved } = await extractPageLinks(
      'concepts/x', 'See [[Janus/Foo]].',
      {}, 'concept', resolver,
    );
    expect(candidates).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  test('frontmatter is parsed out before extraction ever sees it (put_page layering)', async () => {
    // put_page extracts over compiled_truth + timeline, which parseMarkdown
    // produces AFTER gray-matter removes the frontmatter block. A wikilink
    // inside frontmatter therefore never reaches the extractor as body text.
    const raw = [
      '---',
      'title: X',
      'related: "[[janus/from-frontmatter]]"',
      '---',
      '',
      'Body links [[janus/from-body]].',
    ].join('\n');
    const parsed = parseMarkdown(raw, 'concepts/x.md');
    expect(parsed.compiled_truth).not.toContain('janus/from-frontmatter');
    const resolver = makeExistsResolver(['janus/from-body', 'janus/from-frontmatter']);
    const { candidates } = await extractPageLinks(
      'concepts/x', parsed.compiled_truth + '\n' + parsed.timeline,
      parsed.frontmatter, 'concept', resolver, { skipFrontmatter: true },
    );
    expect(candidates.map(c => c.targetSlug)).toEqual(['janus/from-body']);
  });
});

// ─── makeResolver.slugExists ──────────────────────────────────────

describe('makeResolver — slugExists (#1493)', () => {
  function makeFakeEngineWithSlugs(slugs: string[]): BrainEngine {
    let getAllCalls = 0;
    const engine = {
      async getPage() { return null; },
      async findByTitleFuzzy() { return null; },
      async searchKeyword() { return []; },
      async getAllSlugs() {
        getAllCalls++;
        return new Set(slugs);
      },
    } as unknown as BrainEngine;
    (engine as any)._counts = () => ({ getAllCalls });
    return engine;
  }

  test('exact match hits, near-miss does not', async () => {
    const r = makeResolver(makeFakeEngineWithSlugs(['janus/agents/drift-check']));
    expect(await r.slugExists!('janus/agents/drift-check')).toBe(true);
    expect(await r.slugExists!('janus/agents/drift')).toBe(false);
    expect(await r.slugExists!('drift-check')).toBe(false);
    expect(await r.slugExists!('')).toBe(false);
  });

  test('shares one getAllSlugs snapshot with resolveBasenameMatches', async () => {
    const engine = makeFakeEngineWithSlugs(['janus/foo', 'projects/struktura']);
    const r = makeResolver(engine);
    await r.slugExists!('janus/foo');
    await r.resolveBasenameMatches!('struktura');
    await r.slugExists!('janus/foo');
    expect((engine as any)._counts().getAllCalls).toBe(1);
  });

  test('scopes the snapshot by sourceId (no cross-source exact match)', async () => {
    const bySource: Record<string, string[]> = {
      'src-a': ['janus/foo'],
      'src-b': ['janus/bar'],
    };
    const engine = {
      async getPage() { return null; },
      async findByTitleFuzzy() { return null; },
      async searchKeyword() { return []; },
      async getAllSlugs(opts?: { sourceId?: string }) {
        const sid = opts?.sourceId;
        return new Set(sid ? (bySource[sid] ?? []) : Object.values(bySource).flat());
      },
    } as unknown as BrainEngine;
    const r = makeResolver(engine, { mode: 'batch', sourceId: 'src-a' });
    expect(await r.slugExists!('janus/foo')).toBe(true);
    expect(await r.slugExists!('janus/bar')).toBe(false);
  });

  test('degrades to false when getAllSlugs is missing', async () => {
    const engine = {
      async getPage() { return null; },
      async findByTitleFuzzy() { return null; },
      async searchKeyword() { return []; },
    } as unknown as BrainEngine;
    const r = makeResolver(engine);
    expect(await r.slugExists!('janus/foo')).toBe(false);
  });
});

// ─── isAnyDirExactPathEnabled ─────────────────────────────────────

describe('isAnyDirExactPathEnabled', () => {
  function makeFakeEngine(configMap: Map<string, string | null>): BrainEngine {
    return {
      getConfig: async (key: string) => configMap.get(key) ?? null,
    } as unknown as BrainEngine;
  }

  test('null/undefined -> true (default ON — exact match cannot false-positive)', async () => {
    expect(await isAnyDirExactPathEnabled(makeFakeEngine(new Map()))).toBe(true);
  });

  test('"false"/"0"/"no"/"off" -> false', async () => {
    for (const v of ['false', '0', 'no', 'off', '  False  ']) {
      const engine = makeFakeEngine(new Map([['link_resolution.any_dir_exact_path', v]]));
      expect(await isAnyDirExactPathEnabled(engine)).toBe(false);
    }
  });

  test('"true" and garbage -> true (fail-safe to default, like auto_link)', async () => {
    for (const v of ['true', '1', 'garbage']) {
      const engine = makeFakeEngine(new Map([['link_resolution.any_dir_exact_path', v]]));
      expect(await isAnyDirExactPathEnabled(engine)).toBe(true);
    }
  });

  test('env var override wins over DB config', async () => {
    const engine = makeFakeEngine(new Map([['link_resolution.any_dir_exact_path', 'true']]));
    process.env.GBRAIN_LINK_RESOLUTION_ANY_DIR_EXACT_PATH = 'off';
    try {
      expect(await isAnyDirExactPathEnabled(engine)).toBe(false);
    } finally {
      delete process.env.GBRAIN_LINK_RESOLUTION_ANY_DIR_EXACT_PATH;
    }
  });
});
