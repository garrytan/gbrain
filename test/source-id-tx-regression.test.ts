/**
 * v0.18.0+ Step 5+ regression — source_id threading through the per-page
 * transaction surface (putPage / createVersion / getTags / addTag / removeTag /
 * deleteChunks / upsertChunks / addLink / removeLink).
 *
 * Pre-fix bug:
 *   - putPage omitted source_id from its INSERT column list, so the schema
 *     DEFAULT 'default' was applied even when the caller meant to write under
 *     a non-default source (e.g. 'jarvis-memory'). When the same slug already
 *     existed under the intended source, putPage silently fabricated a
 *     duplicate row at (default, slug). Both rows then coexisted under the
 *     composite UNIQUE.
 *   - Subsequent bare-slug subqueries inside the same transaction —
 *     `(SELECT id FROM pages WHERE slug = $1)` in getTags / removeTag /
 *     deleteChunks / removeLink — returned 2 rows and crashed with Postgres
 *     21000 ("more than one row returned by a subquery used as an expression"),
 *     rolling back the entire tx.
 *
 * Fix:
 *   - putPage adds source_id to the INSERT column list (defaults to 'default'
 *     when opts.sourceId is omitted, preserving back-compat).
 *   - Every bare-slug page-id subquery becomes source-qualified
 *     (`AND source_id = $X`), eliminating the multi-row fan-out.
 *   - addLink converts away from `FROM pages f, pages t` cross-product and
 *     mirrors addLinksBatch's VALUES + JOIN-on-(slug, source_id) shape.
 *
 * Backwards-compat: every method's opts param is optional. Existing callers
 * that don't pass sourceId continue to target source 'default' (the schema
 * default) and behave identically to pre-fix.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
  // Add the second source up-front; tests below assume both 'default' and
  // 'testsrc' exist.
  await runSources(engine, ['add', 'testsrc', '--no-federated']);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

const SLUG = 'topics/source-id-regression';

describe('putPage threads source_id into the INSERT column list', () => {
  test('putPage with opts.sourceId writes under the intended source', async () => {
    await engine.putPage(SLUG, {
      type: 'concept',
      title: 'Default-source variant',
      compiled_truth: 'Lives under source=default.',
    });
    await engine.putPage(SLUG, {
      type: 'concept',
      title: 'Testsrc-source variant',
      compiled_truth: 'Lives under source=testsrc.',
    }, { sourceId: 'testsrc' });

    const rows = await engine.executeRaw<{ source_id: string; title: string }>(
      `SELECT source_id, title FROM pages WHERE slug = $1 ORDER BY source_id`,
      [SLUG],
    );
    expect(rows.length).toBe(2);
    expect(rows[0].source_id).toBe('default');
    expect(rows[0].title).toBe('Default-source variant');
    expect(rows[1].source_id).toBe('testsrc');
    expect(rows[1].title).toBe('Testsrc-source variant');
  });

  test('putPage without opts.sourceId still targets source=default (back-compat)', async () => {
    // Call again under default to verify the no-opts path still hits the same
    // (default, slug) row rather than fabricating a duplicate.
    const updated = await engine.putPage(SLUG, {
      type: 'concept',
      title: 'Default-source updated',
      compiled_truth: 'Updated content.',
    });
    expect(updated.title).toBe('Default-source updated');

    const rows = await engine.executeRaw<{ source_id: string; title: string }>(
      `SELECT source_id, title FROM pages WHERE slug = $1 ORDER BY source_id`,
      [SLUG],
    );
    // Still exactly two rows — no duplicate fabricated.
    expect(rows.length).toBe(2);
    expect(rows.find(r => r.source_id === 'default')!.title).toBe('Default-source updated');
    expect(rows.find(r => r.source_id === 'testsrc')!.title).toBe('Testsrc-source variant');
  });
});

describe('Per-page tx methods source-qualify their bare-slug subqueries', () => {
  test('getTags(slug, { sourceId }) returns scoped tags without 21000', async () => {
    // Pre-fix: this call would crash because the bare-slug subquery
    // `(SELECT id FROM pages WHERE slug = $1)` matched both rows.
    await engine.addTag(SLUG, 'shared-by-default', { sourceId: 'default' });
    await engine.addTag(SLUG, 'unique-to-testsrc', { sourceId: 'testsrc' });
    await engine.addTag(SLUG, 'also-shared', { sourceId: 'default' });
    await engine.addTag(SLUG, 'also-shared', { sourceId: 'testsrc' });

    const defaultTags = await engine.getTags(SLUG, { sourceId: 'default' });
    expect(defaultTags.sort()).toEqual(['also-shared', 'shared-by-default']);

    const testsrcTags = await engine.getTags(SLUG, { sourceId: 'testsrc' });
    expect(testsrcTags.sort()).toEqual(['also-shared', 'unique-to-testsrc']);
  });

  test('removeTag(slug, tag, { sourceId }) only removes from one source', async () => {
    await engine.removeTag(SLUG, 'also-shared', { sourceId: 'testsrc' });
    expect((await engine.getTags(SLUG, { sourceId: 'default' })).sort())
      .toEqual(['also-shared', 'shared-by-default']);
    expect((await engine.getTags(SLUG, { sourceId: 'testsrc' })).sort())
      .toEqual(['unique-to-testsrc']);
  });

  test('deleteChunks(slug, { sourceId }) only deletes one source\'s chunks', async () => {
    await engine.upsertChunks(SLUG, [
      { chunk_index: 0, chunk_text: 'default chunk 0', chunk_source: 'compiled_truth' },
    ], { sourceId: 'default' });
    await engine.upsertChunks(SLUG, [
      { chunk_index: 0, chunk_text: 'testsrc chunk 0', chunk_source: 'compiled_truth' },
    ], { sourceId: 'testsrc' });

    const beforeRows = await engine.executeRaw<{ source_id: string; chunk_text: string }>(
      `SELECT p.source_id, cc.chunk_text
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $1
        ORDER BY p.source_id`,
      [SLUG],
    );
    expect(beforeRows.length).toBe(2);

    await engine.deleteChunks(SLUG, { sourceId: 'testsrc' });

    const afterRows = await engine.executeRaw<{ source_id: string; chunk_text: string }>(
      `SELECT p.source_id, cc.chunk_text
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $1`,
      [SLUG],
    );
    expect(afterRows.length).toBe(1);
    expect(afterRows[0].source_id).toBe('default');
  });

  test('createVersion(slug, { sourceId }) snapshots the right row', async () => {
    const v = await engine.createVersion(SLUG, { sourceId: 'testsrc' });
    expect(v).toBeDefined();
    const rows = await engine.executeRaw<{ source_id: string; compiled_truth: string }>(
      `SELECT p.source_id, pv.compiled_truth
         FROM page_versions pv
         JOIN pages p ON p.id = pv.page_id
        WHERE p.slug = $1
        ORDER BY pv.snapshot_at DESC
        LIMIT 1`,
      [SLUG],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('testsrc');
    expect(rows[0].compiled_truth).toBe('Lives under source=testsrc.');
  });
});

describe('addLink rewrites the cross-product into a source-qualified JOIN', () => {
  const FROM_SLUG = 'topics/regression-link-from';
  const TO_SLUG = 'topics/regression-link-to';

  test('addLink with opts.{from,to,origin}SourceId targets the right rows', async () => {
    // Set up: same (from, to) slug pair under both default and testsrc.
    await engine.putPage(FROM_SLUG, { type: 'concept', title: 'F default', compiled_truth: '' });
    await engine.putPage(TO_SLUG, { type: 'concept', title: 'T default', compiled_truth: '' });
    await engine.putPage(FROM_SLUG, { type: 'concept', title: 'F testsrc', compiled_truth: '' }, { sourceId: 'testsrc' });
    await engine.putPage(TO_SLUG, { type: 'concept', title: 'T testsrc', compiled_truth: '' }, { sourceId: 'testsrc' });

    // Add an edge under testsrc only.
    await engine.addLink(
      FROM_SLUG, TO_SLUG, 'testsrc edge', 'documents', 'markdown', undefined, undefined,
      { fromSourceId: 'testsrc', toSourceId: 'testsrc', originSourceId: 'testsrc' },
    );

    // Verify the link's endpoints both point at the testsrc rows, not the
    // default rows. Pre-fix, the cross-product `FROM pages f, pages t` would
    // pick whichever order Postgres returned; the source filter eliminates
    // that fan-out.
    const rows = await engine.executeRaw<{ from_src: string; to_src: string; context: string }>(
      `SELECT f.source_id AS from_src, t.source_id AS to_src, l.context
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE l.context = 'testsrc edge'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_src).toBe('testsrc');
    expect(rows[0].to_src).toBe('testsrc');
  });

  test('addLink with no opts defaults to source=default (back-compat)', async () => {
    await engine.addLink(
      FROM_SLUG, TO_SLUG, 'default edge', 'documents', 'markdown',
    );
    const rows = await engine.executeRaw<{ from_src: string; to_src: string }>(
      `SELECT f.source_id AS from_src, t.source_id AS to_src
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE l.context = 'default edge'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_src).toBe('default');
    expect(rows[0].to_src).toBe('default');
  });

  test('addLink fails fast when the source-qualified endpoint doesn\'t exist', async () => {
    // Pre-fix: cross-product would silently fall back to the wrong source
    // pair and succeed. Post-fix: missing-source-row → no JOIN match → no row
    // inserted → INTERSECT pre-check throws.
    let err: Error | null = null;
    try {
      await engine.addLink(
        FROM_SLUG, TO_SLUG, 'phantom edge', 'documents', 'markdown', undefined, undefined,
        { fromSourceId: 'nonexistent-src', toSourceId: 'nonexistent-src' },
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/not found/);
  });
});

describe('importFromContent threads sourceId through the entire transaction body', () => {
  const IMP_SLUG = 'topics/regression-import-thread';

  test('importFromContent under source=testsrc does not fabricate a (default, slug) duplicate', async () => {
    // Pre-seed a default-source row at the same slug to prove the fix actually
    // discriminates: pre-fix, importing under testsrc would have ALSO touched
    // the default row (or duplicated it) and the bare-slug getTags inside the
    // tx would crash with 21000.
    await engine.putPage(IMP_SLUG, {
      type: 'concept',
      title: 'Default-source seed',
      compiled_truth: 'pre-existing default row',
    });

    const md = `---
type: concept
title: Imported under testsrc
---

# Imported under testsrc

Body content; tags get reconciled inside the transaction.
`;

    // No 21000, no duplicate. Pre-fix this call would have either crashed
    // mid-tx (rolling back) OR fabricated a third row at (default, slug).
    const result = await importFromContent(engine, IMP_SLUG, md, {
      noEmbed: true,
      sourceId: 'testsrc',
    });
    expect(result.status).toBe('imported');

    const rows = await engine.executeRaw<{ source_id: string; title: string }>(
      `SELECT source_id, title FROM pages WHERE slug = $1 ORDER BY source_id`,
      [IMP_SLUG],
    );
    expect(rows.length).toBe(2);
    expect(rows[0].source_id).toBe('default');
    expect(rows[0].title).toBe('Default-source seed');
    expect(rows[1].source_id).toBe('testsrc');
    expect(rows[1].title).toBe('Imported under testsrc');
  });

  test('re-importing same content under same sourceId is idempotent (status=skipped)', async () => {
    const md = `---
type: concept
title: Imported under testsrc
---

# Imported under testsrc

Body content; tags get reconciled inside the transaction.
`;
    const result = await importFromContent(engine, IMP_SLUG, md, {
      noEmbed: true,
      sourceId: 'testsrc',
    });
    expect(result.status).toBe('skipped');
  });
});

describe('addTimelineEntry source-scoping (Data R1 HIGH 2 fix)', () => {
  const TL_SLUG = 'topics/regression-timeline';

  test('addTimelineEntry with opts.sourceId only writes to the intended source', async () => {
    // Set up: same slug under both default and testsrc.
    await engine.putPage(TL_SLUG, { type: 'concept', title: 'TL default', compiled_truth: '' });
    await engine.putPage(TL_SLUG, { type: 'concept', title: 'TL testsrc', compiled_truth: '' }, { sourceId: 'testsrc' });

    // Pre-fix: bare-slug `INSERT ... SELECT id FROM pages WHERE slug = $1`
    // would have inserted timeline rows for BOTH source rows, fanning out
    // the entry across sources.
    await engine.addTimelineEntry(TL_SLUG, {
      date: '2026-05-07',
      source: 'test',
      summary: 'testsrc-only entry',
      detail: 'Should land only under testsrc.',
    }, { sourceId: 'testsrc' });

    const rows = await engine.executeRaw<{ source_id: string; summary: string }>(
      `SELECT p.source_id, te.summary
         FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id
        WHERE p.slug = $1`,
      [TL_SLUG],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('testsrc');
    expect(rows[0].summary).toBe('testsrc-only entry');
  });

  test('addTimelineEntry rejects missing source-qualified page', async () => {
    let err: Error | null = null;
    try {
      await engine.addTimelineEntry(TL_SLUG, {
        date: '2026-05-08',
        source: 'test',
        summary: 'bad source',
        detail: '',
      }, { sourceId: 'nonexistent-src' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/not found/);
  });

  test('addTimelineEntry without opts defaults to source=default (back-compat)', async () => {
    await engine.addTimelineEntry(TL_SLUG, {
      date: '2026-05-09',
      source: 'test',
      summary: 'default-source entry',
      detail: '',
    });

    const rows = await engine.executeRaw<{ source_id: string; summary: string }>(
      `SELECT p.source_id, te.summary
         FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id
        WHERE p.slug = $1 AND te.summary = 'default-source entry'`,
      [TL_SLUG],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
  });
});

describe('deletePage + updateSlug source-scoping (Data R2 CRITICAL + HIGH fix)', () => {
  const DEL_SLUG = 'topics/regression-delete';
  const REN_FROM = 'topics/regression-rename-from';
  const REN_TO = 'topics/regression-rename-to';

  test('deletePage with opts.sourceId only deletes the intended source row', async () => {
    // Set up: same slug under both default and testsrc.
    await engine.putPage(DEL_SLUG, { type: 'concept', title: 'D default', compiled_truth: '' });
    await engine.putPage(DEL_SLUG, { type: 'concept', title: 'D testsrc', compiled_truth: '' }, { sourceId: 'testsrc' });

    // Pre-fix: bare `DELETE FROM pages WHERE slug = $1` would have hard-deleted
    // BOTH rows across sources. Post-fix: only the testsrc row goes.
    await engine.deletePage(DEL_SLUG, { sourceId: 'testsrc' });

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1`,
      [DEL_SLUG],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
  });

  test('deletePage without opts targets source=default only (back-compat)', async () => {
    // Recreate the testsrc row to test that default-source delete leaves it.
    await engine.putPage(DEL_SLUG, { type: 'concept', title: 'D testsrc back', compiled_truth: '' }, { sourceId: 'testsrc' });
    await engine.deletePage(DEL_SLUG); // no opts → defaults to 'default'

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1`,
      [DEL_SLUG],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('testsrc');
  });

  test('updateSlug with opts.sourceId only renames the intended source row', async () => {
    // Set up: same slug under both default and testsrc.
    await engine.putPage(REN_FROM, { type: 'concept', title: 'R default', compiled_truth: '' });
    await engine.putPage(REN_FROM, { type: 'concept', title: 'R testsrc', compiled_truth: '' }, { sourceId: 'testsrc' });

    // Pre-fix: bare `UPDATE pages SET slug = $new WHERE slug = $old` would have
    // hit both rows; if REN_TO already existed in either source, the (source_id,
    // slug) UNIQUE would fail. Post-fix: only the testsrc row gets renamed.
    await engine.updateSlug(REN_FROM, REN_TO, { sourceId: 'testsrc' });

    const fromRows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1 ORDER BY source_id`,
      [REN_FROM],
    );
    expect(fromRows.length).toBe(1);
    expect(fromRows[0].source_id).toBe('default');

    const toRows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1`,
      [REN_TO],
    );
    expect(toRows.length).toBe(1);
    expect(toRows[0].source_id).toBe('testsrc');
  });

  test('getChunks with opts.sourceId only returns the intended source\'s chunks', async () => {
    // Set up: same slug under both default and testsrc, each with distinct chunks.
    const CHUNK_SLUG = 'topics/regression-getchunks';
    await engine.putPage(CHUNK_SLUG, { type: 'concept', title: 'C default', compiled_truth: '' });
    await engine.putPage(CHUNK_SLUG, { type: 'concept', title: 'C testsrc', compiled_truth: '' }, { sourceId: 'testsrc' });
    await engine.upsertChunks(CHUNK_SLUG, [
      { chunk_index: 0, chunk_text: 'default chunk text', chunk_source: 'compiled_truth' },
    ], { sourceId: 'default' });
    await engine.upsertChunks(CHUNK_SLUG, [
      { chunk_index: 0, chunk_text: 'testsrc chunk text', chunk_source: 'compiled_truth' },
    ], { sourceId: 'testsrc' });

    // Pre-fix: bare-slug `WHERE p.slug = $1` returned BOTH source's chunks
    // mashed together. importCodeFile uses getChunks for incremental embedding
    // reuse; pre-fix would have grabbed the wrong source's embeddings.
    const defaultChunks = await engine.getChunks(CHUNK_SLUG, { sourceId: 'default' });
    expect(defaultChunks.length).toBe(1);
    expect(defaultChunks[0].chunk_text).toBe('default chunk text');

    const testsrcChunks = await engine.getChunks(CHUNK_SLUG, { sourceId: 'testsrc' });
    expect(testsrcChunks.length).toBe(1);
    expect(testsrcChunks[0].chunk_text).toBe('testsrc chunk text');
  });

  test('updateSlug without opts targets source=default only (back-compat)', async () => {
    // Default still has REN_FROM. Rename it without opts; testsrc REN_TO
    // already exists, so a bare rename would fail (source_id, slug) UNIQUE
    // when both default and testsrc converge on REN_TO. Source-scoped rename
    // succeeds because testsrc is untouched.
    const REN_TO_2 = 'topics/regression-rename-to-2';
    await engine.updateSlug(REN_FROM, REN_TO_2);

    const rows = await engine.executeRaw<{ source_id: string; slug: string }>(
      `SELECT source_id, slug FROM pages WHERE slug IN ($1, $2) ORDER BY source_id`,
      [REN_FROM, REN_TO_2],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
    expect(rows[0].slug).toBe(REN_TO_2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v0.31.8 — op-handler-layer threading (D7 + D11 + D16 + D20 + D21 + D22)
//
// The pre-v0.31.8 op handlers in src/core/operations.ts called engine methods
// bare-slug, ignoring ctx.sourceId. Result: a remote MCP token whose
// ctx.sourceId='X' calling put_page / add_tag / get_links / etc. silently
// landed on source 'default'. This block drives the actual op handlers
// (operations.ts) — not just the engine surface — through a mock
// OperationContext carrying sourceId='X' and asserts only the X-source row
// is mutated/read.
// ─────────────────────────────────────────────────────────────────────────

import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

function makeCtx(eng: PGLiteEngine, overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: eng as unknown as OperationContext['engine'],
    config: { engine: 'pglite' } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

function getOp(name: string) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`op not registered: ${name}`);
  return op;
}

describe('v0.31.8 op-handler ctx.sourceId threading', () => {
  // Two-source fixture seeded fresh for this block. Use unique slugs so the
  // earlier engine-layer suite's leftover state doesn't pollute assertions.
  const TAG_SLUG = 'topics/op-tag-target';

  beforeAll(async () => {
    // Page exists at BOTH sources (the v0.18.0 supported state).
    await engine.putPage(TAG_SLUG, {
      type: 'concept', title: 'Default tag target', compiled_truth: '.',
    });
    await engine.putPage(TAG_SLUG, {
      type: 'concept', title: 'Testsrc tag target', compiled_truth: '.',
    }, { sourceId: 'testsrc' });
  });

  test('add_tag handler with ctx.sourceId=testsrc tags only the testsrc row', async () => {
    const op = getOp('add_tag');
    await op.handler(makeCtx(engine, { sourceId: 'testsrc' }), { slug: TAG_SLUG, tag: 'op-handler-test-1' });

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT p.source_id FROM tags t JOIN pages p ON p.id = t.page_id
       WHERE p.slug = $1 AND t.tag = $2`,
      [TAG_SLUG, 'op-handler-test-1'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('testsrc');
  });

  test('add_tag handler without ctx.sourceId tags the default row (back-compat)', async () => {
    const op = getOp('add_tag');
    await op.handler(makeCtx(engine), { slug: TAG_SLUG, tag: 'op-handler-test-2' });

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT p.source_id FROM tags t JOIN pages p ON p.id = t.page_id
       WHERE p.slug = $1 AND t.tag = $2`,
      [TAG_SLUG, 'op-handler-test-2'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
  });

  test('get_tags handler with ctx.sourceId=testsrc returns only testsrc tags', async () => {
    // Both rows should now have one tag each from the two tests above.
    const op = getOp('get_tags');
    const tags = await op.handler(makeCtx(engine, { sourceId: 'testsrc' }), { slug: TAG_SLUG }) as string[];
    expect(tags).toContain('op-handler-test-1');
    expect(tags).not.toContain('op-handler-test-2');
  });

  test('get_tags handler without ctx.sourceId returns default-source tags (back-compat)', async () => {
    const op = getOp('get_tags');
    const tags = await op.handler(makeCtx(engine), { slug: TAG_SLUG }) as string[];
    // getTags is a v0.18.0-era source-aware method: it already defaults to
    // source='default' when opts is omitted (see engine.ts addTag/removeTag/
    // getTags comment). It does NOT use the D16 two-branch pattern — the
    // pre-v0.31.8 behavior for tags on multi-source brains was always
    // "scoped to default unless told otherwise." So with ctx.sourceId unset,
    // only the default-source tag surfaces. (D16 two-branch applies to
    // getLinks/getBacklinks/getTimeline/getRawData/getVersions/getAllSlugs/
    // revertToVersion — the methods that pre-D12 had no source filter at all.)
    expect(tags).toContain('op-handler-test-2');
    expect(tags).not.toContain('op-handler-test-1');
  });

  test('add_link handler with ctx.sourceId scopes both endpoints', async () => {
    // Seed a target page at both sources so addLink's INTERSECT pre-check passes.
    const TARGET = 'topics/op-link-target';
    await engine.putPage(TARGET, { type: 'concept', title: 'Default target', compiled_truth: '.' });
    await engine.putPage(TARGET, { type: 'concept', title: 'Testsrc target', compiled_truth: '.' }, { sourceId: 'testsrc' });

    const op = getOp('add_link');
    await op.handler(makeCtx(engine, { sourceId: 'testsrc' }), {
      from: TAG_SLUG, to: TARGET, link_type: 'mentions', context: 'op-test',
    });

    const rows = await engine.executeRaw<{ from_source: string; to_source: string }>(
      `SELECT f.source_id AS from_source, t.source_id AS to_source
       FROM links l JOIN pages f ON f.id = l.from_page_id
                    JOIN pages t ON t.id = l.to_page_id
       WHERE f.slug = $1 AND t.slug = $2 AND l.link_type = 'mentions'`,
      [TAG_SLUG, TARGET],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].from_source).toBe('testsrc');
    expect(rows[0].to_source).toBe('testsrc');
  });

  test('get_links handler scopes to ctx.sourceId; default source view (v0.34 STEP 0)', async () => {
    const op = getOp('get_links');
    const scoped = await op.handler(makeCtx(engine, { sourceId: 'testsrc' }), { slug: TAG_SLUG }) as Array<{ to_slug: string }>;
    const defaultCtx = await op.handler(makeCtx(engine), { slug: TAG_SLUG }) as Array<{ to_slug: string }>;
    // testsrc has the link from add_link test above; the default-source view
    // has none.
    expect(scoped.length).toBeGreaterThanOrEqual(1);
    // v0.34 STEP 0 (D4): OperationContext.sourceId is REQUIRED. makeCtx with
    // no override falls back to 'default'. The pre-v0.34 back-compat
    // "ctx.sourceId undefined → cross-source view" is gone by design —
    // it's the exact cross-source-bleed bug class STEP 0 closed. Cross-
    // source visibility is now an explicit caller decision (e.g. a sources
    // admin running an explicit "all-sources" probe).
    expect(defaultCtx.length).toBeLessThanOrEqual(scoped.length);
  });

  test('delete_page handler scopes to ctx.sourceId (soft-delete only the testsrc row)', async () => {
    // Use a fresh slug so we don't impact other tests in this describe block.
    const DEL_SLUG = 'topics/op-delete-target';
    await engine.putPage(DEL_SLUG, { type: 'concept', title: 'Default', compiled_truth: '.' });
    await engine.putPage(DEL_SLUG, { type: 'concept', title: 'Testsrc', compiled_truth: '.' }, { sourceId: 'testsrc' });

    const op = getOp('delete_page');
    await op.handler(makeCtx(engine, { sourceId: 'testsrc' }), { slug: DEL_SLUG });

    const rows = await engine.executeRaw<{ source_id: string; deleted_at: string | null }>(
      `SELECT source_id, deleted_at FROM pages WHERE slug = $1 ORDER BY source_id`,
      [DEL_SLUG],
    );
    expect(rows.length).toBe(2);
    const def = rows.find(r => r.source_id === 'default')!;
    const tst = rows.find(r => r.source_id === 'testsrc')!;
    expect(def.deleted_at).toBeNull();         // default row untouched
    expect(tst.deleted_at).not.toBeNull();      // testsrc row soft-deleted
  });

  test('put_raw_data handler threads ctx.sourceId (D21)', async () => {
    const op = getOp('put_raw_data');
    await op.handler(makeCtx(engine, { sourceId: 'testsrc' }), {
      slug: TAG_SLUG, source: 'unit-test', data: { variant: 'testsrc' },
    });

    // Read via the engine to assert which source row got the raw_data.
    const rd = await engine.getRawData(TAG_SLUG, 'unit-test', { sourceId: 'testsrc' });
    expect(rd.length).toBe(1);
    expect((rd[0].data as { variant: string }).variant).toBe('testsrc');

    // Default-source raw_data should be untouched.
    const defRd = await engine.getRawData(TAG_SLUG, 'unit-test', { sourceId: 'default' });
    expect(defRd.length).toBe(0);
  });
});
