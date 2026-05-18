/**
 * v0.36.1.0 (T3) — propose_takes cycle phase.
 *
 * Scans markdown pages updated since last run, sends each page's prose to
 * a tuned LLM extractor, writes the extracted gradeable claims to the
 * `take_proposals` queue. User accepts/rejects via `gbrain takes propose`.
 *
 * Idempotency contract (D17 schema spec):
 *   The unique index on (source_id, page_slug, content_hash, prompt_version)
 *   means an unchanged page never re-spends LLM tokens. Bumping
 *   PROPOSE_TAKES_PROMPT_VERSION cleanly invalidates the cache so a tuned
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
 *   The default extractor prompt is a placeholder ("v0.36.1.0-stub"). The
 *   real prompt is tuned via T19's synthetic-corpus build (50 anonymized
 *   pages, 3-model parallel extraction, user reviews disagreement set, F1
 *   ≥ 0.85 on training corpus + F1 ≥ 0.8 on ground-truth holdout). Until
 *   T19 lands, propose_takes is opt-in via config flag and produces best-
 *   effort candidates that the user reviews manually.
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
 * valid as audit history; new runs re-spend LLM tokens on every page.
 */
export const PROPOSE_TAKES_PROMPT_VERSION = 'v0.36.1.0-stub';

/**
 * Stub extractor prompt. v0.36.1.0 ship-state placeholder — T19 corpus
 * build replaces this with a tuned prompt (Hindsight-style, adapted for
 * gbrain's kind/holder/weight take schema rather than Hindsight's
 * conviction/domain shape).
 *
 * The stub returns an empty array reliably so the phase wires up cleanly
 * end-to-end without producing noise during the pre-tuned window. Operators
 * opting in early get a queue that fills only when they explicitly invoke
 * with a non-stub prompt.
 */
export const EXTRACT_TAKES_PROMPT = `[v0.36.1.0-stub] Extract gradeable claims (predictions, recommendations,
interpretive judgments that could turn out wrong) from the prose below.

Output ONLY a JSON array of objects. Each object has fields:
- claim_text   (string, <=200 chars) the claim verbatim or close paraphrase
- kind         ('fact' | 'take' | 'bet' | 'hunch')
- holder       ('world' | 'people/<slug>' | 'companies/<slug>' | 'brain')
- weight       (number 0..1, 0.05 increments preferred)
- domain       (optional short tag, e.g. 'tactics' / 'macro' / 'hiring')

Do NOT include evidence, citations, examples, or restatements of an earlier claim.
If no gradeable claims are present, return [].

EXISTING FENCE ROWS (these are already captured — do NOT propose duplicates):
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
 * and parses the JSON array output. Returns [] on parse failure (logged as
 * warning, not thrown — one bad page must not abort the phase).
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

  // ChatResult.text is already the concatenated text content.
  return parseExtractorOutput(result.text);
}

/**
 * Parse extractor output into ProposedTake[]. Handles common LLM output
 * sins (markdown fence wrapping, leading/trailing prose, single-object
 * instead of array). Returns [] on any unrecoverable parse error rather
 * than throwing.
 */
export function parseExtractorOutput(raw: string): ProposedTake[] {
  if (!raw || raw.trim().length === 0) return [];
  let text = raw.trim();
  // Strip markdown code fence wrapper.
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) text = (fenced[1] ?? '').trim();
  // First-array-or-object substring extraction (defends against leading prose).
  const firstArr = text.indexOf('[');
  const firstObj = text.indexOf('{');
  if (firstArr === -1 && firstObj === -1) return [];
  const start = firstArr !== -1 && (firstObj === -1 || firstArr < firstObj) ? firstArr : firstObj;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProposedTake[] = [];
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
    out.push({ claim_text, kind, holder, weight, domain });
  }
  return out;
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
    const proposalRunId = `propose-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 8)}`;

    const result: ProposeTakesResult = {
      pages_scanned: 0,
      cache_hits: 0,
      cache_misses: 0,
      proposals_inserted: 0,
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

      // Idempotency check. If a row exists for (source_id, page_slug, content_hash,
      // prompt_version), this page was already processed — skip and count as cache hit.
      const sourceId = page.source_id ?? scope.sourceId ?? 'default';
      const cached = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM take_proposals
         WHERE source_id = $1 AND page_slug = $2 AND content_hash = $3 AND prompt_version = $4
         LIMIT 1`,
        [sourceId, page.slug, ch, promptVersion],
      );
      if (cached.length > 0) {
        result.cache_hits += 1;
        continue;
      }
      result.cache_misses += 1;

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

      // Write proposals to take_proposals. Each row is a separate INSERT
      // because the composite idempotency key is on the per-page tuple — a
      // bulk UPSERT would collapse a same-page-multi-claim run into one row.
      for (const p of proposals) {
        await engine.executeRaw(
          `INSERT INTO take_proposals
             (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
              claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (source_id, page_slug, content_hash, prompt_version) DO NOTHING`,
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
        result.proposals_inserted += 1;
      }
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
