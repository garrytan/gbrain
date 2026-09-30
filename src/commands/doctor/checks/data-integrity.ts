/**
 * Data integrity: integrity sample, JSONB integrity and child-table shape checks, whoknows, cross-modal coverage and markdown body completeness.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { startHeartbeat } from '../../../core/progress.ts';
import {
  jsonbIntegrityCheck,
  takesWeightGridCheck,
  childTableOrphansCheck,
  rawProvenanceCheck,
  checkSourceConfigShape,
  whoknowsHealthCheck,
} from './core-health.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runIntegrity(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 10. Integrity sample scan (v0.13 knowledge runtime).
  // Read-only — no network, no writes, no resolver calls. Samples the first
  // 500 pages by slug order and surfaces bare-tweet + dead-link counts as a
  // warning. Full-brain scan: `gbrain integrity check`.
  progress.heartbeat('integrity_sample');
  const integrityHb = startHeartbeat(progress, 'scanning 500-page integrity sample…');
  try {
    const { scanIntegrity } = await import('../../integrity.ts');
    const res = await scanIntegrity(engine, { limit: 500 });
    const total = res.bareHits.length + res.externalHits.length;
    if (total === 0) {
      checks.push({
        name: 'integrity',
        status: 'ok',
        message: `Sampled ${res.pagesScanned} pages; no bare-tweet phrases or external links.`,
      });
    } else if (res.bareHits.length > 0) {
      // v0.40.3.0 T8b (D8): emit integrity-auto RemediationStep.
      // Three-bucket repair handled by `gbrain integrity auto` (the
      // existing CLI). Deterministic — no LLM cost.
      const { makeRemediationStep } = await import('../../../core/remediation-step.ts');
      const integrityStep = makeRemediationStep({
        id: 'integrity-auto',
        job: 'integrity-auto',
        params: {
          bare_count: res.bareHits.length,
          external_count: res.externalHits.length,
          pages_scanned: res.pagesScanned,
        },
        severity: res.bareHits.length > 50 ? 'high' : 'medium',
        est_seconds: 60,
        est_usd_cost: 0,
        rationale: `Auto-repair ${res.bareHits.length} bare-tweet phrase(s)`,
      });
      checks.push({
        name: 'integrity',
        status: 'warn',
        message: `Sampled ${res.pagesScanned} pages; ${res.bareHits.length} bare-tweet phrase(s), ${res.externalHits.length} external link(s). Run: gbrain integrity check (or integrity auto to repair).`,
        remediation: [integrityStep],
        remediation_status: 'remediable',
      });
    } else {
      checks.push({
        name: 'integrity',
        status: 'ok',
        message: `Sampled ${res.pagesScanned} pages; ${res.externalHits.length} external link(s) (no bare tweets).`,
      });
    }
  } catch (e) {
    checks.push({ name: 'integrity', status: 'warn', message: `integrity scan skipped: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    integrityHb();
  }
  return checks;
}

export const integrityEntry: DoctorEntry = { name: 'integrity', emits: ['integrity'], run: runIntegrity };

async function runJsonbIntegrity(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 10. JSONB integrity (v0.12.3 reliability wave).
  // v0.12.0's JSON.stringify()::jsonb pattern stored JSONB string literals
  // instead of objects on real Postgres. PGLite masked this; Supabase did not.
  // Scan 5 known write sites for rows whose top-level jsonb_typeof is
  // 'string'. `page_versions.frontmatter` added in v0.15.2 so doctor's
  // surface matches `repair-jsonb` (the previous 4-target scan missed a
  // repair target, per #254/Codex review).
  progress.heartbeat('jsonb_integrity');
  checks.push(await jsonbIntegrityCheck(engine, progress));

  // 10b. Takes weight grid integrity (v0.32 — EXP-2).
  //
  // Cross-modal eval over 100K production takes flagged 0.74, 0.82-style
  // weights as false precision. v0.31's engine layer rounds to 0.05 on
  // insert (PR #795); v0.32's migration v48 backfills pre-existing data.
  // This check is the post-backfill drift detector — if a downstream
  // extraction agent or hand-edit re-introduces off-grid values, we want
  // the warning to surface before it pollutes scorecard / calibration math.
  //
  // Pure helper so the test surface targets `takesWeightGridCheck(engine)`
  // directly rather than the full `runDoctor` pipeline (codex review #7).
  progress.heartbeat('takes_weight_grid');
  checks.push(await takesWeightGridCheck(engine));

  // 10c. Child-table orphan detection (closes #1063).
  // The autopilot `orphans` phase scans for orphan pages (no inbound links)
  // but does NOT detect orphan rows in FK-child tables. After a bulk page
  // delete, child rows can persist if cascade didn't fire (pre-FK rows,
  // race during bulk cascade, code path that bypassed cascade). This
  // surfaces them with paste-ready cleanup SQL.
  progress.heartbeat('child_table_orphans');
  checks.push(await childTableOrphansCheck(engine));

  // 10d. Raw-source persistence guarantee (#1978, warn-only v1).
  // Every synthesized/derived page must carry a raw trace or an explicit
  // exemption. Warn-only in v1 — surfaces violations, blocks nothing.
  progress.heartbeat('raw_provenance');
  checks.push(await rawProvenanceCheck(engine));

  // #2829: detect sources whose jsonb `config` was re-wrapped into a string
  // scalar (grows a layer per read→write cycle). Non-object configs break
  // federation + ACL reads; surface them with the repair path.
  progress.heartbeat('source_config_shape');
  checks.push(await checkSourceConfigShape(engine));
  return checks;
}

export const jsonbIntegrityEntry: DoctorEntry = {
  name: 'jsonb_integrity',
  emits: [
    'jsonb_integrity',
    'takes_weight_grid',
    'child_table_orphans',
    'raw_provenance',
    'source_config_shape',
  ],
  run: runJsonbIntegrity,
};

async function runWhoknows(ctx: DoctorContext): Promise<Check[]> {
  const { progress, scope } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // v0.33: whoknows_health — fixture presence + row count. The eval
  // gate itself runs via `gbrain eval whoknows`; this check is the
  // "did you do the assignment?" signal.
  // SKILL group — gated behind --scope=all (v0.41.19.0).
  if (scope === 'all') {
    progress.heartbeat('whoknows_health');
    checks.push(await whoknowsHealthCheck(engine));
  }
  return checks;
}

export const whoknowsEntry: DoctorEntry = {
  name: 'whoknows_health',
  emits: ['whoknows_health'],
  run: runWhoknows,
};

async function runCrossModal(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // v0.36 cross-modal wave: modality column cleanup.
  //
  // Historical brains that imported image assets before v0.27.1's
  // `modality='image'` default-set may have image chunks where
  // embedding_image is populated but modality wasn't tagged. The cross-modal
  // search routing in v0.36 depends on `modality` for keyword filtering;
  // surface the gap so operators can run `gbrain backfill modality`.
  progress.heartbeat('cross_modal_modality_backfill');
  try {
    const mismatchRows = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*)::text AS count FROM content_chunks
       WHERE embedding_image IS NOT NULL
         AND chunk_source = 'image_asset'
         AND (modality IS NULL OR modality != 'image')`,
    );
    const mismatch = parseInt(String(mismatchRows[0]?.count ?? '0'), 10);
    if (mismatch === 0) {
      checks.push({
        name: 'cross_modal_modality_backfill',
        status: 'ok',
        message: 'All image-asset chunks have modality=image',
      });
    } else {
      checks.push({
        name: 'cross_modal_modality_backfill',
        status: 'warn',
        message:
          `${mismatch} image-asset chunk(s) have embedding_image populated but modality != 'image'. ` +
          `Fix: \`gbrain backfill modality\``,
      });
    }
  } catch {
    // Engine probably doesn't have the modality column (pre-v0.27.1 brain) —
    // skip silently. Auto-migration will land it on next upgrade.
    checks.push({
      name: 'cross_modal_modality_backfill',
      status: 'ok',
      message: 'modality column not present (pre-v0.27.1 brain); skipped',
    });
  }

  // v0.36 Phase 3 — unified_multimodal coverage (D21 source-aware).
  //
  // Only meaningful when search.unified_multimodal is on. Reports the
  // percentage of content_chunks with embedding_multimodal populated.
  // Source-aware: a global 95% can hide 0% coverage for a specific source.
  progress.heartbeat('unified_multimodal_coverage');
  try {
    const unifiedFlag = await engine.getConfig('search.unified_multimodal').catch(() => null);
    const unifiedOnlyFlag = await engine.getConfig('search.unified_multimodal_only').catch(() => null);
    const unifiedOn = unifiedFlag === 'true' || unifiedFlag === '1';
    const unifiedOnlyOn = unifiedOnlyFlag === 'true' || unifiedOnlyFlag === '1';

    if (!unifiedOn) {
      checks.push({
        name: 'unified_multimodal_coverage',
        status: 'ok',
        message: 'search.unified_multimodal is off; coverage check N/A',
      });
    } else {
      // D21 source-aware: report per-source coverage so multi-source brains
      // can't hide 0% on one source behind a high global average.
      const rows = await engine.executeRaw<{ source_id: string | null; total: string; covered: string }>(
        `SELECT
           COALESCE(p.source_id, 'default') AS source_id,
           COUNT(*)::text AS total,
           SUM(CASE WHEN cc.embedding_multimodal IS NOT NULL THEN 1 ELSE 0 END)::text AS covered
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         GROUP BY p.source_id`,
      );
      const perSource = rows.map(r => ({
        source: r.source_id || 'default',
        total: parseInt(String(r.total), 10),
        covered: parseInt(String(r.covered), 10),
      }));
      const lowestCoverage = perSource.reduce(
        (acc, r) => Math.min(acc, r.total > 0 ? r.covered / r.total : 1),
        1,
      );
      const summary = perSource.map(r => {
        const pct = r.total > 0 ? Math.round((r.covered / r.total) * 100) : 0;
        return `${r.source}:${pct}%`;
      }).join(', ');

      if (unifiedOnlyOn && lowestCoverage < 0.99) {
        checks.push({
          name: 'unified_multimodal_coverage',
          status: 'fail',
          message:
            `unified_multimodal_only is ON but lowest source coverage is ${(lowestCoverage * 100).toFixed(1)}% (${summary}). ` +
            `Run \`gbrain reindex --multimodal\` to bring coverage to 99%+ or disable strict mode.`,
        });
      } else if (lowestCoverage < 0.95) {
        checks.push({
          name: 'unified_multimodal_coverage',
          status: 'warn',
          message:
            `unified_multimodal is on but lowest source coverage is ${(lowestCoverage * 100).toFixed(1)}% (${summary}). ` +
            `Run \`gbrain reindex --multimodal\` to fill the gap.`,
        });
      } else {
        checks.push({
          name: 'unified_multimodal_coverage',
          status: 'ok',
          message: `unified_multimodal coverage: ${summary}`,
        });
      }
    }
  } catch {
    // Column probably not present (pre-v0.36 brain pre-migration); skip silently.
    checks.push({
      name: 'unified_multimodal_coverage',
      status: 'ok',
      message: 'embedding_multimodal column not present yet; skipped',
    });
  }
  return checks;
}

export const crossModalEntry: DoctorEntry = {
  name: 'cross_modal_modality_backfill',
  emits: ['cross_modal_modality_backfill', 'unified_multimodal_coverage'],
  run: runCrossModal,
};

async function runMarkdownBody(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 11. Markdown body completeness (v0.12.3 reliability wave).
  // v0.12.0's splitBody ate everything after the first `---` horizontal rule,
  // truncating wiki-style pages. Heuristic: pages whose body is <30% of the
  // raw source content length when raw has multiple H2/H3 boundaries.
  //
  // No total on this check: the regex scan over rd.data -> 'content' is a
  // sequential scan that LIMIT 100 bounds only the output, not the scan
  // work. We heartbeat every second so agents see life, no fake totals.
  progress.heartbeat('markdown_body_completeness');
  const mbcHb = startHeartbeat(progress, 'scanning pages for truncation…');
  try {
    // #1871: engine.executeRaw (NOT db.getConnection() — that's the postgres
    // singleton, dead on the default PGLite engine; this check silently
    // reported "Skipped" on every PGLite brain).
    const rows = await engine.executeRaw<{ slug: string; body_len: number; raw_len: number }>(
      `SELECT p.slug,
              length(p.compiled_truth) AS body_len,
              length(rd.data ->> 'content') AS raw_len
       FROM pages p
       JOIN raw_data rd ON rd.page_id = p.id
       WHERE rd.data ? 'content'
         AND length(rd.data ->> 'content') > 1000
         AND length(p.compiled_truth) < length(rd.data ->> 'content') * 0.3
         AND (rd.data ->> 'content') ~ '(^|\n)##+ '
       LIMIT 100`,
    );
    if (rows.length === 0) {
      checks.push({ name: 'markdown_body_completeness', status: 'ok', message: 'No truncated bodies detected' });
    } else {
      const sample = rows.slice(0, 3).map((r) => r.slug).join(', ');
      checks.push({
        name: 'markdown_body_completeness',
        status: 'warn',
        message: `${rows.length} page(s) appear truncated (sample: ${sample}). Re-import: edit each page body, then run gbrain sync (see docs/integrations/reliability-repair.md)`,
      });
    }
  } catch {
    // pages_raw.raw_data may not exist on older schemas; best-effort.
    checks.push({ name: 'markdown_body_completeness', status: 'ok', message: 'Skipped (raw_data unavailable)' });
  } finally {
    mbcHb();
  }
  return checks;
}

export const markdownBodyEntry: DoctorEntry = {
  name: 'markdown_body_completeness',
  emits: ['markdown_body_completeness'],
  run: runMarkdownBody,
};
