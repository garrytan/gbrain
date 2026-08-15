/**
 * v0.38 — DRY-extract helpers in `src/core/markdown.ts`. Two pure functions:
 *
 *   - `serializePageToMarkdown(page, tags, opts?)`  — render a Page row to its
 *     canonical on-disk markdown form. Consumed by the dream-cycle reverse-
 *     render in `src/core/cycle/synthesize.ts` AND by the put_page write-
 *     through path in `src/core/operations.ts`. Both used to inline-duplicate
 *     ~90% of `serializeMarkdown` setup; the extract collapses them to a
 *     4-line wrapper. The `frontmatterOverrides` option is the only thing
 *     that differs at the two call sites (dream stamps `dream_generated`,
 *     put_page stamps `ingested_via` + `ingested_at`).
 *
 *   - `resolvePageFilePath(brainDir, slug, sourceId)`  — single source of
 *     truth for the v0.32.8 multi-source filing layout:
 *       - default source → `<brainDir>/<slug>.md`
 *       - non-default    → `<brainDir>/.sources/<source_id>/<slug>.md`
 *     Shared by `reverseWriteRefs` and the put_page write-through path so
 *     both compute the same path for the same row. Caller is responsible
 *     for validating `source_id` against path-traversal attacks via
 *     `validateSourceId` BEFORE passing it here — the helper does filename
 *     math only.
 *
 * These pure functions are the DRY extract that the v0.38 plan-eng-review
 * locked in. Without focused tests, future schema-shape changes to either
 * helper could silently drift the two call sites apart. The test pins:
 *   - Frontmatter merge precedence (page < overrides < tags)
 *   - Type / title defaults when Page columns are sparse
 *   - The empty-overrides happy path (matches pre-v0.38 behavior)
 *   - Provenance stamping shape (the v0.38 use case)
 *   - Path composition for both source layouts
 *   - The exact filename produced for nested slugs (people/alice → file ok)
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Page } from '../src/core/types.ts';
import {
  resolvePageFilePath,
  serializePageToMarkdown,
} from '../src/core/markdown.ts';

function buildPage(overrides: Partial<Page> = {}): Page {
  return {
    id: 1,
    slug: 'wiki/people/alice',
    type: 'person',
    title: 'Alice Example',
    compiled_truth: 'Alice is a founder.',
    timeline: '',
    frontmatter: {},
    created_at: new Date('2026-05-21T00:00:00Z'),
    updated_at: new Date('2026-05-21T00:00:00Z'),
    source_id: 'default',
    ...overrides,
  } as Page;
}

describe('serializePageToMarkdown — DRY extract for dream + put_page write-through', () => {
  test('renders a minimal page with no overrides', () => {
    const page = buildPage();
    const md = serializePageToMarkdown(page, []);
    // Frontmatter open + close fences should bracket the body.
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('title: Alice Example');
    expect(md).toContain('type: person');
    expect(md).toContain('Alice is a founder.');
  });

  test('opts.frontmatterOverrides win over page.frontmatter on key collisions', () => {
    const page = buildPage({
      frontmatter: { ingested_via: 'original', custom_key: 'kept' },
    });
    const md = serializePageToMarkdown(page, [], {
      frontmatterOverrides: { ingested_via: 'put_page' },
    });
    // The override won.
    expect(md).toMatch(/ingested_via:\s*put_page/);
    // The unrelated key from page.frontmatter survived the merge.
    expect(md).toContain('custom_key: kept');
    // The original value is gone.
    expect(md).not.toMatch(/ingested_via:\s*original/);
  });

  test('stamps v0.38 provenance frontmatter (the put_page write-through use case)', () => {
    const page = buildPage();
    const md = serializePageToMarkdown(page, [], {
      frontmatterOverrides: {
        ingested_via: 'put_page',
        ingested_at: '2026-05-21T04:15:00Z',
        source_kind: 'capture-cli',
      },
    });
    expect(md).toMatch(/ingested_via:\s*put_page/);
    expect(md).toContain('2026-05-21T04:15:00Z');
    expect(md).toContain('capture-cli');
  });

  test('stamps dream_generated frontmatter (the dream-cycle reverse-render use case)', () => {
    const page = buildPage();
    const md = serializePageToMarkdown(page, [], {
      frontmatterOverrides: {
        dream_generated: true,
        dream_cycle_date: '2026-05-21',
      },
    });
    expect(md).toMatch(/dream_generated:\s*true/);
    expect(md).toContain('2026-05-21');
  });

  test('falls back to type=note when Page.type is missing', () => {
    // Coerce to bypass the strict typed Page interface — exercising the
    // defensive default that the helper documents.
    const page = buildPage({ type: undefined as unknown as Page['type'] });
    const md = serializePageToMarkdown(page, []);
    expect(md).toContain('type: note');
  });

  test('falls back to empty title when Page.title is missing', () => {
    const page = buildPage({ title: undefined as unknown as Page['title'] });
    const md = serializePageToMarkdown(page, []);
    // The helper should not crash; the title line should be empty or absent.
    // serializeMarkdown emits `title: ` (no value) for empty titles.
    expect(md).toMatch(/title:\s*('')?\s*\n/);
  });

  test('preserves timeline section when present', () => {
    const page = buildPage({
      timeline: '## Timeline\n\n- 2026-01-01: Founded',
    });
    const md = serializePageToMarkdown(page, []);
    expect(md).toContain('## Timeline');
    expect(md).toContain('2026-01-01: Founded');
  });

  test('handles empty compiled_truth + empty timeline (page with frontmatter only)', () => {
    const page = buildPage({ compiled_truth: '', timeline: '' });
    const md = serializePageToMarkdown(page, []);
    // Frontmatter close fence should still appear.
    expect(md).toMatch(/^---\n/);
    expect(md.match(/---/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('passes tags through to the underlying serializer', () => {
    const page = buildPage();
    const md = serializePageToMarkdown(page, ['yc', 'w2025']);
    expect(md).toContain('yc');
    expect(md).toContain('w2025');
  });

  test('omits opts argument entirely (matches the dream-cycle wrapper signature)', () => {
    const page = buildPage();
    // The dream-cycle wrapper called serializePageToMarkdown(page, tags)
    // with no opts argument. Pin that this still works post-extract.
    const md = serializePageToMarkdown(page, []);
    expect(md).toContain('Alice Example');
  });

  test('null/undefined frontmatter on Page does not crash', () => {
    const page = buildPage({
      frontmatter: undefined as unknown as Page['frontmatter'],
    });
    const md = serializePageToMarkdown(page, [], {
      frontmatterOverrides: { ingested_via: 'put_page' },
    });
    expect(md).toMatch(/ingested_via:\s*put_page/);
  });
});

describe('resolvePageFilePath — single source of truth for v0.32.8 filing layout', () => {
  test('default source writes to <brainDir>/<slug>.md', () => {
    const path = resolvePageFilePath('/brain', 'wiki/people/alice', 'default');
    expect(path).toBe(join('/brain', 'wiki/people/alice.md'));
  });

  test('non-default source writes under <brainDir>/.sources/<source_id>/<slug>.md', () => {
    const path = resolvePageFilePath('/brain', 'wiki/people/alice', 'gstack');
    expect(path).toBe(join('/brain', '.sources', 'gstack', 'wiki/people/alice.md'));
  });

  test('source_id is the literal string "default" — anything else routes to .sources/', () => {
    // The discriminator is exactly the string 'default'. Casing matters.
    const lower = resolvePageFilePath('/brain', 's', 'default');
    const upper = resolvePageFilePath('/brain', 's', 'Default');
    expect(lower).toBe(join('/brain', 's.md'));
    expect(upper).toBe(join('/brain', '.sources', 'Default', 's.md'));
  });

  test('empty string source_id is treated as non-default', () => {
    // Regression: '' is not 'default' so it lands in .sources/<empty>/. This is
    // a bug surface — `validateSourceId` is the caller's responsibility to
    // reject. Pin the current behavior so a refactor doesn't quietly change it.
    const path = resolvePageFilePath('/brain', 's', '');
    expect(path).toBe(join('/brain', '.sources', '', 's.md'));
  });

  test('nested slug paths join cleanly without traversal artifacts', () => {
    const path = resolvePageFilePath('/brain', 'wiki/companies/acme-co', 'default');
    expect(path).toBe(join('/brain', 'wiki/companies/acme-co.md'));
    expect(path).not.toContain('..');
  });

  test('non-default source path with nested slug preserves structure', () => {
    const path = resolvePageFilePath('/brain', 'inbox/2026-05-21-thought', 'mobile');
    expect(path).toBe(join('/brain', '.sources', 'mobile', 'inbox', '2026-05-21-thought.md'));
  });

  test('absolute and relative brainDir both work (path.join semantics)', () => {
    const abs = resolvePageFilePath('/absolute/brain', 's', 'default');
    const rel = resolvePageFilePath('./relative/brain', 's', 'default');
    expect(abs).toBe(join('/absolute/brain', 's.md'));
    expect(rel).toBe(join('./relative/brain', 's.md'));
  });

  test('source_id with spaces or special chars passes through (caller validates)', () => {
    // Pin that the helper does NOT mutate source_id — validation is the
    // caller's job per the helper's documented contract. If this ever
    // changes (helper starts validating internally) a real implementation
    // change is needed and this test surfaces it.
    const path = resolvePageFilePath('/brain', 's', 'has spaces');
    expect(path).toBe(join('/brain', '.sources', 'has spaces', 's.md'));
  });
});
