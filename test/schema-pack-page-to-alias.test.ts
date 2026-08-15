// v0.42 Type Unification (T25) — runPageToAliasCore unit tests.
//
// Coverage: canonical resolution, self-reference rejection, canonical_missing,
// UNIQUE conflict idempotency, soft-delete after alias insert, NO rewriteLinks
// regression guard (D15 — alias table IS the resolver).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPageToAliasCore } from '../src/core/schema-pack/page-to-alias.ts';
import type { OperationContext } from '../src/core/operations.ts';

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
});

function ctxOf(): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
  } as unknown as OperationContext;
}

async function seed(slug: string, type: string, body: string, fm: Record<string, unknown> = {}) {
  await engine.putPage(slug, {
    title: slug,
    type: type as never,
    compiled_truth: body,
    timeline: '',
    frontmatter: fm,
    source_path: `${slug}.md`,
  });
}

describe('runPageToAliasCore', () => {
  describe('apply', () => {
    it('inserts slug_aliases row + soft-deletes source', async () => {
      await seed('wiki/concepts/canonical', 'concept', 'canonical body that is sufficiently long for any backstop guards we have in the codebase');
      await seed('wiki/concepts/redirect-1', 'concept-redirect',
        '[[wiki/concepts/canonical]] this redirects to canonical');
      const result = await runPageToAliasCore(ctxOf(), {
        rules: [{
          from_type: 'concept-redirect',
          canonical_from: 'body_first_link',
          alias_slug_from: 'slug',
          notes_from: 'body_excerpt',
        }],
        apply: true,
      });
      expect(result.per_rule[0].aliased).toBe(1);
      expect(result.per_rule[0].soft_deleted).toBe(1);
      const aliasRows = await engine.executeRaw<{ alias_slug: string; canonical_slug: string; notes: string | null }>(
        `SELECT alias_slug, canonical_slug, notes FROM slug_aliases`,
      );
      expect(aliasRows.length).toBe(1);
      expect(aliasRows[0].alias_slug).toBe('wiki/concepts/redirect-1');
      expect(aliasRows[0].canonical_slug).toBe('wiki/concepts/canonical');
      expect(aliasRows[0].notes).toContain('redirects to canonical');
      // Source page soft-deleted
      const srcRows = await engine.executeRaw<{ deleted_at: string | null }>(
        `SELECT deleted_at FROM pages WHERE slug = 'wiki/concepts/redirect-1'`,
      );
      expect(srcRows[0].deleted_at).not.toBeNull();
    });

    it('records canonical_missing when target page does not exist', async () => {
      await seed('wiki/concepts/redirect-bad', 'concept-redirect',
        '[[wiki/concepts/does-not-exist]] redirects to missing canonical');
      const result = await runPageToAliasCore(ctxOf(), {
        rules: [{
          from_type: 'concept-redirect',
          canonical_from: 'body_first_link',
          alias_slug_from: 'slug',
        }],
        apply: true,
      });
      expect(result.per_rule[0].aliased).toBe(0);
      expect(result.per_rule[0].unresolved.length).toBe(1);
      expect(result.per_rule[0].unresolved[0].reason).toBe('canonical_missing');
    });

    it('rejects self-references', async () => {
      await seed('wiki/concepts/canonical', 'concept', 'canonical body that is sufficiently long for any backstop guards');
      await seed('wiki/concepts/self', 'concept-redirect',
        '[[wiki/concepts/self]] would be a self-loop');
      const result = await runPageToAliasCore(ctxOf(), {
        rules: [{
          from_type: 'concept-redirect',
          canonical_from: 'body_first_link',
          alias_slug_from: 'slug',
        }],
        apply: true,
      });
      expect(result.per_rule[0].aliased).toBe(0);
      expect(result.per_rule[0].unresolved[0].reason).toBe('self_reference');
    });

    it('is idempotent on UNIQUE conflict (re-run no-op)', async () => {
      await seed('wiki/concepts/canonical', 'concept', 'canonical body that is sufficiently long for any backstop guards');
      await seed('wiki/concepts/redirect-1', 'concept-redirect',
        '[[wiki/concepts/canonical]] redirects to canonical');
      const r1 = await runPageToAliasCore(ctxOf(), {
        rules: [{
          from_type: 'concept-redirect',
          canonical_from: 'body_first_link',
          alias_slug_from: 'slug',
        }],
        apply: true,
      });
      expect(r1.per_rule[0].aliased).toBe(1);
      // Restore the redirect (un-soft-delete) so the rule re-fires on it
      await engine.executeRaw(`UPDATE pages SET deleted_at = NULL WHERE slug = 'wiki/concepts/redirect-1'`);
      const r2 = await runPageToAliasCore(ctxOf(), {
        rules: [{
          from_type: 'concept-redirect',
          canonical_from: 'body_first_link',
          alias_slug_from: 'slug',
        }],
        apply: true,
      });
      // Page is processed; alias row insertion ON CONFLICT DO NOTHING is the idempotency.
      // The handler still increments aliased counter for matched rows.
      const aliasRows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM slug_aliases WHERE alias_slug = 'wiki/concepts/redirect-1'`,
      );
      // Only one row exists despite two runs (idempotent insert).
      expect(aliasRows.length).toBe(1);
    });
  });

  describe('D15 regression guard — NO rewriteLinks for page-to-alias', () => {
    it('does NOT call engine.rewriteLinks during page-to-alias', async () => {
      // Engine.rewriteLinks is a no-op stub today, but the regression guard
      // ensures the handler does not introduce a call. We check by spying:
      // we monkey-patch rewriteLinks and assert it's never invoked.
      let rewriteLinksCalled = false;
      const original = engine.rewriteLinks.bind(engine);
      engine.rewriteLinks = async (oldSlug: string, newSlug: string) => {
        rewriteLinksCalled = true;
        return original(oldSlug, newSlug);
      };
      try {
        await seed('wiki/concepts/canonical', 'concept', 'canonical body that is sufficiently long for any backstop guards');
        await seed('wiki/concepts/redirect-1', 'concept-redirect',
          '[[wiki/concepts/canonical]] redirects to canonical');
        await runPageToAliasCore(ctxOf(), {
          rules: [{
            from_type: 'concept-redirect',
            canonical_from: 'body_first_link',
            alias_slug_from: 'slug',
          }],
          apply: true,
        });
        expect(rewriteLinksCalled).toBe(false);
      } finally {
        engine.rewriteLinks = original;
      }
    });
  });
});
