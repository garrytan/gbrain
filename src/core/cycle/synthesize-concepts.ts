// v0.41 T6 — synthesize_concepts cycle phase (minimal-viable implementation).
//
// v0.41 ships a working concept synthesis path: group atoms by simple
// frontmatter tag/concept references, tier by count (T1 ≥10, T2 ≥5,
// T3 ≥2, T4 ≥1), Sonnet-synthesize T1/T2 narratives. Voice gate
// integration + dedup-by-embedding-similarity ship in v0.42+.
//
// Sequencing:
//   1. Query all atom-typed pages from DB (excluding imported_from
//      marker → atoms already extracted by your OpenClaw don't get
//      re-synthesized as concepts here; their original concept pages
//      come through greenfield import already).
//   2. Group by `concepts:` frontmatter field on each atom (when the
//      Haiku 3-check from extract_atoms decides "this atom is about
//      concept X", it stamps the field).
//   3. For each group with count ≥2: assign tier (T1/T2/T3/T4 by count).
//   4. Sort by tier, evidence count, and slug so the bounded LLM budget goes
//      to the strongest groups deterministically.
//   5. For T1/T2 groups: Sonnet call to produce a 1-paragraph narrative.
//      For T3/T4: deterministic stub narrative.
//   6. Write concept-typed pages with the synthesis mode made explicit.

import type { BrainEngine } from '../engine.ts';
import { resolveModel } from '../model-config.ts';
import type { PhaseResult } from '../cycle.ts';
import type { ProgressReporter } from '../progress.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import { chat as gatewayChat, isAvailable } from '../ai/gateway.ts';
import { createGlobalLlmHaltTracker, haltedClassOf, type GlobalLlmErrorClass } from '../ai/errors.ts';
// #2163: concept pages route through importFromContent (the same
// parse→chunk→embed pipeline put_page uses) instead of a bare engine.putPage,
// so they land in the retrieval surface (content_chunks + embeddings) where
// source-boost's 1.3× 'concepts/' weighting can actually reach them.
import { importFromContent } from '../import-file.ts';
import { serializeMarkdown } from '../markdown.ts';
import { canonicalLookup, type ModelPricing } from '../model-pricing.ts';

const DEFAULT_BUDGET_USD = 1.5;
// Canonical-miss policy — mirrors skillopt/preflight.ts's lookupPrice:
// assume Sonnet-tier pricing for models absent from CANONICAL_PRICING.
// Conservative and non-throwing; keeps the budget gate effective (and
// matches this file's pre-canonical behavior) instead of letting an
// unpriced model run unmetered. The rates are DERIVED from the canonical
// table (never hand-copied — CLAUDE.md invariant); the literal pair only
// fires if the Sonnet key itself ever leaves the table.
const FALLBACK_PRICING: ModelPricing = canonicalLookup('anthropic:claude-sonnet-4-6') ?? {
  input: 3.0,
  output: 15.0,
};
const TIER_T1_MIN = 10;
const TIER_T2_MIN = 5;
const TIER_T3_MIN = 2;

export interface SynthesizeConceptsOpts {
  brainDir?: string;
  /**
   * #4416: the cycle's resolved source scope (cycleSourceId in cycle.ts).
   * Without it every write below falls through to the engine's `?? 'default'`
   * literal, which misfiles (or, on the createVersion update path, kills the
   * cycle) on any brain whose sole source is not named `default`: getPage's
   * undefined-source path is source-agnostic, so the existence probe passes,
   * then createVersion throws "page ... (source=default) not found".
   */
  sourceId?: string;
  dryRun?: boolean;
  yieldDuringPhase?: (() => Promise<void>) | undefined;
  /**
   * v0.41.19.0 (T4): progress reporter for in-phase ticks. Cycle.ts
   * passes the SAME reporter (not a child — see extract-atoms.ts for
   * the path-collision bug codex caught). Phases only call `tick()` /
   * `heartbeat()`; cycle.ts owns start/finish.
   */
  progress?: ProgressReporter;
  /** Test seam: alternative chat function. */
  _chat?: typeof gatewayChat;
  /** Test seam: skip DB query; cluster these atoms directly. */
  _atoms?: Array<{ slug: string; concept_refs: string[]; body: string; title: string }>;
}

interface AtomGroup {
  conceptSlug: string;
  atomTitles: string[];
  atomBodies: string[];
  tier: 'T1' | 'T2' | 'T3' | 'T4';
}

type ConceptSynthesisMode =
  | 'llm'
  | 'deterministic_tier'
  | 'budget_fallback'
  | 'error_fallback';

const SYNTH_PROMPT = `You write a 1-paragraph executive summary of a concept
based on multiple atom-shaped insights that reference it.

Output ONLY the summary paragraph (3-5 sentences). No headers, no JSON,
no preamble. Write in plain English, present-tense voice. Synthesize what
the atoms collectively SAY about the concept; don't enumerate the atoms.`;

export async function runPhaseSynthesizeConcepts(
  engine: BrainEngine,
  opts: SynthesizeConceptsOpts = {},
): Promise<PhaseResult> {
  const chat = opts._chat ?? gatewayChat;

  // 1. Get atom pages (test seam OR DB query)
  let atoms = opts._atoms ?? [];
  if (atoms.length === 0 && opts._atoms === undefined) {
    try {
      const rows = await engine.executeRaw<{
        slug: string;
        title: string;
        compiled_truth: string;
        frontmatter: { concepts?: string[]; imported_from?: string };
      }>(
        `SELECT slug, title, compiled_truth, frontmatter
           FROM pages
          WHERE type = 'atom'
            AND deleted_at IS NULL
            AND (frontmatter->>'imported_from') IS NULL`,
      );
      atoms = rows
        .filter((r) => Array.isArray(r.frontmatter?.concepts) && r.frontmatter.concepts.length > 0)
        .map((r) => ({
          slug: r.slug,
          title: r.title,
          body: r.compiled_truth,
          concept_refs: r.frontmatter!.concepts!,
        }));
    } catch {
      // No atoms table or query failed — phase no-ops cleanly.
    }
  }

  if (atoms.length === 0) {
    return {
      phase: 'synthesize_concepts',
      status: 'skipped',
      duration_ms: 0,
      summary: 'synthesize_concepts: no atoms with concept refs',
      details: { reason: 'no_atoms' },
    };
  }

  // 2. Group atoms by concept slug
  const groups = new Map<string, { titles: string[]; bodies: string[] }>();
  for (const atom of atoms) {
    for (const conceptSlug of atom.concept_refs) {
      const existing = groups.get(conceptSlug) ?? { titles: [], bodies: [] };
      existing.titles.push(atom.title);
      existing.bodies.push(atom.body);
      groups.set(conceptSlug, existing);
    }
  }

  // 3. Filter to count ≥2, assign tier
  const atomGroups: AtomGroup[] = [];
  for (const [conceptSlug, data] of groups) {
    const count = data.titles.length;
    if (count < TIER_T3_MIN) continue;
    const tier: AtomGroup['tier'] =
      count >= TIER_T1_MIN ? 'T1' : count >= TIER_T2_MIN ? 'T2' : 'T3';
    atomGroups.push({
      conceptSlug,
      atomTitles: data.titles,
      atomBodies: data.bodies,
      tier,
    });
  }

  if (atomGroups.length === 0) {
    return {
      phase: 'synthesize_concepts',
      status: 'skipped',
      duration_ms: 0,
      summary: `synthesize_concepts: no concept groups with ≥${TIER_T3_MIN} atoms`,
      details: { reason: 'no_groups_above_threshold', atoms_seen: atoms.length },
    };
  }

  // Spend the bounded LLM budget on the strongest concepts first, independent
  // of Postgres/PGLite row encounter order. Stable slug ordering makes equal
  // groups deterministic across engines and repeated runs.
  const tierRank: Record<AtomGroup['tier'], number> = { T1: 0, T2: 1, T3: 2, T4: 3 };
  atomGroups.sort((a, b) =>
    tierRank[a.tier] - tierRank[b.tier] ||
    b.atomTitles.length - a.atomTitles.length ||
    a.conceptSlug.localeCompare(b.conceptSlug));

  // 4. Per group: synthesize narrative (LLM for T1/T2, deterministic for T3+)
  let conceptsWritten = 0;
  let estimatedSpendUsd = 0;
  const budgetCap = DEFAULT_BUDGET_USD;
  const failures: Array<{ concept: string; error: string }> = [];
  // #3044 adoption: shared halt policy — auth/billing halt on the first
  // hit, a rate_limit streak halts after 3 consecutive failures, a
  // successful chat call resets the streak.
  const llmHalt = createGlobalLlmHaltTracker();
  let abortedGlobalError: GlobalLlmErrorClass | null = null;
  const tierCounts = { T1: 0, T2: 0, T3: 0, T4: 0 };
  const synthesisModeCounts: Record<ConceptSynthesisMode, number> = {
    llm: 0,
    deterministic_tier: 0,
    budget_fallback: 0,
    error_fallback: 0,
  };

  // v0.41.19.0 (T3): throttled yield helper. Fires `opts.yieldDuringPhase`
  // every 30s — cycle.ts threads `buildYieldDuringPhase(lock, outer)` so
  // each fire refreshes the cycle DB lock + the existing external hook.
  // Pre-v0.41.19 the bare `if (opts.yieldDuringPhase) await ...()` at
  // every iteration fired hundreds of times per phase; the 30s throttle
  // matches the actual lock-refresh budget.
  let lastYieldMs = Date.now();
  async function maybeYield(): Promise<void> {
    if (!opts.yieldDuringPhase) return;
    const now = Date.now();
    if (now - lastYieldMs < 30_000) return;
    lastYieldMs = now;
    try {
      await opts.yieldDuringPhase();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[synthesize_concepts] yieldDuringPhase failed (non-fatal): ${msg}`);
    }
  }

  // Honour the documented per-task routing. Without an explicit model this
  // call inherits models.chat, so models.dream.synthesize (advertised in the
  // routing table as tier.reasoning) had no effect on this path.
  const synthModel = await resolveModel(engine, {
    configKey: 'models.dream.synthesize',
    tier: 'reasoning',
    fallback: 'sonnet',
  });
  for (const group of atomGroups) {
    tierCounts[group.tier]++;
    let narrative: string;
    let synthesisMode: ConceptSynthesisMode;
    if (group.tier === 'T1' || group.tier === 'T2') {
      if (estimatedSpendUsd >= budgetCap) {
        narrative = deterministicNarrative(group);
        synthesisMode = 'budget_fallback';
      } else {
        try {
          const result = await chat({
            model: synthModel,
            system: SYNTH_PROMPT,
            messages: [
              {
                role: 'user',
                content:
                  `Concept slug: ${group.conceptSlug}\n` +
                  `${group.atomTitles.length} atoms reference this concept.\n\n` +
                  `Sample atom titles:\n${group.atomTitles.slice(0, 10).map((t) => `  - ${t}`).join('\n')}\n\n` +
                  `Sample atom bodies:\n${group.atomBodies
                    .slice(0, 5)
                    .map((b, i) => `${i + 1}. ${b.slice(0, 500)}`)
                    .join('\n\n')}`,
              },
            ],
            maxTokens: 500,
          });
          // Post-await yield (T3): the LLM call is the main TTL hazard
          // codex flagged. Throttle inside maybeYield bounds the actual
          // refresh rate.
          await maybeYield();
          llmHalt.reset();
          // Price from the model that actually answered, through the one
          // canonical chat-pricing table (CLAUDE.md invariant). Canonical
          // miss → Sonnet-tier FALLBACK_PRICING (see constant above).
          const pricing = canonicalLookup(result.model) ?? FALLBACK_PRICING;
          estimatedSpendUsd +=
            (result.usage.input_tokens * pricing.input +
              result.usage.output_tokens * pricing.output) /
            1_000_000;
          const text = result.text.trim();
          if (text) {
            narrative = text;
            synthesisMode = 'llm';
          } else {
            failures.push({ concept: group.conceptSlug, error: 'empty model response' });
            narrative = deterministicNarrative(group);
            synthesisMode = 'error_fallback';
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // #3044 adoption: a whole-run LLM outage must not overwrite
          // existing concept pages with error_fallback stub narratives.
          // A halt decision stops the phase; a below-streak rate limit
          // skips this group's write (the page stays intact for the next
          // run); only non-global errors keep the per-item
          // error_fallback behavior.
          const decision = llmHalt.observe(err);
          if (decision !== 'continue') {
            abortedGlobalError = haltedClassOf(decision);
            failures.push({
              concept: group.conceptSlug,
              error: `aborting phase: ${llmHalt.note()} (${msg})`,
            });
            break;
          }
          failures.push({ concept: group.conceptSlug, error: msg });
          if (llmHalt.lastClass() === 'rate_limit') continue;
          narrative = deterministicNarrative(group);
          synthesisMode = 'error_fallback';
        }
      }
    } else {
      narrative = deterministicNarrative(group);
      synthesisMode = 'deterministic_tier';
    }
    synthesisModeCounts[synthesisMode]++;

    if (!opts.dryRun) {
      const title = group.conceptSlug.split('/').pop() ?? group.conceptSlug;
      // #2163: serialize to markdown and import via the canonical pipeline so
      // the page is chunked (+ embedded when a provider is configured) —
      // mirrors put_page's isAvailable('embedding') → noEmbed gate.
      const md = serializeMarkdown(
        {
          tier: group.tier,
          mention_count: group.atomTitles.length,
          composite_score: group.atomTitles.length,
          synthesis_mode: synthesisMode,
          synthesized_at: new Date().toISOString(),
          synthesized_by: 'synthesize_concepts-v0.41',
        },
        narrative,
        '',
        { type: 'concept', title: title.replace(/-/g, ' '), tags: [] },
      );
      await importFromContent(engine, `concepts/${title}`, md, {
        noEmbed: !isAvailable('embedding'),
        // #4416: target the cycle's resolved source, not the 'default' literal.
        sourceId: opts.sourceId,
      });
    }
    conceptsWritten++;
    // v0.41.19.0 (T4): one tick per concept group with running count.
    opts.progress?.tick(1, `${conceptsWritten} concepts`);

    // v0.41.19.0 (T3): replaced bare per-iteration fire with throttled
    // helper. Same hook, same cycle-lock refresh effect, just at the
    // right cadence (30s instead of every-group).
    await maybeYield();
  }

  // v0.42 Wave B3: receipt + rollup for synthesize_concepts. Receipt/rollup
  // carry the cycle's resolved source (#4416, opts.sourceId); 'default'
  // survives only as the fallback for legacy unscoped callers. Receipt only
  // fires when concepts were actually written; rollup always fires so doctor
  // sees the phase ran.
  if (!opts.dryRun && conceptsWritten > 0) {
    const runId = `concepts-${Date.now().toString(36)}`;
    try {
      await writeReceipt(engine, {
        kind: 'concepts',
        source_id: opts.sourceId ?? 'default',
        run_id: runId,
        round: 'single',
        extracted_at: new Date().toISOString(),
        total_rows: conceptsWritten,
        cost_usd: estimatedSpendUsd,
        summary:
          `Synthesized ${conceptsWritten} concepts ` +
          `(T1=${tierCounts.T1} T2=${tierCounts.T2} T3=${tierCounts.T3}) ` +
          `(llm=${synthesisModeCounts.llm} deterministic=${synthesisModeCounts.deterministic_tier} ` +
          `budget_fallback=${synthesisModeCounts.budget_fallback} error_fallback=${synthesisModeCounts.error_fallback}) ` +
          `from ${atomGroups.length} groups across ${atoms.length} atoms.`,
      });
    } catch (err) {
      console.error(`[synthesize_concepts] receipt write failed: ${(err as Error).message}`);
    }
  }
  if (!opts.dryRun) {
    await upsertExtractRollup(engine, {
      kind: 'concepts',
      source_id: opts.sourceId ?? 'default',
      cost_delta: estimatedSpendUsd,
      round_completed_delta: failures.length === 0 ? 1 : 0,
      halt_delta: failures.length > 0 ? 1 : 0,
    });
  }

  return {
    phase: 'synthesize_concepts',
    status: failures.length > 0 ? 'warn' : 'ok',
    duration_ms: 0,
    summary:
      `synthesize_concepts: ${conceptsWritten} concepts ` +
      `(T1=${tierCounts.T1} T2=${tierCounts.T2} T3=${tierCounts.T3})` +
      (failures.length > 0 ? ` (${failures.length} LLM-failed → template fallback)` : ''),
    details: {
      concepts_written: conceptsWritten,
      tier_counts: tierCounts,
      synthesis_mode_counts: synthesisModeCounts,
      groups_found: atomGroups.length,
      atoms_seen: atoms.length,
      failures,
      ...(abortedGlobalError ? { aborted_global_error: abortedGlobalError } : {}),
      estimated_spend_usd: estimatedSpendUsd,
      budget_usd: budgetCap,
      dry_run: opts.dryRun ?? false,
    },
  };
}

/**
 * Deterministic fallback narrative for T3/T4 concepts and budget-exhausted
 * T1/T2 groups. No LLM call. v0.41 minimal shape — v0.42 enriches with
 * dominant themes, time spread, breadth.
 */
function deterministicNarrative(group: AtomGroup): string {
  const tier = group.tier;
  const count = group.atomTitles.length;
  return (
    `${tier} concept. ${count} atom${count === 1 ? '' : 's'} reference this. ` +
    `Top mentions:\n${group.atomTitles
      .slice(0, 5)
      .map((t) => `  - ${t}`)
      .join('\n')}`
  );
}
