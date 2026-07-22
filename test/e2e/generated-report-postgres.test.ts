/**
 * #2570 v1 — Postgres parity for buildGeneratedPagesReport.
 *
 * DATABASE_URL-gated (skips without a database, same pattern as the other
 * postgres e2e suites). The report path is raw SQL through
 * `engine.executeRaw` with positional params; PGLite hides postgres.js
 * quirks, so this compact fixture re-runs the load-bearing behaviors on the
 * real driver: durable-marker enumeration (jsonb_typeof boolean strictness),
 * the mentions exclusion, the summary_only bucket, the `--since` bind, and
 * the coverage warning.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { buildGeneratedPagesReport } from '../../src/core/generated-report.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

const CYCLE = '2026-07-01';
const SUMMARY_SLUG = `dream-cycle-summaries/${CYCLE}`;
const PREFIX = 'genrep-pg';

let engine: PostgresEngine;

beforeAll(async () => {
  if (skip) return;
  engine = (await setupDB()) as PostgresEngine;

  const put = (slug: string, frontmatter?: Record<string, unknown>) =>
    engine.putPage(slug, {
      type: 'note',
      title: `Title of ${slug}`,
      compiled_truth: `Body of ${slug}.`,
      ...(frontmatter ? { frontmatter } : {}),
    });

  await put(`${PREFIX}/people/curator`);
  await put(SUMMARY_SLUG, { dream_generated: true, dream_cycle_date: CYCLE });
  await put(`${PREFIX}/gen-adopted`, { dream_generated: true, dream_cycle_date: CYCLE });
  await put(`${PREFIX}/gen-summary-only`, { dream_generated: true, dream_cycle_date: CYCLE });
  await put(`${PREFIX}/gen-mentions-only`, { dream_generated: true, dream_cycle_date: CYCLE });
  await put(`${PREFIX}/gen-string-marker`, { dream_generated: 'true', dream_cycle_date: CYCLE });
  await put(`${PREFIX}/gen-unstamped`);

  await engine.addLink(`${PREFIX}/people/curator`, `${PREFIX}/gen-adopted`, '', 'references', 'markdown');
  await engine.addLink(SUMMARY_SLUG, `${PREFIX}/gen-summary-only`, '', 'references', 'markdown');
  await engine.addLink(`${PREFIX}/people/curator`, `${PREFIX}/gen-mentions-only`, '', 'references', 'mentions');
  await engine.addLink(SUMMARY_SLUG, `${PREFIX}/gen-unstamped`, '', 'references', 'markdown');
  await engine.addLink(SUMMARY_SLUG, `${PREFIX}/gen-string-marker`, '', 'references', 'markdown');
});

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

describeIfDB('buildGeneratedPagesReport (Postgres parity)', () => {
  test('buckets, marker strictness, mentions exclusion, coverage', async () => {
    const report = await buildGeneratedPagesReport(engine, { limit: 0 });

    // Scanned: 3 canonical-marker gen pages + the summary index page.
    // NOT scanned: string marker (jsonb_typeof strictness), unstamped page.
    expect(report.summary.generated_pages_scanned).toBe(4);
    expect(report.summary.buckets.external).toBe(1);
    expect(report.summary.buckets.summary_only).toBe(1);
    // mentions-only page + the summary page itself
    expect(report.summary.buckets.none).toBe(2);

    const bySlug = new Map(report.candidates.map((c) => [c.slug, c]));
    expect(bySlug.has(`${PREFIX}/gen-adopted`)).toBe(false); // external → not a candidate
    expect(bySlug.get(`${PREFIX}/gen-summary-only`)?.bucket).toBe('summary_only');
    const mentionsOnly = bySlug.get(`${PREFIX}/gen-mentions-only`)!;
    expect(mentionsOnly.bucket).toBe('none');
    expect(mentionsOnly.inbound.raw_edges).toBe(1);
    expect(mentionsOnly.inbound.eligible_edges).toBe(0);
    expect(bySlug.has(`${PREFIX}/gen-string-marker`)).toBe(false);

    // Coverage: unstamped + string-marker (both summary-linked, no durable marker).
    expect(report.coverage.summary_linked_unstamped).toBe(2);
  });

  test('--since binds through positional params on the real driver', async () => {
    const inside = await buildGeneratedPagesReport(engine, { since: CYCLE, limit: 0 });
    expect(inside.summary.generated_pages_scanned).toBe(4);
    const outside = await buildGeneratedPagesReport(engine, { since: '2026-07-02', limit: 0 });
    expect(outside.summary.generated_pages_scanned).toBe(0);
    expect(outside.coverage.summary_linked_unstamped).toBe(0);
  });
});
