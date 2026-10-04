/**
 * Knowledge-layer health: eval capture, contradictions, facts extraction, effective dates and salience.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { parseFrontmatter } from '../../../core/backfill-effective-date.ts';
import { computeEffectiveDate } from '../../../core/effective-date.ts';
import { zeroTotalContradictionsCheck } from '../../../core/eval-contradictions/run-health.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError, doctorVerify } from '../check-fix.ts';

async function runEvalCapture(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 11a-bis. Eval-capture health (v0.25.0). Capture is a fire-and-forget
  // side-effect that logs failures to a persistent table so this check
  // can see drops cross-process (the MCP server captures; `gbrain doctor`
  // runs in a separate process). Counts failures in the last 24h and
  // warns when non-zero. Pre-v31 brains: the table doesn't exist yet;
  // swallow the error and report skipped.
  progress.heartbeat('eval_capture');
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const failures = await engine.listEvalCaptureFailures({ since });
    if (failures.length === 0) {
      checks.push({ name: 'eval_capture', status: 'ok', message: 'No capture failures in the last 24h' });
    } else {
      const byReason = new Map<string, number>();
      for (const f of failures) {
        byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
      }
      const breakdown = [...byReason.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${n} ${r}`)
        .join(', ');
      checks.push({
        name: 'eval_capture',
        status: 'warn',
        message: `${failures.length} capture failure(s) in the last 24h (${breakdown}). ` +
          'Captured queries feed retrieval evals; if the user does not use them, capture can be turned off.',
        fix: {
          argv: ['gbrain', 'config', 'set', 'eval.capture', 'false'], consent: [], actor: 'user', requires_exclusive: false,
          why: 'Query capture only feeds retrieval evals (gbrain eval export/replay). Turning it off stops these failures; it is the user\'s preference, so ask first.',
          user_message: 'gbrain failed to record some queries for its retrieval evals. If you don\'t run gbrain evals, I can turn query capture off. Should I?',
          verify: doctorVerify('eval_capture'),
        },
      });
    }
  } catch (err) {
    // Distinguish "table doesn't exist yet" (pre-v31, ok skip) from real
    // problems like RLS denying SELECT — the latter masks the very condition
    // this check is supposed to surface (capture INSERTs almost certainly
    // also fail).
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      checks.push({ name: 'eval_capture', status: 'ok', message: 'Skipped (eval_capture_failures table unavailable — apply migrations or upgrade)' });
    } else if (code === '42501') {
      checks.push({
        name: 'eval_capture',
        status: 'warn',
        message: 'RLS denies SELECT on eval_capture_failures. Capture INSERTs are almost certainly failing too. Run as a role with BYPASSRLS or grant SELECT on this table.',
      });
    } else {
      checks.push(checkError('eval_capture', 'read eval_capture_failures', err));
    }
  }
  return checks;
}

export const evalCaptureEntry: DoctorEntry = {
  name: 'eval_capture',
  emits: ['eval_capture'],
  run: runEvalCapture,
};

async function runContradictions(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 11a-bis-3. contradictions probe summary (v0.32.6 — M1).
  //
  // Reads the most recent eval_contradictions_runs row and surfaces:
  //   - headline count + severity breakdown
  //   - paste-ready resolution commands per HIGH-severity finding
  //   - Wilson CI band so the user knows whether the headline is trustworthy
  // Skipped (status: 'ok') when the table is empty — the probe simply hasn't
  // run yet, which is normal on a fresh install.
  progress.heartbeat('contradictions');
  try {
    const recent = await engine.loadContradictionsTrend(7);
    if (recent.length === 0) {
      checks.push({
        name: 'contradictions',
        status: 'ok',
        message: 'No probe runs in the last 7 days. Run `gbrain eval suspected-contradictions --query "..." --top-k 5` to populate.',
      });
    } else {
      const latest = recent[0];
      const report = latest.report_json as Record<string, unknown> | null;
      const perQuery = (report?.per_query as Array<{
        contradictions: Array<{
          severity: 'low' | 'medium' | 'high';
          axis: string;
          a: { slug: string };
          b: { slug: string };
          resolution_command: string;
        }>;
      }> | undefined) ?? [];
      let high = 0, medium = 0, low = 0;
      const highFindings: Array<{ a: string; b: string; axis: string; cmd: string }> = [];
      for (const q of perQuery) {
        for (const c of q.contradictions) {
          if (c.severity === 'high') {
            high++;
            highFindings.push({ a: c.a.slug, b: c.b.slug, axis: c.axis, cmd: c.resolution_command });
          } else if (c.severity === 'medium') medium++;
          else low++;
        }
      }
      const total = high + medium + low;
      if (total === 0) {
        // #3889: warn (not ok) when the latest run judged zero pairs but
        // errored — "0 contradictions" from an all-error run is a lie.
        checks.push({ name: 'contradictions', ...zeroTotalContradictionsCheck(latest) });
      } else {
        const ciLow = (latest.wilson_ci_lower * 100).toFixed(0);
        const ciHigh = (latest.wilson_ci_upper * 100).toFixed(0);
        const lines = [
          `${total} suspected contradictions (high=${high} medium=${medium} low=${low}) detected by latest probe — Wilson CI 95%: ${ciLow}-${ciHigh}%.`,
        ];
        for (const f of highFindings.slice(0, 3)) {
          lines.push(`  HIGH: ${f.a} vs ${f.b}${f.axis ? ' — ' + f.axis : ''}`);
          lines.push(`    → ${f.cmd}`);
        }
        if (highFindings.length > 3) {
          lines.push(`  …and ${highFindings.length - 3} more — see \`gbrain eval suspected-contradictions review\``);
        }
        checks.push({
          name: 'contradictions',
          status: high > 0 ? 'warn' : 'ok',
          message: lines.join('\n  '),
        });
      }
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      checks.push({ name: 'contradictions', status: 'ok', message: 'Skipped (eval_contradictions_runs table unavailable — apply migrations to enable)' });
    } else {
      checks.push(checkError('contradictions', 'read contradictions trend', err));
    }
  }
  return checks;
}

export const contradictionsEntry: DoctorEntry = {
  name: 'contradictions',
  emits: ['contradictions'],
  run: runContradictions,
};

async function runFactsExtraction(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 11a-bis-2. facts_extraction_health (v0.31.2 — codex P1 #3).
  //
  // Mirrors the eval_capture check shape but reads facts:absorb rows
  // (written by writeFactsAbsorbLog from src/core/facts/absorb-log.ts).
  // Iterates over EVERY source so multi-source brains see per-source
  // failure rates instead of only 'default'. Threshold configurable via
  // `facts.absorb_warn_threshold` (default 10 over the last 24h, per
  // source, per reason). When the threshold is exceeded for any
  // (source, reason) pair, status flips to warn and the message names
  // the breakdown.
  progress.heartbeat('facts_extraction_health');
  try {
    const thresholdRaw = await engine.getConfig('facts.absorb_warn_threshold');
    const parsed = parseInt(thresholdRaw ?? '', 10);
    const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;

    // Single SQL grouping by (source_id, reason) over the last 24h. The
    // composite index v50 added (idx_ingest_log_source_type_created on
    // source_id, source_type, created_at DESC) covers this query's
    // filter + sort path.
    const rows = await engine.executeRaw<{
      source_id: string;
      reason: string;
      n: string | number;
    }>(
      `SELECT
         source_id,
         split_part(summary, ':', 1) AS reason,
         COUNT(*)::text AS n
       FROM ingest_log
       WHERE source_type = 'facts:absorb'
         AND created_at >= now() - INTERVAL '24 hours'
       GROUP BY source_id, split_part(summary, ':', 1)
       ORDER BY source_id, COUNT(*) DESC`,
    );

    if (rows.length === 0) {
      // Zero failure rows is only "healthy" when extraction is actually
      // configured. Keyless installs deliberately write NO absorb rows (the
      // calm expected state) — reporting "ok: no failures" there would read
      // as extraction-healthy while extraction never runs. Doctor HOLDS the
      // engine, so probe the ACTUAL resolved extraction model (sees DB-plane
      // facts.extraction_model / models.* overrides the engine-blind
      // detectCapabilities() cannot) — the same gate the runtime uses.
      const { getFactsExtractionModel } = await import('../../../core/facts/extract.ts');
      const { isAvailable } = await import('../../../core/ai/gateway.ts');
      const extractionAvailable = isAvailable('chat', await getFactsExtractionModel(engine));
      if (!extractionAvailable) {
        // Keyless vs keyed-but-misrouted split (same classification the
        // backstop uses): a quiet keyed brain whose pinned extraction model
        // lost its key must NOT read as calm "(keyless)" — that masks a
        // fixable misconfiguration.
        const { KEYLESS_EXTRACTION_GUIDANCE, classifyUnavailable } = await import('../../../core/facts/backstop.ts');
        const { getFactsExtractionModel } = await import('../../../core/facts/extract.ts');
        const unavailableModel = await getFactsExtractionModel(engine);
        if ((await classifyUnavailable(unavailableModel)) === 'keyed') {
          checks.push({
            name: 'facts_extraction_health',
            status: 'warn',
            message:
              `Automatic fact extraction is misconfigured: resolved model ${unavailableModel} has no usable ` +
              `provider key. Fix: set the provider's API key, or \`gbrain config set facts.extraction_model <provider:model>\`.`,
          });
        } else {
          checks.push({
            name: 'facts_extraction_health',
            status: 'ok',
            message: `Automatic fact extraction not configured (keyless) — ${KEYLESS_EXTRACTION_GUIDANCE}`,
          });
        }
      } else {
        checks.push({
          name: 'facts_extraction_health',
          status: 'ok',
          message: 'No facts:absorb failures in the last 24h.',
        });
      }
    } else {
      // Group per source so the breakdown is operator-friendly.
      const bySource = new Map<string, Array<{ reason: string; n: number }>>();
      let anyOverThreshold = false;
      for (const r of rows) {
        const n = typeof r.n === 'number' ? r.n : parseInt(r.n, 10);
        if (!Number.isFinite(n)) continue;
        if (n >= threshold) anyOverThreshold = true;
        if (!bySource.has(r.source_id)) bySource.set(r.source_id, []);
        bySource.get(r.source_id)!.push({ reason: r.reason, n });
      }
      const summary = [...bySource.entries()]
        .map(([sid, reasons]) =>
          `${sid}: ${reasons.map(x => `${x.n} ${x.reason}`).join(', ')}`,
        )
        .join(' | ');
      checks.push({
        name: 'facts_extraction_health',
        status: anyOverThreshold ? 'warn' : 'ok',
        message: anyOverThreshold
          ? `Facts:absorb failures over the threshold (${threshold}) in the last 24h: ${summary}. ` +
            `Run \`gbrain recall --since 24h --json\` to inspect what landed; ` +
            `tune the gate via \`gbrain config set facts.absorb_warn_threshold N\`.`
          : `Facts:absorb activity in last 24h (under threshold ${threshold}): ${summary}.`,
      });
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01' || code === '42703') {
      // ingest_log missing entirely (extreme legacy) or source_id column
      // missing (pre-v50 brain that hasn't run apply-migrations yet).
      checks.push({
        name: 'facts_extraction_health',
        status: 'ok',
        message: 'Skipped (ingest_log.source_id unavailable — run `gbrain apply-migrations --yes`).',
      });
    } else if (code === '42501') {
      checks.push({
        name: 'facts_extraction_health',
        status: 'warn',
        message: 'RLS denies SELECT on ingest_log. The check can\'t see facts:absorb rows. Run as a BYPASSRLS role or grant SELECT on this table.',
      });
    } else {
      checks.push(checkError('facts_extraction_health', 'read ingest_log for facts:absorb', err));
    }
  }
  return checks;
}

export const factsExtractionEntry: DoctorEntry = {
  name: 'facts_extraction_health',
  emits: ['facts_extraction_health'],
  run: runFactsExtraction,
};

async function runEffectiveDate(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 11a-2. effective_date_health (v0.29.1).
  //
  // Detects pages where computeEffectiveDate fell back to updated_at even
  // though parseable frontmatter dates are present (codex pass-1 #5
  // resolution: the sentinel column lets us catch "wrong but populated"
  // rows that look healthy at first glance).
  //
  // Sample 1000 random rows by default to keep the check fast on 200K-page
  // brains. The expression index pages_coalesce_date_idx makes the future-
  // date and pre-1990 scans cheap. Explicit frontmatter dates may be
  // historical (#5742), so only an inferred pre-1990 date is an anomaly. The "fell back despite parseable date"
  // arm can't be a pure SQL COUNT(*) — JSONB `?` only proves a key exists,
  // not that its value parses — so it fetches the candidate rows and
  // re-runs computeEffectiveDate() in JS (same function `gbrain
  // reindex-frontmatter` uses) to confirm a real date was missed.
  progress.heartbeat('effective_date_health');
  try {
    const result = await engine.executeRaw<{ kind: string; count: string }>(
      `WITH sample AS (
         SELECT effective_date, effective_date_source
           FROM pages
          ORDER BY id DESC
          LIMIT 1000
       )
       SELECT 'future_dated' AS kind, COUNT(*)::text AS count FROM sample
        WHERE effective_date IS NOT NULL AND effective_date > NOW() + INTERVAL '1 year'
       UNION ALL
       SELECT 'pre_1990', COUNT(*)::text FROM sample
        WHERE effective_date IS NOT NULL AND effective_date < TIMESTAMPTZ '1990-01-01'
          AND COALESCE(effective_date_source, '') NOT IN ('event_date', 'date', 'published', 'created')`,
    );
    const counts = new Map(result.map(r => [r.kind, Number(r.count)]));
    const future = counts.get('future_dated') ?? 0;
    const pre1990 = counts.get('pre_1990') ?? 0;

    // `frontmatter ? 'date'` (JSONB key-existence) only proves the key is
    // present — an empty string, null, or unparseable value still passes
    // it, so a naive COUNT(*) on that predicate over-reports "fell back
    // despite a parseable date". Fetch the candidate rows instead and run
    // them through the SAME parse/range rules `gbrain reindex-frontmatter`
    // uses (computeEffectiveDate) to confirm the frontmatter value itself
    // is parseable. This is a ONE-DIRECTIONAL guarantee, not equivalence:
    // every row counted here is a row reindex-frontmatter's dry run would
    // also flag, but reindex-frontmatter's dry run additionally flags rows
    // this arm intentionally excludes (filename-derived dates only, no
    // parseable frontmatter — that's a different message). Two queries
    // against the "last 1000 pages" window means this and the counts above
    // can drift by a row or two under concurrent writes — acceptable for a
    // sampled health check that already says "sample of last 1000 pages"
    // in its message.
    const candidates = await engine.executeRaw<{
      slug: string;
      frontmatter: unknown;
      created_at: string;
      updated_at: string;
    }>(
      `WITH sample AS (
         SELECT slug, frontmatter, effective_date_source, created_at, updated_at
           FROM pages
          ORDER BY id DESC
          LIMIT 1000
       )
       SELECT slug, frontmatter, created_at, updated_at
         FROM sample
        WHERE effective_date_source = 'fallback'
          AND (frontmatter ? 'event_date' OR frontmatter ? 'date' OR frontmatter ? 'published')`,
    );
    let fallbackWithFm = 0;
    for (const row of candidates) {
      // filename: null — this arm asks "does the frontmatter ALONE have a
      // parseable date", independent of whichever source wins the full
      // precedence chain. Passing the row's real filename would let a
      // daily/meetings-prefixed slug's filename-first precedence (see
      // effective-date.ts) resolve to source='filename' whenever the slug
      // also carries a YYYY-MM-DD prefix — silently hiding a genuinely
      // parseable frontmatter date (Codex review: reproduced with
      // `daily/2024-03-15-standup` + `{ date: '2024-04-01' }`, which
      // reindex-frontmatter WOULD still act on). filename=null makes
      // computeEffectiveDate fall straight through to the frontmatter
      // fields regardless of slug prefix.
      const recomputed = computeEffectiveDate({
        slug: row.slug,
        frontmatter: parseFrontmatter(row.frontmatter),
        filename: null,
        updatedAt: new Date(row.updated_at),
        createdAt: new Date(row.created_at),
      });
      if (recomputed.source === 'event_date' || recomputed.source === 'date' || recomputed.source === 'published') {
        fallbackWithFm++;
      }
    }

    if (fallbackWithFm > 0 || future > 0 || pre1990 > 0) {
      const parts: string[] = [];
      if (fallbackWithFm > 0) parts.push(`${fallbackWithFm} fell back to updated_at despite parseable frontmatter date`);
      if (future > 0) parts.push(`${future} dated > NOW() + 1y`);
      if (pre1990 > 0) parts.push(`${pre1990} pre-1990`);
      checks.push({
        name: 'effective_date_health',
        status: 'warn',
        message: `${parts.join('; ')} (sample of last 1000 pages). Run \`gbrain reindex-frontmatter\` to recompute.`,
      });
    } else {
      checks.push({
        name: 'effective_date_health',
        status: 'ok',
        message: 'Sample of last 1000 pages clean (no fallback-with-parseable-fm-date, no future-dated, no pre-1990)',
      });
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42703') {
      // column doesn't exist — pre-v0.29.1 brain
      checks.push({ name: 'effective_date_health', status: 'ok', message: 'Skipped (effective_date column unavailable — run gbrain apply-migrations)' });
    } else {
      checks.push(checkError('effective_date_health', 'read pages', err));
    }
  }
  return checks;
}

export const effectiveDateEntry: DoctorEntry = {
  name: 'effective_date_health',
  emits: ['effective_date_health'],
  run: runEffectiveDate,
};

async function runSalience(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 11a-3. salience_health (v0.29.1).
  //
  // Detects pages with active takes (so emotional_weight should be > 0)
  // whose recompute_emotional_weight phase hasn't yet run, plus the
  // brain-average emotional_weight as an informational signal.
  progress.heartbeat('salience_health');
  try {
    const result = await engine.executeRaw<{ kind: string; n: string }>(
      `SELECT 'zero_weight_with_takes' AS kind, COUNT(DISTINCT p.id)::text AS n
         FROM pages p
         JOIN takes t ON t.page_id = p.id AND t.active = TRUE
        WHERE COALESCE(p.emotional_weight, 0) = 0
       UNION ALL
       SELECT 'nonzero_weight', COUNT(*)::text FROM pages WHERE COALESCE(emotional_weight, 0) > 0`,
    );
    const counts = new Map(result.map(r => [r.kind, Number(r.n)]));
    const zeroWithTakes = counts.get('zero_weight_with_takes') ?? 0;
    const nonzero = counts.get('nonzero_weight') ?? 0;
    if (zeroWithTakes > 0) {
      checks.push({
        name: 'salience_health',
        status: 'warn',
        message: `${zeroWithTakes} pages with active takes have emotional_weight=0. Run \`gbrain dream --phase recompute_emotional_weight\` to populate. Brain has ${nonzero} pages with non-zero emotional_weight.`,
      });
    } else if (nonzero === 0) {
      checks.push({
        name: 'salience_health',
        status: 'ok',
        message: 'Skipped (no pages have emotional_weight > 0; either fresh install or recompute hasn\'t run yet)',
      });
    } else {
      checks.push({
        name: 'salience_health',
        status: 'ok',
        message: `${nonzero} pages have non-zero emotional_weight; no take/weight mismatches detected`,
      });
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42703' || code === '42P01') {
      checks.push({ name: 'salience_health', status: 'ok', message: 'Skipped (emotional_weight or takes table unavailable — pre-v0.29 brain)' });
    } else {
      checks.push(checkError('salience_health', 'read pages', err));
    }
  }
  return checks;
}

export const salienceEntry: DoctorEntry = {
  name: 'salience_health',
  emits: ['salience_health'],
  run: runSalience,
};
