/**
 * v0.36.1.0 (T3) — propose_takes cycle phase.
 *
 * Scans markdown pages updated since last run, sends each page's prose to
 * a tuned LLM extractor, writes the extracted gradeable claims to the
 * `take_proposals` queue. User accepts/rejects via `gbrain takes propose`.
 *
 * Idempotency contract (D17 schema spec + v0.37.1.1 cost fix):
 *   `take_proposal_page_scans` records every successful extractor call keyed by
 *   (source_id, page_slug, content_hash, prompt_version), even when the LLM
 *   returns []. `take_proposals` remains the operator-facing queue. Bumping
 *   PROPOSE_TAKES_PROMPT_VERSION cleanly invalidates the scan cache so a tuned
 *   prompt re-runs proposals on every page.
 *
 * F2 fence dedup:
 *   The phase reads the page's existing `<!-- gbrain:takes:begin -->` fence
 *   (when present) and passes the canonical take rows to the extractor as
 *   "things you have already captured." This prevents duplicate proposals
 *   when a user adds prose to a page that already has takes.
 *
 * Auto-resolve posture:
 *   propose_takes only WRITES proposals to the queue. Nothing here mutates
 *   the canonical takes table. Operator opt-in via `gbrain takes propose
 *   --accept N` is the only path from queue to canonical fence (D17).
 *
 * Prompt tuning status (v0.36.1.0 ship state):
 *   The default extractor prompt was tuned against the synthetic corpus at
 *   test/fixtures/calibration/ and validated via the cat15 propose_takes
 *   eval in the gbrain-evals repo. First live run scored 0.952 F1 on
 *   training (target 0.85) and 0.922 F1 on holdout (target 0.80), with a
 *   0.03 train-holdout gap (no overfitting). PROPOSE_TAKES_PROMPT_VERSION
 *   is "v0.36.1.0-tuned-cat15". Re-tuning requires re-running cat15;
 *   bumping the version string invalidates the take_proposals idempotency
 *   cache so old proposals stay as audit history but the next cycle
 *   re-extracts fresh against the new prompt.
 *
 * The extractor LLM call is INJECTED via opts.extractor for tests, so the
 * phase can run hermetically in unit tests without touching the gateway.
 */

import { randomUUID, createHash } from 'node:crypto';
import { BaseCyclePhase, type ScopedReadOpts, type BasePhaseOpts } from './base-phase.ts';
import { chat as gatewayChat } from '../ai/gateway.ts';
import { GBrainError } from '../types.ts';
import type { Page, PageFilters } from '../types.ts';
import type { OperationContext } from '../operations.ts';
import type { BrainEngine } from '../engine.ts';
import type { PhaseStatus, CyclePhase } from '../cycle.ts';

/**
 * Bump when the extractor prompt or the JSON output shape changes. Old
 * verdicts in `take_proposals` (composite key includes prompt_version) stay
 * valid as audit history; new runs re-spend LLM tokens on every page. The
 * companion `take_proposal_page_scans` cache uses the same key and also
 * records successful zero-proposal scans so unchanged pages do not churn the
 * extractor forever.
 */
export const PROPOSE_TAKES_PROMPT_VERSION = 'v0.36.1.0-tuned-cat15';

/**
 * Tuned extractor prompt, validated against the hand-labeled synthetic
 * corpus at test/fixtures/calibration/. Measured F1 on first live run
 * via gbrain-evals cat15 (claude-sonnet-4-6 extractor, claude-haiku-4-5
 * matcher judge):
 *
 *   training avg F1: 0.952 (target 0.85, exceeded by 10 points)
 *   holdout  avg F1: 0.922 (target 0.80, exceeded by 12 points)
 *   train-holdout gap: 0.03 (no overfitting signal)
 *
 * Per-genre F1 floor: 0.80 (people-pages, the hardest genre). The
 * concept-with-timeline and meeting-notes genres scored at 1.00 on
 * holdout pages.
 *
 * Design choices baked into the prompt:
 *   - Worked example list seeds the model's notion of "gradeable claim"
 *     so it doesn't drift into pure-fact extraction.
 *   - NOT-gradeable list catches the most common over-extraction modes
 *     (pure facts, direct quotes, restatements).
 *   - conviction inference rules anchored to specific hedging language
 *     ("I bet"/"strong conviction"=0.7-0.85, "I think"/"moderate"=0.5-0.7).
 *   - kind enum kept narrow ('prediction'|'judgment'|'bet') — the v1
 *     stub's 4-tag enum bled into noise classification.
 *
 * Replaces the v0.36.1.0-stub. If you re-tune, run cat15 against the
 * fixtures before bumping PROPOSE_TAKES_PROMPT_VERSION; the train-holdout
 * gap should stay < 0.10 (overfitting threshold).
 */
export const EXTRACT_TAKES_PROMPT = `Extract gradeable claims from the prose below.

A "gradeable claim" is a prediction, recommendation, or interpretive judgment
that could turn out wrong over time. Examples:
- "X company will hit ARR milestone by Q3" (prediction)
- "Y founder is going to struggle with execution" (judgment)
- "Z market will compress in 18 months" (prediction)
- "I bet alice wins the round" (bet)

NOT gradeable (do NOT extract these):
- Pure facts ("X was founded in 2020")
- Direct quotes from others without endorsement
- Restatements of an earlier claim in the same page

For each gradeable claim, output a JSON object with:
- claim_text   (string, <=200 chars, paraphrase or near-verbatim from prose)
- kind         ('prediction' | 'judgment' | 'bet')
- holder       ('world' | 'people/<slug>' | 'companies/<slug>' | 'brain' — default 'brain' when author asserts the claim)
- weight       (number 0..1 inferred from hedging language: 'I bet'/'strong conviction'=0.7-0.85,
                'I think'/'moderate conviction'=0.5-0.7, 'maybe'/'I'd guess'=0.3-0.5)
- domain       (short tag — e.g. 'tactics', 'macro', 'hiring', 'geography', 'pricing')

Output ONLY a JSON array of these objects. No prose. No commentary. If no
gradeable claims, return [].

EXISTING FENCE ROWS (already captured — do NOT propose duplicates):
{EXISTING_TAKES_JSON}

PAGE PROSE:
{PAGE_BODY}
`;

/** One proposed take, as the extractor produces it. */
export interface ProposedTake {
  claim_text: string;
  kind: 'fact' | 'take' | 'bet' | 'hunch';
  holder: string;
  weight: number;
  domain?: string;
}

/** Extractor function signature — injected for tests; production calls gateway. */
export type ProposeTakesExtractor = (input: {
  pagePath: string;
  pageBody: string;
  existingTakes: Array<{ claim: string; kind: string; holder: string; weight: number }>;
  modelHint?: string;
}) => Promise<ProposedTake[]>;

export interface ProposeTakesOpts extends BasePhaseOpts {
  /** Brain repo root for fs-source page walking. Optional — defaults to engine pages. */
  repoPath?: string;
  /** Limit pages processed in this cycle (for triage / quick smoke). Default: 100. */
  pageLimit?: number;
  /** Inject the LLM call for tests; production uses gateway.chat. */
  extractor?: ProposeTakesExtractor;
  /** Override prompt_version (tests). */
  promptVersion?: string;
  /** Override model id (tests + config). */
  model?: string;
  /** Skip pages that already have a complete takes fence. Default: true. */
  skipPagesWithFence?: boolean;
}

export interface ProposeTakesResult {
  pages_scanned: number;
  cache_hits: number;
  cache_misses: number;
  proposals_inserted: number;
  scan_cache_writes: number;
  empty_results_cached: number;
  llm_calls_skipped: number;
  dry_run: boolean;
  budget_exhausted: boolean;
  warnings: string[];
}

/**
 * Compute the content_hash key for the idempotency cache. SHA-256 of the
 * page body suffices — page slug + prompt_version are separate columns in
 * the composite unique index.
 */
export function contentHash(pageBody: string): string {
  return createHash('sha256').update(pageBody).digest('hex');
}

/**
 * Detect whether a page already has a complete `<!-- gbrain:takes:begin -->`
 * fence. We DO propose against pages with fences (F2 dedup) but the operator
 * may opt to skip-with-fence pages via skipPagesWithFence:true for a faster
 * pass. The fence shape mirrors src/core/takes-fence.ts.
 */
export function hasCompleteFence(pageBody: string): boolean {
  return /<!---?\s*gbrain:takes:begin[\s\S]*?gbrain:takes:end\s*-->/.test(pageBody);
}

/**
 * Parse the existing fence into rows so the extractor can dedupe.
 * Returns [] when no fence is present. Best-effort — malformed fences
 * surface to the operator via the existing v0.28 fence parser, not here.
 */
export function extractExistingTakesForDedup(pageBody: string): Array<{
  claim: string;
  kind: string;
  holder: string;
  weight: number;
}> {
  const fenceMatch = pageBody.match(/<!---?\s*gbrain:takes:begin\s*-->([\s\S]*?)<!---?\s*gbrain:takes:end\s*-->/);
  if (!fenceMatch) return [];
  const body = fenceMatch[1] ?? '';
  const rows: Array<{ claim: string; kind: string; holder: string; weight: number }> = [];
  for (const line of body.split('\n')) {
    const cells = line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    // Skip header + separator rows.
    if (cells.length < 4) continue;
    if (cells[0] === '#' || cells[0]?.match(/^-+$/)) continue;
    const claim = cells[1] ?? '';
    if (!claim || claim.startsWith('~~')) continue; // strikethrough = inactive, doesn't count for dedup
    const kind = cells[2] ?? 'take';
    const holder = cells[3] ?? 'brain';
    const weight = Number.parseFloat(cells[4] ?? '0.5');
    rows.push({
      claim: claim.replace(/^~~|~~$/g, ''),
      kind,
      holder,
      weight: Number.isFinite(weight) ? weight : 0.5,
    });
  }
  return rows;
}

/**
 * Production extractor — calls gateway.chat with the EXTRACT_TAKES_PROMPT
 * and parses the JSON array output. Throws on malformed model output so the
 * caller treats it as a retryable extractor failure instead of caching it as a
 * successful zero-proposal scan.
 *
 * Stub-prompt note: the v0.36.1.0 ship-state prompt is a placeholder. Real
 * extractor lands when T19 corpus build produces the tuned prompt. Until
 * then, the production extractor returns whatever the stub LLM produces —
 * empirically often a sparse list or [].
 */
export async function defaultExtractor(
  input: Parameters<ProposeTakesExtractor>[0],
): Promise<ProposedTake[]> {
  const prompt = EXTRACT_TAKES_PROMPT
    .replace('{EXISTING_TAKES_JSON}', JSON.stringify(input.existingTakes, null, 2))
    .replace('{PAGE_BODY}', input.pageBody);

  const result = await gatewayChat({
    messages: [{ role: 'user', content: prompt }],
    ...(input.modelHint ? { model: input.modelHint } : {}),
    maxTokens: 2048,
  });

  // ChatResult.text is already the concatenated text content. Malformed
  // extractor output is a retryable extractor failure, not a successful []
  // result, so the caller must not cache it as processed.
  return parseExtractorOutputStrict(result.text);
}

/**
 * Parse extractor output into ProposedTake[]. Handles common LLM output
 * sins (markdown fence wrapping, leading/trailing prose, single-object
 * instead of array). Returns [] on any unrecoverable parse error rather
 * than throwing.
 */
export function parseExtractorOutput(raw: string): ProposedTake[] {
  return parseExtractorOutputDetailed(raw).proposals;
}

/**
 * Detailed parser for production extractor calls. `ok=false` means the model
 * failed to return parseable JSON, which is a retryable extractor failure and
 * must not be cached as a successful zero-proposal scan.
 */
export function parseExtractorOutputDetailed(raw: string): { ok: boolean; proposals: ProposedTake[] } {
  if (!raw || raw.trim().length === 0) return { ok: false, proposals: [] };
  let text = raw.trim();
  // Strip markdown code fence wrapper.
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  // First-array-or-object substring extraction (defends against leading prose).
  const firstArr = text.indexOf('[');
  const firstObj = text.indexOf('{');
  if (firstArr === -1 && firstObj === -1) return { ok: false, proposals: [] };
  const start = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj) ? firstArr : firstObj;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return { ok: false, proposals: [] };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const proposals: ProposedTake[] = [];
  for (const raw of arr) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const claim_text = typeof r.claim_text === 'string' ? r.claim_text.trim() : '';
    if (!claim_text || claim_text.length > 500) continue;
    const kind = ['fact', 'take', 'bet', 'hunch'].includes(r.kind as string)
      ? (r.kind as ProposedTake['kind'])
      : 'take';
    const holder = typeof r.holder === 'string' && r.holder.length > 0 ? r.holder : 'brain';
    const weightRaw = typeof r.weight === 'number' ? r.weight : 0.5;
    const weight = Math.max(0, Math.min(1, weightRaw));
    const domain = typeof r.domain === 'string' && r.domain.length > 0 ? r.domain : undefined;
    proposals.push({ claim_text, kind, holder, weight, domain });
  }
  if (arr.length > 0 && proposals.length === 0) {
    return { ok: false, proposals: [] };
  }
  return { ok: true, proposals };
}

/**
 * Strict parser for production extractor calls. Malformed output is a
 * retryable extractor failure, not a successful empty result.
 */
export function parseExtractorOutputStrict(raw: string): ProposedTake[] {
  const parsed = parseExtractorOutputDetailed(raw);
  if (!parsed.ok) {
    throw new Error('extractor returned malformed JSON');
  }
  return parsed.proposals;
}

/**
 * BaseCyclePhase subclass. Walks pages, checks idempotency cache, calls
 * extractor, writes proposals.
 */
class ProposeTakesPhase extends BaseCyclePhase {
  readonly name = 'propose_takes' as CyclePhase;
  protected readonly budgetUsdKey = 'cycle.propose_takes.budget_usd';
  protected readonly budgetUsdDefault = 5.0;

  protected override mapErrorCode(err: unknown): string {
    if (err instanceof GBrainError) return err.problem;
    if (err instanceof Error) {
      if (err.message.includes('content_hash')) return 'CALIBRATION_PROPOSAL_DEDUP_FAIL';
      if (err.message.includes('budget') || err.message.includes('Budget')) return 'CALIBRATION_GRADE_BUDGET_EXHAUSTED';
    }
    return 'PROPOSE_TAKES_UNKNOWN';
  }

  protected async process(
    engine: BrainEngine,
    scope: ScopedReadOpts,
    _ctx: OperationContext,
    opts: ProposeTakesOpts,
  ): Promise<{ summary: string; details: Record<string, unknown>; status?: PhaseStatus }> {
    const extractor = opts.extractor ?? defaultExtractor;
    const promptVersion = opts.promptVersion ?? PROPOSE_TAKES_PROMPT_VERSION;
    const pageLimit = opts.pageLimit ?? 100;
    const skipPagesWithFence = opts.skipPagesWithFence ?? false;
    const dryRun = opts.dryRun ?? _ctx.dryRun ?? false;
    const proposalRunId = `propose-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 8)}`;

    const result: ProposeTakesResult = {
      pages_scanned: 0,
      cache_hits: 0,
      cache_misses: 0,
      proposals_inserted: 0,
      scan_cache_writes: 0,
      empty_results_cached: 0,
      llm_calls_skipped: 0,
      dry_run: dryRun,
      budget_exhausted: false,
      warnings: [],
    };

    // Load pages eligible for proposal. Source-scoped per BaseCyclePhase.
    const pageFilters: PageFilters = {
      ...scope,
      limit: pageLimit,
      sort: 'updated_desc',
    };
    const pages: Page[] = await engine.listPages(pageFilters);

    if (opts.reporter) {
      opts.reporter.start('propose_takes.pages' as never, pages.length);
    }

    for (const page of pages) {
      result.pages_scanned += 1;
      this.tick(opts);

      // Skip pages that have NO prose body (e.g. metadata-only entity stubs).
      const body = page.compiled_truth ?? '';
      if (body.trim().length === 0) continue;
      if (skipPagesWithFence && hasCompleteFence(body)) continue;

      const ch = contentHash(body);
      const existingTakes = extractExistingTakesForDedup(body);

      // Idempotency check. `take_proposal_page_scans` is the authoritative
      // per-page cache because it records successful extractor calls even when
      // the extractor returned []. `take_proposals` is checked as a legacy cache
      // so users upgrading from v0.36 do not re-spend on pages that already have
      // pending/accepted/rejected proposals.
      const sourceId = page.source_id ?? scope.sourceId ?? 'default';
      const cachedScan = await engine.executeRaw<{ found: number }>(
        `SELECT 1 AS found FROM take_proposal_page_scans
         WHERE source_id = $1 AND page_slug = $2 AND content_hash = $3 AND prompt_version = $4
         LIMIT 1`,
        [sourceId, page.slug, ch, promptVersion],
      );
      if (cachedScan.length > 0) {
        result.cache_hits += 1;
        continue;
      }
      const cachedProposal = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM take_proposals
         WHERE source_id = $1 AND page_slug = $2 AND content_hash = $3 AND prompt_version = $4
         LIMIT 1`,
        [sourceId, page.slug, ch, promptVersion],
      );
      if (cachedProposal.length > 0) {
        result.cache_hits += 1;
        continue;
      }
      result.cache_misses += 1;
      if (dryRun) {
        result.llm_calls_skipped += 1;
        continue;
      }

      // Budget pre-check before the LLM call. Estimate: ~1500 input tokens + 500 output.
      const budget = this.checkBudget({
        modelId: opts.model ?? 'claude-sonnet-4-6',
        estimatedInputTokens: 1500,
        maxOutputTokens: 500,
      });
      if (!budget.allowed) {
        result.budget_exhausted = true;
        result.warnings.push(
          `budget exhausted at page ${result.pages_scanned}/${pages.length} (cumulative $${budget.cumulativeCostUsd.toFixed(4)} / cap $${budget.budgetUsd.toFixed(2)})`,
        );
        break;
      }

      // Call the extractor. Errors on a single page log a warning but do not abort.
      let proposals: ProposedTake[];
      try {
        proposals = await extractor({
          pagePath: page.slug,
          pageBody: body,
          existingTakes,
          modelHint: opts.model,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.warnings.push(`extractor failed on ${page.slug}: ${msg}`);
        continue;
      }

      // Write proposals to take_proposals. The scan cache owns per-page
      // idempotency; the proposal queue dedups only identical claims from the
      // same page/prompt so a single page can surface multiple distinct takes.
      for (const p of proposals) {
        const insertedRows = await engine.executeRaw<{ id: number }>(
          `INSERT INTO take_proposals
             (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
              claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (source_id, page_slug, content_hash, prompt_version, claim_text) DO NOTHING
           RETURNING id`,
          [
            sourceId,
            page.slug,
            ch,
            promptVersion,
            proposalRunId,
            p.claim_text,
            p.kind,
            p.holder,
            p.weight,
            p.domain ?? null,
            JSON.stringify(existingTakes),
            opts.model ?? 'claude-sonnet-4-6',
          ],
        );
        result.proposals_inserted += insertedRows.length;
      }

      // Cache every successful extractor call, including the common [] result.
      // Failures above intentionally do not write here so transient model/API
      // errors retry on a later cycle.
      await engine.executeRaw(
        `INSERT INTO take_proposal_page_scans
           (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
            proposals_count, model_id, dedup_against_fence_rows)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (source_id, page_slug, content_hash, prompt_version) DO UPDATE SET
           scanned_at = now(),
           proposal_run_id = EXCLUDED.proposal_run_id,
           proposals_count = EXCLUDED.proposals_count,
           model_id = EXCLUDED.model_id,
           dedup_against_fence_rows = EXCLUDED.dedup_against_fence_rows`,
        [
          sourceId,
          page.slug,
          ch,
          promptVersion,
          proposalRunId,
          proposals.length,
          opts.model ?? 'claude-sonnet-4-6',
          JSON.stringify(existingTakes),
        ],
      );
      result.scan_cache_writes += 1;
      if (proposals.length === 0) result.empty_results_cached += 1;
    }

    if (opts.reporter) opts.reporter.finish();

    return {
      summary: `propose_takes: scanned ${result.pages_scanned} pages, ${result.cache_hits} cached, ${result.proposals_inserted} new proposals (run ${proposalRunId})`,
      details: { ...result, proposal_run_id: proposalRunId, prompt_version: promptVersion },
      status: result.budget_exhausted ? 'warn' : 'ok',
    };
  }
}

/**
 * Public entry point — mirrors the v0.23 `runPhaseSynthesize` shape so the
 * cycle orchestrator in cycle.ts can call it uniformly.
 */
export async function runPhaseProposeTakes(
  ctx: OperationContext,
  opts: ProposeTakesOpts = {},
) {
  return new ProposeTakesPhase().run(ctx, opts);
}

/** Test-only access to the class for subclassing in tests. */
export const __testing = {
  ProposeTakesPhase,
  parseExtractorOutput,
  contentHash,
  hasCompleteFence,
  extractExistingTakesForDedup,
};
