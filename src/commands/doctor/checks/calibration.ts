/**
 * Calibration + retrieval check cluster — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { startHeartbeat, type ProgressReporter } from '../../../core/progress.ts';
import { resolveOwnerHolder } from '../../../core/owner-holder.ts';
import {
  extractEntityRefs,
  isGlobalBasenameEnabled,
  buildBasenameIndex,
  queryBasenameIndex,
} from '../../../core/link-extraction.ts';
// issue #1777: hidden_by_search_policy — count chunked pages withheld from
// default search by the hard-exclude prefix policy. Reuses the canonical
// exclude resolver + LIKE escaper + visibility clause so the doctor count can't
// drift from what search actually filters.
import { resolveHardExcludes, DEFAULT_HARD_EXCLUDES } from '../../../core/search/source-boost.ts';
import { escapeLikePattern, buildVisibilityClause } from '../../../core/search/sql-ranking.ts';
import type { Check } from '../../doctor.ts';

// --- v0.36.1.0 calibration doctor checks (T12) ---

/**
 * abandoned_threads: surfaces active high-conviction takes (weight >= 0.7)
 * older than 12 months that have neither been superseded nor linked to a
 * follow-up page. These are commitments the user made and never revisited.
 * Status 'ok' with a count; never warns/fails (this is signal, not error).
 */
/**
 * v0.40.3.0 contextual_retrieval_coverage check.
 *
 * Surfaces drift between the active CR mode + the per-page
 * `contextual_retrieval_mode` column. Three signals:
 *
 *   1. Pages with chunker_version < current — pre-v40 pages that need
 *      to be re-embedded for the wrapper to apply. Paste-ready fix:
 *      `gbrain reindex --markdown`.
 *   2. Pages with contextual_retrieval_mode IS NULL — never evaluated
 *      against the CR ladder. Same fix as (1).
 *   3. Synopsis-failure events in the audit JSONL over the last 7 days
 *      — surfaces refusals + page-level fallbacks. >5% refusal rate
 *      warns; otherwise reported as informational.
 *
 * Reads `~/.gbrain/audit/synopsis-failures-YYYY-Www.jsonl` via
 * readRecentSynopsisFailures + summarizeSynopsisFailures from
 * `src/core/audit-synopsis.ts`. Failure-only audit means low write
 * volume on healthy brains.
 */
export async function checkContextualRetrievalCoverage(engine: BrainEngine): Promise<Check> {
  try {
    const { MARKDOWN_CHUNKER_VERSION } = await import('../../../core/chunkers/recursive.ts');
    const rows = await engine.executeRaw<{ chunker_drift: number; mode_null: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE chunker_version < $1)::int AS chunker_drift,
         -- #4009 belt+braces: extract receipts are audit artifacts stamped
         -- mode 'none' at write time, but a reindex DB fallback can clear
         -- the stamp — never count them as "never evaluated".
         COUNT(*) FILTER (WHERE contextual_retrieval_mode IS NULL AND type <> 'extract_receipt')::int AS mode_null
       FROM pages
       WHERE page_kind = 'markdown'
         AND deleted_at IS NULL`,
      [MARKDOWN_CHUNKER_VERSION],
    );
    const chunkerDrift = rows[0]?.chunker_drift ?? 0;
    const modeNull = rows[0]?.mode_null ?? 0;

    // Synopsis-failures audit summary (best-effort; missing audit file = 0).
    let failureSummaryLine = '';
    try {
      const audit = await import('../../../core/audit-synopsis.ts');
      const events = audit.readRecentSynopsisFailures(7);
      const summary = audit.summarizeSynopsisFailures(events);
      if (summary && summary.total > 0) {
        const rate = (summary.page_level_fallback_rate * 100).toFixed(1);
        failureSummaryLine =
          ` ${summary.total} synopsis failure(s) in last 7d ` +
          `(${summary.page_level_fallback_count} triggered page-level fall-back, ${rate}%).`;
      }
    } catch {
      // Audit module unavailable — skip the summary line.
    }

    if (chunkerDrift === 0 && modeNull === 0 && failureSummaryLine === '') {
      return {
        name: 'contextual_retrieval_coverage',
        status: 'ok',
        message: 'All markdown pages aligned to current chunker + CR mode.',
      };
    }

    const parts: string[] = [];
    if (chunkerDrift > 0) {
      parts.push(`${chunkerDrift} page(s) at older chunker_version`);
    }
    if (modeNull > 0) {
      parts.push(`${modeNull} page(s) never evaluated against CR ladder`);
    }
    const fixHint =
      chunkerDrift > 0 || modeNull > 0
        ? ` Run \`gbrain reindex --markdown\` to align.`
        : '';
    return {
      name: 'contextual_retrieval_coverage',
      status: chunkerDrift > 0 || modeNull > 0 ? 'warn' : 'ok',
      message: `${parts.join('; ')}.${fixHint}${failureSummaryLine}`,
    };
  } catch (e) {
    return {
      name: 'contextual_retrieval_coverage',
      status: 'warn',
      message: `Could not check contextual retrieval coverage: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * issue #1777 — hidden_by_search_policy
 *
 * Counts CHUNKED pages that are withheld from default search by the
 * hard-exclude prefix policy (`test/`, `attachments/`, `.raw/`, plus any
 * `GBRAIN_SEARCH_EXCLUDE` env additions). Makes the surviving exclude policy
 * auditable so an empty search result is distinguishable from "withheld by
 * policy" — the deeper bug the archive-demote fix only half-closes.
 *
 * HONEST SUPERSET: the count is "chunked pages under an excluded prefix", NOT
 * "searchable pages". Keyword search additionally filters
 * `search_vector @@ ... AND modality='text'` and vector search filters text
 * modality + non-null embedding, so `EXISTS (content_chunks)` over-includes
 * image-only / non-text pages. Tightening to the exact per-modality predicate
 * would couple this check to search internals for a number nobody paginates on;
 * the superset is the right operator signal. The message says "chunked page(s)".
 *
 * Status (CV-1a): pages hidden ONLY under DEFAULT excludes → `ok` (intentional
 * noise; warning would make every healthy brain look unhealthy). Pages hidden
 * under a NON-default (env-supplied) prefix → `warn`. The message is
 * agent-prescriptive: move content out of the excluded prefix or pass
 * `include_slug_prefixes` on the query.
 *
 * NOTE: this does NOT verify `archive/` pages are embedded/graphed — after the
 * #1777 fix `archive/` is no longer excluded, so it never appears here.
 */
export async function checkHiddenBySearchPolicy(engine: BrainEngine): Promise<Check> {
  const name = 'hidden_by_search_policy';
  try {
    const prefixes = resolveHardExcludes();
    if (prefixes.length === 0) {
      return { name, status: 'ok', message: 'No search-exclude prefixes active.' };
    }

    // ONE query: COUNT(DISTINCT p.id) per prefix in a single pass. Prefixes are
    // bound params, LIKE-escaped (env-supplied prefixes may contain %/_/\) with
    // an explicit ESCAPE clause. Candidate gate is EXISTS(content_chunks);
    // buildVisibilityClause mirrors search's page-level visibility (soft-delete,
    // archived source, quarantine) and REQUIRES the `sources s` join.
    const visibility = buildVisibilityClause('p', 's');
    const filters = prefixes
      .map((_, i) => `COUNT(DISTINCT p.id) FILTER (WHERE p.slug LIKE $${i + 1} ESCAPE '\\')::int AS c${i}`)
      .join(',\n         ');
    const params = prefixes.map((pfx) => `${escapeLikePattern(pfx)}%`);
    const sql =
      `SELECT
         ${filters}
       FROM pages p
       JOIN sources s ON s.id = p.source_id
       WHERE EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id)
         ${visibility}`;
    const rows = await engine.executeRaw<Record<string, number>>(sql, params);
    const row = rows[0] ?? {};

    const defaults = new Set(DEFAULT_HARD_EXCLUDES);
    const perPrefix = prefixes
      .map((pfx, i) => ({ prefix: pfx, count: Number(row[`c${i}`] ?? 0), isDefault: defaults.has(pfx) }))
      .filter((e) => e.count > 0);

    if (perPrefix.length === 0) {
      return {
        name,
        status: 'ok',
        message: 'No pages hidden by search-exclude policy.',
        details: { prefixes, counts: {} },
      };
    }

    const counts: Record<string, number> = {};
    for (const e of perPrefix) counts[e.prefix] = e.count;
    const breakdown = perPrefix.map((e) => `${e.count} under '${e.prefix}'`).join(', ');
    const hasNonDefault = perPrefix.some((e) => !e.isDefault);
    const guidance =
      'If any hold content you want findable, move them out of the excluded ' +
      "prefix or pass `include_slug_prefixes` on the query.";
    return {
      name,
      status: hasNonDefault ? 'warn' : 'ok',
      message: `${breakdown} chunked page(s) are excluded from default search by prefix policy. ${guidance}`,
      details: { prefixes, counts },
    };
  } catch (e) {
    return {
      name,
      status: 'warn',
      message: `Could not check hidden-by-search-policy: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Issue #972 — link_resolution_opportunity check.
 *
 * Walks every page in the brain, scans for bare wikilinks
 * (`[[struktura]]` outside DIR_PATTERN) that would resolve to at least
 * one page under global-basename mode, and surfaces a paste-ready
 * `gbrain config set link_resolution.global_basename true` hint when
 * the count is meaningful (>=5 would-resolve AND >=20% of bare
 * wikilinks have matches). Skipped silently when the flag is already
 * enabled (no signal to surface) or the brain is empty.
 *
 * Bounded scan: batch-loads the 1000 most-recent pages in one query (not a
 * per-page getPage walk) with a 60s backstop. On DB error, downgrades to an
 * informational `ok` so doctor never blocks on this check.
 */
export async function checkLinkResolutionOpportunity(
  engine: BrainEngine,
  progress?: ProgressReporter,
): Promise<Check> {
  const name = 'link_resolution_opportunity';
  try {
    if (await isGlobalBasenameEnabled(engine)) {
      return { name, status: 'ok', message: 'global_basename mode already enabled' };
    }
    const allSlugs = await engine.getAllSlugs();
    if (allSlugs.size === 0) {
      return { name, status: 'ok', message: 'Brain is empty — nothing to scan' };
    }
    // Build a basename → slug[] index ONCE for the entire scan via the shared
    // builder (issue #972 codex [P2] DRY) — same key set (raw/lower/slugified)
    // as extraction, so this estimate matches what extraction actually
    // resolves. Pre-fix the doctor omitted the slugified key and undercounted.
    const basenameIndex = buildBasenameIndex(allSlugs);

    let bareCount = 0;
    let wouldResolveCount = 0;
    const distinctTargets = new Set<string>();

    // Issue #972 (codex [P2] perf): batch-load the most-recent N pages in ONE
    // query instead of listAllPageRefs() + a getPage() per page. The prior
    // full N-page walk hit the 60s budget every run on large brains and
    // returned a perpetual partial; this bounds the work to a fixed sample.
    const SAMPLE_LIMIT = 1000;
    const sampled = await engine.executeRaw<{ compiled_truth: string | null; timeline: string | null }>(
      `SELECT compiled_truth, timeline FROM pages WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ${SAMPLE_LIMIT}`,
    );
    const totalPages = allSlugs.size;
    const sampledNote = totalPages > SAMPLE_LIMIT
      ? ` (scanned the ${SAMPLE_LIMIT} most-recent of ${totalPages} pages)`
      : '';
    const deadline = Date.now() + 60_000;
    const hb = progress ? startHeartbeat(progress, `scanning ${sampled.length} pages for bare wikilinks…`) : null;
    try {
      for (const row of sampled) {
        if (Date.now() > deadline) break; // backstop; in-memory scan rarely hits it
        const content = (row.compiled_truth ?? '') + '\n' + (row.timeline ?? '');
        for (const e of extractEntityRefs(content)) {
          if (!e.needsResolution) continue;
          bareCount++;
          // Issue #972 (codex): match on the wikilink TARGET (e.slug), not
          // the display alias (e.name), via the shared query so the doctor
          // estimate equals what extraction actually resolves.
          const matches = queryBasenameIndex(basenameIndex, e.slug);
          if (matches.length > 0) {
            wouldResolveCount++;
            for (const m of matches) distinctTargets.add(m);
          }
        }
      }
    } finally {
      hb?.();
    }

    if (bareCount === 0) {
      return { name, status: 'ok', message: 'No bare wikilinks found' };
    }
    if (wouldResolveCount === 0) {
      return {
        name,
        status: 'ok',
        message: `${bareCount} bare wikilink(s) found, but none have basename matches in the brain.`,
      };
    }
    const ratio = wouldResolveCount / bareCount;
    if (wouldResolveCount >= 5 && ratio >= 0.20) {
      const pct = Math.round(ratio * 100);
      return {
        name,
        status: 'warn',
        message:
          `${wouldResolveCount} of ${bareCount} bare wikilinks (${pct}%) would resolve to ` +
          `${distinctTargets.size} distinct page(s) under global_basename mode${sampledNote}. ` +
          `Enable with: gbrain config set link_resolution.global_basename true`,
      };
    }
    const pct = Math.round(ratio * 100);
    return {
      name,
      status: 'ok',
      message: `${wouldResolveCount}/${bareCount} bare wikilinks (${pct}%) would resolve — below the 20% / 5-link threshold for surfacing a hint${sampledNote}.`,
    };
  } catch (e) {
    return {
      name,
      status: 'ok',
      message: `Skipped (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

export async function checkAbandonedThreads(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ count: number }>(
      // since_date is TEXT and may be month-precision ('YYYY-MM'); 'YYYY-MM'::date
      // throws "invalid input syntax for type date", so normalize to the 1st
      // before casting — same guarded cast as the detail query in serve-http.ts
      // (`gbrain calibration` abandoned-threads), which must stay in lockstep so
      // the doctor count matches the listing it points users at.
      `SELECT COUNT(*)::int AS count FROM takes
         WHERE active = true
           AND resolved_at IS NULL
           AND superseded_by IS NULL
           AND weight >= 0.7
           AND since_date IS NOT NULL
           AND (since_date || CASE WHEN length(since_date) = 7 THEN '-01' ELSE '' END)::date
               < (now() - INTERVAL '12 months')`,
    );
    const count = rows[0]?.count ?? 0;
    if (count === 0) {
      return {
        name: 'abandoned_threads',
        status: 'ok',
        message: 'No abandoned high-conviction threads',
      };
    }
    return {
      name: 'abandoned_threads',
      status: 'ok',
      message: `${count} high-conviction take(s) older than 12 months and never revisited — see \`gbrain calibration\` for details`,
    };
  } catch (e) {
    return {
      name: 'abandoned_threads',
      status: 'warn',
      message: `Could not check abandoned threads: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * calibration_freshness: warns when the active calibration profile is
 * older than 7 days (configurable). Default holder resolves via resolveOwnerHolder
 * (config emotional_weight.user_holder, else 'self'). Multi-source
 * brains see one row per source; this check uses the most recent across
 * all sources.
 */
export async function checkCalibrationFreshness(engine: BrainEngine): Promise<Check> {
  try {
    const ownerHolder = resolveOwnerHolder({
      configValue: await engine.getConfig('emotional_weight.user_holder'),
    });
    const rows = await engine.executeRaw<{ generated_at: Date | null }>(
      `SELECT MAX(generated_at) AS generated_at FROM calibration_profiles WHERE holder = $1`,
      [ownerHolder],
    );
    const generated = rows[0]?.generated_at;
    if (!generated) {
      return {
        name: 'calibration_freshness',
        status: 'ok',
        message: 'No calibration profile yet (builds after 5+ resolved takes)',
      };
    }
    const ageMs = Date.now() - new Date(generated).getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const staleDays = 7;
    if (ageDays > staleDays) {
      return {
        name: 'calibration_freshness',
        status: 'warn',
        message: `Calibration profile is ${ageDays} days old (stale at >${staleDays}d). Run \`gbrain calibration --regenerate\``,
      };
    }
    return {
      name: 'calibration_freshness',
      status: 'ok',
      message: `Calibration profile generated ${ageDays}d ago`,
    };
  } catch (e) {
    return {
      name: 'calibration_freshness',
      status: 'warn',
      message: `Could not check calibration freshness: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * grade_confidence_drift (CDX-11 mitigation): compare the judge's
 * self-reported confidence on auto-applied verdicts against the eventual
 * accuracy on those same takes. When auto-resolutions diverge from
 * confidence prediction, the judge is mis-calibrated and the operator
 * should retune the prompt or revisit the threshold.
 *
 * v0.36.1.0 ship state: returns 'ok' with a counter — actual drift math
 * requires a measurement window we haven't accumulated yet. The check
 * exists so the surface is wired; the math arrives once we have N >= 30
 * auto-applied verdicts to compare.
 */
export async function checkGradeConfidenceDrift(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ applied_count: number }>(
      `SELECT COUNT(*)::int AS applied_count FROM take_grade_cache WHERE applied = true`,
    );
    const applied = rows[0]?.applied_count ?? 0;
    if (applied < 30) {
      return {
        name: 'grade_confidence_drift',
        status: 'ok',
        message: `Only ${applied} auto-applied verdicts — need 30+ for drift detection`,
      };
    }
    // v0.37+ TODO: compute confidence-vs-accuracy correlation; warn when
    // mean(applied verdicts' confidence) deviates from the actual accuracy
    // rate (cross-checked against later manual corrections via the
    // contradictions probe). For v0.36.1.0 the check surfaces only the
    // count and a "calibration math pending" status.
    return {
      name: 'grade_confidence_drift',
      status: 'ok',
      message: `${applied} auto-applied verdicts; drift math arrives in v0.37+`,
    };
  } catch (e) {
    return {
      name: 'grade_confidence_drift',
      status: 'warn',
      message: `Could not check grade confidence drift: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * voice_gate_health: warns when calibration_profiles rows show a high rate
 * of voice gate failures over the last 7 days. Failures aren't bad in
 * isolation (template fallback is fine), but a sustained high rate signals
 * the rubric needs tuning.
 */
/**
 * v0.41 Bug 2 / Eng D8 — surfaces rate-lease pressure from
 * `minion_lease_pressure_log` (populated by the worker's lease-full bypass
 * path). The operator's primary forensic signal for "is the lease cap too
 * tight" — without this check, the v0.41 bypass would be invisible (no
 * dead-letter, but also no operator awareness).
 *
 * Thresholds (windowed at 24h):
 *   0 bounces                                            → ok ("no pressure")
 *   1-99 bounces                                         → ok ("transient")
 *   100+ bounces + subagent jobs completed in same window → ok ("healthy backpressure")
 *   100+ bounces + ZERO completed subagent jobs           → warn (paste-ready cap-raise hint)
 *   1000+ bounces                                        → fail ("blocking real work")
 *
 * Works on both Postgres + PGLite (migration v94 creates the table on both).
 * Pre-v93 brains (no table) silently skip with an OK message.
 */
export async function checkSubagentHealth(engine: BrainEngine): Promise<Check> {
  try {
    const bounceRows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_lease_pressure_log
        WHERE bounced_at > now() - interval '24 hours'`,
    );
    const bounces = parseInt(bounceRows[0]?.count ?? '0', 10);
    if (bounces === 0) {
      return {
        name: 'subagent_health',
        status: 'ok',
        message: 'No rate-lease pressure in last 24h',
      };
    }
    if (bounces >= 1000) {
      return {
        name: 'subagent_health',
        status: 'fail',
        message: `${bounces} lease-pressure bounces in last 24h — this is blocking real work. Raise the cap: \`export GBRAIN_ANTHROPIC_MAX_INFLIGHT=64\` (or \`unlimited\` for Azure / Bedrock / self-hosted upstreams with no provider-side rate limit). After raising, restart \`gbrain jobs work\`.`,
      };
    }
    // 1-999 bounces: cross-check forward progress.
    const completedRows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs
        WHERE finished_at > now() - interval '24 hours'
          AND status = 'completed'
          AND name = 'subagent'`,
    ).catch(() => [{ count: '0' }]);
    const completed = parseInt(completedRows[0]?.count ?? '0', 10);
    if (bounces >= 100 && completed === 0) {
      return {
        name: 'subagent_health',
        status: 'warn',
        message: `${bounces} lease-pressure bounces in last 24h with no completed subagent jobs — cap is too tight. Raise via \`export GBRAIN_ANTHROPIC_MAX_INFLIGHT=64\` (or \`unlimited\` for upstreams with no provider-side cap).`,
      };
    }
    return {
      name: 'subagent_health',
      status: 'ok',
      message: `Lease pressure: ${bounces} bounces in last 24h, ${completed} subagent jobs completed — backpressure is binding but throughput is healthy`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env.GBRAIN_DEBUG === '1') {
      process.stderr.write(`[doctor] subagent_health skipped: ${msg}\n`);
    }
    return {
      name: 'subagent_health',
      status: 'ok',
      message: 'Skipped (minion_lease_pressure_log unavailable — pre-v0.41 brain)',
    };
  }
}

export async function checkVoiceGateHealth(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ total: number; failures: number }>(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(CASE WHEN voice_gate_passed = false THEN 1 ELSE 0 END), 0)::int AS failures
         FROM calibration_profiles
         WHERE generated_at >= (now() - INTERVAL '7 days')`,
    );
    const total = rows[0]?.total ?? 0;
    const failures = rows[0]?.failures ?? 0;
    if (total === 0) {
      return {
        name: 'voice_gate_health',
        status: 'ok',
        message: 'No calibration profile generation in the last 7 days',
      };
    }
    const failRate = failures / total;
    if (failRate >= 0.3) {
      return {
        name: 'voice_gate_health',
        status: 'warn',
        message: `Voice gate failed ${failures}/${total} (${Math.round(failRate * 100)}%) in last 7 days. Review src/core/calibration/voice-gate.ts rubric.`,
      };
    }
    return {
      name: 'voice_gate_health',
      status: 'ok',
      message: `Voice gate ${failures}/${total} failed in last 7 days (${Math.round(failRate * 100)}%)`,
    };
  } catch (e) {
    return {
      name: 'voice_gate_health',
      status: 'warn',
      message: `Could not check voice gate health: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * v0.35.0.0+ reranker_health doctor check.
 *
 * Logic (post-CDX2 review):
 *   1) Read `search.reranker.enabled` first. When disabled and no
 *      failures in window → 'ok: reranker disabled'. Avoids interpreting
 *      "no events" as "broken" when reranker is simply not in use.
 *   2) Walk last 7 days of `~/.gbrain/audit/rerank-failures-*.jsonl`.
 *   3) Auth failures: ANY single one warns (config-time problem doctor's
 *      own probe should have caught — surface it).
 *   4) Transient (network/timeout/rate_limit): warn at >=5 in window.
 *      Below that they're noise; reranker fails open anyway.
 *   5) Payload-too-large failures: warn at >=1 (indicates a workload
 *      mismatch that the operator should know about).
 *   6) Budget/pricing failures: warn at >=1 with the rerank pricing surface
 *      and --max-cost escape hatch.
 *
 * Engine-agnostic (file-based + one config-key read).
 */
export async function checkRerankerHealth(engine: BrainEngine): Promise<Check> {
  try {
    const { readRecentRerankFailures } = await import('../../../core/rerank-audit.ts');
    const cfg = await engine.getConfig('search.reranker.enabled');
    const rerankerEnabled = cfg === 'true' || cfg === '1';

    const failures = readRecentRerankFailures(7);
    if (failures.length === 0) {
      return {
        name: 'reranker_health',
        status: 'ok',
        message: rerankerEnabled
          ? 'No rerank failures in last 7 days'
          : 'Reranker disabled — no failures expected',
      };
    }

    const authFails = failures.filter((f) => f.reason === 'auth');
    if (authFails.length > 0) {
      return {
        name: 'reranker_health',
        status: 'warn',
        message: `${authFails.length} reranker auth failure(s) in last 7 days. Fix: verify the reranker provider's API key (e.g. VOYAGE_API_KEY) and run \`gbrain models doctor\`.`,
      };
    }

    const payloadFails = failures.filter((f) => f.reason === 'payload_too_large');
    if (payloadFails.length > 0) {
      return {
        name: 'reranker_health',
        status: 'warn',
        message: `${payloadFails.length} reranker payload-too-large failure(s) in last 7 days. Fix: lower \`search.reranker.top_n_in\` (default 30) or split very large documents.`,
      };
    }

    const budgetFails = failures.filter((f) => f.reason === 'budget');
    if (budgetFails.length > 0) {
      return {
        name: 'reranker_health',
        status: 'warn',
        message: `${budgetFails.length} reranker budget/pricing failure(s) in last 7 days. Fix: add rerank pricing to src/core/embedding-pricing.ts or drop --max-cost.`,
      };
    }

    const transientFails = failures.filter(
      (f) => f.reason === 'network' || f.reason === 'timeout' || f.reason === 'rate_limit',
    );
    if (transientFails.length >= 5) {
      return {
        name: 'reranker_health',
        status: 'warn',
        message: `${transientFails.length} transient reranker failure(s) in last 7 days. Search fails open to RRF order; check ZE status if persistent.`,
      };
    }

    // #4648: success-shaped pass-throughs — the provider answered 200 with an
    // empty/malformed result set, so searches returned raw RRF order with no
    // rerank_score. The reranker "runs" (logs grow, latency paid) but has
    // zero effect; the response-shape mismatch is the usual culprit.
    const passThroughFails = failures.filter(
      (f) => f.reason === 'empty_result_set' || f.reason === 'malformed_shape',
    );
    if (passThroughFails.length >= 3) {
      return {
        name: 'reranker_health',
        status: 'warn',
        message: `${passThroughFails.length} reranker empty/malformed-response pass-through(s) in last 7 days — those searches returned raw RRF order unscored. Fix: verify the rerank endpoint answers {results:[{index, relevance_score}]} for a non-empty documents array (check \`search.reranker.model\` and the endpoint's response shape).`,
      };
    }

    // Historical #2059 rows were logged as `unknown` before missing reranker
    // auth was classified at the gateway. Surface repeated unknowns instead of
    // reporting "ok" while every rerank fails open.
    const unknownFails = failures.filter((f) => f.reason === 'unknown');
    if (unknownFails.length >= 3) {
      const setupHint = unknownFails.some((f) => {
        const summary = String(f.error_summary ?? '');
        return (
          summary.includes('ZEROENTROPY_API_KEY') ||
          summary.includes('VOYAGE_API_KEY') ||
          summary.toLowerCase().includes('api key')
        );
      })
        ? " Fix: verify the reranker provider's API key (e.g. VOYAGE_API_KEY) and run `gbrain models doctor`."
        : '';
      return {
        name: 'reranker_health',
        status: 'warn',
        message: `${unknownFails.length} unknown reranker failure(s) in last 7 days.${setupHint}`,
      };
    }

    return {
      name: 'reranker_health',
      status: 'ok',
      message: `${failures.length} reranker failure(s) in last 7 days (below threshold)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'reranker_health',
      status: 'warn',
      message: `Could not check reranker audit: ${msg}`,
    };
  }
}

