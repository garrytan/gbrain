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

import type { BrainEngine } from './engine.ts';
import type { TakeBatchInput, TakeKind } from './engine.ts';
import { chat, isAvailable } from './ai/gateway.ts';

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
  /** Progress hook called per page. */
  onProgress?: (done: number, total: number, claims: number) => void;
}

export interface ExtractTakesFromPagesResult {
  pages_scanned: number;
  claims_extracted: number;
  /** True if the run was a no-op because bootstrapEnabled is false. */
  consent_gate_blocked: boolean;
  /** True if chat gateway is unavailable (no LLM call possible). */
  llm_unavailable: boolean;
}

interface PageRow {
  id: number;
  slug: string;
  source_id: string;
  type: string;
  compiled_truth: string;
  updated_at: string | Date;
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
  // A12 consent gate: refuse without bootstrap_enabled even on manual call.
  if (!opts.bootstrapEnabled) {
    return {
      pages_scanned: 0,
      claims_extracted: 0,
      consent_gate_blocked: true,
      llm_unavailable: false,
    };
  }

  if (!isAvailable('chat')) {
    return {
      pages_scanned: 0,
      claims_extracted: 0,
      consent_gate_blocked: false,
      llm_unavailable: true,
    };
  }

  const dryRun = opts.dryRun ?? false;
  const maxPages = opts.maxPages ?? 50;
  const holder = opts.holder ?? 'system';
  const sourceFilter = opts.sourceIdFilter ? `AND source_id = $1` : '';
  const params = opts.sourceIdFilter ? [opts.sourceIdFilter] : [];

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
    `SELECT id, slug, source_id, type, compiled_truth, updated_at
       FROM pages
      WHERE type IN (${typesList})
        AND deleted_at IS NULL
        AND length(COALESCE(compiled_truth, '')) > 200
        ${coveredFilter}
        ${sourceFilter}
      ORDER BY updated_at DESC
      LIMIT ${maxPages}`,
    params,
  );

  let pagesScanned = 0;
  let claimsExtracted = 0;
  const batch: TakeBatchInput[] = [];

  async function flush() {
    if (batch.length === 0) return;
    if (!dryRun) {
      try {
        claimsExtracted += await engine.addTakesBatch(batch);
      } catch {
        // batch error — drop and continue with subsequent pages
      }
    } else {
      claimsExtracted += batch.length;
    }
    batch.length = 0;
  }

  for (const page of pages) {
    pagesScanned++;
    opts.onProgress?.(pagesScanned, pages.length, claimsExtracted);

    if (!page.compiled_truth || page.compiled_truth.length < 200) continue;

    // Truncate to keep per-page cost bounded (~20K chars → ~5K input tokens).
    const text = page.compiled_truth.slice(0, 20_000);

    let response: { text: string };
    try {
      response = await chat({
        model: opts.model ?? 'anthropic:claude-haiku-4-5',
        system: CLASSIFIER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `<page slug="${page.slug}" type="${page.type}">\n${text}\n</page>`,
          },
        ],
        maxTokens: 2000,
      });
    } catch {
      // Skip pages whose chat call fails (rate limit, content filter,
      // transient error). Per-page progress continues.
      continue;
    }

    const claims = parseClaimsJson(response.text);
    if (claims.length === 0) continue;

    // Assign row_num starting from 1 per page. We don't query existing
    // takes for the page — collisions on (page_id, row_num) are an existing
    // bug class addresses by extract-conversation-facts; takes-bootstrap
    // inherits the same posture: writes start at row_num=1 and the engine's
    // unique constraint surfaces duplicates as failures (caller re-runs).
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i];
      batch.push({
        page_id: page.id,
        row_num: i + 1,
        claim: c.claim,
        kind: c.kind,
        holder,
        weight: c.weight,
        source: 'cli:takes-bootstrap-from-pages',
      });
    }
    if (batch.length >= 200) await flush();
  }

  await flush();
  return {
    pages_scanned: pagesScanned,
    claims_extracted: claimsExtracted,
    consent_gate_blocked: false,
    llm_unavailable: false,
  };
}
