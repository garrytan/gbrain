// v0.42 Type Unification (T34) — IRON RULE E2E test.
//
// Seeds a synthetic brain with all 9 clusters from issue #1479 (~30 pages
// covering tweets / articles / companies / atoms / media / analysis /
// concept-redirect / one-offs / symlinks), runs the full unify-types
// pipeline against gbrain-base-v2, and asserts:
//   - distinct types drops from ~25 to ≤16 (15 canonical + residual)
//   - alias rows created for concept-redirect pages
//   - canonical pages survive
//   - source pages soft-deleted for page-to-link + page-to-alias clusters
//   - active pack flipped
//   - wikilink resolution via slug_aliases works
//   - re-running is idempotent (total_applied: 0)

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runUnifyTypes } from '../../src/core/schema-pack/unify-types-handler.ts';
import { runAllOnboardChecks } from '../../src/core/onboard/checks.ts';
import { _resetPackCacheForTests } from '../../src/core/schema-pack/registry.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
});

function ctxOf() {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
  } as never;
}

async function seedAll9Clusters() {
  const seeds: Array<{ slug: string; type: string; body?: string; fm?: Record<string, unknown> }> = [
    // Cluster 1: tweet family (5 types)
    { slug: 'tweets/a', type: 'tweet-single' },
    { slug: 'tweets/b', type: 'tweet-thread' },
    { slug: 'tweets/c', type: 'tweet-bundle' },
    { slug: 'tweets/d', type: 'tweet-stub' },
    { slug: 'tweets/e', type: 'media/x-tweet/bundle' },
    // Cluster 2: articles (3 types → 1 with subtype + 1 → source)
    { slug: 'articles/x', type: 'article' },
    { slug: 'articles/y', type: 'media/article' },
    { slug: 'sources/z', type: 'sources/article' },
    // Cluster 3: companies (3 types → 1 with subtype)
    { slug: 'companies/x', type: 'company' },
    { slug: 'companies/y', type: 'yc-company' },
    { slug: 'companies/z', type: 'product' },
    // Cluster 4: atoms (3 types → 1 with subtype + 1 page→link)
    { slug: 'atoms/a', type: 'atom-extraction' },
    { slug: 'atoms/b', type: 'content-atom' },
    { slug: 'atoms/c', type: 'lore' },
    // Cluster 5: media (3 types → 1 with subtype)
    { slug: 'videos/x', type: 'video' },
    { slug: 'youtube/y', type: 'youtube-video' },
    { slug: 'books/z', type: 'book' },
    // Cluster 6: analysis (2 types → 1)
    { slug: 'analysis/x', type: 'media/analysis' },
    { slug: 'analysis/y', type: 'competitive-intel' },
    // Cluster 7: concept-redirect (canonical + 2 redirects)
    { slug: 'wiki/concepts/canonical', type: 'concept' },
    { slug: 'wiki/concepts/redirect-1', type: 'concept-redirect',
      body: '[[wiki/concepts/canonical]] redirect body that is long enough to pass any min-char gates' },
    { slug: 'wiki/concepts/redirect-2', type: 'concept-redirect',
      body: '[[wiki/concepts/canonical]] another redirect to the same canonical with sufficient length' },
    // Cluster 8: one-offs (4 types → all note with legacy_type)
    { slug: 'note/civic-1', type: 'civic' },
    { slug: 'note/framework-1', type: 'framework' },
    { slug: 'note/insight-1', type: 'insight' },
    { slug: 'note/memo-1', type: 'memo' },
    // Cluster 9: symlinks (already handled by page_to_link rule; need target + source)
    { slug: 'people/alice', type: 'person' },
    { slug: 'companies/acme', type: 'company' },
    { slug: 'atoms/partner-1', type: 'atom-partner-link',
      fm: { source: 'people/alice', target: 'companies/acme' } },
  ];
  for (const s of seeds) {
    await engine.putPage(s.slug, {
      title: s.slug,
      type: s.type as never,
      compiled_truth: s.body ?? 'page body that is sufficiently long to pass any minimum-length backstop guards in the codebase',
      timeline: '',
      frontmatter: s.fm ?? {},
      source_path: `${s.slug}.md`,
    });
  }
  return seeds.length;
}

describe('v0.42 type-unification E2E (IRON RULE)', () => {
  it('runs the full pipeline against a synthetic 9-cluster brain', async () => {
    const seedCount = await seedAll9Clusters();
    expect(seedCount).toBeGreaterThan(25);

    // Pre-state: many distinct types
    const preTypes = await engine.executeRaw<{ cnt: string }>(
      `SELECT COUNT(DISTINCT type)::text AS cnt FROM pages WHERE deleted_at IS NULL`,
    );
    const preDistinct = parseInt(preTypes[0].cnt, 10);
    expect(preDistinct).toBeGreaterThanOrEqual(20);

    // Onboard surfaces pack_upgrade_available
    const checks = await runAllOnboardChecks(engine);
    const packUpgrade = checks.find(c => c.check.name === 'pack_upgrade_available');
    expect(packUpgrade?.check.status).toBe('warn');
    expect(packUpgrade?.remediations[0]?.job).toBe('unify-types');

    // Dry-run
    const dryResult = await runUnifyTypes(ctxOf(), {
      target_pack: 'gbrain-base-v2',
      apply: false,
    });
    expect(dryResult.apply).toBe(false);
    expect(dryResult.per_phase.retype_explicit.would_apply).toBeGreaterThan(10);

    // Apply
    const applyResult = await runUnifyTypes(ctxOf(), {
      target_pack: 'gbrain-base-v2',
      apply: true,
    });
    expect(applyResult.apply).toBe(true);
    expect(applyResult.active_pack_flipped).toBe(true);
    expect(applyResult.pack_identity_after).toContain('gbrain-base-v2');

    // Post-state: ≤16 distinct types (15 canonical + maybe residual)
    const postTypes = await engine.executeRaw<{ cnt: string }>(
      `SELECT COUNT(DISTINCT type)::text AS cnt FROM pages WHERE deleted_at IS NULL`,
    );
    const postDistinct = parseInt(postTypes[0].cnt, 10);
    expect(postDistinct).toBeLessThanOrEqual(16);
    expect(postDistinct).toBeLessThan(preDistinct);

    // Concept-redirect pages soft-deleted
    const aliasedRedirects = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE slug LIKE 'wiki/concepts/redirect-%' AND deleted_at IS NULL`,
    );
    expect(aliasedRedirects.length).toBe(0);

    // slug_aliases rows created
    const aliasRows = await engine.executeRaw<{ alias_slug: string; canonical_slug: string }>(
      `SELECT alias_slug, canonical_slug FROM slug_aliases ORDER BY alias_slug`,
    );
    expect(aliasRows.length).toBe(2);
    expect(aliasRows[0].canonical_slug).toBe('wiki/concepts/canonical');

    // resolveSlugWithAlias short-circuits old slug to canonical
    const resolved = await engine.resolveSlugWithAlias('wiki/concepts/redirect-1', 'default');
    expect(resolved).toBe('wiki/concepts/canonical');

    // atom-partner-link converted to real link row
    const linkRows = await engine.executeRaw<{ link_type: string }>(
      `SELECT l.link_type FROM links l
       JOIN pages p1 ON l.from_page_id = p1.id
       JOIN pages p2 ON l.to_page_id = p2.id
       WHERE p1.slug = 'people/alice' AND p2.slug = 'companies/acme'
         AND l.link_source = 'manual'`,
    );
    expect(linkRows.length).toBe(1);
    expect(linkRows[0].link_type).toBe('partner_of');

    // Onboard checks clear post-unify
    const checksAfter = await runAllOnboardChecks(engine);
    const packUpgradeAfter = checksAfter.find(c => c.check.name === 'pack_upgrade_available');
    expect(packUpgradeAfter?.check.status).toBe('ok');
    const typeProlifAfter = checksAfter.find(c => c.check.name === 'type_proliferation');
    expect(typeProlifAfter?.check.status).toBe('ok');

    // Idempotency: re-running is no-op
    const idempResult = await runUnifyTypes(ctxOf(), {
      target_pack: 'gbrain-base-v2',
      apply: true,
    });
    expect(idempResult.per_phase.retype_explicit.applied).toBe(0);
    expect(idempResult.per_phase.page_to_alias.aliased).toBe(0);
    expect(idempResult.per_phase.page_to_link.converted).toBe(0);
  });

  it('canonical pages preserve their type identity', async () => {
    // After unify, key reference pages keep their canonical types.
    await seedAll9Clusters();
    await runUnifyTypes(ctxOf(), {
      target_pack: 'gbrain-base-v2',
      apply: true,
    });
    const ppl = await engine.executeRaw<{ type: string }>(
      `SELECT type FROM pages WHERE slug = 'people/alice' AND deleted_at IS NULL`,
    );
    expect(ppl[0].type).toBe('person');
    const co = await engine.executeRaw<{ type: string }>(
      `SELECT type FROM pages WHERE slug = 'companies/acme' AND deleted_at IS NULL`,
    );
    expect(co[0].type).toBe('company');
    const conc = await engine.executeRaw<{ type: string }>(
      `SELECT type FROM pages WHERE slug = 'wiki/concepts/canonical' AND deleted_at IS NULL`,
    );
    expect(conc[0].type).toBe('concept');
  });

  it('legacy_type frontmatter enables per-page rollback (D8)', async () => {
    await seedAll9Clusters();
    await runUnifyTypes(ctxOf(), {
      target_pack: 'gbrain-base-v2',
      apply: true,
    });
    // Pick one retyped page and verify legacy_type
    const rows = await engine.executeRaw<{ slug: string; type: string; frontmatter: Record<string, unknown> }>(
      `SELECT slug, type, frontmatter FROM pages
       WHERE slug = 'tweets/a' AND deleted_at IS NULL`,
    );
    expect(rows[0].type).toBe('tweet');
    expect(rows[0].frontmatter.legacy_type).toBe('tweet-single');
    // Rollback would be: UPDATE pages SET type = frontmatter->>'legacy_type'
    // — this is verified semantically by the value being preserved.
  });
});
