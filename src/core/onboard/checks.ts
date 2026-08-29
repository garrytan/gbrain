// src/core/onboard/checks.ts
// sourcescope:file-brain-wide — every SQL site here is intentionally
// brain-wide aggregate. The onboard checks REPORT across all sources
// (orphan_count, stale_count, link_coverage, takes_count) so adding
// source_id WHERE clauses would change the semantic. Per A26.
//
// v0.41.18.0 (A16, T4). Four new doctor checks consumed by both:
//   - src/commands/doctor.ts runDoctor      (local surface)
//   - src/core/doctor-remote.ts             (thin-client surface)
//   - src/core/onboard/plan-from-checks.ts  (onboard remediation aggregator)
//
// Each helper is shaped: compute metric → return both Check entry (for
// doctor render) and RemediationStep[] (for onboard's extra-remediation
// plumbing per A2). Helpers stay PURE wrt config: no engine.connect, no
// process.exit. SQL via engine.executeRaw with `sourceScopeOpts(ctx)`
// when ctx threads — onboard surface threads explicitly per A26.

import type { BrainEngine } from '../engine.ts';
import type { RemediationStep } from '../remediation-step.ts';
import { makeRemediationStep } from '../remediation-step.ts';
import { QUARANTINE_FILTER_FRAGMENT } from '../quarantine.ts';

/** Shared shape returned by all four checks. */
export interface OnboardCheckResult {
  check: {
    name: string;
    status: 'ok' | 'warn' | 'fail';
    message: string;
  };
  remediations: RemediationStep[];
}

/** Internal sql helper. Returns first row or empty object on throw. */
async function safeCount(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<number> {
  try {
    const result = await engine.executeRaw(sql, params);
    const rows = (result as { rows?: Array<Record<string, unknown>> } | undefined)?.rows
      ?? (result as Array<Record<string, unknown>> | undefined)
      ?? [];
    const row = rows[0] ?? {};
    const raw = (row as Record<string, unknown>).count ?? (row as Record<string, unknown>).c ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

const VISIBLE_ENTITY_PREDICATE = `p.type IN ('person', 'company', 'organization', 'entity')
  AND p.deleted_at IS NULL
  AND ${QUARANTINE_FILTER_FRAGMENT}`;

type CoverageFeature =
  | { table: 'links'; pageIdColumn: 'to_page_id' }
  | { table: 'timeline_entries'; pageIdColumn: 'page_id' };

interface EntityCoverageSample {
  matched: number;
  sampleSize: number;
}

/** Parse a SQL count defensively: coverage is an operator-facing health metric,
 * so a malformed driver value must not escape as NaN or a negative count. */
function finiteCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * Count the feature numerator and denominator from the SAME sampled CTE.
 * TABLESAMPLE BERNOULLI returns a random number of rows; deriving its
 * denominator from `total * requestedPercent` can make coverage exceed 100%.
 */
async function sampleVisibleEntityCoverage(
  engine: BrainEngine,
  sampleClause: string,
  feature: CoverageFeature,
): Promise<EntityCoverageSample> {
  try {
    const result = await engine.executeRaw(
      `WITH sampled_entities AS (
         SELECT p.id
           FROM pages p ${sampleClause}
          WHERE ${VISIBLE_ENTITY_PREDICATE}
       )
       SELECT
         COUNT(*)::int AS sample_size,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM ${feature.table} f
              WHERE f.${feature.pageIdColumn} = s.id
           )
         )::int AS matched
         FROM sampled_entities s`,
    );
    const rows = (result as { rows?: Array<Record<string, unknown>> } | undefined)?.rows
      ?? (result as Array<Record<string, unknown>> | undefined)
      ?? [];
    const row = rows[0] ?? {};
    const sampleSize = finiteCount(row.sample_size);
    // The SQL shape guarantees matched <= sample_size. Keep a defensive clamp
    // at the rendering boundary so a driver/fixture anomaly still cannot emit
    // impossible percentages or feed a negative value into sqrt().
    const matched = Math.min(sampleSize, finiteCount(row.matched));
    return { matched, sampleSize };
  } catch {
    return { matched: 0, sampleSize: 0 };
  }
}

function coverageWithConfidence(sample: EntityCoverageSample): { coverage: number; ci: number } {
  const rawCoverage = sample.sampleSize > 0 ? sample.matched / sample.sampleSize : 0;
  const coverage = Math.min(1, Math.max(0, rawCoverage));
  const variance = Math.max(0, coverage * (1 - coverage));
  const ci = Math.sqrt(variance / Math.max(1, sample.sampleSize));
  return { coverage, ci };
}

/**
 * embed_staleness: count of chunks awaiting embedding.
 *
 * Backed by content_chunks_stale_idx partial index (v100) so the count
 * is cheap even on big brains.
 */
export async function checkEmbedStaleness(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  const staleCount = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM content_chunks WHERE embedding IS NULL`,
  );
  const remediations: RemediationStep[] = [];
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  let message: string;

  if (staleCount === 0) {
    message = 'No stale chunks';
  } else if (staleCount < 1000) {
    status = 'warn';
    message = `${staleCount} stale chunks (small backlog)`;
    remediations.push(makeRemediationStep({
      id: 'onboard.embed_catch_up',
      job: 'embed-catch-up',
      params: { batchSize: 500 },
      severity: 'medium',
      est_seconds: Math.min(900, Math.ceil(staleCount * 0.2)),
      est_usd_cost: staleCount * 0.00002,
      rationale: `${staleCount} chunks awaiting embedding`,
      status: 'remediable',
    }));
  } else {
    // v0.41.18.0: warn-only even on large backlogs. Doctor exit code should
    // not flip from a brain that has pages waiting to be embedded — that's
    // a "needs work" condition, not a "broken" one. The high-severity
    // remediation still surfaces via onboard's plan.
    status = 'warn';
    message = `${staleCount} stale chunks (large backlog — vector search returning outdated content)`;
    remediations.push(makeRemediationStep({
      id: 'onboard.embed_catch_up',
      job: 'embed-catch-up',
      params: { batchSize: 1000, priority: 'recent' },
      severity: 'high',
      est_seconds: Math.min(3600, Math.ceil(staleCount * 0.2)),
      est_usd_cost: staleCount * 0.00002,
      rationale: `${staleCount} chunks awaiting embedding; recent-first catch-up`,
      status: 'remediable',
    }));
  }
  return {
    check: { name: 'embed_staleness', status, message },
    remediations,
  };
}

/**
 * Can `extract-ner` actually do anything on this brain?
 *
 * Three-state on purpose. The recommender must be able to tell "the pack
 * declares no NER rules" (a real, explainable no-auto-fix) from "the pack
 * could not be resolved at all" (an operator problem). Collapsing both into
 * a bare `false` is what turns a phantom recommendation into a phantom
 * SILENCE: the nag disappears and nothing says why.
 *
 * Resolution goes through `loadActivePackForLocalEngine`, which is also what
 * the `extract-ner` handler uses — so recommender and handler cannot resolve
 * different packs and then disagree about the same brain. That helper pins
 * `remote: false` (an onboard check is a LOCAL surface; the generic
 * `loadActivePackBestEffort` defaults `remote: ctx.remote ?? true`, and a
 * tier-1 trust rejection would arrive here masquerading as "pack has no NER
 * rules") and pairs file-only config with the engine's DB-side `schema_pack`,
 * matching `checkPackUpgradeAvailable` / `checkTypeProliferation` below.
 *
 * Those two siblings still open-code the same resolution rather than calling
 * the shared helper: their outer `catch` returns a distinguishable
 * `Check skipped: <message>`, which a null-swallowing helper would flatten
 * into "No active pack".
 */
async function resolveNerInferenceCapability(
  engine: BrainEngine,
): Promise<'supported' | 'no_rules' | 'unresolved'> {
  try {
    const { loadActivePackForLocalEngine, packSupportsNerInference } =
      await import('../schema-pack/best-effort.ts');
    const pack = await loadActivePackForLocalEngine(engine);
    if (!pack) return 'unresolved';
    return packSupportsNerInference(pack) ? 'supported' : 'no_rules';
  } catch {
    return 'unresolved';
  }
}

/**
 * entity_link_coverage: fraction of entity pages with at least one inbound link.
 *
 * Per A21 + codex finding #15: TABLESAMPLE BERNOULLI on Postgres when
 * total_pages > 50K, with pinned sample rate (LEAST 100, GREATEST 2,
 * targeting ~5000 sampled rows). PGLite path: full scan.
 *
 * The ±sqrt(p(1-p)/n) confidence interval is embedded in the message
 * itself so doctor + onboard render show "coverage: 31% ± 1.3%" not
 * a misleading point estimate.
 */
export async function checkEntityLinkCoverage(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  // Total visible entity pages. Quarantined pages are hidden from the brain,
  // so they are outside both the coverage numerator and denominator.
  const totalEntities = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM pages p
       WHERE ${VISIBLE_ENTITY_PREDICATE}`,
  );

  if (totalEntities === 0) {
    return {
      check: { name: 'entity_link_coverage', status: 'ok', message: 'No entity pages — coverage check vacuous' },
      remediations: [],
    };
  }

  // Decide TABLESAMPLE policy (PG only, when >50K entities)
  const useSample = engine.kind === 'postgres' && totalEntities > 50_000;
  const samplePct = useSample
    ? Math.max(2.0, Math.min(100.0, (5000.0 / totalEntities) * 100))
    : 100;
  const sampleClause = useSample ? `TABLESAMPLE BERNOULLI (${samplePct.toFixed(2)})` : '';

  const sample = await sampleVisibleEntityCoverage(
    engine,
    sampleClause,
    { table: 'links', pageIdColumn: 'to_page_id' },
  );
  const { coverage, ci } = coverageWithConfidence(sample);

  const pct = Math.round(coverage * 100);
  const ciPct = (ci * 100).toFixed(1);
  const sampleNote = useSample ? ` (sampled ${samplePct.toFixed(1)}%)` : '';

  const remediations: RemediationStep[] = [];
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  let message: string;

  // v0.41.18.0: warn-only, never fail. Empty entity link coverage is "needs
  // work" not "broken" — doctor's exit code should not flip from a fresh
  // brain with entity pages but no auto-extracted links yet. Fail status
  // would break `gbrain doctor exits 0` contract; the recommendation
  // surfaces the same fix via the onboard plan either way.
  if (coverage >= 0.7) {
    message = `Coverage ${pct}% ± ${ciPct}%${sampleNote}`;
  } else {
    status = 'warn';
    message = `Coverage ${pct}% ± ${ciPct}% (target 70%)${sampleNote}`;
    // Only recommend NER extraction if the active pack actually declares
    // inference.regex rules — otherwise `extract-ner` is a structural no-op
    // (pack_unavailable, 0 links) and the recommendation could never clear.
    //
    // Recommender and handler now share BOTH halves of the question: the same
    // resolver (`loadActivePackForLocalEngine`) picks the pack, and the same
    // predicate (`packSupportsNerInference`) judges its capability. Sharing
    // only the predicate would still have let the two resolve different packs.
    const nerCapability = await resolveNerInferenceCapability(engine);
    if (nerCapability === 'supported') {
      remediations.push(makeRemediationStep({
        id: 'onboard.extract_ner_links',
        job: 'extract-ner',
        params: {},
        severity: coverage >= 0.4 ? 'medium' : 'high',
        est_seconds: coverage >= 0.4 ? 300 : 600,
        est_usd_cost: 0,
        rationale: `Entity link coverage at ${pct}%; NER extraction lifts typed-link density`,
        status: 'remediable',
      }));
    } else if (nerCapability === 'no_rules') {
      message += ' — no auto-fix: the active schema pack declares no NER inference rules'
        + ' (add link_types[].inference.regex, or upgrade the pack)';
    } else {
      message += ' — no auto-fix: could not resolve the active schema pack, so NER'
        + ' capability is unknown (see `gbrain doctor` schema_pack checks)';
    }
  }
  return {
    check: { name: 'entity_link_coverage', status, message },
    remediations,
  };
}

/**
 * timeline_coverage: fraction of entity pages with at least one timeline entry.
 *
 * Same TABLESAMPLE policy as entity_link_coverage for big brains.
 */
export async function checkTimelineCoverage(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  const totalEntities = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM pages p
       WHERE ${VISIBLE_ENTITY_PREDICATE}`,
  );

  if (totalEntities === 0) {
    return {
      check: { name: 'timeline_coverage', status: 'ok', message: 'No entity pages — coverage check vacuous' },
      remediations: [],
    };
  }

  const useSample = engine.kind === 'postgres' && totalEntities > 50_000;
  const samplePct = useSample
    ? Math.max(2.0, Math.min(100.0, (5000.0 / totalEntities) * 100))
    : 100;
  const sampleClause = useSample ? `TABLESAMPLE BERNOULLI (${samplePct.toFixed(2)})` : '';

  const sample = await sampleVisibleEntityCoverage(
    engine,
    sampleClause,
    { table: 'timeline_entries', pageIdColumn: 'page_id' },
  );
  const { coverage, ci } = coverageWithConfidence(sample);
  const pct = Math.round(coverage * 100);
  const ciPct = (ci * 100).toFixed(1);
  const sampleNote = useSample ? ` (sampled ${samplePct.toFixed(1)}%)` : '';

  const remediations: RemediationStep[] = [];
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  let message: string;

  // v0.41.18.0: warn-only, never fail. Same posture as entity_link_coverage —
  // the recommendation still surfaces in onboard's plan, but doctor exit
  // code doesn't flip on a fresh brain.
  if (coverage >= 0.9) {
    message = `Coverage ${pct}% ± ${ciPct}%${sampleNote}`;
  } else {
    status = 'warn';
    message = `Coverage ${pct}% ± ${ciPct}% (target 90%)${sampleNote}`;
    // Only recommend meeting-derived timeline extraction if there are dated
    // meeting pages to extract FROM — otherwise the job creates 0 entries
    // (it skips meetings without effective_date) and the rec never clears.
    const datableMeetings = await safeCount(
      engine,
      `SELECT COUNT(*) AS count FROM pages
         WHERE type = 'meeting' AND effective_date IS NOT NULL AND deleted_at IS NULL`,
    );
    if (datableMeetings > 0) {
      remediations.push(makeRemediationStep({
        id: 'onboard.extract_timeline_from_meetings',
        job: 'extract-timeline-from-meetings',
        params: {},
        severity: coverage >= 0.7 ? 'medium' : 'high',
        est_seconds: coverage >= 0.7 ? 240 : 480,
        est_usd_cost: 0,
        rationale: `Timeline coverage at ${pct}%; meeting-derived entries lift it`,
        status: 'remediable',
      }));
    } else {
      message += ' — no auto-fix: no dated meeting pages to extract timeline entries from';
    }
  }
  return {
    check: { name: 'timeline_coverage', status, message },
    remediations,
  };
}

/**
 * takes_count: number of takes (typed claims) in the brain.
 *
 * Per A12 two-gate consent: the remediation only emits when
 * `takes.bootstrap_enabled` config is true. Otherwise the check shows
 * a status + hint, but no autopilot-eligible remediation.
 */
export async function checkTakesCount(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  const takesCount = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM takes`,
  );

  let bootstrapEnabled = false;
  try {
    const cfg = await engine.getConfig('takes.bootstrap_enabled');
    bootstrapEnabled = cfg === 'true' || cfg === '1';
  } catch {
    bootstrapEnabled = false;
  }

  const remediations: RemediationStep[] = [];
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  let message: string;

  if (takesCount >= 100) {
    message = `${takesCount} takes (calibration ready)`;
  } else if (takesCount === 0) {
    status = 'warn';
    if (bootstrapEnabled) {
      message = `0 takes (bootstrap eligible — gbrain takes extract --from-pages)`;
      remediations.push(makeRemediationStep({
        id: 'onboard.takes_bootstrap',
        job: 'extract-takes-from-pages',
        protected: true,
        params: {},
        severity: 'medium',
        est_seconds: 1800,
        est_usd_cost: 5.00,
        rationale: '0 takes; LLM-bearing extraction over concept/atom/lore pages',
        status: 'remediable',
      }));
    } else {
      message = '0 takes (takes.bootstrap_enabled is false; opt in to enable)';
    }
  } else {
    message = `${takesCount} takes (calibration usable; >100 ideal)`;
  }
  return {
    check: { name: 'takes_count', status, message },
    remediations,
  };
}

/**
 * Run all four checks in parallel; aggregate into a single payload.
 * Consumed by onboard's plan generation + (later) doctor's runDoctor.
 *
 * Per A20: callers can race this against an AbortSignal-bound timer for
 * partial-results fallthrough. Each individual safeCount() returns 0
 * on throw so a single check failure doesn't break the aggregate.
 */
export async function runAllOnboardChecks(
  engine: BrainEngine,
): Promise<OnboardCheckResult[]> {
  return Promise.all([
    checkEmbedStaleness(engine),
    checkEntityLinkCoverage(engine),
    checkTimelineCoverage(engine),
    checkTakesCount(engine),
    // v0.42 type-unification (T13-T15): 3 new checks added to onboard.
    checkPackUpgradeAvailable(engine),
    checkTypeProliferation(engine),
    checkDanglingAliases(engine),
  ]);
}

// ===========================================================================
// v0.42 Type Unification (T13-T15) — 3 onboard checks
// ===========================================================================

/**
 * pack_upgrade_available: fires when the active schema pack has a successor
 * pack declared via `migration_from`. v0.42 ships gbrain-base-v2 as the
 * declared successor of gbrain-base@1.x. Emits a manual_only RemediationStep
 * (D17) targeting the unify-types Minion handler.
 */
export async function checkPackUpgradeAvailable(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  try {
    const { loadActivePack, findPackSuccessors } = await import('../schema-pack/load-active.ts');
    const { loadConfigFileOnly } = await import('../config.ts');
    // Read the engine's DB-side schema_pack so a post-unify flip is visible
    // here even before the file-plane config catches up. File-only config
    // preserves tier-6 schema_pack without merging transient env/database state.
    let dbConfig: string | undefined;
    try {
      dbConfig = (await engine.getConfig('schema_pack')) ?? undefined;
    } catch { /* engine.config may not exist on very old brains */ }
    const active = await loadActivePack({ cfg: loadConfigFileOnly(), remote: false, dbConfig })
      .catch(() => null);
    if (!active) {
      return {
        check: { name: 'pack_upgrade_available', status: 'ok', message: 'No active pack' },
        remediations: [],
      };
    }
    const successors = await findPackSuccessors(active.manifest.name, active.manifest.version);
    if (successors.length === 0) {
      return {
        check: {
          name: 'pack_upgrade_available',
          status: 'ok',
          message: `Active pack ${active.identity} is current (no successor declared)`,
        },
        remediations: [],
      };
    }
    const successor = successors[0];
    return {
      check: {
        name: 'pack_upgrade_available',
        status: 'warn',
        message:
          `Active pack: ${active.identity}. Successor available: ${successor.identity}. ` +
          `Preview: \`gbrain onboard --check --explain\``,
      },
      remediations: [
        makeRemediationStep({
          id: 'onboard.pack_upgrade_' + successor.manifest.name,
          job: 'unify-types',
          // #1575: the worker defaults `apply` to false (dry-run); a
          // remediation step is a consented apply, so carry it explicitly.
          params: { target_pack: successor.manifest.name, apply: true },
          severity: 'medium',
          est_seconds: 600,  // ~10min on 186K-page brain (production proxy)
          est_usd_cost: 0,   // pure SQL; no LLM spend
          protected: true,   // PROTECTED handler + manual_only via render allowlist
          rationale:
            `Pack upgrade ${active.manifest.name} → ${successor.manifest.name}; ` +
            `collapses redundant page types into the new canonical taxonomy. ` +
            `Reversible via 72h soft-delete TTL on alias/link pages + ` +
            `frontmatter.legacy_type preservation on retyped pages.`,
          status: 'remediable',
        }),
      ],
    };
  } catch (e) {
    return {
      check: {
        name: 'pack_upgrade_available',
        status: 'ok',
        message: `Check skipped: ${(e as Error).message}`,
      },
      remediations: [],
    };
  }
}

/**
 * type_proliferation (D16): pack-aware ratio. Warns when distinct typed
 * pages exceed pack-declared types + 5; fails at declared × 2. No false
 * positives on custom packs (compares to actual pack declaration count,
 * not a hardcoded threshold).
 */
export async function checkTypeProliferation(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  let declared = 15;  // fallback to gbrain-base-v2 default if pack unavailable
  try {
    const { loadActivePack } = await import('../schema-pack/load-active.ts');
    const { loadConfigFileOnly } = await import('../config.ts');
    let dbConfig: string | undefined;
    try {
      dbConfig = (await engine.getConfig('schema_pack')) ?? undefined;
    } catch { /* tolerate pre-config brains */ }
    const active = await loadActivePack({ cfg: loadConfigFileOnly(), remote: false, dbConfig })
      .catch(() => null);
    if (active) declared = active.manifest.page_types.length;
  } catch {
    // Use fallback.
  }
  const n = await safeCount(
    engine,
    `SELECT COUNT(DISTINCT type) AS count FROM pages WHERE deleted_at IS NULL AND type IS NOT NULL`,
  );
  const warn = declared + 5;
  const fail = declared * 2;
  if (n > fail) {
    return {
      check: {
        name: 'type_proliferation',
        status: 'fail',
        message:
          `${n} distinct page types (pack declares ${declared}). ` +
          `Run \`gbrain onboard --check --explain\` to preview a pack upgrade ` +
          `or define a custom pack with mapping_rules.`,
      },
      remediations: [],  // pack_upgrade_available check emits the actionable step
    };
  }
  if (n > warn) {
    return {
      check: {
        name: 'type_proliferation',
        status: 'warn',
        message: `${n} distinct page types vs ${declared} declared in pack — consider unification.`,
      },
      remediations: [],
    };
  }
  return {
    check: {
      name: 'type_proliferation',
      status: 'ok',
      message: `${n} distinct typed values (pack declares ${declared})`,
    },
    remediations: [],
  };
}

/**
 * dangling_aliases (F12): surfaces both slug_aliases redirects and
 * page_aliases free-text names whose target page no longer exists.
 * Source-scoped JOINs prevent cross-source false-positive deletion.
 *
 * v0.42 ships surface-only (no auto-GC RemediationStep). v0.43+ may add
 * `cleanup-dangling-aliases` as an auto_apply handler once detection is
 * confirmed clean in production.
 *
 * Defensive: pre-v105 brains don't have slug_aliases yet — returns ok
 * via the `isUndefinedTableError` fallthrough inherent in safeCount's
 * catch-all (returns 0 on any SQL error).
 */
export async function checkDanglingAliases(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  const slugAliases = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM slug_aliases sa
     LEFT JOIN pages p
       ON p.slug = sa.canonical_slug
      AND p.source_id = sa.source_id
      AND p.deleted_at IS NULL
     WHERE p.id IS NULL`,
  );
  const pageAliases = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM page_aliases pa
     LEFT JOIN pages p
       ON p.slug = pa.slug
      AND p.source_id = pa.source_id
      AND p.deleted_at IS NULL
     WHERE p.id IS NULL`,
  );
  const n = slugAliases + pageAliases;
  if (n > 0) {
    return {
      check: {
        name: 'dangling_aliases',
        status: 'warn',
        message:
          `${n} alias rows point at missing/deleted pages ` +
          `(${slugAliases} slug redirects; ${pageAliases} free-text page aliases). ` +
          `Safe GC (source-scoped): ` +
          `\`DELETE FROM slug_aliases sa WHERE NOT EXISTS (SELECT 1 FROM pages p ` +
          `WHERE p.slug = sa.canonical_slug AND p.source_id = sa.source_id ` +
          `AND p.deleted_at IS NULL); DELETE FROM page_aliases pa WHERE NOT EXISTS ` +
          `(SELECT 1 FROM pages p WHERE p.slug = pa.slug ` +
          `AND p.source_id = pa.source_id AND p.deleted_at IS NULL);\``,
      },
      remediations: [],  // v0.42: surface-only; auto-GC v0.43+
    };
  }
  return {
    check: { name: 'dangling_aliases', status: 'ok', message: 'No dangling aliases' },
    remediations: [],
  };
}
