// src/core/extract-takes-from-pages.ts
// v0.41.18.0 (A12, A24, T9). Haiku classifier loop over allowlisted page
// types — concept, atom, lore, briefing, writing, originals — extracts
// gradeable claims and inserts them as takes fence rows.
//
// Two-gate consent per A12:
//   - takes.bootstrap_enabled (default false): must be true to run at all.
//     Even manual `gbrain takes extract --from-pages` refuses without it.
//   - takes.autopilot_allowed (default false): must be true for autopilot's
//     auto-apply tier to fire the takes-bootstrap remediation.
//
// A24 deliberately limits autopilot to manual_only until v0.42.1 lands a
// 100+-case eval suite. v0.42 ships the classifier + CLI; autopilot stays
// blocked until eval coverage catches up.

import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import type { BrainEngine } from './engine.ts';
import type { TakeKind } from './engine.ts';
import type { OperationContext } from './ops/contract.ts';
import { chat, getChatModel, isAvailable } from './ai/gateway.ts';
import {
  appendTakesToPageBody,
  appendTakesToPageMdFirst,
  materializeTakeResolutions,
  isSafeFenceCellText,
  resolveTakesRepoDir,
  resolveTakesWritePath,
  TakesWriteError,
} from './takes-write.ts';
import { managedPersistenceEnabled } from './persistence/ownership.ts';
import { serializePageToMarkdown } from './markdown.ts';
import { BudgetMeter, loadPricingOverrides } from './cycle/budget-meter.ts';
import { parseTakesFence } from './takes-fence.ts';

export const ALLOWED_PAGE_TYPES = [
  'concept', 'atom', 'lore', 'briefing', 'writing', 'originals',
] as const;

const CLASSIFIER_SYSTEM = `You extract gradeable CLAIMS from longform writing.

Output strict JSON: an array of objects with shape:
  {"claim": "<short imperative or assertion, <= 200 chars>",
   "kind": "fact" | "take" | "bet" | "hunch",
   "weight": 0.0..1.0}

Kind taxonomy:
  - fact: verifiable as true/false (e.g. "X raised $5M in Mar 2024")
  - take: a stated opinion that could be wrong (e.g. "X is undervalued")
  - bet:  a forward-looking prediction (e.g. "X will IPO in 2026")
  - hunch: a low-confidence gut feeling (e.g. "Y feels overstretched")

Skip pure narrative, questions, definitions, or pure quotes from others.
Max 15 claims per page; output [] if no gradeable claims are present.`;

export interface ExtractTakesFromPagesOpts {
  /** Required: must be true for any work to happen (A12). */
  bootstrapEnabled: boolean;
  /** Dry-run: classify but don't write to takes table. */
  dryRun?: boolean;
  /** Scope to a single source. */
  sourceIdFilter?: string;
  /** Max pages to classify per run (caps cost). Default 50. */
  maxPages?: number;
  /**
   * Resume point from an earlier run's `next_before` (#5043): only pages
   * ordered after it (older `updated_at`, or the same instant and a lower id)
   * are selected.
   */
  before?: { updatedAt: string; id: number };
  /**
   * Also rescan pages that already hold takes (refresh semantics).
   * Default false: bootstrap runs skip covered pages, so repeated runs
   * PROGRESS through a corpus larger than one run's cap instead of
   * rescanning the same most-recently-updated slice forever.
   */
  includeCovered?: boolean;
  /** Owner identifier for the inserted takes. Default 'system'. */
  holder?: string;
  /** Model override; defaults to facts.extraction_model. */
  model?: string;
  /**
   * USD cap for the run's classifier calls. Default: config
   * `takes.bootstrap_budget_usd`, else 5.0 (the propose_takes default).
   * 0 disables the cap.
   */
  budgetUsd?: number;
  /** Progress hook called per page. */
  onProgress?: (done: number, total: number, claims: number) => void;
}

export interface ExtractTakesFromPagesResult {
  pages_scanned: number;
  claims_extracted: number;
  /**
   * Where the next run should resume, as `<updated_at text>,<page id>`: the
   * position of the last page this run finished with, or null if it finished
   * none. Pages that yield no claims stay uncovered and would otherwise be
   * selected first forever (#5043); passing this to `--before` moves past
   * them. A page a budget stop never reached is not counted as finished, and
   * one skipped on an error stays uncovered for a run without `--before`.
   */
  next_before: string | null;
  /** True if the run was a no-op because bootstrapEnabled is false. */
  consent_gate_blocked: boolean;
  /** True if chat gateway is unavailable (no LLM call possible). */
  llm_unavailable: boolean;
  /**
   * #4473 — pages the md-first writer refused (takes are markdown-canonical;
   * a page with no locatable .md file is skipped BEFORE the LLM call, never
   * written DB-only). Skipped pages hold no takes, so future runs rescan them.
   */
  pages_skipped: number;
  skipped: Array<{ slug: string; reason: string }>;
  /** Count of pages whose md write landed but whose DB mirror warned (reconcile heals). */
  mirror_warnings: number;
  /** True when the run stopped because the next classifier call would exceed the USD budget. */
  budget_exhausted: boolean;
  /** Extracted claims dropped because the page's takes fence already holds them. */
  duplicates_skipped: number;
}

/** Duplicate key for a take claim: case, whitespace and trailing punctuation aside. */
function claimKey(claim: string, holder: string): string {
  return `${holder}\u0000${claim.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?;:,]+$/, '')}`;
}

async function resolveBudgetUsd(engine: BrainEngine, explicit: number | undefined): Promise<number> {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const raw = await engine.getConfig('takes.bootstrap_budget_usd').catch(() => null);
  const parsed = raw == null ? NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5.0;
}

interface PageRow {
  id: number;
  slug: string;
  source_id: string;
  type: string;
  compiled_truth: string;
  updated_at: string | Date;
  /** `<updated_at::text>,<id>`, the value `next_before` reports for this page. */
  resume_at: string;
}

/**
 * Pure helper: parse Haiku JSON output into typed claims. Returns []
 * on any parse failure (caller treats as "no claims extracted").
 */
export function parseClaimsJson(raw: string): Array<{ claim: string; kind: TakeKind; weight: number }> {
  try {
    // Strip code fences if model wrapped output in ```json.
    let text = raw.trim();
    const fenceMatch = text.match(/^```(?:json)?\n?([\s\S]*?)\n?```$/);
    if (fenceMatch) text = fenceMatch[1].trim();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const valid: Array<{ claim: string; kind: TakeKind; weight: number }> = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const claim = typeof item.claim === 'string' ? item.claim.trim().slice(0, 200) : '';
      const kind = typeof item.kind === 'string' ? item.kind : '';
      const weightRaw = typeof item.weight === 'number' ? item.weight : 0.5;
      const weight = Math.max(0, Math.min(1, weightRaw));
      if (!claim || !['fact', 'take', 'bet', 'hunch'].includes(kind)) continue;
      valid.push({ claim, kind, weight });
    }
    return valid;
  } catch {
    return [];
  }
}

export async function extractTakesFromPages(
  engine: BrainEngine,
  opts: ExtractTakesFromPagesOpts,
): Promise<ExtractTakesFromPagesResult> {
  const emptyTail = { next_before: null, pages_skipped: 0, skipped: [], mirror_warnings: 0, budget_exhausted: false, duplicates_skipped: 0 };
  // A12 consent gate: refuse without bootstrap_enabled even on manual call.
  if (!opts.bootstrapEnabled) {
    return {
      pages_scanned: 0,
      claims_extracted: 0,
      consent_gate_blocked: true,
      llm_unavailable: false,
      ...emptyTail,
    };
  }

  if (!isAvailable('chat')) {
    return {
      pages_scanned: 0,
      claims_extracted: 0,
      consent_gate_blocked: false,
      llm_unavailable: true,
      ...emptyTail,
    };
  }

  const dryRun = opts.dryRun ?? false;
  const managedJournalWrites = await managedPersistenceEnabled(engine);
  const maxPages = opts.maxPages ?? 50;
  const holder = opts.holder ?? 'system';
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  const scope: string[] = [];
  if (opts.sourceIdFilter) scope.push(`source_id = ${bind(opts.sourceIdFilter)}`);
  // Resume strictly after the caller's position in the (updated_at DESC,
  // id DESC) order. The timestamp is bound as text and cast in SQL so its
  // microseconds survive; a parameter typed as timestamptz goes through a JS
  // Date in postgres.js and loses them.
  if (opts.before) scope.push(`(updated_at, id) < (${bind(opts.before.updatedAt)}::text::timestamptz, ${bind(opts.before.id)})`);

  // Fetch eligible pages. Order by updated_at DESC so recently-edited
  // pages get bootstrapped first.
  const typesList = ALLOWED_PAGE_TYPES.map((t) => `'${t}'`).join(', ');
  // Bootstrap progression: skip pages that already hold takes (opt out via
  // includeCovered). Without this, the updated_at-DESC + LIMIT selection made
  // every re-run rescan the same most-recent slice — a corpus larger than one
  // run's cap could never be fully bootstrapped (and each rescan re-spent LLM
  // budget on covered pages for upsert-identical rows).
  const coveredFilter = opts.includeCovered
    ? ''
    : `AND NOT EXISTS (SELECT 1 FROM takes t WHERE t.page_id = pages.id)`;
  const pages = await engine.executeRaw<PageRow>(
    `SELECT id, slug, source_id, type, compiled_truth, updated_at, updated_at::text || ',' || id AS resume_at
       FROM pages
      WHERE type IN (${typesList})
        AND deleted_at IS NULL
        AND length(COALESCE(compiled_truth, '')) > 200
        ${coveredFilter}
        ${scope.map((condition) => `AND ${condition}`).join(' ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${maxPages}`,
    params,
  );

  let pagesScanned = 0;
  let claimsExtracted = 0;
  let pagesSkipped = 0;
  let mirrorWarnings = 0;
  let budgetExhausted = false;
  let duplicatesSkipped = 0;
  const skipped: Array<{ slug: string; reason: string }> = [];
  const model = opts.model || getChatModel();
  const meter = new BudgetMeter({
    budgetUsd: await resolveBudgetUsd(engine, opts.budgetUsd),
    phase: 'takes_bootstrap',
    pricingOverrides: await loadPricingOverrides(engine),
  });
  // #4473: takes are markdown-canonical (takes-write.ts contract), so the
  // bootstrap routes every write through the fence writer instead of minting
  // DB-only rows the next reconcile/extract would clobber.
  const repoDir = await resolveTakesRepoDir(engine);

  const skipPage = (slug: string, reason: string) => {
    pagesSkipped++;
    skipped.push({ slug, reason });
  };

  for (const page of pages) {
    pagesScanned++;
    opts.onProgress?.(pagesScanned, pages.length, claimsExtracted);

    if (!page.compiled_truth || page.compiled_truth.length < 200) continue;

    // #4473: locate the page's markdown home BEFORE the LLM call — a page the
    // fence writer would refuse must not burn classifier budget (skipped pages
    // hold no takes, so every future run would re-classify them).
    let mdPath: string | null = null;
    if (!dryRun) {
      try {
        const { path } = await resolveTakesWritePath(engine, repoDir, page.slug, page.source_id);
        if (existsSync(path)) mdPath = path;
      } catch {
        // mirror_unavailable (no repo dir + no source local_path)
      }
      if (!mdPath) {
        skipPage(page.slug, 'mirror_unavailable');
        continue;
      }
    }

    // Pin the selected page before spending time on extraction. A managed
    // publication with a newer revision must skip the whole page atomically.
    const managedSnapshot = managedJournalWrites && !dryRun
      ? await engine.readPageSnapshot(page.slug, { sourceId: page.source_id }) : null;
    if (managedJournalWrites && !dryRun && (!managedSnapshot || managedSnapshot.page.id !== page.id)) {
      skipPage(page.slug, 'page_identity_changed');
      continue;
    }

    // Truncate to keep per-page cost bounded (~20K chars → ~5K input tokens).
    const text = (managedSnapshot?.page.compiled_truth ?? page.compiled_truth).slice(0, 20_000);

    const budget = meter.check({
      modelId: model,
      estimatedInputTokens: Math.ceil((CLASSIFIER_SYSTEM.length + text.length) / 4) + 50,
      maxOutputTokens: 2000,
      label: 'takes_bootstrap',
    });
    if (!budget.allowed) {
      budgetExhausted = true;
      break;
    }

    let response: { text: string };
    try {
      response = await chat({
        // #2997 — default to the configured chat model (file-plane gateway
        // config, same idiom as enrich.ts) instead of hardcoded cloud Haiku.
        // On OAuth/local-only installs the hardcoded model made every takes
        // extraction die with llm_unavailable despite a working chat_model.
        model,
        system: CLASSIFIER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `<page slug="${page.slug}" type="${page.type}">\n${text}\n</page>`,
          },
        ],
        maxTokens: 2000,
      });
    } catch (err) {
      // Skip pages whose chat call fails (rate limit, content filter, auth,
      // transient error) with the reason, so an outage is distinguishable
      // from "nothing to extract". Per-page progress continues.
      const code = (err as { code?: unknown; status?: unknown } | null)?.code
        ?? (err as { status?: unknown } | null)?.status
        ?? (err instanceof Error ? err.name : 'unknown');
      skipPage(page.slug, `llm_error:${String(code)}`);
      continue;
    }

    const claims = parseClaimsJson(response.text);
    if (claims.length === 0) continue;

    if (dryRun) {
      claimsExtracted += claims.length;
      continue;
    }

    // #4473: md-first write through the fence pipeline (row numbers derive
    // from the fence — max existing + 1 — so the historical row_num=1
    // collision posture is gone). LLM output is pre-filtered against the
    // fence-cell guards so one garbled claim drops alone instead of sinking
    // the page's other claims.
    // Never append a claim the page's takes fence already holds (a rerun with
    // includeCovered, or a hand-added take): duplicate gradeable takes skew
    // calibration. The fence is canonical, so dedupe against its active rows.
    const duplicateBody = managedJournalWrites
      ? serializePageToMarkdown(managedSnapshot!.page, managedSnapshot!.tags)
      : readFileSync(mdPath!, 'utf-8');
    const held = new Set(parseTakesFence(duplicateBody).takes
      .filter((t) => t.active).map((t) => claimKey(t.claim, t.holder)));
    const safeClaims = claims.filter((c) => {
      if (!isSafeFenceCellText(c.claim)) return false;
      const key = claimKey(c.claim, holder);
      if (held.has(key)) {
        duplicatesSkipped++;
        return false;
      }
      held.add(key);
      return true;
    });
    if (safeClaims.length === 0) continue;
    try {
      const rows = safeClaims.map((c) => ({
          claim: c.claim,
          kind: c.kind,
          holder,
          weight: c.weight,
          source: 'cli:takes-bootstrap-from-pages',
        }));
      if (managedJournalWrites) {
        const body = await materializeTakeResolutions(engine, managedSnapshot!.page.id, serializePageToMarkdown(managedSnapshot!.page, managedSnapshot!.tags));
        const composed = appendTakesToPageBody(body, rows);
        const { operations } = await import('./operations.ts');
        const putPage = operations.filter(operation => !operation.localOnly).find(operation => operation.name === 'put_page');
        if (!putPage) throw new Error('put_page operation missing (gbrain build issue)');
        const config = loadConfig() ?? { engine: engine.kind };
        const ctx: OperationContext = {
          engine, config, logger: { info: () => {}, warn: () => {}, error: () => {} },
          dryRun: false, remote: false, sourceId: page.source_id,
        };
        await putPage.handler(ctx, {
          slug: page.slug,
          content: composed.body,
          expected_revision: managedSnapshot!.revision,
        });
        claimsExtracted += composed.rowNums.length;
      } else {
        const { rowNums, mirror } = await appendTakesToPageMdFirst(
          { engine, slug: page.slug, brainDir: repoDir, sourceId: page.source_id }, rows,
        );
        claimsExtracted += rowNums.length;
        if (mirror.mirror_warning) mirrorWarnings++;
      }
    } catch (err) {
      const code = (err as { code?: string; writeError?: string })?.code ?? (err as { writeError?: string })?.writeError;
      if (managedJournalWrites && (code === 'revision_conflict' || code === 'page_identity_changed' || code === 'source_changed')) {
        skipPage(page.slug, code);
        continue;
      }
      if (err instanceof TakesWriteError) {
        // Skip + count (mirror_unavailable race, fence_unparsed, page_locked,
        // invalid_input) — never fall back to a DB-only write.
        skipPage(page.slug, err.code);
        continue;
      }
      throw err;
    }
  }

  // Every page the loop entered is finished except the one a budget stop broke on.
  const finished = budgetExhausted ? pagesScanned - 1 : pagesScanned;
  return {
    pages_scanned: pagesScanned,
    claims_extracted: claimsExtracted,
    next_before: finished > 0 ? pages[finished - 1]!.resume_at : null,
    consent_gate_blocked: false,
    llm_unavailable: false,
    pages_skipped: pagesSkipped,
    skipped,
    mirror_warnings: mirrorWarnings,
    budget_exhausted: budgetExhausted,
    duplicates_skipped: duplicatesSkipped,
  };
}
