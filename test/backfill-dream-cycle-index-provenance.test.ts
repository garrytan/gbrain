/**
 * #1978 follow-up — `gbrain backfill dream_cycle_index_provenance`.
 *
 * Dream-cycle index pages written BEFORE synthesize.ts started stamping
 * `raw_trace_exempt` prospectively warn forever in `doctor`'s raw_provenance
 * check. This backfill applies the writer's own stamp to those rows and
 * nothing else.
 *
 * Runs against real PGLite so the predicate SQL (`?|`, `~`, NOT EXISTS) and
 * the `frontmatter || $N::jsonb` merge are pinned on an actual engine.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getBackfill } from '../src/core/backfill-registry.ts';
import { runBackfill } from '../src/core/backfill-base.ts';
import { rawProvenanceCheck } from '../src/commands/doctor.ts';
import {
  DREAM_CYCLE_SUMMARY_SLUG_PREFIX,
  DREAM_INDEX_RAW_TRACE_EXEMPT_REASON,
  untracedSynthesizedPagesPredicate,
} from '../src/core/raw-provenance.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;

const UNSTAMPED_INDEX = `${DREAM_CYCLE_SUMMARY_SLUG_PREFIX}2026-05-24`;
const STAMPED_INDEX = `${DREAM_CYCLE_SUMMARY_SLUG_PREFIX}2026-06-01`;
const HAND_AUTHORED_IN_NAMESPACE = `${DREAM_CYCLE_SUMMARY_SLUG_PREFIX}notes-about-dreams`;
const WIKI_SYNTHESIS = 'wiki/derived/cross-org-pattern';
const EXTRACT_SYNTHESIS = 'extracts/some-transcript';

function spec() {
  const reg = getBackfill('dream_cycle_index_provenance');
  if (!reg) throw new Error('dream_cycle_index_provenance backfill not registered');
  return reg.spec;
}

async function frontmatterOf(slug: string): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<{ frontmatter: unknown }>(
    `SELECT frontmatter FROM pages WHERE slug = $1`,
    [slug],
  );
  const raw = rows[0]?.frontmatter;
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>;
  return (raw ?? {}) as Record<string, unknown>;
}

async function contentFingerprintOf(slug: string): Promise<{ compiled_truth: string; content_hash: string | null }> {
  const rows = await engine.executeRaw<{ compiled_truth: string; content_hash: string | null }>(
    `SELECT compiled_truth, content_hash FROM pages WHERE slug = $1`,
    [slug],
  );
  return rows[0];
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // 1. The target: a dream-cycle index page from before the writer stamped
  //    the exemption. Carries the writer's dream_generated + dream_cycle_date.
  await engine.putPage(UNSTAMPED_INDEX, {
    type: 'note', title: 'Dream cycle 2026-05-24', compiled_truth: '# Dream cycle 2026-05-24', timeline: '',
    frontmatter: { dream_generated: true, dream_cycle_date: '2026-05-24' },
  });
  // 2. Already stamped by the current writer — must not be rewritten.
  await engine.putPage(STAMPED_INDEX, {
    type: 'note', title: 'Dream cycle 2026-06-01', compiled_truth: '# Dream cycle 2026-06-01', timeline: '',
    frontmatter: {
      dream_generated: true,
      dream_cycle_date: '2026-06-01',
      raw_trace_exempt: true,
      raw_trace_exempt_reason: DREAM_INDEX_RAW_TRACE_EXEMPT_REASON,
    },
  });
  // 3. Hand-authored page that merely lives under the namespace — the slug
  //    tail is not an ISO date, so it is out of scope even though it is
  //    dream_generated.
  await engine.putPage(HAND_AUTHORED_IN_NAMESPACE, {
    type: 'note', title: 'Notes about dreams', compiled_truth: 'body', timeline: '',
    frontmatter: { dream_generated: true },
  });
  // 4/5. Synthesis pages whose accurate provenance is a raw_source that
  //      cannot be reconstructed — deliberately out of scope.
  await engine.putPage(WIKI_SYNTHESIS, {
    type: 'note', title: 'Cross-org pattern', compiled_truth: 'body', timeline: '',
    frontmatter: { dream_generated: true, dream_cycle_date: '2026-07-03' },
  });
  await engine.putPage(EXTRACT_SYNTHESIS, {
    type: 'synthesis', title: 'Extract', compiled_truth: 'body', timeline: '',
    frontmatter: {},
  });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('dream_cycle_index_provenance backfill (#1978 follow-up)', () => {
  test('the slug prefix is a literal with no regex metacharacters', () => {
    // DREAM_CYCLE_INDEX_SLUG_SQL_PATTERN interpolates the prefix into a
    // POSIX ARE; that is only safe while the prefix stays metachar-free.
    expect(DREAM_CYCLE_SUMMARY_SLUG_PREFIX).toMatch(/^[a-z0-9-]+\/$/);
  });

  test('predicate helper rejects a non-identifier alias', () => {
    expect(() => untracedSynthesizedPagesPredicate('p; DROP TABLE pages --')).toThrow();
  });

  test('stamps only the unstamped dream-cycle index page', async () => {
    const before = await contentFingerprintOf(UNSTAMPED_INDEX);

    const result = await runBackfill(engine as unknown as BrainEngine, spec(), { batchSize: 100 });
    expect(result.updated).toBe(1);
    expect(result.errors).toBe(0);

    const fm = await frontmatterOf(UNSTAMPED_INDEX);
    expect(fm.raw_trace_exempt).toBe(true);
    expect(fm.raw_trace_exempt_reason).toBe(DREAM_INDEX_RAW_TRACE_EXEMPT_REASON);
    // Merge, not replace — the writer's existing markers survive.
    expect(fm.dream_generated).toBe(true);
    expect(fm.dream_cycle_date).toBe('2026-05-24');

    // Content untouched: nothing re-chunks or re-embeds off this write.
    const after = await contentFingerprintOf(UNSTAMPED_INDEX);
    expect(after.compiled_truth).toBe(before.compiled_truth);
    expect(after.content_hash).toBe(before.content_hash);
  });

  test('leaves the already-stamped index page, the hand-authored namespace page, and wiki/extracts synthesis pages untouched', async () => {
    const stamped = await frontmatterOf(STAMPED_INDEX);
    expect(stamped.raw_trace_exempt).toBe(true);
    expect(stamped.dream_cycle_date).toBe('2026-06-01');

    for (const slug of [HAND_AUTHORED_IN_NAMESPACE, WIKI_SYNTHESIS, EXTRACT_SYNTHESIS]) {
      const fm = await frontmatterOf(slug);
      expect(fm.raw_trace_exempt).toBeUndefined();
      expect(fm.raw_trace_exempt_reason).toBeUndefined();
    }
  });

  test('re-running is a no-op — and needs no --fresh, because the backfill is not checkpointed', async () => {
    expect(spec().resumable).toBe(false);
    const rerun = await runBackfill(engine as unknown as BrainEngine, spec(), { batchSize: 100 });
    expect(rerun.examined).toBe(0);
    expect(rerun.updated).toBe(0);
    expect(rerun.errors).toBe(0);
  });

  test('doctor no longer names the index page, and still warns about the out-of-scope pages', async () => {
    const check = await rawProvenanceCheck(engine as unknown as BrainEngine);
    expect(check.status).toBe('warn');
    expect(check.message).not.toContain(UNSTAMPED_INDEX);
    expect(check.message).toContain(WIKI_SYNTHESIS);
    expect(check.message).toContain('gbrain backfill dream_cycle_index_provenance');
  });

  test('soft-deleted index pages are not stamped', async () => {
    const deletedSlug = `${DREAM_CYCLE_SUMMARY_SLUG_PREFIX}2026-04-01`;
    await engine.putPage(deletedSlug, {
      type: 'note', title: 'Dream cycle 2026-04-01', compiled_truth: 'body', timeline: '',
      frontmatter: { dream_generated: true, dream_cycle_date: '2026-04-01' },
    });
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = $1`, [deletedSlug]);

    const result = await runBackfill(engine as unknown as BrainEngine, spec(), { batchSize: 100 });
    expect(result.updated).toBe(0);
    expect((await frontmatterOf(deletedSlug)).raw_trace_exempt).toBeUndefined();
  });

  test('an index page with an existing raw trace is skipped (predicate parity with doctor)', async () => {
    const tracedSlug = `${DREAM_CYCLE_SUMMARY_SLUG_PREFIX}2026-03-01`;
    await engine.putPage(tracedSlug, {
      type: 'note', title: 'Dream cycle 2026-03-01', compiled_truth: 'body', timeline: '',
      // dream_cycle_date matches the slug tail on purpose, so this fixture
      // is stopped by the raw-trace guard rather than the date guard.
      frontmatter: {
        dream_generated: true,
        dream_cycle_date: '2026-03-01',
        raw_source: '/transcripts/2026-03-01.md',
      },
    });

    const result = await runBackfill(engine as unknown as BrainEngine, spec(), { batchSize: 100 });
    expect(result.updated).toBe(0);
    expect((await frontmatterOf(tracedSlug)).raw_trace_exempt).toBeUndefined();
  });

  test('a date-shaped slug whose dream_cycle_date disagrees with the slug tail is skipped', async () => {
    // The writer always composes the slug FROM dream_cycle_date, so a
    // mismatch means this page was not produced by writeSummaryPage.
    const impostorSlug = `${DREAM_CYCLE_SUMMARY_SLUG_PREFIX}2026-02-01`;
    await engine.putPage(impostorSlug, {
      type: 'note', title: 'Impostor', compiled_truth: 'body', timeline: '',
      frontmatter: { dream_generated: true, dream_cycle_date: '2025-12-31' },
    });

    const result = await runBackfill(engine as unknown as BrainEngine, spec(), { batchSize: 100 });
    expect(result.updated).toBe(0);
    expect((await frontmatterOf(impostorSlug)).raw_trace_exempt).toBeUndefined();
  });

  test('an index page with an attached raw_data row is skipped', async () => {
    const slug = `${DREAM_CYCLE_SUMMARY_SLUG_PREFIX}2026-02-02`;
    const page = await engine.putPage(slug, {
      type: 'note', title: 'Has raw_data', compiled_truth: 'body', timeline: '',
      frontmatter: { dream_generated: true, dream_cycle_date: '2026-02-02' },
    });
    await engine.executeRaw(
      `INSERT INTO raw_data (page_id, source, data) VALUES ($1, 'test', '{}'::jsonb)`,
      [page.id],
    );

    const result = await runBackfill(engine as unknown as BrainEngine, spec(), { batchSize: 100 });
    expect(result.updated).toBe(0);
    expect((await frontmatterOf(slug)).raw_trace_exempt).toBeUndefined();
  });

  // The synthesis_evidence arm of the predicate is not re-tested here: it is
  // the SAME string as doctor's (untracedSynthesizedPagesPredicate), already
  // pinned against a real engine by test/doctor-raw-provenance.test.ts, and
  // seeding a row requires a full takes(page_id, row_num) FK parent. The
  // raw_data case above proves the NOT EXISTS arms execute on this engine.

  test('dry-run reports the row without writing it', async () => {
    const slug = `${DREAM_CYCLE_SUMMARY_SLUG_PREFIX}2026-01-05`;
    await engine.putPage(slug, {
      type: 'note', title: 'Dry run target', compiled_truth: 'body', timeline: '',
      frontmatter: { dream_generated: true, dream_cycle_date: '2026-01-05' },
    });

    const dry = await runBackfill(engine as unknown as BrainEngine, spec(), { batchSize: 100, dryRun: true });
    expect(dry.examined).toBe(1);
    expect(dry.updated).toBe(0);
    expect((await frontmatterOf(slug)).raw_trace_exempt).toBeUndefined();

    // And the real run then stamps it.
    const real = await runBackfill(engine as unknown as BrainEngine, spec(), { batchSize: 100 });
    expect(real.updated).toBe(1);
    expect((await frontmatterOf(slug)).raw_trace_exempt).toBe(true);
  });
});
