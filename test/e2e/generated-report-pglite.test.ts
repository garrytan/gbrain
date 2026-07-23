/**
 * #2570 v1 e2e — buildGeneratedPagesReport against a real PGLite engine.
 *
 * Exercises the full query + assembly path the CLI (`gbrain adoption list`)
 * and the MCP op (`list_generated_pages`) share: durable-marker enumeration,
 * the four buckets, mentions exclusion, soft-deleted origin/target handling,
 * extract_receipt exclusion, the `--since` window on dream_cycle_date,
 * source scoping, the #2569 coverage warning, and candidate sort/cap
 * determinism. Zero-write contract: repeated runs return identical output.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  buildGeneratedPagesReport,
  GENERATED_REPORT_SCHEMA_VERSION,
} from '../../src/core/generated-report.ts';

let engine: PGLiteEngine;

const CYCLE = '2026-07-01';
const OLD_CYCLE = '2026-01-05';
const SUMMARY_SLUG = `dream-cycle-summaries/${CYCLE}`;
const OLD_SUMMARY_SLUG = `dream-cycle-summaries/${OLD_CYCLE}`;

function dreamFm(cycle: string = CYCLE): Record<string, unknown> {
  return { dream_generated: true, dream_cycle_date: cycle };
}

async function putNote(
  slug: string,
  frontmatter?: Record<string, unknown>,
  opts?: { sourceId?: string; type?: string },
): Promise<void> {
  await engine.putPage(
    slug,
    {
      type: opts?.type ?? 'note',
      title: `Title of ${slug}`,
      compiled_truth: `Body of ${slug}.`,
      ...(frontmatter ? { frontmatter } : {}),
    },
    opts?.sourceId ? { sourceId: opts.sourceId } : undefined,
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // Human/curated pages.
  await putNote('people/alice-example');
  await putNote('people/bob-example');
  await putNote('people/deleted-fan');

  // Summary index pages (dream-stamped, like writeSummaryPage does).
  await putNote(SUMMARY_SLUG, dreamFm(CYCLE));
  await putNote(OLD_SUMMARY_SLUG, dreamFm(OLD_CYCLE));

  // Generated pages under review.
  await putNote('ideas/gen-external', dreamFm());        // → external
  await putNote('ideas/gen-summary-only', dreamFm());    // → summary_only
  await putNote('ideas/gen-cluster', dreamFm());         // → generated_cluster
  await putNote('ideas/gen-none', dreamFm());            // → none (self-link only)
  await putNote('ideas/gen-mentions-only', dreamFm());   // → none (mentions never promote)
  await putNote('ideas/gen-deleted-origin', dreamFm());  // → none (its only fan is soft-deleted)
  await putNote('ideas/gen-deleted-target', dreamFm());  // soft-deleted → not scanned
  await putNote('ideas/gen-old-cycle', dreamFm(OLD_CYCLE)); // outside --since window

  // Marker-reuse / invalid-marker pages that must NOT be scanned.
  await putNote(
    'receipts/extract-r1',
    { dream_generated: true, kind: 'facts' },
    { type: 'extract_receipt' },
  );
  await putNote('ideas/flag-no-date', { dream_generated: true }); // no cycle date
  await putNote('ideas/bad-date', { dream_generated: true, dream_cycle_date: 'soon' });
  // Noncanonical STRING marker — not the #2569 boolean stamp; must not be
  // enumerated (jsonb_typeof strictness in SQL).
  await putNote('ideas/string-marker', {
    dream_generated: 'true',
    dream_cycle_date: CYCLE,
  });

  // Summary-linked page WITHOUT the durable marker (#2569 best-effort stamp
  // failed / pre-#2569 cycle) → coverage warning.
  await putNote('ideas/gen-unstamped');

  // Second source with its own generated page (scoping check).
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('srcb', 'srcb') ON CONFLICT (id) DO NOTHING`,
  );
  await putNote('ideas/gen-in-srcb', dreamFm(), { sourceId: 'srcb' });
  // srcb page adopted from a DIFFERENT source: cross-source inbound links
  // count as adoption (findOrphans' deliberate definition — target side is
  // scoped, inbound origins are not).
  await putNote('ideas/gen-srcb-cross-adopted', dreamFm(), { sourceId: 'srcb' });

  // --- links ---
  // external adoption (explicit markdown ref from a human page)
  await engine.addLink('people/alice-example', 'ideas/gen-external', '', 'references', 'markdown');
  // gen-external is ALSO summary-linked + mentioned — external must win.
  await engine.addLink(SUMMARY_SLUG, 'ideas/gen-external', '', 'references', 'markdown');
  await engine.addLink('people/bob-example', 'ideas/gen-external', '', 'references', 'mentions');

  // summary_only
  await engine.addLink(SUMMARY_SLUG, 'ideas/gen-summary-only', '', 'references', 'markdown');

  // generated_cluster (sibling generated page + its summary)
  await engine.addLink('ideas/gen-external', 'ideas/gen-cluster', '', 'references', 'markdown');
  await engine.addLink(SUMMARY_SLUG, 'ideas/gen-cluster', '', 'references', 'markdown');

  // none via self-link only
  await engine.addLink('ideas/gen-none', 'ideas/gen-none', '', 'references', 'markdown');

  // none via mentions-only inbound
  await engine.addLink('people/alice-example', 'ideas/gen-mentions-only', '', 'references', 'mentions');

  // soft-deleted origin: link first, then delete the fan page
  await engine.addLink('people/deleted-fan', 'ideas/gen-deleted-origin', '', 'references', 'markdown');
  await engine.softDeletePage('people/deleted-fan');

  // soft-deleted target: give it an external link so a leak would be visible
  await engine.addLink('people/alice-example', 'ideas/gen-deleted-target', '', 'references', 'markdown');
  await engine.softDeletePage('ideas/gen-deleted-target');

  // old-cycle page: summary-linked from its own old cycle
  await engine.addLink(OLD_SUMMARY_SLUG, 'ideas/gen-old-cycle', '', 'references', 'markdown');

  // coverage: summary links a page that lacks the durable marker
  await engine.addLink(SUMMARY_SLUG, 'ideas/gen-unstamped', '', 'references', 'markdown');
  // coverage: the string-marker page is also summary-linked — it must land
  // in the coverage warning, not the scan.
  await engine.addLink(SUMMARY_SLUG, 'ideas/string-marker', '', 'references', 'markdown');

  // cross-source adoption edge (default-source human page → srcb page)
  await engine.addLink(
    'people/alice-example',
    'ideas/gen-srcb-cross-adopted',
    '',
    'references',
    'markdown',
    undefined,
    undefined,
    { fromSourceId: 'default', toSourceId: 'srcb' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('buildGeneratedPagesReport (PGLite e2e)', () => {
  test('classifies the four buckets, excludes invalid markers, and reports coverage', async () => {
    const report = await buildGeneratedPagesReport(engine, { limit: 0 });

    expect(report.schema_version).toBe(GENERATED_REPORT_SCHEMA_VERSION);
    expect(report.report).toBe('generated_pages');
    expect(report.window.since).toBeNull();
    expect(report.source_scope).toBeNull();

    // Scanned: 6 default-source live marker pages in CYCLE + gen-old-cycle +
    // 2 srcb pages + the two summary index pages (they carry the durable
    // marker themselves). NOT scanned: receipt, flag-no-date, bad-date,
    // string-marker (noncanonical), deleted target.
    const bySlug = new Map(report.candidates.map((c) => [`${c.source_id}:${c.slug}`, c]));
    expect(report.summary.generated_pages_scanned).toBe(11);

    // external: gen-external + the cross-source-adopted srcb page
    expect(report.summary.buckets.external).toBe(2);
    // summary_only: gen-summary-only + gen-old-cycle
    expect(report.summary.buckets.summary_only).toBe(2);
    // generated_cluster: gen-cluster (sibling wins over summary)
    expect(report.summary.buckets.generated_cluster).toBe(1);
    // none: gen-none, gen-mentions-only, gen-deleted-origin, gen-in-srcb,
    // and the two summary pages themselves (nothing links to a summary).
    expect(report.summary.buckets.none).toBe(6);

    // Candidates exclude the external page.
    expect(bySlug.has('default:ideas/gen-external')).toBe(false);
    expect(bySlug.get('default:ideas/gen-summary-only')?.bucket).toBe('summary_only');
    expect(bySlug.get('default:ideas/gen-cluster')?.bucket).toBe('generated_cluster');
    expect(bySlug.get('default:ideas/gen-none')?.bucket).toBe('none');
    expect(bySlug.get('default:ideas/gen-mentions-only')?.bucket).toBe('none');
    expect(bySlug.get('default:ideas/gen-deleted-origin')?.bucket).toBe('none');
    expect(bySlug.get('srcb:ideas/gen-in-srcb')?.bucket).toBe('none');
    // Soft-deleted target and invalid-marker pages never appear.
    expect(bySlug.has('default:ideas/gen-deleted-target')).toBe(false);
    expect(bySlug.has('default:receipts/extract-r1')).toBe(false);
    expect(bySlug.has('default:ideas/flag-no-date')).toBe(false);
    expect(bySlug.has('default:ideas/bad-date')).toBe(false);
    expect(bySlug.has('default:ideas/string-marker')).toBe(false);
    // Cross-source-adopted page is external → counted, never a candidate.
    expect(bySlug.has('srcb:ideas/gen-srcb-cross-adopted')).toBe(false);

    // Inbound stats detail: mentions counted raw but not eligible.
    const mentionsOnly = bySlug.get('default:ideas/gen-mentions-only')!;
    expect(mentionsOnly.inbound.raw_edges).toBe(1);
    expect(mentionsOnly.inbound.eligible_edges).toBe(0);
    expect(mentionsOnly.inbound.mentions_only_origins).toBe(1);

    // Self-link accounting.
    const selfOnly = bySlug.get('default:ideas/gen-none')!;
    expect(selfOnly.inbound.self_link_edges).toBe(1);
    expect(selfOnly.inbound.raw_edges).toBe(0);

    // Soft-deleted origin contributes nothing (raw included).
    const deletedOrigin = bySlug.get('default:ideas/gen-deleted-origin')!;
    expect(deletedOrigin.inbound.raw_edges).toBe(0);

    // Coverage: the unstamped summary-linked page + the noncanonical
    // string-marker page (summary-linked, but not the durable boolean stamp).
    expect(report.coverage.summary_linked_unstamped).toBe(2);
  });

  test('zero writes / idempotent: an immediate re-run returns identical JSON', async () => {
    const a = await buildGeneratedPagesReport(engine, { limit: 0 });
    const b = await buildGeneratedPagesReport(engine, { limit: 0 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test('--since windows on dream_cycle_date (inclusive) and scopes coverage', async () => {
    const report = await buildGeneratedPagesReport(engine, { since: '2026-06-01', limit: 0 });
    expect(report.window.since).toBe('2026-06-01');
    const slugs = report.candidates.map((c) => c.slug);
    expect(slugs).not.toContain('ideas/gen-old-cycle');
    // The old summary page (cycle 2026-01-05) is also outside the window.
    expect(report.summary.generated_pages_scanned).toBe(9);
    // Inclusive boundary: the cycle date itself passes.
    const inclusive = await buildGeneratedPagesReport(engine, { since: CYCLE, limit: 0 });
    expect(inclusive.candidates.map((c) => c.slug)).toContain('ideas/gen-summary-only');
    // Coverage stays window-scoped (the CYCLE summary is inside the window).
    expect(report.coverage.summary_linked_unstamped).toBe(2);
    const outside = await buildGeneratedPagesReport(engine, { since: '2026-07-02', limit: 0 });
    expect(outside.summary.generated_pages_scanned).toBe(0);
    expect(outside.coverage.summary_linked_unstamped).toBe(0);
  });

  test('source scoping: scalar sourceId and federated sourceIds', async () => {
    const onlyB = await buildGeneratedPagesReport(engine, { sourceId: 'srcb', limit: 0 });
    expect(onlyB.source_scope).toEqual(['srcb']);
    expect(onlyB.summary.generated_pages_scanned).toBe(2);
    // Cross-source inbound adoption is honored even under a srcb-only scope:
    // gen-srcb-cross-adopted classifies external (counted, not a candidate).
    expect(onlyB.summary.buckets.external).toBe(1);
    expect(onlyB.candidates.map((c) => c.slug)).toEqual(['ideas/gen-in-srcb']);
    // srcb has no summary pages → no coverage signal leaks across sources.
    expect(onlyB.coverage.summary_linked_unstamped).toBe(0);

    const onlyDefault = await buildGeneratedPagesReport(engine, { sourceId: 'default', limit: 0 });
    expect(onlyDefault.candidates.map((c) => c.slug)).not.toContain('ideas/gen-in-srcb');

    const federated = await buildGeneratedPagesReport(engine, {
      sourceIds: ['default', 'srcb'],
      limit: 0,
    });
    expect(federated.source_scope).toEqual(['default', 'srcb']);
    expect(federated.summary.generated_pages_scanned).toBe(11);
  });

  test('deterministic sort and candidate cap', async () => {
    const full = await buildGeneratedPagesReport(engine, { limit: 0 });
    // Least-adopted first: every none precedes every summary_only precedes
    // every generated_cluster.
    const order = full.candidates.map((c) => c.bucket);
    const firstSummaryIdx = order.indexOf('summary_only');
    const lastNoneIdx = order.lastIndexOf('none');
    expect(lastNoneIdx).toBeLessThan(firstSummaryIdx);
    expect(order.indexOf('generated_cluster')).toBeGreaterThan(order.lastIndexOf('summary_only'));
    // Within summary_only: newest cycle first.
    const summaryOnly = full.candidates.filter((c) => c.bucket === 'summary_only');
    expect(summaryOnly.map((c) => c.dream_cycle_date)).toEqual([CYCLE, OLD_CYCLE]);

    const capped = await buildGeneratedPagesReport(engine, { limit: 3 });
    expect(capped.candidates).toHaveLength(3);
    expect(capped.candidates_truncated).toBe(true);
    expect(capped.total_candidates).toBe(full.total_candidates);
    expect(capped.candidates).toEqual(full.candidates.slice(0, 3));
    // Bucket counts stay complete even when candidates are capped.
    expect(capped.summary).toEqual(full.summary);
  });
});
