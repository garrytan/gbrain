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

import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import { resolveModel } from '../model-config.ts';
import type { PhaseResult } from '../cycle.ts';
import type { ProgressReporter } from '../progress.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import { chat as gatewayChat, isAvailable, isThinkingModel, THINKING_MODEL_MAX_OUTPUT_TOKENS } from '../ai/gateway.ts';
import { createGlobalLlmHaltTracker, haltedClassOf, type GlobalLlmErrorClass } from '../ai/errors.ts';
// #2163: concept pages route through importFromContent (the same
// parse→chunk→embed pipeline put_page uses) instead of a bare engine.putPage,
// so they land in the retrieval surface (content_chunks + embeddings) where
// source-boost's 1.3× 'concepts/' weighting can actually reach them.
import { importFromContent } from '../import-file.ts';
import { canonicalLookup, type ModelPricing } from '../model-pricing.ts';
import { priceFor, type PricingOverrides } from '../budget/reservation-cost.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { pricingSetCommand } from '../budget/no-pricing.ts';
import { createHash } from 'node:crypto';
import { slugifySegment } from '../sync.ts';
import { validatePageSlug } from '../ops/context.ts';
import { privatePagesFilterFragment, strictestVisibility, type Visibility } from '../search/private-visibility.ts';
import { maintenancePreflight } from '../persistence/prepared-maintenance.ts';
import { derivedWriteThrough } from './derived-write-through.ts';
import { canonicalConceptStem, loadConceptRedirects } from './concept-redirects.ts';
import {
  addManagedProvenanceLinks, CONCEPT_DEFERRAL_CODES, CONCEPT_HOLD_CODES, publishClassicConcept, publishManagedConcept, stripFenceSections,
} from './concept-publication.ts';
import { readPhaseConfigNumber, SYNTHESIZE_CONCEPTS_BUDGET_KEY, SYNTHESIZE_CONCEPTS_DEFAULT_BUDGET_USD } from './phase-config-values.ts';
import { ConceptRetryBound, MAX_CONCEPT_ATTEMPTS } from './concept-retry-bound.ts';

// Miss policy for the shared resolver (`priceFor`: operator overrides, the
// claude-cli → Anthropic sibling, canonical rows): assume Sonnet-tier
// pricing for a model nothing prices, and name it in the phase details
// (`pricing_fallback_models`) plus one stderr line. Conservative and
// non-throwing; keeps this default budget effective instead of letting an
// unpriced model run unmetered. The rates are DERIVED from the canonical
// table (never hand-copied — CLAUDE.md invariant); the literal pair only
// fires if the Sonnet key itself ever leaves the table.
const FALLBACK_PRICING: ModelPricing = canonicalLookup('anthropic:claude-sonnet-4-6') ?? {
  input: 3.0,
  output: 15.0,
};
/** The rate a narrative call meters at: the shared resolver, else the Sonnet fallback, naming each fallback model once. */
function narrativePricing(model: string, overrides: PricingOverrides | undefined, fallbackModels: Set<string>, budgetUsd: number): ModelPricing {
  const priced = priceFor(model, 'chat', overrides);
  if (priced) return priced.pricing;
  if (!fallbackModels.has(model)) {
    fallbackModels.add(model);
    console.error(`[synthesize_concepts] ${model} has no pricing; metering it at Sonnet-tier rates against the $${budgetUsd.toFixed(2)} phase budget. To meter its real price, look it up and register it: ${pricingSetCommand(model, 'chat')}`);
  }
  return FALLBACK_PRICING;
}

/** #4907: the run's named-key budget warnings (invalid stored budget, groups refused at the cap), each echoed once to stderr. */
function budgetWarnings(configWarning: string | undefined, capped: number, budgetUsd: number): string[] {
  const warnings = configWarning ? [configWarning] : [];
  if (capped > 0) {
    warnings.push(`${capped} LLM-eligible concept(s) got no model narrative because the $${budgetUsd.toFixed(2)} phase budget was reached; they retry next run. ` +
      `Raise the cap: gbrain config set ${SYNTHESIZE_CONCEPTS_BUDGET_KEY} <usd>. Verify: gbrain config get ${SYNTHESIZE_CONCEPTS_BUDGET_KEY}`);
  }
  for (const warning of warnings) console.error(`[synthesize_concepts] ${warning}`);
  return warnings;
}

const TIER_T1_MIN = 10;
const TIER_T2_MIN = 5;
const TIER_T3_MIN = 2;
/**
 * Output cap for the per-concept narrative. 500 sizes the *answer* (a
 * 1-paragraph summary) and is ample for a non-reasoning model. It is NOT ample
 * for a thinking-by-default model: reasoning bills as output and counts against
 * max_tokens, so the budget is spent before any answer text is emitted — hosted
 * DeepSeek returns empty content (→ `deterministicNarrative` ships a template
 * stub as 'error_fallback'), while the native deepseek: recipe promotes the
 * truncated reasoning_content into content (→ chain-of-thought persisted as
 * the narrative with synthesis_mode 'llm'). This phase resolves at
 * `tier: 'reasoning'`, so a thinking model here is the expected case.
 */
const DEFAULT_SYNTH_MAX_OUTPUT_TOKENS = 500;

/**
 * Narrative output cap for the resolved model. `isThinkingModel` is the
 * gateway's shared predicate (name-matched Claude 5 OR recipe-declared
 * `thinking_by_default`; unknown providers count as non-thinking), the same
 * check think's maxOutputTokensFor and the subagent handler use. Thinking
 * models get the gateway's verified THINKING_MODEL_MAX_OUTPUT_TOKENS rather
 * than a phase-private number: a local 8000 contradicted it, and DeepSeek v4
 * truncates at 8192-class caps — the reasoning budget was gone before any
 * answer text.
 */
export function resolveSynthMaxOutputTokens(modelStr: string): number {
  return isThinkingModel(modelStr) ? THINKING_MODEL_MAX_OUTPUT_TOKENS : DEFAULT_SYNTH_MAX_OUTPUT_TOKENS;
}

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
  _atoms?: Array<{ slug: string; concept_refs: string[]; body: string; title: string; visibility?: Visibility }>;
}

interface AtomGroup {
  conceptSlug: string;
  /** #4589: member atom slugs — the provenance edges are written from these. */
  atomSlugs: string[];
  atomTitles: string[];
  atomBodies: string[];
  /** #5525: strictest effective visibility of the member atoms. */
  visibility: Visibility;
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
        private: boolean;
      }>(
        // Codex P2: scoped to the cycle source — the provenance edges below
        // are pinned to it, so a brain-global scan grouped same-slug atoms
        // from OTHER sources into this source's concepts.
        `SELECT slug, title, compiled_truth, frontmatter, NOT (${privatePagesFilterFragment('pages')}) AS private
           FROM pages
          WHERE type = 'atom'
            AND source_id = $1
            AND deleted_at IS NULL
            AND (frontmatter->>'imported_from') IS NULL`,
        [opts.sourceId ?? 'default'],
      );
      atoms = rows
        .filter((r) => Array.isArray(r.frontmatter?.concepts) && r.frontmatter.concepts.length > 0)
        .map((r) => ({
          slug: r.slug,
          title: r.title,
          body: r.compiled_truth,
          concept_refs: r.frontmatter!.concepts!,
          visibility: r.private ? 'private' as const : 'world' as const,
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

  // 2. Group atoms by normalized concept slug (#6161: a merged concept groups under its canonical one); one atom counts once per concept.
  const redirects = await loadConceptRedirects(engine, opts.sourceId ?? 'default', conceptStemFor).catch(() => new Map<string, string>());
  const groups = new Map<string, { slugs: string[]; titles: string[]; bodies: string[]; visibilities: Visibility[] }>();
  for (const atom of atoms) {
    const conceptSlugs = new Set(atom.concept_refs.map(conceptStemFor).filter((s): s is string => s !== null).map((stem) => canonicalConceptStem(stem, redirects)));
    for (const conceptSlug of conceptSlugs) {
      const existing = groups.get(conceptSlug) ?? { slugs: [], titles: [], bodies: [], visibilities: [] };
      existing.slugs.push(atom.slug);
      existing.titles.push(atom.title);
      existing.bodies.push(atom.body);
      // An atom with no recorded visibility is private (derived pages fail closed).
      existing.visibilities.push(atom.visibility ?? 'private');
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
      atomSlugs: data.slugs,
      atomTitles: data.titles,
      atomBodies: data.bodies,
      visibility: strictestVisibility(data.visibilities),
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
  const budget = await readPhaseConfigNumber(engine, SYNTHESIZE_CONCEPTS_BUDGET_KEY);
  const budgetCap = budget.value ?? SYNTHESIZE_CONCEPTS_DEFAULT_BUDGET_USD;
  let budgetCapped = 0;
  const failures: Array<{ concept: string; error: string }> = [];
  // #4589 provenance-link problems. Kept OUT of `failures`: that list means
  // "the LLM call failed → template fallback" downstream (summary wording,
  // rollup halt_delta / round_completed_delta), which a missing edge is not —
  // the narrative was synthesized and persisted as-is. Warn-only.
  const linkWarnings: Array<{ concept: string; warning: string }> = [];
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
  const synthMaxOutputTokens = resolveSynthMaxOutputTokens(synthModel);
  // #5484: a managed brain refuses the legacy importFromContent writer. Claim
  // maintenance authority before any model spend so a missing canonical owner
  // fails fast; null on an unmanaged brain.
  const maintenance = opts.dryRun ? null : await maintenancePreflight(engine, opts.sourceId ?? 'default', opts.brainDir);
  const conceptFiles = await derivedWriteThrough(engine, 'synthesize_concepts', opts.sourceId ?? 'default', { managed: maintenance !== null, dryRun: opts.dryRun ?? false });
  // Managed publication outcomes, kept out of `failures` (LLM fallback). A
  // deferred concept moved under a concurrent writer and is retried next run;
  // a held concept cannot be republished without losing canonical material.
  const publicationDeferred: Array<{ concept: string; reason: string }> = [];
  const publicationHeld: Array<{ concept: string; reason: string }> = [];
  const skippedHumanOwned: string[] = [];
  const skippedDeleted: string[] = [];
  const skippedUnchanged: string[] = [];
  const rehashed: string[] = [];
  const keptExistingNarrative: string[] = [];
  const pricingOverrides = await loadPricingOverrides(engine);
  const pricingFallbackModels = new Set<string>();
  const retries = await ConceptRetryBound.load(engine); // #6260: bounded paid retries per member hash
  const skippedRetryBound: string[] = [];
  for (const group of atomGroups) {
    const conceptSlug = `concepts/${group.conceptSlug}`;
    // A concept page this phase did not write belongs to a human (or another
    // writer). Check before any spend; never replace its body.
    const existingSnapshot = await engine.readPageSnapshot(conceptSlug, { sourceId: opts.sourceId ?? 'default', includeDeleted: true });
    if (existingSnapshot?.page.deleted_at) { skippedDeleted.push(conceptSlug); continue; } // #6161: a deleted concept is never resurrected
    const existing = existingSnapshot?.page ?? null;
    if (existing && !String(existing.frontmatter?.synthesized_by ?? '').startsWith('synthesize_concepts')) {
      skippedHumanOwned.push(conceptSlug);
      continue;
    }
    // The narrative is a function of the member atoms' narrative (their
    // `## Facts` / `## Takes` sections excluded, D-N3), their strictest
    // visibility and the model. When none changed and the page holds a real
    // narrative, there is nothing to spend or rewrite; a fallback page is retried,
    // and so is one a chat_fallback_chain model wrote (hashed under that model).
    const hashOf = (model: string, bodies: string[]): string => createHash('sha256')
      .update(JSON.stringify([model, group.visibility, group.atomSlugs.map((s, i) => [s, group.atomTitles[i], bodies[i]])
        .sort((a, b) => a[0].localeCompare(b[0]))]))
      .digest('hex').slice(0, 16);
    const narrativeBodies = group.atomBodies.map(stripFenceSections);
    const hashFor = (model: string): string => hashOf(model, narrativeBodies);
    const memberHash = hashFor(synthModel);
    const priorMode = existing?.frontmatter?.synthesis_mode;
    const realNarrative = priorMode === 'llm' || priorMode === 'deterministic_tier';
    if (existing?.frontmatter?.member_hash === memberHash && realNarrative) {
      skippedUnchanged.push(conceptSlug);
      continue;
    }
    // A page hashed by the pre-D-N3 formula (full atom bodies) whose inputs are
    // provably unchanged keeps its narrative: only the hash is rewritten, no spend.
    const grandfathered = realNarrative && existing?.frontmatter?.member_hash === hashOf(synthModel, group.atomBodies);
    if (!grandfathered) tierCounts[group.tier]++;
    let narrative: string;
    let synthesisMode: ConceptSynthesisMode, unverifiedClaims: UnverifiedClaim[] = [];
    let fallbackWriter: string | undefined;
    if (grandfathered) {
      narrative = stripFenceSections(existing!.compiled_truth);
      synthesisMode = priorMode as ConceptSynthesisMode;
      rehashed.push(conceptSlug);
    } else if (group.tier === 'T1' || group.tier === 'T2') {
      if (estimatedSpendUsd >= budgetCap) {
        narrative = deterministicNarrative(group);
        synthesisMode = 'budget_fallback';
        budgetCapped++;
      } else if (retries.exhausted(`${opts.sourceId ?? 'default'}:${conceptSlug}`, memberHash)) {
        skippedRetryBound.push(conceptSlug);
        continue;
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
                  `Sample atom bodies:\n${narrativeBodies
                    .slice(0, 5)
                    .map((b, i) => `${i + 1}. ${b.slice(0, 500)}`)
                    .join('\n\n')}`,
              },
            ],
            maxTokens: synthMaxOutputTokens,
          });
          // Post-await yield (T3): the LLM call is the main TTL hazard
          // codex flagged. Throttle inside maybeYield bounds the actual
          // refresh rate.
          await maybeYield();
          llmHalt.reset();
          const pricing = narrativePricing(result.model, pricingOverrides, pricingFallbackModels, budgetCap);
          estimatedSpendUsd +=
            (result.usage.input_tokens * pricing.input +
              result.usage.output_tokens * pricing.output) /
            1_000_000;
          const text = result.text.trim();
          // #6260: a narrative stopped before the end never replaces a page or advances its member hash.
          const stopped = result.stopReason === 'length' || result.stopReason === 'refusal' || result.stopReason === 'content_filter';
          if (text && !stopped) {
            ({ narrative, unverified: unverifiedClaims } = await groundConceptNarrative(engine, text, group));
            synthesisMode = 'llm';
            if (result.fallbackFrom) fallbackWriter = result.model;
            retries.succeed(`${opts.sourceId ?? 'default'}:${conceptSlug}`);
          } else {
            failures.push({ concept: group.conceptSlug, error: stopped ? `output stopped before the end (stopReason=${result.stopReason})` : 'empty model response' });
            narrative = deterministicNarrative(group);
            synthesisMode = 'error_fallback';
            retries.fail(`${opts.sourceId ?? 'default'}:${conceptSlug}`, memberHash);
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
          retries.fail(`${opts.sourceId ?? 'default'}:${conceptSlug}`, memberHash);
        }
      }
    } else {
      narrative = deterministicNarrative(group);
      synthesisMode = 'deterministic_tier';
    }
    // Never replace an LLM narrative with a template stub; the next cycle retries.
    if (priorMode === 'llm' && (synthesisMode === 'budget_fallback' || synthesisMode === 'error_fallback')) {
      keptExistingNarrative.push(conceptSlug);
      continue;
    }
    if (!grandfathered) synthesisModeCounts[synthesisMode]++;

    if (!opts.dryRun) {
      // #5525: tighten-only — a concept already private stays private.
      const prior = await engine.getPage(conceptSlug, { sourceId: opts.sourceId ?? 'default' });
      const visibility = strictestVisibility([group.visibility, prior?.frontmatter?.visibility === 'private' ? 'private' : 'world']);
      // #2163: serialize to markdown and import via the canonical pipeline so
      // the page is chunked (+ embedded when a provider is configured) —
      // mirrors put_page's isAvailable('embedding') → noEmbed gate.
      const synthesizedAt = grandfathered ? String(existing!.frontmatter.synthesized_at ?? new Date().toISOString()) : new Date().toISOString();
      const synthesized = (pageVisibility: Visibility) => ({
        tier: group.tier,
        mention_count: group.atomTitles.length,
        composite_score: group.atomTitles.length,
        synthesis_mode: synthesisMode,
        member_hash: fallbackWriter ? hashFor(fallbackWriter) : memberHash,
        synthesized_at: synthesizedAt,
        synthesized_by: 'synthesize_concepts-v0.41',
        visibility: pageVisibility, ...(unverifiedClaims.length ? { unverified_claims: unverifiedClaims.map(c => ({ ...c, sources: ['member atoms'], detected_at: synthesizedAt.slice(0, 10) })) } : {}),
      });
      // Each managed publication is bound to the revision the narrative was
      // synthesized from, then to the previous publication's result.
      let conceptRevision = existingSnapshot?.revision ?? null;
      // Unmanaged: the narrative the page held when synthesis started; a
      // different narrative under the page lock defers the concept (D-N3).
      let baseline = existing?.compiled_truth ?? '';
      const publish = async (pageVisibility: Visibility): Promise<void> => {
        if (maintenance) {
          conceptRevision = await publishManagedConcept(engine, maintenance, conceptSlug, synthesized(pageVisibility), narrative,
            conceptRevision, opts.brainDir);
          return;
        }
        // #4416: target the cycle's resolved source, not the 'default' literal.
        baseline = await publishClassicConcept(engine, conceptSlug, opts.sourceId ?? 'default', synthesized(pageVisibility), narrative,
          baseline, { writeThrough: conceptFiles !== null, importPage: (markdown) => importFromContent(engine, conceptSlug, markdown, {
            noEmbed: !isAvailable('embedding'), sourceId: opts.sourceId,
          }) });
      };
      // A publication that lost a revision race or would lose canonical
      // material is recorded and skipped; any other error stops the phase.
      const publishOrRecord = async (pageVisibility: Visibility): Promise<boolean> => {
        try { await publish(pageVisibility); return true; } catch (err) {
          const code = (err as { code?: unknown }).code;
          if (typeof code !== 'string') throw err;
          const reason = `${code}: ${(err as Error).message}`;
          if (CONCEPT_DEFERRAL_CODES.has(code)) publicationDeferred.push({ concept: group.conceptSlug, reason });
          else if (CONCEPT_HOLD_CODES.has(code)) publicationHeld.push({ concept: group.conceptSlug, reason });
          else throw err;
          return false;
        }
      };
      // #5525: a world concept stays private until every member's provenance
      // edge is durable, because a later private flip reaches it through them.
      if (!await publishOrRecord('private')) continue;
      // #4589: bank concept<->member-atom provenance edges. The prompt forbids
      // enumerating atoms in the body and no frontmatter field maps to a link
      // verb, so without this every concept page lands with zero edges (graph
      // orphan). Dedicated link_source keeps reconcile passes from pruning
      // them; both endpoints sit in the cycle's source (an atom living in
      // another source drops out of the batch JOIN — no cross-source edge).
      // ON CONFLICT DO NOTHING makes re-runs idempotent, so a failure here is
      // best-effort: recorded as a warn, the page write stands. Mirrors #3961.
      const src = opts.sourceId ?? 'default';
      const provenanceLinks: LinkBatchInput[] = [...new Set(group.atomSlugs)].flatMap((atomSlug) => [
        { from_slug: conceptSlug, to_slug: atomSlug, link_type: 'synthesized_from', link_source: 'concept-provenance', context: 'member atom', from_source_id: src, to_source_id: src },
        { from_slug: atomSlug, to_slug: conceptSlug, link_type: 'synthesizes', link_source: 'concept-provenance', context: 'concept synthesized from this atom', from_source_id: src, to_source_id: src },
      ]);
      try {
        const inserted = maintenance ? await addManagedProvenanceLinks(engine, src, provenanceLinks)
          : await engine.addLinksBatch(provenanceLinks, { auditSite: 'cycle.synthesize_concepts.provenance' }); // gbrain-allow-direct-insert: concept-provenance edges derived from the synthesis itself (no markdown body to reconcile from)
        // Zero rows back with edges requested means every member atom fell
        // out of the batch JOIN (not in this source) — unless a prior run
        // already banked them (ON CONFLICT DO NOTHING also returns 0). A
        // silent 'ok' here is a graph orphan with a clean receipt.
        if (inserted === 0 && provenanceLinks.length > 0) {
          const banked = (await engine.getLinks(conceptSlug, { sourceId: src }))
            .some((l) => l.link_source === 'concept-provenance');
          if (!banked) {
            linkWarnings.push({ concept: group.conceptSlug, warning: `provenance links: 0 of ${provenanceLinks.length} edges landed (member atoms not in source '${src}'?)` });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        linkWarnings.push({ concept: group.conceptSlug, warning: `provenance links failed: ${msg}` });
        console.error(`[synthesize_concepts] provenance links failed for ${conceptSlug} (non-fatal): ${msg}`);
      }
      if (visibility === 'world') {
        const members = [...new Set(group.atomSlugs)];
        const [{ linked }] = await engine.executeRaw<{ linked: number }>(`SELECT COUNT(DISTINCT a.slug)::int AS linked FROM links l
          JOIN pages c ON c.id=l.from_page_id JOIN pages a ON a.id=l.to_page_id
          WHERE c.source_id=$1 AND c.slug=$2 AND a.slug=ANY($3::text[]) AND l.link_source='concept-provenance' AND l.link_type='synthesized_from'`,
        [src, conceptSlug, members]);
        if (Number(linked) === members.length && !await publishOrRecord('world')) continue;
      }
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
  const warnings = budgetWarnings(budget.warning, budgetCapped, budgetCap);
  if (!opts.dryRun) await retries.save(engine);
  // Managed brains skip the receipt page (a legacy putPage), like extract_atoms;
  // the rollup row below still records the run for doctor.
  if (!opts.dryRun && !maintenance && conceptsWritten > 0) {
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
      round_completed_delta: failures.length === 0 && publicationDeferred.length === 0 && publicationHeld.length === 0 ? 1 : 0,
      halt_delta: failures.length > 0 ? 1 : 0,
    });
  }

  return {
    phase: 'synthesize_concepts',
    status: failures.length > 0 || linkWarnings.length > 0 || publicationDeferred.length > 0 || publicationHeld.length > 0 ? 'warn' : 'ok',
    duration_ms: 0,
    summary:
      `synthesize_concepts: ${conceptsWritten} concepts ` +
      `(T1=${tierCounts.T1} T2=${tierCounts.T2} T3=${tierCounts.T3})` +
      (failures.length > 0 ? ` (${failures.length} LLM-failed → template fallback)` : '') +
      (budgetCapped > 0 ? ` (${budgetCapped} over the $${budgetCap.toFixed(2)} budget → template fallback)` : '') +
      (linkWarnings.length > 0 ? ` (${linkWarnings.length} provenance-link warning(s))` : '') +
      (skippedHumanOwned.length > 0 ? ` (${skippedHumanOwned.length} human-owned page(s) left untouched)` : '') +
      (skippedUnchanged.length > 0 ? ` (${skippedUnchanged.length} unchanged)` : '') +
      (rehashed.length > 0 ? ` (${rehashed.length} rehashed without synthesis)` : '') +
      (keptExistingNarrative.length > 0 ? ` (${keptExistingNarrative.length} existing narrative(s) kept)` : '') +
      (skippedRetryBound.length > 0 ? ` (${skippedRetryBound.length} skipped after ${MAX_CONCEPT_ATTEMPTS} failed attempts on unchanged members)` : '') +
      (publicationDeferred.length > 0 ? ` (${publicationDeferred.length} publication(s) deferred: page changed, retried next run)` : '') +
      (publicationHeld.length > 0 ? ` (${publicationHeld.length} publication(s) held: existing page needs import/repair)` : ''),
    details: {
      concepts_written: conceptsWritten,
      tier_counts: tierCounts,
      synthesis_mode_counts: synthesisModeCounts,
      groups_found: atomGroups.length,
      atoms_seen: atoms.length,
      failures,
      link_warnings: linkWarnings,
      warnings,
      skipped_human_owned: skippedHumanOwned,
      skipped_deleted: skippedDeleted,
      skipped_unchanged: skippedUnchanged,
      rehashed,
      kept_existing_narrative: keptExistingNarrative,
      skipped_retry_bound: skippedRetryBound,
      publication_deferred: publicationDeferred,
      publication_held: publicationHeld,
      ...(abortedGlobalError ? { aborted_global_error: abortedGlobalError } : {}),
      estimated_spend_usd: estimatedSpendUsd,
      budget_usd: budgetCap,
      pricing_fallback_models: [...pricingFallbackModels],
      dry_run: opts.dryRun ?? false,
    },
  };
}

/**
 * The concept an atom's concept ref names, as the stem of its `concepts/`
 * slug. LLM refs vary in case, spacing and prefix ("Network Effects",
 * "concepts/network-effects"); they all name `network-effects`. A ref with no
 * valid slug is dropped.
 */
function conceptStemFor(ref: string): string | null {
  const stem = slugifySegment(String(ref).trim().split('/').pop() ?? '');
  if (!stem) return null;
  try {
    validatePageSlug(`concepts/${stem}`);
  } catch {
    return null;
  }
  return stem;
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

/**
 * Ground the narrative's quoted spans against the atom titles and bodies the
 * prompt carried (quotes only: a concept narrative may count or compare).
 * A claim unit with an unverified quote is removed from the narrative and
 * kept in frontmatter `unverified_claims`. Kill switch: dream.quote_verify (default on).
 */
type UnverifiedClaim = { text: string; reason: string; detail: string };
async function groundConceptNarrative(engine: BrainEngine, narrative: string, group: { atomTitles: string[]; atomBodies: string[] }):
  Promise<{ narrative: string; unverified: UnverifiedClaim[] }> {
  const { ALL_CLAIMS_QUARANTINED_BODY, dreamQuoteVerifyEnabled, groundSource, verifyBody } = await import('./synthesize-verify.ts');
  if (!await dreamQuoteVerifyEnabled(engine)) return { narrative, unverified: [] };
  const sources = [
    groundSource('concept-atom-titles', group.atomTitles.slice(0, 10).join('\n'), { tolerant: true }),
    ...group.atomBodies.slice(0, 5).map((b, i) => groundSource(`concept-atom-${i + 1}`, b.slice(0, 500), { tolerant: true })),
  ];
  const v = verifyBody(narrative, sources, { checks: 'quotes' });
  return { narrative: v.body.trim() || ALL_CLAIMS_QUARANTINED_BODY, unverified: v.quarantined };
}
