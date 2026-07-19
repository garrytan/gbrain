/**
 * Dismissal-ledger tests — v124 manual-review ledger for the contradiction
 * probe. Pins:
 *   - pair_key identity: order-invariance, kind separation, content drift
 *     re-flags, judge-config independence (by construction: no model/prompt
 *     inputs exist)
 *   - shared projection: matches recomputed keys, so pre-ledger report rows
 *     (no pair_id) filter too; text-less shapes always surface
 *   - engine CRUD on PGLite: active listing, soft-revoke (audit row kept),
 *     re-dismiss reactivation, prefix ambiguity rejection, reason CHECKs
 *   - runner integration: dismissed findings leave every headline count and
 *     the Wilson-CI denominator, land in per_query.dismissed, and
 *     verdict_breakdown still tallies raw judge behavior
 *   - CLI flag parsing for dismiss/undismiss/--include-dismissed
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  PAIR_ID_DISPLAY_LEN,
  activePairKeySet,
  computeFindingPairKey,
  computePairId,
  contradictionPairKey,
  dismissalHashPair,
  flattenRunFindings,
  loadActivePairKeySetBestEffort,
  pairIdFromKey,
  projectContradictionFindings,
} from '../src/core/eval-contradictions/dismissals.ts';
import { runContradictionProbe, type JudgeFn } from '../src/core/eval-contradictions/runner.ts';
import type { JudgeOutput } from '../src/core/eval-contradictions/judge.ts';
import type { SearchResult } from '../src/core/types.ts';
import { parseFlags } from '../src/commands/eval-suspected-contradictions.ts';

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

const TEXT_A = 'Acme MRR is $2M';
const TEXT_B = 'Acme MRR is $50K';

function ledgerRow(kind: string, textA: string, textB: string, reason = 'reviewed: false positive') {
  return {
    pair_key: contradictionPairKey(kind, textA, textB),
    kind,
    ...dismissalHashPair(textA, textB),
    reason,
    dismissed_by: null,
  };
}

// ── identity ────────────────────────────────────────────────────────────

describe('pair_key identity', () => {
  test('order-invariant: (a,b) and (b,a) produce the same key', () => {
    expect(contradictionPairKey('cross_slug_chunks', TEXT_A, TEXT_B))
      .toBe(contradictionPairKey('cross_slug_chunks', TEXT_B, TEXT_A));
  });

  test('kind participates in the identity', () => {
    expect(contradictionPairKey('cross_slug_chunks', TEXT_A, TEXT_B))
      .not.toBe(contradictionPairKey('intra_page_chunk_take', TEXT_A, TEXT_B));
  });

  test('content drift changes the key (the re-flag mechanism)', () => {
    expect(contradictionPairKey('cross_slug_chunks', TEXT_A, TEXT_B))
      .not.toBe(contradictionPairKey('cross_slug_chunks', TEXT_A, TEXT_B + ' (updated)'));
  });

  test('pair_id is the fixed-length hex prefix of pair_key', () => {
    const key = contradictionPairKey('cross_slug_chunks', TEXT_A, TEXT_B);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(pairIdFromKey(key)).toBe(key.slice(0, PAIR_ID_DISPLAY_LEN));
    expect(computePairId('cross_slug_chunks', TEXT_A, TEXT_B)).toBe(pairIdFromKey(key));
  });
});

// ── shared projection ───────────────────────────────────────────────────

describe('computeFindingPairKey / projectContradictionFindings', () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    kind: 'cross_slug_chunks',
    a: { slug: 'x', text: TEXT_A },
    b: { slug: 'y', text: TEXT_B },
    severity: 'high',
    ...over,
  });

  test('recomputes the key from finding content', () => {
    expect(computeFindingPairKey(finding()))
      .toBe(contradictionPairKey('cross_slug_chunks', TEXT_A, TEXT_B));
  });

  test('returns null for shapes without member texts or kind', () => {
    expect(computeFindingPairKey(finding({ a: { slug: 'x' } }))).toBeNull();
    expect(computeFindingPairKey(finding({ kind: undefined }))).toBeNull();
    expect(computeFindingPairKey(null)).toBeNull();
    expect(computeFindingPairKey('not-an-object')).toBeNull();
  });

  test('pre-ledger report rows (no pair_id field) still match by content', () => {
    const activeKeys = new Set([contradictionPairKey('cross_slug_chunks', TEXT_A, TEXT_B)]);
    const oldShaped = finding(); // deliberately has no pair_id
    const { surfaced, dismissed } = projectContradictionFindings([oldShaped], activeKeys);
    expect(dismissed).toHaveLength(1);
    expect(surfaced).toHaveLength(0);
  });

  test('unmatchable (text-less) findings always surface', () => {
    const activeKeys = new Set([contradictionPairKey('cross_slug_chunks', TEXT_A, TEXT_B)]);
    const textless = finding({ a: { slug: 'x' } });
    const { surfaced, dismissed } = projectContradictionFindings([textless], activeKeys);
    expect(surfaced).toHaveLength(1);
    expect(dismissed).toHaveLength(0);
  });

  test('non-listed pairs surface', () => {
    const { surfaced, dismissed } = projectContradictionFindings([finding()], new Set(['0'.repeat(64)]));
    expect(surfaced).toHaveLength(1);
    expect(dismissed).toHaveLength(0);
  });

  test('undismiss restores runner-parked dismissed findings at read time (union projection)', () => {
    // A prior run parked this finding under per_query.dismissed; the ledger
    // row has since been revoked. Projecting the UNION against the current
    // (now-empty) ledger must surface it again — codex round-1 P1.
    const perQuery = [
      { contradictions: [finding({ a: { slug: 'x', text: 'other A' }, b: { slug: 'y', text: 'other B' } })],
        dismissed: [finding()] },
    ];
    const union = flattenRunFindings(perQuery);
    expect(union).toHaveLength(2);
    const { surfaced, dismissed } = projectContradictionFindings(union, new Set());
    expect(surfaced).toHaveLength(2);
    expect(dismissed).toHaveLength(0);
  });

  test('flattenRunFindings tolerates pre-ledger rows without a dismissed array', () => {
    expect(flattenRunFindings([{ contradictions: [finding()] }])).toHaveLength(1);
  });
});

// ── engine CRUD ─────────────────────────────────────────────────────────

describe('dismissal ledger engine methods (PGLite)', () => {
  test('put → list returns the active row with fields intact', async () => {
    const row = ledgerRow('cross_slug_chunks', TEXT_A, TEXT_B, 'same-device apps, not a conflict');
    await engine.putContradictionDismissal(row);
    const listed = await engine.listContradictionDismissals();
    expect(listed).toHaveLength(1);
    expect(listed[0].pair_key).toBe(row.pair_key);
    expect(listed[0].kind).toBe('cross_slug_chunks');
    expect(listed[0].reason).toBe('same-device apps, not a conflict');
    expect(listed[0].dismissed_by).toBeNull();
    expect(activePairKeySet(listed).has(row.pair_key)).toBe(true);
  });

  test('revoke is soft-state: row leaves the active list but survives in the table', async () => {
    const row = ledgerRow('cross_slug_chunks', TEXT_A, TEXT_B);
    await engine.putContradictionDismissal(row);
    const result = await engine.revokeContradictionDismissal(pairIdFromKey(row.pair_key));
    expect(result.status).toBe('revoked');
    expect(result.matches).toEqual([row.pair_key]);
    expect(await engine.listContradictionDismissals()).toHaveLength(0);
    const { rows } = await engine.db.query(
      `SELECT undismissed_at FROM eval_contradictions_dismissals WHERE pair_key = $1`,
      [row.pair_key],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { undismissed_at: unknown }).undismissed_at).not.toBeNull();
  });

  test('re-dismiss after revoke reactivates the same row', async () => {
    const row = ledgerRow('cross_slug_chunks', TEXT_A, TEXT_B, 'first reason');
    await engine.putContradictionDismissal(row);
    await engine.revokeContradictionDismissal(row.pair_key);
    await engine.putContradictionDismissal({ ...row, reason: 'second reason' });
    const listed = await engine.listContradictionDismissals();
    expect(listed).toHaveLength(1);
    expect(listed[0].reason).toBe('second reason');
  });

  test('revoke: not_found on unknown prefix, ambiguous on a shared prefix', async () => {
    expect((await engine.revokeContradictionDismissal('deadbeef')).status).toBe('not_found');
    // Synthetic keys sharing a prefix — pair_key is just TEXT to the engine.
    const base = ledgerRow('cross_slug_chunks', TEXT_A, TEXT_B);
    await engine.putContradictionDismissal({ ...base, pair_key: 'abcd'.padEnd(64, '1') });
    await engine.putContradictionDismissal({ ...base, chunk_a_hash: base.chunk_a_hash + 'x', pair_key: 'abcd'.padEnd(64, '2') });
    const result = await engine.revokeContradictionDismissal('abcd');
    expect(result.status).toBe('ambiguous');
    expect(result.matches).toHaveLength(2);
    // Nothing was revoked.
    expect(await engine.listContradictionDismissals()).toHaveLength(2);
  });

  test('reason CHECK rejects blank (incl. tab/newline-only) and over-long reasons', async () => {
    const row = ledgerRow('cross_slug_chunks', TEXT_A, TEXT_B);
    await expect(engine.putContradictionDismissal({ ...row, reason: '   ' })).rejects.toThrow();
    // btrim's default trim set is spaces only — codex round-1 P2 pinned the
    // CHECK to a whitespace character class instead.
    await expect(engine.putContradictionDismissal({ ...row, reason: '\t\n' })).rejects.toThrow();
    await expect(engine.putContradictionDismissal({ ...row, reason: 'x'.repeat(1001) })).rejects.toThrow();
  });

  test('loadActivePairKeySetBestEffort fails open to an empty set', async () => {
    const broken = { listContradictionDismissals: async () => { throw new Error('table missing'); } };
    const keys = await loadActivePairKeySetBestEffort(broken as never);
    expect(keys.size).toBe(0);
  });
});

// ── runner integration ──────────────────────────────────────────────────

/** Seed a page; returns the id. */
async function seedPage(slug: string, title: string): Promise<number> {
  await engine.putPage(slug, {
    title, type: 'concept', frontmatter: {},
    compiled_truth: `body for ${slug}`, timeline: '',
  });
  const page = await engine.getPage(slug);
  return page!.id;
}

function mkResult(slug: string, page_id: number, chunk_id: number, text: string, score = 1.0): SearchResult {
  return {
    slug, page_id, chunk_id, chunk_index: 0,
    title: slug, type: 'concept',
    chunk_text: text, chunk_source: 'compiled_truth',
    score, stale: false,
  };
}

const contradictionJudge: JudgeFn = async (): Promise<JudgeOutput> => ({
  verdict: {
    verdict: 'contradiction', severity: 'high', axis: 'MRR value',
    confidence: 0.9, resolution_kind: 'manual_review',
  },
  usage: { inputTokens: 500, outputTokens: 80 },
});

describe('runner integration', () => {
  test('dismissed pair leaves headline counts + CI denominator, lands in per_query.dismissed', async () => {
    const idA = await seedPage('companies/acme', 'Acme');
    const idB = await seedPage('openclaw/chat/x', 'Chat');
    await engine.putContradictionDismissal(ledgerRow('cross_slug_chunks', TEXT_A, TEXT_B));

    const out = await runContradictionProbe({
      engine,
      queries: ['what is acme MRR'],
      judgeFn: contradictionJudge,
      searchFn: async () => [
        mkResult('companies/acme', idA, 1, TEXT_A, 1.5),
        mkResult('openclaw/chat/x', idB, 2, TEXT_B, 0.5),
      ],
      budgetUsd: 5,
    });

    expect(out.report.total_contradictions_flagged).toBe(0);
    expect(out.report.queries_with_contradiction).toBe(0);
    expect(out.report.queries_with_any_finding).toBe(0);
    expect(out.report.dismissed_count).toBe(1);
    expect(out.report.per_query[0].contradictions).toHaveLength(0);
    expect(out.report.per_query[0].dismissed).toHaveLength(1);
    expect(out.report.per_query[0].dismissed![0].pair_id)
      .toBe(computePairId('cross_slug_chunks', TEXT_A, TEXT_B));
    // Raw judge behavior stays visible: the verdict was still a contradiction.
    expect(out.report.verdict_breakdown.contradiction).toBe(1);
    // Wilson CI denominator excludes the dismissed query.
    expect(out.report.calibration.queries_with_contradiction).toBe(0);
  });

  test('changed text re-flags: stale ledger row stops matching', async () => {
    const idA = await seedPage('companies/acme', 'Acme');
    const idB = await seedPage('openclaw/chat/x', 'Chat');
    await engine.putContradictionDismissal(ledgerRow('cross_slug_chunks', TEXT_A, TEXT_B));

    const changedB = `${TEXT_B} as of 2026-07`;
    const out = await runContradictionProbe({
      engine,
      queries: ['what is acme MRR'],
      judgeFn: contradictionJudge,
      searchFn: async () => [
        mkResult('companies/acme', idA, 1, TEXT_A, 1.5),
        mkResult('openclaw/chat/x', idB, 2, changedB, 0.5),
      ],
      budgetUsd: 5,
    });

    expect(out.report.total_contradictions_flagged).toBe(1);
    expect(out.report.dismissed_count).toBe(0);
  });

  test('findings carry pair_id for downstream ledger matching', async () => {
    const idA = await seedPage('companies/acme', 'Acme');
    const idB = await seedPage('openclaw/chat/x', 'Chat');
    const out = await runContradictionProbe({
      engine,
      queries: ['what is acme MRR'],
      judgeFn: contradictionJudge,
      searchFn: async () => [
        mkResult('companies/acme', idA, 1, TEXT_A, 1.5),
        mkResult('openclaw/chat/x', idB, 2, TEXT_B, 0.5),
      ],
      budgetUsd: 5,
    });
    const finding = out.report.per_query[0].contradictions[0];
    expect(finding.pair_id).toBe(computePairId(finding.kind, finding.a.text, finding.b.text));
    expect(computeFindingPairKey(finding))
      .toBe(contradictionPairKey(finding.kind, finding.a.text, finding.b.text));
  });
});

// ── CLI flag parsing ────────────────────────────────────────────────────

describe('parseFlags: dismiss/undismiss', () => {
  test('dismiss takes a positional pair_id and --reason', () => {
    const f = parseFlags(['dismiss', 'abcdef123456', '--reason', 'not a real conflict']);
    expect(f.sub).toBe('dismiss');
    expect(f.pairId).toBe('abcdef123456');
    expect(f.reason).toBe('not a real conflict');
  });

  test('undismiss takes a positional pair_id', () => {
    const f = parseFlags(['undismiss', 'abcdef123456']);
    expect(f.sub).toBe('undismiss');
    expect(f.pairId).toBe('abcdef123456');
  });

  test('review accepts --include-dismissed', () => {
    const f = parseFlags(['review', '--include-dismissed']);
    expect(f.sub).toBe('review');
    expect(f.includeDismissed).toBe(true);
  });

  test('a second positional on dismiss is rejected as an unknown flag', () => {
    expect(() => parseFlags(['dismiss', 'abc123', 'extra'])).toThrow();
  });
});
