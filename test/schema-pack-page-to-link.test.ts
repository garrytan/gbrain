// v0.42 Type Unification (T24) — runPageToLinkCore unit tests.
//
// Coverage: resolver variants (frontmatter / body_first_link / explicit field),
// unresolved tracking (no_source / no_target / cycle / parse_failed),
// soft-delete after link insert, source-scoping, regression guard that
// page-to-link does NOT keep the source page (it's converted away).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPageToLinkCore } from '../src/core/schema-pack/page-to-link.ts';
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

async function seed(slug: string, type: string, fm: Record<string, unknown> = {}, body = 'edge body that is long enough') {
  await engine.putPage(slug, {
    title: slug,
    type: type as never,
    compiled_truth: body,
    timeline: '',
    frontmatter: fm,
    source_path: `${slug}.md`,
  });
}

describe('runPageToLinkCore', () => {
  describe('dry-run', () => {
    it('counts pages without mutating', async () => {
      await seed('atoms/partner-1', 'atom-partner-link',
        { source: 'people/alice', target: 'companies/acme' });
      await seed('people/alice', 'person');
      await seed('companies/acme', 'company');
      const result = await runPageToLinkCore(ctxOf(), {
        rules: [{
          from_type: 'atom-partner-link',
          link_type: 'partner_of',
          source_slug_from: { frontmatter_field: 'source' },
          target_slug_from: { frontmatter_field: 'target' },
        }],
        apply: false,
      });
      expect(result.per_rule[0].would_convert).toBe(1);
      expect(result.per_rule[0].converted).toBe(0);
      // Source page should still exist
      const rows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM pages WHERE slug = 'atoms/partner-1' AND deleted_at IS NULL`,
      );
      expect(rows.length).toBe(1);
    });
  });

  describe('apply', () => {
    it('inserts link row + soft-deletes source page', async () => {
      await seed('people/alice', 'person');
      await seed('companies/acme', 'company');
      await seed('atoms/partner-1', 'atom-partner-link',
        { source: 'people/alice', target: 'companies/acme' });
      const result = await runPageToLinkCore(ctxOf(), {
        rules: [{
          from_type: 'atom-partner-link',
          link_type: 'partner_of',
          source_slug_from: { frontmatter_field: 'source' },
          target_slug_from: { frontmatter_field: 'target' },
        }],
        apply: true,
      });
      expect(result.per_rule[0].converted).toBe(1);
      expect(result.per_rule[0].soft_deleted).toBe(1);
      // Source page soft-deleted
      const srcRows = await engine.executeRaw<{ deleted_at: string | null }>(
        `SELECT deleted_at FROM pages WHERE slug = 'atoms/partner-1'`,
      );
      expect(srcRows[0].deleted_at).not.toBeNull();
      // Link row inserted
      const linkRows = await engine.executeRaw<{ link_type: string }>(
        `SELECT link_type FROM links l
         JOIN pages p1 ON l.from_page_id = p1.id
         JOIN pages p2 ON l.to_page_id = p2.id
         WHERE p1.slug = 'people/alice' AND p2.slug = 'companies/acme'`,
      );
      expect(linkRows.length).toBe(1);
      expect(linkRows[0].link_type).toBe('partner_of');
    });

    it('records unresolved when source frontmatter field is missing', async () => {
      await seed('atoms/bad-1', 'atom-partner-link', { target: 'companies/acme' }); // no source
      const result = await runPageToLinkCore(ctxOf(), {
        rules: [{
          from_type: 'atom-partner-link',
          link_type: 'partner_of',
          source_slug_from: { frontmatter_field: 'source' },
          target_slug_from: { frontmatter_field: 'target' },
        }],
        apply: true,
      });
      expect(result.per_rule[0].converted).toBe(0);
      expect(result.per_rule[0].unresolved.length).toBe(1);
      expect(result.per_rule[0].unresolved[0].reason).toBe('no_source');
    });

    it('records unresolved when target is missing', async () => {
      await seed('atoms/bad-1', 'atom-partner-link', { source: 'people/alice' }); // no target
      const result = await runPageToLinkCore(ctxOf(), {
        rules: [{
          from_type: 'atom-partner-link',
          link_type: 'partner_of',
          source_slug_from: { frontmatter_field: 'source' },
          target_slug_from: { frontmatter_field: 'target' },
        }],
        apply: true,
      });
      expect(result.per_rule[0].unresolved[0].reason).toBe('no_target');
    });

    it('rejects self-references (cycle reason)', async () => {
      await seed('atoms/loop-1', 'atom-partner-link',
        { source: 'people/alice', target: 'people/alice' });
      await seed('people/alice', 'person');
      const result = await runPageToLinkCore(ctxOf(), {
        rules: [{
          from_type: 'atom-partner-link',
          link_type: 'partner_of',
          source_slug_from: { frontmatter_field: 'source' },
          target_slug_from: { frontmatter_field: 'target' },
        }],
        apply: true,
      });
      expect(result.per_rule[0].converted).toBe(0);
      expect(result.per_rule[0].unresolved[0].reason).toBe('cycle');
    });

    it('resolves slugs from body_first_link', async () => {
      await seed('symlinks/x', 'symlink',
        { target: 'concepts/foo' },
        '[[concepts/bar]] this is body first link\nLine 2');
      await seed('concepts/foo', 'concept');
      await seed('concepts/bar', 'concept');
      const result = await runPageToLinkCore(ctxOf(), {
        rules: [{
          from_type: 'symlink',
          link_type: 'relates_to',
          source_slug_from: 'body_first_link',
          target_slug_from: { frontmatter_field: 'target' },
        }],
        apply: true,
      });
      expect(result.per_rule[0].converted).toBe(1);
      const links = await engine.executeRaw<{ from_slug: string; to_slug: string }>(
        `SELECT p1.slug AS from_slug, p2.slug AS to_slug FROM links l
         JOIN pages p1 ON l.from_page_id = p1.id
         JOIN pages p2 ON l.to_page_id = p2.id
         WHERE l.link_type = 'relates_to'`,
      );
      expect(links[0].from_slug).toBe('concepts/bar');
      expect(links[0].to_slug).toBe('concepts/foo');
    });
  });

  describe('source-scoping (F9)', () => {
    it('limits processing to the specified sourceId', async () => {
      // Two sources: default + alt
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alt', 'alt') ON CONFLICT DO NOTHING`);
      await seed('people/alice', 'person');
      await seed('atoms/p1', 'atom-partner-link',
        { source: 'people/alice', target: 'people/alice' }); // default source
      // Alt-source page (skipped)
      await engine.putPage('atoms/p2', {
        title: 'p2', type: 'atom-partner-link' as never,
        compiled_truth: 'body that is long enough to pass min char gates around extraction',
        timeline: '', frontmatter: { source: 'people/alice', target: 'people/alice' },
        source_path: 'atoms/p2.md',
      }, { sourceId: 'alt' });
      const result = await runPageToLinkCore(ctxOf(), {
        rules: [{
          from_type: 'atom-partner-link',
          link_type: 'partner_of',
          source_slug_from: { frontmatter_field: 'source' },
          target_slug_from: { frontmatter_field: 'target' },
        }],
        apply: true,
        sourceId: 'default',
      });
      // Only default-source page processed (and that one is a cycle → unresolved)
      expect(result.per_rule[0].would_convert).toBe(1);
    });
  });
});
