/**
 * Consecutive retryable-transport-failure abort for propose_takes.
 *
 * Repro wedge (2026-07-17): dead egress path → per-page catch-and-continue
 * → phase exits status=ok with "Embedded 0 chunks" / zero proposals and
 * process rc=0. Budget of 3 consecutive retryable transport failures must
 * fail the phase (status=fail) with last errors + affected slugs preserved.
 *
 * Classification walks the error cause chain (and AggregateError.errors),
 * not message-string regex alone — an SDK-retry-exhausted wrapper that
 * only carries the timeout on `.cause` still increments the budget.
 *
 * AbortError: only abort-caused-by-deadline/timeout counts; bare AbortError
 * (user cancel / unrelated signal) must NOT increment the budget.
 *
 * Multi-phase rollup: transport_abort on a phase forces overall cycle
 * status 'failed' (not 'partial') so dream exits nonzero.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  runPhaseProposeTakes,
  type ProposeTakesExtractor,
} from '../../src/core/cycle/propose-takes.ts';
import {
  CONSECUTIVE_TRANSPORT_FAILURE_BUDGET,
  isRetryableTransportFailure,
} from '../../src/core/cycle/transport-failure.ts';
import {
  deriveStatus,
  phaseForcesCycleFailed,
  type PhaseResult,
  type CycleReport,
} from '../../src/core/cycle.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { Page } from '../../src/core/types.ts';

// ─── Fixtures (mirror test/propose-takes.test.ts mock shape) ────────

function buildMockEngine(pages: Page[]): BrainEngine {
  return {
    kind: 'pglite',
    async listPages() {
      return pages;
    },
    async executeRaw<T>(sql: string, _params?: unknown[]): Promise<T[]> {
      if (sql.includes('SELECT id FROM take_proposals')) return [];
      return [];
    },
  } as unknown as BrainEngine;
}

function buildPage(slug: string, body = `prose for ${slug}`): Page {
  return {
    id: 1,
    slug,
    type: 'analysis',
    title: slug,
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
    source_id: 'default',
    created_at: new Date(),
    updated_at: new Date(),
  } as Page;
}

function buildCtx(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

function makeTimeoutError(message = 'Request timed out'): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = 'ETIMEDOUT';
  return err;
}

function makeConnRefusedError(): Error {
  const err = new Error('connect ECONNREFUSED 127.0.0.1:11434');
  (err as Error & { code?: string }).code = 'ECONNREFUSED';
  return err;
}

function makeProvider5xx(): Error {
  const err = new Error('Internal Server Error');
  (err as Error & { status?: number }).status = 503;
  return err;
}

// ─── Classifier unit tests ──────────────────────────────────────────

describe('isRetryableTransportFailure', () => {
  test('counts timeout / ETIMEDOUT / deadline-shaped AbortError', () => {
    expect(isRetryableTransportFailure(makeTimeoutError())).toBe(true);
    // AbortError counts only when timeout/deadline-shaped (message).
    const abortTimeout = new Error('The operation was aborted due to timeout');
    abortTimeout.name = 'AbortError';
    expect(isRetryableTransportFailure(abortTimeout)).toBe(true);
    // TimeoutError name always counts (incl. DOMException-shaped).
    const te = new Error('Deadline exceeded');
    te.name = 'TimeoutError';
    expect(isRetryableTransportFailure(te)).toBe(true);
  });

  test('bare AbortError (user cancel / no timeout cause) is NOT retryable', () => {
    const bare = new Error('This operation was aborted');
    bare.name = 'AbortError';
    expect(isRetryableTransportFailure(bare)).toBe(false);

    const cancel = new Error('The user aborted a request');
    cancel.name = 'AbortError';
    expect(isRetryableTransportFailure(cancel)).toBe(false);
  });

  test('AbortError with timeout cause or abort reason IS retryable', () => {
    const abortWithCause = new Error('The operation was aborted');
    abortWithCause.name = 'AbortError';
    (abortWithCause as Error & { cause?: unknown }).cause = makeTimeoutError();
    expect(isRetryableTransportFailure(abortWithCause)).toBe(true);

    const reason = new Error('Timeout');
    reason.name = 'TimeoutError';
    const abortWithReason = new Error('The operation was aborted');
    abortWithReason.name = 'AbortError';
    (abortWithReason as Error & { reason?: unknown }).reason = reason;
    expect(isRetryableTransportFailure(abortWithReason)).toBe(true);
  });

  test('counts connection / DNS codes', () => {
    expect(isRetryableTransportFailure(makeConnRefusedError())).toBe(true);
    const dns = new Error('getaddrinfo ENOTFOUND api.example.com');
    (dns as Error & { code?: string }).code = 'ENOTFOUND';
    expect(isRetryableTransportFailure(dns)).toBe(true);
    const again = new Error('getaddrinfo EAI_AGAIN api.example.com');
    (again as Error & { code?: string }).code = 'EAI_AGAIN';
    expect(isRetryableTransportFailure(again)).toBe(true);
  });

  test('counts provider 5xx via status / statusCode', () => {
    expect(isRetryableTransportFailure(makeProvider5xx())).toBe(true);
    const e = new Error('bad gateway');
    (e as Error & { statusCode?: number }).statusCode = 502;
    expect(isRetryableTransportFailure(e)).toBe(true);
  });

  test('does NOT count auth / config / parse / content rejection', () => {
    const auth = new Error('Invalid API key');
    (auth as Error & { status?: number }).status = 401;
    expect(isRetryableTransportFailure(auth)).toBe(false);

    const forbidden = new Error('Forbidden');
    (forbidden as Error & { status?: number }).status = 403;
    expect(isRetryableTransportFailure(forbidden)).toBe(false);

    expect(isRetryableTransportFailure(new Error('JSON parse failed at position 0'))).toBe(false);
    expect(isRetryableTransportFailure(new Error('content rejected by safety filter'))).toBe(false);
    expect(isRetryableTransportFailure(new Error('model not configured'))).toBe(false);
  });

  test('walks .cause chain — wrapped/AggregateError timeout still counts', () => {
    const root = makeTimeoutError('underlying deadline exceeded');
    const wrapped = new Error('SDK retries exhausted');
    (wrapped as Error & { cause?: unknown }).cause = root;
    expect(isRetryableTransportFailure(wrapped)).toBe(true);

    const agg = new AggregateError([new Error('noise'), root], 'multiple failures');
    expect(isRetryableTransportFailure(agg)).toBe(true);

    // Outer message has no timeout keyword — only the cause does.
    const silentWrap = new Error('All 3 attempts failed');
    (silentWrap as Error & { cause?: unknown }).cause = makeTimeoutError();
    expect(isRetryableTransportFailure(silentWrap)).toBe(true);
  });
});

// ─── Phase integration ──────────────────────────────────────────────

describe('propose_takes consecutive transport-failure abort', () => {
  test(`(a) ${CONSECUTIVE_TRANSPORT_FAILURE_BUDGET} consecutive retryable failures → phase FAILED`, async () => {
    const pages = [
      buildPage('wiki/a'),
      buildPage('wiki/b'),
      buildPage('wiki/c'),
      buildPage('wiki/d'), // must NOT be reached after budget trips
    ];
    const engine = buildMockEngine(pages);
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      throw makeConnRefusedError();
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(result.status).toBe('fail');
    expect(calls).toBe(CONSECUTIVE_TRANSPORT_FAILURE_BUDGET);
    const details = result.details as Record<string, unknown>;
    expect(details.transport_abort).toBe(true);
    expect(details.abort_reason).toBe('consecutive_transport_failures');
    expect(details.consecutive_transport_failures).toBe(CONSECUTIVE_TRANSPORT_FAILURE_BUDGET);
  });

  test('(b) interleaved success resets the consecutive counter', async () => {
    const pages = [
      buildPage('wiki/a'),
      buildPage('wiki/b'),
      buildPage('wiki/c'),
      buildPage('wiki/d'),
      buildPage('wiki/e'),
    ];
    const engine = buildMockEngine(pages);
    let calls = 0;
    // fail, fail, success, fail, fail → never 3 consecutive → ok
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      if (calls === 3) {
        return [{ claim_text: 'reset claim', kind: 'take', holder: 'brain', weight: 0.5 }];
      }
      throw makeTimeoutError();
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(result.status).toBe('ok');
    expect(calls).toBe(5);
    const details = result.details as Record<string, unknown>;
    expect(details.transport_abort).not.toBe(true);
    expect(details.proposals_inserted).toBe(1);
  });

  test('(c) non-retryable errors (auth, parse-shaped) do NOT increment the budget', async () => {
    const pages = [
      buildPage('wiki/a'),
      buildPage('wiki/b'),
      buildPage('wiki/c'),
      buildPage('wiki/d'),
    ];
    const engine = buildMockEngine(pages);
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      // Four auth failures — if counted as transport, budget would trip at 3.
      const err = new Error('Invalid API key');
      (err as Error & { status?: number }).status = 401;
      throw err;
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(result.status).toBe('ok');
    expect(calls).toBe(4);
    const details = result.details as Record<string, unknown>;
    expect(details.transport_abort).not.toBe(true);
    expect((details.warnings as string[]).length).toBe(4);
  });

  test('(d) cause-chain classification: wrapped timeout increments the budget', async () => {
    const pages = [buildPage('wiki/a'), buildPage('wiki/b'), buildPage('wiki/c')];
    const engine = buildMockEngine(pages);
    const extractor: ProposeTakesExtractor = async () => {
      const root = makeTimeoutError('socket hang up after deadline');
      const wrapped = new Error('AI SDK retry loop exhausted');
      (wrapped as Error & { cause?: unknown }).cause = root;
      throw wrapped;
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(result.status).toBe('fail');
    const details = result.details as Record<string, unknown>;
    expect(details.transport_abort).toBe(true);
    expect(details.consecutive_transport_failures).toBe(3);
  });

  test('(e) last errors + affected page slugs are present in the phase report', async () => {
    const pages = [buildPage('wiki/alpha'), buildPage('wiki/beta'), buildPage('wiki/gamma')];
    const engine = buildMockEngine(pages);
    let n = 0;
    const extractor: ProposeTakesExtractor = async () => {
      n++;
      if (n === 1) throw makeConnRefusedError();
      if (n === 2) throw makeProvider5xx();
      throw makeTimeoutError('deadline exceeded');
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(result.status).toBe('fail');
    const details = result.details as Record<string, unknown>;
    const slugs = details.transport_failure_slugs as string[];
    const errors = details.transport_failure_errors as string[];
    expect(slugs).toEqual(['wiki/alpha', 'wiki/beta', 'wiki/gamma']);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/ECONNREFUSED/);
    expect(errors[1]).toMatch(/Internal Server Error|503/i);
    expect(errors[2]).toMatch(/deadline|timeout|ETIMEDOUT/i);
    // Warnings still carry the per-page messages for operator readability.
    expect((details.warnings as string[]).some(w => w.includes('wiki/alpha'))).toBe(true);
  });

  test('(f) bare AbortError does not trip budget — phase completes, no abort', async () => {
    // Four pages, each throws bare AbortError (user cancel shape). If
    // misclassified as transport, budget would trip at 3 and status=fail.
    const pages = [
      buildPage('wiki/a'),
      buildPage('wiki/b'),
      buildPage('wiki/c'),
      buildPage('wiki/d'),
    ];
    const engine = buildMockEngine(pages);
    let calls = 0;
    const extractor: ProposeTakesExtractor = async () => {
      calls++;
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });

    expect(result.status).toBe('ok');
    expect(calls).toBe(4);
    const details = result.details as Record<string, unknown>;
    expect(details.transport_abort).not.toBe(true);
    expect((details.warnings as string[]).length).toBe(4);
  });
});

// ─── Multi-phase rollup + dream exit mapping ────────────────────────

function emptyTotals(): CycleReport['totals'] {
  return {
    lint_fixes: 0,
    backlinks_added: 0,
    pages_synced: 0,
    pages_extracted: 0,
    pages_embedded: 0,
    orphans_found: 0,
    transcripts_processed: 0,
    synth_pages_written: 0,
    patterns_written: 0,
    pages_emotional_weight_recomputed: 0,
    edges_resolved: 0,
    edges_ambiguous: 0,
    purged_sources_count: 0,
    purged_pages_count: 0,
    facts_consolidated: 0,
    consolidate_takes_written: 0,
    phantoms_redirected: 0,
    phantoms_ambiguous: 0,
    phantoms_skipped_drift: 0,
  };
}

function phase(
  name: PhaseResult['phase'],
  status: PhaseResult['status'],
  details: Record<string, unknown> = {},
): PhaseResult {
  return {
    phase: name,
    status,
    duration_ms: 1,
    summary: `${name}: ${status}`,
    details,
  };
}

describe('transport_abort escalates overall cycle status to failed', () => {
  test('multi-phase: propose_takes transport_abort + sibling ok → overall failed', () => {
    // The silent-success wedge: without this escalation, fail+ok rolls
    // to 'partial' and dream exits 0.
    const phases: PhaseResult[] = [
      phase('propose_takes', 'fail', {
        transport_abort: true,
        abort_reason: 'consecutive_transport_failures',
        consecutive_transport_failures: CONSECUTIVE_TRANSPORT_FAILURE_BUDGET,
      }),
      phase('embed', 'ok', { embedded: 12 }),
    ];
    expect(phaseForcesCycleFailed(phases[0]!)).toBe(true);
    expect(deriveStatus(phases, emptyTotals())).toBe('failed');
  });

  test('ordinary per-item fail + ok still rolls to partial (not failed)', () => {
    // Do not change the meaning of 'partial' for ordinary failures.
    const phases: PhaseResult[] = [
      phase('propose_takes', 'fail', {
        // no transport_abort marker — e.g. unexpected throw envelope
        error_code: 'UNKNOWN',
      }),
      phase('embed', 'ok', { embedded: 3 }),
    ];
    expect(phaseForcesCycleFailed(phases[0]!)).toBe(false);
    expect(deriveStatus(phases, emptyTotals())).toBe('partial');
  });

  test("dream command exits nonzero only on overall 'failed' (source mapping)", () => {
    // dream.ts — process.exit(1) when report.status === 'failed'.
    // Combined with the rollup above, transport_abort → failed → rc≠0.
    const dreamSource = readFileSync(
      new URL('../../src/commands/dream.ts', import.meta.url),
      'utf8',
    );
    const exitIdx = dreamSource.indexOf('// Exit non-zero when the cycle failed overall');
    expect(exitIdx).toBeGreaterThan(0);
    const exitBlock = dreamSource.slice(exitIdx, exitIdx + 350);
    // Exit condition is failed only — partial is soft (mentioned in comment,
    // never in the if condition).
    expect(exitBlock).toMatch(/if\s*\(\s*report\.status\s*===\s*['"]failed['"]\s*\)/);
    expect(exitBlock).toMatch(/process\.exit\(1\)/);
    expect(exitBlock).not.toMatch(/if\s*\([^)]*partial/);
  });
});
