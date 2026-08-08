import { describe, test, expect } from 'bun:test';
import { importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * Regression: the pre-write existence check in importFromContent must be
 * scoped to the SAME namespace the writes target.
 *
 * putPage/createVersion default sourceId to 'default', but the existence
 * check used to run unscoped (`sourceId ? { sourceId } : undefined`), which
 * matches a same-slug row from ANY source (LIMIT 1). On a multi-source brain
 * where another source owns the slug and no default-source row exists,
 * `existing` came back truthy → tx.createVersion(slug) scoped to default
 * found 0 rows → threw `createVersion failed: page "<slug>" (source=default)
 * not found`, aborting the import. This crashed synthesize_concepts in every
 * dream cycle (concepts are written to the default namespace) as soon as one
 * synthesized concept slug collided with a row owned by another source.
 */

// Source-aware mock engine: simulates the real (source_id, slug) keyed pages
// table. getPage honors opts.sourceId exactly like the real engine (scoped →
// exact match; unscoped → any source, LIMIT 1). createVersion mirrors the
// real engine's failure mode: throws when no row exists at
// (sourceId ?? 'default', slug).
function sourceAwareMockEngine(seed: { sourceId: string; slug: string; content_hash?: string }[] = []) {
  const calls: { method: string; args: unknown[] }[] = [];
  const pageStore = new Map<string, { slug: string; source_id: string; content_hash: string; title: string; type: string; frontmatter: Record<string, unknown> }>();
  const key = (sourceId: string, slug: string) => `${sourceId}\u0000${slug}`;
  for (const s of seed) {
    pageStore.set(key(s.sourceId, s.slug), {
      slug: s.slug,
      source_id: s.sourceId,
      content_hash: s.content_hash ?? 'seeded-hash',
      title: s.slug,
      type: 'concept',
      frontmatter: {},
    });
  }

  const engine = new Proxy({} as Record<string, unknown>, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (prop === 'getTags') return () => Promise.resolve([]);
      if (prop === 'getPage') {
        return async (slug: string, opts?: { sourceId?: string }) => {
          calls.push({ method: 'getPage', args: [slug, opts] });
          if (opts?.sourceId) return pageStore.get(key(opts.sourceId, slug)) ?? null;
          // Unscoped: any source, LIMIT 1 (matches the real engine).
          for (const row of pageStore.values()) {
            if (row.slug === slug) return row;
          }
          return null;
        };
      }
      if (prop === 'putPage') {
        return async (slug: string, page: { content_hash?: string; title?: string; type?: string; frontmatter?: Record<string, unknown> }, opts?: { sourceId?: string }) => {
          calls.push({ method: 'putPage', args: [slug, page, opts] });
          const sourceId = opts?.sourceId ?? 'default';
          pageStore.set(key(sourceId, slug), {
            slug,
            source_id: sourceId,
            content_hash: page.content_hash ?? '',
            title: page.title ?? '',
            type: page.type ?? '',
            frontmatter: page.frontmatter ?? {},
          });
          return undefined;
        };
      }
      if (prop === 'createVersion') {
        return async (slug: string, opts?: { sourceId?: string }) => {
          calls.push({ method: 'createVersion', args: [slug, opts] });
          const sourceId = opts?.sourceId ?? 'default';
          if (!pageStore.has(key(sourceId, slug))) {
            throw new Error(`createVersion failed: page "${slug}" (source=${sourceId}) not found`);
          }
          return { id: 1, page_id: 1 };
        };
      }
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<unknown>) => fn(engine as unknown as BrainEngine);
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return Promise.resolve(null);
      };
    },
  });
  return engine as unknown as BrainEngine & { _calls: { method: string; args: unknown[] }[] };
}

const CONTENT = `---
type: concept
title: Scope Test
---

Body for the source-scope regression test.
`;

describe('importFromContent existence-check source scoping', () => {
  test('same slug owned by another source: import to default succeeds as a NEW page (no createVersion)', async () => {
    const engine = sourceAwareMockEngine([
      { sourceId: 'other-source', slug: 'concepts/scope-test' },
    ]);

    // Pre-fix this threw: unscoped existence check found the other-source row,
    // then createVersion scoped to default found nothing.
    const result = await importFromContent(engine, 'concepts/scope-test', CONTENT, { noEmbed: true });

    expect(result.status).toBe('imported');
    const versionCalls = engine._calls.filter(c => c.method === 'createVersion');
    expect(versionCalls.length).toBe(0); // no default-source row existed → new page, no snapshot
    const putCall = engine._calls.find(c => c.method === 'putPage');
    expect(putCall).toBeTruthy();
  });

  test('existence check is scoped to default when no sourceId is given', async () => {
    const engine = sourceAwareMockEngine();
    await importFromContent(engine, 'concepts/scope-test', CONTENT, { noEmbed: true });

    const firstGet = engine._calls.find(c => c.method === 'getPage');
    expect(firstGet).toBeTruthy();
    expect((firstGet!.args[1] as { sourceId?: string })?.sourceId).toBe('default');
  });

  test('existing default-source page still gets a version snapshot', async () => {
    const engine = sourceAwareMockEngine([
      { sourceId: 'default', slug: 'concepts/scope-test' },
    ]);
    const result = await importFromContent(engine, 'concepts/scope-test', CONTENT, { noEmbed: true });

    expect(result.status).toBe('imported');
    const versionCalls = engine._calls.filter(c => c.method === 'createVersion');
    expect(versionCalls.length).toBe(1);
  });

  test('explicit sourceId path is unchanged: scoped check + scoped snapshot', async () => {
    const engine = sourceAwareMockEngine([
      { sourceId: 'other-source', slug: 'concepts/scope-test' },
    ]);
    const result = await importFromContent(engine, 'concepts/scope-test', CONTENT, {
      noEmbed: true,
      sourceId: 'other-source',
    });

    expect(result.status).toBe('imported');
    const versionCalls = engine._calls.filter(c => c.method === 'createVersion');
    expect(versionCalls.length).toBe(1);
    expect((versionCalls[0].args[1] as { sourceId?: string })?.sourceId).toBe('other-source');
  });
});
