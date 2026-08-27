/**
 * #2544 — runAutoLink's existence check is a targeted probe, not getAllSlugs.
 *
 * Pre-fix, EVERY put_page with auto-link enabled materialized the whole
 * brain's slug set (getAllSlugs = full pages scan) just to validate a
 * handful of candidate link targets. The check now probes exactly the
 * candidate target/from slugs (`slug = ANY($1::text[]) AND source_id = $2`,
 * the proven oneshot pattern) and skips the query when there are no
 * candidates.
 *
 * These tests pin the BEHAVIOR through put_page: resolvable references
 * still create links, references to nonexistent pages are still dropped
 * (FK-churn guard), link-free pages still reconcile to zero, and source
 * scoping still confines resolution to the write's source.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

// PGLite schema init (130 migrations) exceeds the 5s default hook timeout on
// a loaded machine — same mitigation as hybrid-cache-scope-poison.serial.
setDefaultTimeout(30_000);

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway(); // no embedding provider → put_page runs noEmbed
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;

type PutResult = {
  status: string;
  auto_links?: { created: number; removed: number; errors: number } | { error: string } | { skipped: string };
};

async function put(slug: string, body: string, ctx = makeCtx()): Promise<PutResult> {
  return (await putPage.handler(ctx, {
    slug,
    content: `---\ntitle: ${slug}\n---\n\n${body}`,
  })) as PutResult;
}

describe('#2544 — auto-link behavior through put_page (targeted probe)', () => {
  test('a reference to an existing page still creates the link', async () => {
    await put('people/alice-example', 'A person page.');
    const result = await put('meetings/2026-04-03', 'Discussed roadmap with people/alice-example today.');
    expect(result.status).toBe('created_or_updated');
    const links = result.auto_links as { created: number };
    expect(links.created).toBeGreaterThanOrEqual(1);
    const rows = await engine.getLinks('meetings/2026-04-03', { sourceId: 'default' });
    expect(rows.some((l) => l.to_slug === 'people/alice-example')).toBe(true);
  });

  test('a reference to a nonexistent page is still dropped (no FK churn)', async () => {
    const result = await put('meetings/2026-04-04', 'Mentioned people/ghost-nobody in passing.');
    const links = result.auto_links as { created: number; errors: number };
    expect(links.created).toBe(0);
    expect(links.errors).toBe(0);
    const rows = await engine.getLinks('meetings/2026-04-04', { sourceId: 'default' });
    expect(rows).toHaveLength(0);
  });

  test('a link-free page reconciles to zero without error (probe skipped)', async () => {
    const result = await put('inbox/plain-note', 'No references here at all.');
    const links = result.auto_links as { created: number; removed: number; errors: number };
    expect(links.created).toBe(0);
    expect(links.errors).toBe(0);
  });

  test('resolution stays scoped to the write source', async () => {
    // Target exists ONLY in 'default'. A write into source-b must not link to it.
    // Real writable dir: #3935 (absorbed this wave) makes put_page throw
    // storage_error on a failed write-through, so a fake path would fail the
    // put before scoped resolution is ever exercised.
    const sourceBDir = mkdtempSync(join(tmpdir(), 'gbrain-2544-source-b-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('source-b', 'source-b', '${sourceBDir.replace(/'/g, "''")}', '{}'::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
    );
    await put('people/alice-example', 'A person page in default.');
    const result = await put(
      'meetings/cross-source',
      'Mentions people/alice-example which lives in another source.',
      makeCtx({ sourceId: 'source-b' }),
    );
    const links = result.auto_links as { created: number };
    expect(links.created).toBe(0);
    const rows = await engine.getLinks('meetings/cross-source', { sourceId: 'source-b' });
    expect(rows).toHaveLength(0);
  });

  test('probe binds the slug array with an explicit ::text[] cast (postgres.js parity)', () => {
    // The PGLite behavior tests above can't see this: postgres.js binds a JS
    // array parameter without server-side type context, so a bare ANY($1)
    // relies on inference the house style never does (cf. dropPrivateSlugs in
    // the same file). Pin the cast on EVERY slug-array probe in pages.ts.
    // test-reads-source-ok: postgres.js-only bind-cast bug is invisible on the PGLite runtime path; the ::text[] cast pin is the unit-testable seam
    const src = readFileSync(join(import.meta.dir, '../src/core/ops/pages.ts'), 'utf8');
    const probes = src.match(/slug = ANY\(\$1[^)]*\)/g) ?? [];
    expect(probes.length).toBeGreaterThanOrEqual(2); // both runAutoLink branches
    for (const probe of probes) expect(probe).toContain('::text[]');
  });

  test('stale-link removal still works (reconciliation unaffected)', async () => {
    await put('people/alice-example', 'A person page.');
    await put('meetings/removal-check', 'With people/alice-example.');
    const before = await engine.getLinks('meetings/removal-check', { sourceId: 'default' });
    expect(before.some((l) => l.to_slug === 'people/alice-example')).toBe(true);
    // Rewrite without the reference: the edge must be reconciled away.
    const result = await put('meetings/removal-check', 'Reference removed entirely, new content.');
    const links = result.auto_links as { removed: number };
    expect(links.removed).toBeGreaterThanOrEqual(1);
    const after = await engine.getLinks('meetings/removal-check', { sourceId: 'default' });
    expect(after.some((l) => l.to_slug === 'people/alice-example')).toBe(false);
  });
});
