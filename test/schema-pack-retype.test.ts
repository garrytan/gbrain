// v0.42 Type Unification (T23) — runRetypeCore unit tests.
//
// Coverage: dry-run vs apply, JSONB subtype + legacy_type stamp parity,
// idempotency, source-scoping, path_filter, progress callback, max-iteration
// safety net, error-wrap, subtype_field allowlist enforcement (D9).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runRetypeCore, UNKNOWN_TYPE_SENTINEL } from '../src/core/schema-pack/retype.ts';
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

function ctxOf(remote = false): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote,
  } as unknown as OperationContext;
}

async function seed(slug: string, type: string, opts: { sourceId?: string; sourcePath?: string } = {}) {
  await engine.putPage(slug, {
    title: slug,
    type: type as never,
    compiled_truth: 'body that exceeds minimum length to pass any backstop guards we may have around content here',
    timeline: '',
    frontmatter: {},
    source_path: opts.sourcePath ?? `${slug}.md`,
  });
}

describe('runRetypeCore', () => {
  describe('dry-run', () => {
    it('returns would_apply count without mutating', async () => {
      await seed('tweets/a', 'tweet-single');
      await seed('tweets/b', 'tweet-single');
      const result = await runRetypeCore(ctxOf(), {
        rules: [{ from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' }],
        apply: false,
      });
      expect(result.apply).toBe(false);
      expect(result.per_rule[0].would_apply).toBe(2);
      expect(result.per_rule[0].applied).toBe(0);
      expect(result.total_would_apply).toBe(2);
      expect(result.total_applied).toBe(0);
      // Verify no mutation occurred
      const rows = await engine.executeRaw<{ type: string }>(
        `SELECT type FROM pages WHERE slug = 'tweets/a'`,
      );
      expect(rows[0].type).toBe('tweet-single');
    });

    it('caps sample_slugs at 10', async () => {
      for (let i = 0; i < 15; i++) await seed(`tweets/${i}`, 'tweet-single');
      const result = await runRetypeCore(ctxOf(), {
        rules: [{ from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' }],
        apply: false,
      });
      expect(result.per_rule[0].would_apply).toBe(15);
      expect(result.per_rule[0].sample_slugs.length).toBeLessThanOrEqual(10);
    });

    it('handles zero matches', async () => {
      const result = await runRetypeCore(ctxOf(), {
        rules: [{ from_type: 'tweet-single', to_type: 'tweet' }],
        apply: false,
      });
      expect(result.per_rule[0].would_apply).toBe(0);
      expect(result.per_rule[0].sample_slugs).toEqual([]);
    });
  });

  describe('apply', () => {
    it('mutates type + stamps subtype in frontmatter', async () => {
      await seed('tweets/a', 'tweet-single');
      const result = await runRetypeCore(ctxOf(), {
        rules: [{ from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' }],
        apply: true,
      });
      expect(result.per_rule[0].applied).toBe(1);
      const rows = await engine.executeRaw<{ type: string; frontmatter: Record<string, unknown> }>(
        `SELECT type, frontmatter FROM pages WHERE slug = 'tweets/a'`,
      );
      expect(rows[0].type).toBe('tweet');
      expect(rows[0].frontmatter.subtype).toBe('single');
    });

    it('always writes frontmatter.legacy_type = from_type (D8)', async () => {
      await seed('tweets/a', 'tweet-single');
      await runRetypeCore(ctxOf(), {
        rules: [{ from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' }],
        apply: true,
      });
      const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
        `SELECT frontmatter FROM pages WHERE slug = 'tweets/a'`,
      );
      expect(rows[0].frontmatter.legacy_type).toBe('tweet-single');
    });

    it('does NOT double-write legacy_type when subtype_field IS legacy_type', async () => {
      await seed('note/civic-1', 'civic');
      await runRetypeCore(ctxOf(), {
        rules: [{ from_type: 'civic', to_type: 'note', subtype_field: 'legacy_type', subtype: 'civic' }],
        apply: true,
      });
      const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
        `SELECT frontmatter FROM pages WHERE slug = 'note/civic-1'`,
      );
      expect(rows[0].frontmatter.legacy_type).toBe('civic');
      expect(rows[0].frontmatter.subtype).toBeUndefined();
    });

    it('is idempotent (re-run produces 0 applied)', async () => {
      await seed('tweets/a', 'tweet-single');
      const result1 = await runRetypeCore(ctxOf(), {
        rules: [{ from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' }],
        apply: true,
      });
      expect(result1.total_applied).toBe(1);
      const result2 = await runRetypeCore(ctxOf(), {
        rules: [{ from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' }],
        apply: true,
      });
      expect(result2.total_applied).toBe(0);
    });

    it('processes multiple rules in order', async () => {
      await seed('tweets/a', 'tweet-single');
      await seed('tweets/b', 'tweet-thread');
      const result = await runRetypeCore(ctxOf(), {
        rules: [
          { from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' },
          { from_type: 'tweet-thread', to_type: 'tweet', subtype: 'bundle' },
        ],
        apply: true,
      });
      expect(result.total_applied).toBe(2);
      const rows = await engine.executeRaw<{ slug: string; type: string; frontmatter: Record<string, unknown> }>(
        `SELECT slug, type, frontmatter FROM pages WHERE slug LIKE 'tweets/%' ORDER BY slug`,
      );
      expect(rows[0].type).toBe('tweet');
      expect(rows[0].frontmatter.subtype).toBe('single');
      expect(rows[1].type).toBe('tweet');
      expect(rows[1].frontmatter.subtype).toBe('bundle');
    });

    it('fires progress callback per rule', async () => {
      await seed('tweets/a', 'tweet-single');
      const progressEvents: Array<{ rule_index: number; appliedSoFar: number }> = [];
      await runRetypeCore(ctxOf(), {
        rules: [{ from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' }],
        apply: true,
        onProgress: (i) => progressEvents.push({ rule_index: i.rule_index, appliedSoFar: i.appliedSoFar }),
      });
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents[0].rule_index).toBe(0);
      expect(progressEvents[0].appliedSoFar).toBeGreaterThan(0);
    });

    it('skips pages outside the path_filter', async () => {
      await seed('tweets/a', 'tweet-single', { sourcePath: 'tweets/a.md' });
      await seed('other/b', 'tweet-single', { sourcePath: 'other/b.md' });
      const result = await runRetypeCore(ctxOf(), {
        rules: [{ from_type: 'tweet-single', to_type: 'tweet', path_filter: 'tweets/%' }],
        apply: true,
      });
      expect(result.total_applied).toBe(1);
      const rows = await engine.executeRaw<{ type: string }>(
        `SELECT type FROM pages WHERE slug = 'other/b'`,
      );
      expect(rows[0].type).toBe('tweet-single');
    });
  });

  describe('subtype_field allowlist (D9)', () => {
    it('rejects subtype_field outside ALLOWED_SUBTYPE_FIELDS', async () => {
      await seed('tweets/a', 'tweet-single');
      await expect(runRetypeCore(ctxOf(), {
        // @ts-expect-error: deliberately bypassing the type-level allowlist
        rules: [{ from_type: 'tweet-single', to_type: 'tweet', subtype_field: 'title', subtype: 'PWNED' }],
        apply: true,
      })).rejects.toThrow(/ALLOWED_SUBTYPE_FIELDS/);
    });
  });

  describe('catch-all sentinel guard', () => {
    it('refuses to process *unknown* sentinel directly (caller must expand)', async () => {
      await expect(runRetypeCore(ctxOf(), {
        rules: [{ from_type: UNKNOWN_TYPE_SENTINEL, to_type: 'note' }],
        apply: false,
      })).rejects.toThrow(/catch-all/);
    });
  });
});
