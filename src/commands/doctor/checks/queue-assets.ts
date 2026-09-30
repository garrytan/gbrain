/**
 * Queue and asset health: queue health, subagent capability, facts health, the opt-in index audit, image assets and OCR.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import * as db from '../../../core/db.ts';
import { startHeartbeat } from '../../../core/progress.ts';
import { computeQueueHealthCheck } from './queue-jobs.ts';
import { checkSubagentCapability } from './search-eval.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runQueueHealth(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  progress.heartbeat('queue_health');
  const queueHealthHb = startHeartbeat(progress, 'scanning queue health…');
  try {
    checks.push(await computeQueueHealthCheck(engine));
  } finally {
    queueHealthHb();
  }

  // 11.4 subagent_capability (v0.38 — D7; was subagent_provider in v0.31.12). Surfaces a
  // warn when models.tier.subagent or models.default points at a non-Anthropic
  // provider. Layers 1 (queue.ts submit-time) and 2 (handler runtime) also
  // enforce; this is the surfacing layer so users see the config drift before
  // a job is submitted.
  progress.heartbeat('subagent_capability');
  checks.push(await checkSubagentCapability(engine));

  // 11.5 facts_health (v0.31 hot memory). Surfaces per-source counters so
  // operators can see the extraction pipeline's pulse without raw SQL.
  // Lightweight: one COUNT-with-filters query + a top-5 aggregate. Only
  // runs when the facts table exists (post-v40 brains); pre-v40 the
  // probe is a no-op.
  progress.heartbeat('facts_health');
  try {
    const factsExists = await engine.executeRaw<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'facts') AS exists`,
    );
    if (factsExists[0]?.exists) {
      const health = await engine.getFactsHealth('default');
      const status: 'ok' | 'warn' = health.total_active >= 0 ? 'ok' : 'warn';
      const top = health.top_entities
        .slice(0, 3)
        .map(t => `${t.entity_slug}:${t.count}`)
        .join(', ') || '—';
      checks.push({
        name: 'facts_health',
        status,
        message:
          `facts_health(default): ${health.total_active} active, ` +
          `${health.total_today} today, ${health.total_week} this week, ` +
          `${health.total_consolidated} consolidated, ` +
          `top entities ${top}`,
      });
    } else {
      checks.push({
        name: 'facts_health',
        status: 'ok',
        message: 'facts table not present (pre-v0.31 brain or migration pending)',
      });
    }
  } catch (e) {
    checks.push({
      name: 'facts_health',
      status: 'warn',
      message: `facts_health probe failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  return checks;
}

export const queueHealthEntry: DoctorEntry = {
  name: 'queue_health',
  emits: ['queue_health', 'subagent_capability', 'facts_health'],
  run: runQueueHealth,
};

async function runIndexAudit(ctx: DoctorContext): Promise<Check[]> {
  const { args, progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 12. Index audit (opt-in via --index-audit). v0.13.1 follow-up to #170.
  // Reports indexes with zero recorded scans on Postgres. Informational only;
  // we DO NOT auto-drop. On #170's brain, idx_pages_frontmatter and
  // idx_pages_trgm showed 0 scans — the suggestion there is "consider
  // investigating on YOUR brain," not "drop these globally." Zero scans on a
  // fresh install is also normal (nothing has queried yet); the real signal
  // is zero scans on a long-running active brain.
  if (args.includes('--index-audit')) {
    progress.heartbeat('index_audit');
    if (engine.kind === 'pglite') {
      checks.push({
        name: 'index_audit',
        status: 'ok',
        message: 'Skipped (PGLite — pg_stat_user_indexes is a Postgres extension)',
      });
    } else {
      try {
        const sql = db.getConnection();
        const rows = await sql`
          SELECT schemaname, relname AS table, indexrelname AS index,
                 idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
            FROM pg_stat_user_indexes
           WHERE schemaname = 'public'
             AND idx_scan = 0
           ORDER BY pg_relation_size(indexrelid) DESC
           LIMIT 20
        `;
        if (rows.length === 0) {
          checks.push({ name: 'index_audit', status: 'ok', message: 'All public indexes have recorded scans' });
        } else {
          const list = rows.map((r: any) => `${r.index}(${r.size})`).join(', ');
          checks.push({
            name: 'index_audit',
            status: 'warn',
            message: `${rows.length} zero-scan index(es): ${list}. ` +
                     `Consider investigating whether they're used on YOUR workload (fresh brains naturally show zero scans until queries accumulate). ` +
                     `Do not drop without confirming.`,
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        checks.push({ name: 'index_audit', status: 'warn', message: `Index audit failed: ${msg}` });
      }
    }
  }
  return checks;
}

export const indexAuditEntry: DoctorEntry = {
  name: 'index_audit',
  emits: ['index_audit'],
  run: runIndexAudit,
};

async function runImageAssets(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // v0.27.1: image_assets — vanished images (files row exists but file
  // missing on disk). Cherry-4b. Engine-agnostic; uses listFilesForPage's
  // sibling SQL via raw query for cross-engine compatibility.
  if (engine) {
    progress.heartbeat('image_assets');
    try {
      const rows = await engine.executeRaw<{ storage_path: string; source_local_path: string | null; metadata: unknown }>(
        `SELECT f.storage_path, f.metadata, s.local_path AS source_local_path FROM files f LEFT JOIN sources s ON s.id = COALESCE(f.source_id, 'default') WHERE f.mime_type LIKE 'image/%' LIMIT 1000`
      );
      let vanished = 0;
      let foreign = 0;
      let remote = 0;
      const vanishedPaths: string[] = [];
      const fs = await import('node:fs');
      const { resolveImageAssetPath, imageAssetStorageLane } = await import('../../doctor-asset-paths.ts');
      // storage_path is repo-relative for sync-ingested assets. Prefer the
      // owning source's root; sync.repo_path is only a legacy fallback.
      const repoRoot = (await engine.getConfig('sync.repo_path')) ?? process.cwd();
      for (const r of rows) {
        // #4910: an explicit non-git lane (supabase/s3/local backend) means
        // storage_path is a bucket key, never a source-relative file. Only
        // `gbrain files verify` can probe those; unmarked rows keep the stat.
        if (imageAssetStorageLane(r.metadata) === 'backend') { remote++; continue; }
        // #1835: Windows drive paths (D:/…) translate to the WSL automount
        // (/mnt/d/…) under WSL, and are SKIPPED (not "missing") on hosts
        // where they cannot exist (macOS / plain Linux) — never joined onto
        // repoRoot, which produced a false "restore from git" WARN.
        const resolved = resolveImageAssetPath(r.storage_path, r.source_local_path, repoRoot);
        if (resolved.abs === null) {
          foreign++;
          continue;
        }
        try {
          fs.statSync(resolved.abs);
        } catch {
          vanished++;
          if (vanishedPaths.length < 5) vanishedPaths.push(r.storage_path);
        }
      }
      const checked = rows.length - foreign - remote;
      const foreignNote = (foreign > 0
        ? ` (${foreign} Windows-drive path(s) skipped — not resolvable on this platform)`
        : '') + (remote > 0
        ? ` (${remote} storage-backend object(s) not checked locally — run \`gbrain files verify\`)`
        : '');
      if (rows.length === 0) {
        checks.push({ name: 'image_assets', status: 'ok', message: 'No image assets indexed yet' });
      } else if (checked === 0) {
        checks.push({ name: 'image_assets', status: 'ok', message: `No local image assets to check${foreignNote}` });
      } else if (vanished === 0) {
        checks.push({ name: 'image_assets', status: 'ok', message: `${checked} image(s) all present on disk${foreignNote}` });
      } else {
        checks.push({
          name: 'image_assets',
          status: 'warn',
          message: `${vanished} of ${checked} image(s) missing from disk (e.g. ${vanishedPaths.join(', ')})${foreignNote}. ` +
                   `Fix: restore from git, or \`gbrain sync --skip-failed\` to acknowledge.`,
        });
      }
    } catch {
      // Pre-v36 brains may not have the files table on PGLite — quiet skip.
    }

    // v0.27.1 Eng-1B: ocr_health — counters incremented by importImageFile.
    // Warns when OCR is opted-in (attempted > 0) but never succeeds.
    progress.heartbeat('ocr_health');
    try {
      const attempted = parseInt((await engine.getConfig('ocr_attempted')) ?? '0', 10);
      const succeeded = parseInt((await engine.getConfig('ocr_succeeded')) ?? '0', 10);
      const failedNoKey = parseInt((await engine.getConfig('ocr_failed_no_key')) ?? '0', 10);
      const failedOther = parseInt((await engine.getConfig('ocr_failed_other')) ?? '0', 10);
      // #3973: images skipped by the per-run OCR budget cap (maybeOcr).
      const skippedBudget = parseInt((await engine.getConfig('ocr_skipped_budget')) ?? '0', 10);
      if (attempted === 0 && skippedBudget === 0) {
        checks.push({ name: 'ocr_health', status: 'ok', message: 'OCR not in use (or no images ingested with OCR opt-in)' });
      } else if (succeeded === 0 && (failedNoKey > 0 || failedOther > 0)) {
        const reasons: string[] = [];
        if (failedNoKey > 0) reasons.push(`${failedNoKey} no-key`);
        if (failedOther > 0) reasons.push(`${failedOther} other`);
        checks.push({
          name: 'ocr_health',
          status: 'warn',
          message: `OCR is opted-in but no calls succeeded (${attempted} attempted, ${reasons.join(', ')}). ` +
                   `Fix: verify OPENAI_API_KEY is set, or set embedding_image_ocr=false to disable.`,
        });
      } else if (skippedBudget > 0) {
        checks.push({
          name: 'ocr_health',
          status: 'warn',
          message: `OCR budget cap skipped ${skippedBudget} image(s) (${succeeded}/${attempted} attempted calls succeeded). ` +
                   `Fix: raise embedding_image_ocr_max_images / embedding_image_ocr_max_usd and re-import, or ignore if the cap is intentional.`,
        });
      } else {
        checks.push({
          name: 'ocr_health',
          status: 'ok',
          message: `OCR healthy (${succeeded}/${attempted} succeeded; ${failedNoKey} no-key, ${failedOther} other failures)`,
        });
      }
    } catch { /* config table missing on a very old brain — skip */ }
  }
  return checks;
}

export const imageAssetsEntry: DoctorEntry = {
  name: 'image_assets',
  emits: ['image_assets', 'ocr_health'],
  run: runImageAssets,
};
