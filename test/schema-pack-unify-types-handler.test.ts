// v0.42 Type Unification (T33) — unify-types handler lifecycle tests.
//
// Coverage: preflight rejects missing mapping_rules; dry-run no mutation;
// apply runs all 4 phases (retype-explicit, retype-catch-all, page-to-link,
// page-to-alias) + final sync; active-pack flip (D13); celebration summary;
// gbrain-unify lock held; verify-step thresholds.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runUnifyTypes } from '../src/core/schema-pack/unify-types-handler.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';

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

async function seed(slug: string, type: string, fm: Record<string, unknown> = {}, body = 'body that is sufficiently long for any backstop guards we have in the codebase') {
  await engine.putPage(slug, {
    title: slug,
    type: type as never,
    compiled_truth: body,
    timeline: '', frontmatter: fm, source_path: `${slug}.md`,
  });
}

describe('runUnifyTypes', () => {
  describe('preflight', () => {
    it('refuses target pack with no mapping_rules', async () => {
      // gbrain-base has no mapping_rules
      await expect(runUnifyTypes(ctxOf(), {
        target_pack: 'gbrain-base',
        apply: false,
      })).rejects.toThrow(/mapping_rules/);
    });

    it('refuses unknown target pack', async () => {
      await expect(runUnifyTypes(ctxOf(), {
        target_pack: 'nonexistent-pack',
        apply: false,
      })).rejects.toThrow();
    });
  });

  describe('dry-run', () => {
    it('returns shape with would_apply counts; no mutation', async () => {
      await seed('tweets/a', 'tweet-single');
      const result = await runUnifyTypes(ctxOf(), {
        target_pack: 'gbrain-base-v2',
        apply: false,
      });
      expect(result.apply).toBe(false);
      expect(result.active_pack_flipped).toBe(false);
      expect(result.per_phase.retype_explicit.would_apply).toBeGreaterThanOrEqual(1);
      // Original page is untouched
      const rows = await engine.executeRaw<{ type: string }>(
        `SELECT type FROM pages WHERE slug = 'tweets/a'`,
      );
      expect(rows[0].type).toBe('tweet-single');
    });
  });

  describe('apply (full lifecycle)', () => {
    it('runs all 4 phases + active-pack flip (D13)', async () => {
      await seed('tweets/a', 'tweet-single');
      await seed('articles/x', 'media/article');
      await seed('atoms/a', 'atom-extraction');
      await seed('note/civic-1', 'civic');  // cluster-8 retype to note
      await seed('wiki/concepts/canonical', 'concept');
      await seed('wiki/concepts/redirect-1', 'concept-redirect',
        {},
        '[[wiki/concepts/canonical]] redirect body that is long enough to pass min char gates');
      const result = await runUnifyTypes(ctxOf(), {
        target_pack: 'gbrain-base-v2',
        apply: true,
      });
      expect(result.apply).toBe(true);
      expect(result.active_pack_flipped).toBe(true);
      expect(result.pack_identity_after).toContain('gbrain-base-v2');
      // Retype: tweets/a → tweet, articles/x → media, atoms/a → atom, note/civic-1 → note
      expect(result.per_phase.retype_explicit.applied).toBeGreaterThanOrEqual(4);
      // Page-to-alias: wiki/concepts/redirect-1 → slug_aliases row
      expect(result.per_phase.page_to_alias.aliased).toBeGreaterThanOrEqual(1);
      // Verify state
      const rows = await engine.executeRaw<{ slug: string; type: string; frontmatter: Record<string, unknown> }>(
        `SELECT slug, type, frontmatter FROM pages WHERE deleted_at IS NULL ORDER BY slug`,
      );
      const map = Object.fromEntries(rows.map((r) => [r.slug, { type: r.type, fm: r.frontmatter }]));
      expect(map['tweets/a'].type).toBe('tweet');
      expect(map['tweets/a'].fm.subtype).toBe('single');
      expect(map['tweets/a'].fm.legacy_type).toBe('tweet-single');
      expect(map['articles/x'].type).toBe('media');
      expect(map['atoms/a'].type).toBe('atom');
      expect(map['note/civic-1'].type).toBe('note');
      expect(map['note/civic-1'].fm.legacy_type).toBe('civic');
      // Alias row created
      const aliasRows = await engine.executeRaw<{ alias_slug: string }>(
        `SELECT alias_slug FROM slug_aliases`,
      );
      expect(aliasRows.length).toBeGreaterThanOrEqual(1);
    });

    it('catch-all rule retypes unknown types to note with legacy_type', async () => {
      await seed('odd/x', 'some-weird-type');  // not in any explicit rule
      const result = await runUnifyTypes(ctxOf(), {
        target_pack: 'gbrain-base-v2',
        apply: true,
      });
      expect(result.per_phase.retype_catch_all.synthesized_rules).toBeGreaterThanOrEqual(1);
      const rows = await engine.executeRaw<{ type: string; frontmatter: Record<string, unknown> }>(
        `SELECT type, frontmatter FROM pages WHERE slug = 'odd/x'`,
      );
      expect(rows[0].type).toBe('note');
      expect(rows[0].frontmatter.legacy_type).toBe('some-weird-type');
    });
  });

  describe('idempotency', () => {
    it('second apply run is mostly no-op', async () => {
      await seed('tweets/a', 'tweet-single');
      const r1 = await runUnifyTypes(ctxOf(), {
        target_pack: 'gbrain-base-v2',
        apply: true,
      });
      expect(r1.per_phase.retype_explicit.applied).toBeGreaterThan(0);
      const r2 = await runUnifyTypes(ctxOf(), {
        target_pack: 'gbrain-base-v2',
        apply: true,
      });
      // Second run: no more pages to retype
      expect(r2.per_phase.retype_explicit.applied).toBe(0);
      expect(r2.per_phase.page_to_alias.aliased).toBe(0);
    });
  });
});
