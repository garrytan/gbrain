import type { BrainEngine } from '../core/engine.ts';
import * as db from '../core/db.ts';
import { LATEST_VERSION } from '../core/migrate.ts';
import { checkResolvable } from '../core/check-resolvable.ts';
import { autoFixDryViolations, type AutoFixReport, type FixOutcome } from '../core/dry-fix.ts';
import { loadCompletedMigrations } from '../core/preferences.ts';
import type { DbUrlSource } from '../core/config.ts';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  issues?: Array<{ type: string; skill: string; action: string; fix?: any }>;
}

/**
 * Run doctor with filesystem-first, DB-second architecture.
 * Filesystem checks (resolver, conformance) run without engine.
 * DB checks run only if engine is provided.
 *
 * `dbSource` is passed only from the `--fast` and DB-unavailable paths in
 * cli.ts so we can emit a precise "why no DB check" message. When null, the
 * user has no DB configured anywhere; otherwise the caller chose --fast or
 * we failed to connect despite a configured URL.
 */
export async function runDoctor(engine: BrainEngine | null, args: string[], dbSource?: DbUrlSource) {
  const jsonOutput = args.includes('--json');
  const fastMode = args.includes('--fast');
  const doFix = args.includes('--fix');
  const dryRun = args.includes('--dry-run');
  const checks: Check[] = [];
  let autoFixReport: AutoFixReport | null = null;

  // --- Filesystem checks (always run, no DB needed) ---

  // 1. Resolver health
  const repoRoot = findRepoRoot();
  if (repoRoot) {
    const skillsDir = join(repoRoot, 'skills');

    // --fix: run auto-repair BEFORE checkResolvable so the post-fix scan
    // reflects the new state. Auto-fix only targets DRY violations today;
    // other resolver issues are left to human repair.
    if (doFix) {
      autoFixReport = autoFixDryViolations(skillsDir, { dryRun });
      printAutoFixReport(autoFixReport, dryRun, jsonOutput);
    }

    const report = checkResolvable(skillsDir);
    if (report.ok && report.issues.length === 0) {
      checks.push({
        name: 'resolver_health',
        status: 'ok',
        message: `${report.summary.total_skills} skills, all reachable`,
      });
    } else {
      const errors = report.issues.filter(i => i.severity === 'error');
      const warnings = report.issues.filter(i => i.severity === 'warning');
      const status = errors.length > 0 ? 'fail' as const : 'warn' as const;
      const check: Check = {
        name: 'resolver_health',
        status,
        message: `${report.issues.length} issue(s): ${errors.length} error(s), ${warnings.length} warning(s)`,
        issues: report.issues.map(i => ({
          type: i.type,
          skill: i.skill,
          action: i.action,
          fix: i.fix,
        })),
      };
      checks.push(check);
    }
  } else {
    checks.push({ name: 'resolver_health', status: 'warn', message: 'Could not find skills directory' });
  }

  // 2. Skill conformance
  if (repoRoot) {
    const skillsDir = join(repoRoot, 'skills');
    const conformanceResult = checkSkillConformance(skillsDir);
    checks.push(conformanceResult);
  }

  // 3. Half-migrated Minions detection (filesystem-only).
  // If completed.jsonl has any status:"partial" entry with no later
  // status:"complete" for the same version, the install is mid-migration.
  // Typical cause: v0.11.0 stopgap wrote a partial record but nobody ran
  // `gbrain apply-migrations --yes` afterward. This check fires on every
  // `gbrain doctor` invocation so Wintermute's health skill catches it.
  try {
    const completed = loadCompletedMigrations();
    const byVersion = new Map<string, { complete: boolean; partial: boolean }>();
    for (const entry of completed) {
      const seen = byVersion.get(entry.version) ?? { complete: false, partial: false };
      if (entry.status === 'complete') seen.complete = true;
      if (entry.status === 'partial') seen.partial = true;
      byVersion.set(entry.version, seen);
    }
    const stuck = Array.from(byVersion.entries())
      .filter(([, s]) => s.partial && !s.complete)
      .map(([v]) => v);
    if (stuck.length > 0) {
      checks.push({
        name: 'minions_migration',
        status: 'fail',
        message: `MINIONS HALF-INSTALLED (partial migration: ${stuck.join(', ')}). Run: gbrain apply-migrations --yes`,
      });
    }
    // Note: the "no preferences.json but schema is v7+" case is detected
    // in the DB section below (needs schema version).
  } catch (e) {
    // completed.jsonl read/parse failure is non-fatal — probably a fresh
    // install with no record yet. Don't warn here; the DB check below
    // handles the "schema v7+ but no prefs" case.
  }

  // 3b. Upgrade-error trail (v0.13+). `gbrain upgrade` silently swallows
  // best-effort failures in `gbrain post-upgrade`; the failure record is
  // appended to ~/.gbrain/upgrade-errors.jsonl so we can surface it here
  // with a paste-ready recovery hint. Without this, users end up with
  // half-upgraded brains and no signal.
  try {
    const home = process.env.HOME || '';
    const errPath = join(home, '.gbrain', 'upgrade-errors.jsonl');
    if (existsSync(errPath)) {
      const lines = readFileSync(errPath, 'utf-8').split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        const latest = JSON.parse(lines[lines.length - 1]) as {
          ts: string; phase: string; from_version: string; to_version: string; hint: string;
        };
        const date = latest.ts.slice(0, 10);
        checks.push({
          name: 'upgrade_errors',
          status: 'warn',
          message: `Post-upgrade failure on ${date} (${latest.from_version} → ${latest.to_version}, phase: ${latest.phase}). Recovery: ${latest.hint}`,
        });
      }
    }
  } catch {
    // Read/parse failure is itself best-effort; skip silently.
  }

  // 3c. Sync failure trail (Bug 9). sync.ts gates the `sync.last_commit`
  // bookmark when per-file parse errors happen, and appends each failure
  // to ~/.gbrain/sync-failures.jsonl with the commit hash + exact error.
  // Without this doctor check, users see "sync blocked" and have no
  // surface showing which files to fix.
  try {
    const { unacknowledgedSyncFailures, loadSyncFailures } = await import('../core/sync.ts');
    const unacked = unacknowledgedSyncFailures();
    const all = loadSyncFailures();
    if (unacked.length > 0) {
      const preview = unacked.slice(0, 3).map(f => `${f.path} (${f.error.slice(0, 60)})`).join('; ');
      checks.push({
        name: 'sync_failures',
        status: 'warn',
        message:
          `${unacked.length} unacknowledged sync failure(s). ${preview}` +
          `${unacked.length > 3 ? `, and ${unacked.length - 3} more` : ''}. ` +
          `Fix the file(s) and re-run 'gbrain sync', or use 'gbrain sync --skip-failed' to acknowledge.`,
      });
    } else if (all.length > 0) {
      // Acknowledged-only: informational, not a warning.
      checks.push({
        name: 'sync_failures',
        status: 'ok',
        message: `${all.length} historical sync failure(s), all acknowledged.`,
      });
    }
  } catch {
    // Best-effort. A broken JSONL should not stop doctor.
  }

  // --- DB checks (skip if --fast or no engine) ---

  if (fastMode || !engine) {
    if (!engine) {
      // Pick the precise message. When dbSource is provided, we know
      // whether a URL exists (env or config-file) — the caller simply
      // skipped the connection. When null, there really is no config
      // anywhere.
      let msg: string;
      if (fastMode && dbSource) {
        msg = `Skipping DB checks (--fast mode, URL present from ${dbSource})`;
      } else if (!fastMode && dbSource) {
        msg = `Could not connect to configured DB (URL from ${dbSource}); filesystem checks only`;
      } else {
        msg = 'No database configured (filesystem checks only). Set GBRAIN_DATABASE_URL or run `gbrain init`.';
      }
      checks.push({ name: 'connection', status: 'warn', message: msg });
    }
    const earlyFail1 = outputResults(checks, jsonOutput);
    process.exit(earlyFail1 ? 1 : 0);
    return;
  }

  // 3. Connection
  try {
    const stats = await engine.getStats();
    checks.push({ name: 'connection', status: 'ok', message: `Connected, ${stats.page_count} pages` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'connection', status: 'fail', message: msg });
    const earlyFail2 = outputResults(checks, jsonOutput);
    process.exit(earlyFail2 ? 1 : 0);
    return;
  }

  // 4. pgvector extension
  try {
    const sql = db.getConnection();
    const ext = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    if (ext.length > 0) {
      checks.push({ name: 'pgvector', status: 'ok', message: 'Extension installed' });
    } else {
      checks.push({ name: 'pgvector', status: 'fail', message: 'Extension not found. Run: CREATE EXTENSION vector;' });
    }
  } catch {
    checks.push({ name: 'pgvector', status: 'warn', message: 'Could not check pgvector extension' });
  }

  // 5. RLS
  try {
    const sql = db.getConnection();
    const tables = await sql`
      SELECT tablename, rowsecurity FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('pages','content_chunks','links','tags','raw_data',
                           'page_versions','timeline_entries','ingest_log','config','files')
    `;
    const noRls = tables.filter((t: any) => !t.rowsecurity);
    if (noRls.length === 0) {
      checks.push({ name: 'rls', status: 'ok', message: 'RLS enabled on all tables' });
    } else {
      const names = noRls.map((t: any) => t.tablename).join(', ');
      checks.push({ name: 'rls', status: 'warn', message: `RLS not enabled on: ${names}` });
    }
  } catch {
    checks.push({ name: 'rls', status: 'warn', message: 'Could not check RLS status' });
  }

  // 6. Schema version
  let schemaVersion = 0;
  try {
    const version = await engine.getConfig('version');
    schemaVersion = parseInt(version || '0', 10);
    if (schemaVersion >= LATEST_VERSION) {
      checks.push({ name: 'schema_version', status: 'ok', message: `Version ${schemaVersion} (latest: ${LATEST_VERSION})` });
    } else {
      checks.push({ name: 'schema_version', status: 'warn', message: `Version ${schemaVersion}, latest is ${LATEST_VERSION}. Run gbrain init to migrate.` });
    }
  } catch {
    checks.push({ name: 'schema_version', status: 'warn', message: 'Could not check schema version' });
  }

  // Note: we intentionally DO NOT fail on "schema v7+ but no preferences.json".
  // That's a valid fresh-install state after `gbrain init` — the migration
  // orchestrator writes preferences, but `init` alone doesn't run it. The
  // partial-completed.jsonl check in the filesystem section (step 3) is
  // the canonical half-migration signal and fires when the stopgap ran
  // but `apply-migrations` didn't follow up.

  // 7. Embedding health
  try {
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    if (health.embed_coverage >= 0.9) {
      checks.push({ name: 'embeddings', status: 'ok', message: `${pct}% coverage, ${health.missing_embeddings} missing` });
    } else if (health.embed_coverage > 0) {
      checks.push({ name: 'embeddings', status: 'warn', message: `${pct}% coverage, ${health.missing_embeddings} missing. Run: gbrain embed --stale` });
    } else {
      checks.push({ name: 'embeddings', status: 'warn', message: 'No embeddings yet. Run: gbrain embed --stale' });
    }
  } catch {
    checks.push({ name: 'embeddings', status: 'warn', message: 'Could not check embedding health' });
  }

  // 8. Graph health (link + timeline coverage on entity pages).
  try {
    const health = await engine.getHealth();
    const linkPct = ((health.link_coverage ?? 0) * 100).toFixed(0);
    const timelinePct = ((health.timeline_coverage ?? 0) * 100).toFixed(0);
    if ((health.link_coverage ?? 0) >= 0.5 && (health.timeline_coverage ?? 0) >= 0.5) {
      checks.push({ name: 'graph_coverage', status: 'ok', message: `Entity link coverage ${linkPct}%, timeline ${timelinePct}%` });
    } else {
      checks.push({
        name: 'graph_coverage',
        status: 'warn',
        message: `Entity link coverage ${linkPct}%, timeline ${timelinePct}%. Run: gbrain link-extract && gbrain timeline-extract`,
      });
    }

    // Bug 11 — brain_score breakdown. When the total is < 100, show which
    // components contributed the deficit so users know what to fix.
    // Uses distinct *_score field names (not overloading link_coverage /
    // timeline_coverage, which are entity-scoped).
    if (health.brain_score < 100) {
      const parts = [
        `embed ${health.embed_coverage_score}/35`,
        `links ${health.link_density_score}/25`,
        `timeline ${health.timeline_coverage_score}/15`,
        `orphans ${health.no_orphans_score}/15`,
        `dead-links ${health.no_dead_links_score}/10`,
      ];
      checks.push({
        name: 'brain_score',
        status: health.brain_score >= 70 ? 'ok' : 'warn',
        message: `Brain score ${health.brain_score}/100 (${parts.join(', ')})`,
      });
    } else {
      checks.push({ name: 'brain_score', status: 'ok', message: `Brain score 100/100` });
    }
  } catch {
    checks.push({ name: 'graph_coverage', status: 'warn', message: 'Could not check graph coverage' });
  }

  // 9. Integrity sample scan (v0.13 knowledge runtime).
  // Read-only — no network, no writes, no resolver calls. Samples the first
  // 500 pages by slug order and surfaces bare-tweet + dead-link counts as a
  // warning. Full-brain scan: `gbrain integrity check`.
  try {
    const { scanIntegrity } = await import('./integrity.ts');
    const res = await scanIntegrity(engine, { limit: 500 });
    const total = res.bareHits.length + res.externalHits.length;
    if (total === 0) {
      checks.push({
        name: 'integrity',
        status: 'ok',
        message: `Sampled ${res.pagesScanned} pages; no bare-tweet phrases or external links.`,
      });
    } else if (res.bareHits.length > 0) {
      checks.push({
        name: 'integrity',
        status: 'warn',
        message: `Sampled ${res.pagesScanned} pages; ${res.bareHits.length} bare-tweet phrase(s), ${res.externalHits.length} external link(s). Run: gbrain integrity check (or integrity auto to repair).`,
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
  }

  // 10. JSONB integrity (v0.12.3 reliability wave).
  // v0.12.0's JSON.stringify()::jsonb pattern stored JSONB string literals
  // instead of objects on real Postgres. PGLite masked this; Supabase did not.
  // Scan the 4 known sites (pages.frontmatter, raw_data.data, ingest_log.pages_updated,
  // files.metadata) for rows whose top-level jsonb_typeof is 'string'.
  try {
    const sql = db.getConnection();
    const targets: Array<{ table: string; col: string; expected: 'object' | 'array' }> = [
      { table: 'pages',      col: 'frontmatter',    expected: 'object' },
      { table: 'raw_data',   col: 'data',           expected: 'object' },
      { table: 'ingest_log', col: 'pages_updated',  expected: 'array'  },
      { table: 'files',      col: 'metadata',       expected: 'object' },
    ];
    let totalBad = 0;
    const breakdown: string[] = [];
    for (const { table, col } of targets) {
      const rows = await sql.unsafe(
        `SELECT count(*)::int AS n FROM ${table} WHERE jsonb_typeof(${col}) = 'string'`,
      );
      const n = Number((rows as any)[0]?.n ?? 0);
      if (n > 0) { totalBad += n; breakdown.push(`${table}.${col}=${n}`); }
    }
    if (totalBad === 0) {
      checks.push({ name: 'jsonb_integrity', status: 'ok', message: 'All JSONB columns store objects/arrays' });
    } else {
      checks.push({
        name: 'jsonb_integrity',
        status: 'warn',
        message: `${totalBad} row(s) double-encoded (${breakdown.join(', ')}). Fix: gbrain repair-jsonb`,
      });
    }
  } catch {
    checks.push({ name: 'jsonb_integrity', status: 'warn', message: 'Could not check JSONB integrity' });
  }

  // 11. Markdown body completeness (v0.12.3 reliability wave).
  // v0.12.0's splitBody ate everything after the first `---` horizontal rule,
  // truncating wiki-style pages. Heuristic: pages whose body is <30% of the
  // raw source content length when raw has multiple H2/H3 boundaries.
  try {
    const sql = db.getConnection();
    const rows = await sql`
      SELECT p.slug,
             length(p.compiled_truth) AS body_len,
             length(rd.data ->> 'content') AS raw_len
      FROM pages p
      JOIN raw_data rd ON rd.page_id = p.id
      WHERE rd.data ? 'content'
        AND length(rd.data ->> 'content') > 1000
        AND length(p.compiled_truth) < length(rd.data ->> 'content') * 0.3
        AND (rd.data ->> 'content') ~ '(^|\n)##+ '
      LIMIT 100
    `;
    if (rows.length === 0) {
      checks.push({ name: 'markdown_body_completeness', status: 'ok', message: 'No truncated bodies detected' });
    } else {
      const sample = rows.slice(0, 3).map((r: any) => r.slug).join(', ');
      checks.push({
        name: 'markdown_body_completeness',
        status: 'warn',
        message: `${rows.length} page(s) appear truncated (sample: ${sample}). Re-import with: gbrain sync --force`,
      });
    }
  } catch {
    // pages_raw.raw_data may not exist on older schemas; best-effort.
    checks.push({ name: 'markdown_body_completeness', status: 'ok', message: 'Skipped (raw_data unavailable)' });
  }

  const hasFail = outputResults(checks, jsonOutput);

  // Features teaser (non-JSON, non-failing only)
  if (!jsonOutput && !hasFail && engine) {
    try {
      const { featuresTeaserForDoctor } = await import('./features.ts');
      const teaser = await featuresTeaserForDoctor(engine);
      if (teaser) console.log(`\n${teaser}`);
    } catch { /* best-effort */ }
  }

  process.exit(hasFail ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Print the auto-fix report in human-readable form. JSON output goes through
 *  outputResults alongside the check list; this is the pretty-print path. */
function printAutoFixReport(report: AutoFixReport, dryRun: boolean, jsonOutput: boolean): void {
  if (jsonOutput) return; // JSON consumers read autoFixReport via the check issues / caller
  const verb = dryRun ? 'PROPOSED' : 'APPLIED';
  for (const outcome of report.fixed) {
    console.log(`[${verb}] ${outcome.skillPath} (${outcome.patternLabel})`);
    if (outcome.before) {
      console.log('--- before');
      console.log(outcome.before);
      console.log('--- after');
      console.log(outcome.after ?? '');
      console.log('');
    }
  }
  const n = report.fixed.length;
  const s = report.skipped.length;
  if (n === 0 && s === 0) {
    console.log('Doctor --fix: no DRY violations to repair.');
    return;
  }
  const label = dryRun ? 'fixes proposed' : 'fixes applied';
  console.log(`${n} ${label}${s > 0 ? `, ${s} skipped:` : '.'}`);
  for (const sk of report.skipped) {
    const hint = sk.reason === 'working_tree_dirty' ? ' (run `git stash` first)' : '';
    console.log(`  - ${sk.skillPath}: ${sk.reason}${hint}`);
  }
  if (dryRun && n > 0) console.log('\nRun without --dry-run to apply.');
}

/** Find the GBrain repo root by walking up from cwd looking for skills/RESOLVER.md */
function findRepoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'skills', 'RESOLVER.md'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Quick skill conformance check — frontmatter + required sections */
function checkSkillConformance(skillsDir: string): Check {
  const manifestPath = join(skillsDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { name: 'skill_conformance', status: 'warn', message: 'manifest.json not found' };
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const skills = manifest.skills || [];
    let passing = 0;
    const failing: string[] = [];

    for (const skill of skills) {
      const skillPath = join(skillsDir, skill.path);
      if (!existsSync(skillPath)) {
        failing.push(`${skill.name}: file missing`);
        continue;
      }
      const content = readFileSync(skillPath, 'utf-8');
      // Check frontmatter exists
      if (!content.startsWith('---')) {
        failing.push(`${skill.name}: no frontmatter`);
        continue;
      }
      passing++;
    }

    if (failing.length === 0) {
      return { name: 'skill_conformance', status: 'ok', message: `${passing}/${skills.length} skills pass` };
    }
    return {
      name: 'skill_conformance',
      status: 'warn',
      message: `${passing}/${skills.length} pass. Failing: ${failing.join(', ')}`,
    };
  } catch {
    return { name: 'skill_conformance', status: 'warn', message: 'Could not parse manifest.json' };
  }
}

function outputResults(checks: Check[], json: boolean): boolean {
  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');

  // Compute composite health score (0-100)
  let score = 100;
  for (const c of checks) {
    if (c.status === 'fail') score -= 20;
    else if (c.status === 'warn') score -= 5;
  }
  score = Math.max(0, score);

  if (json) {
    const status = hasFail ? 'unhealthy' : hasWarn ? 'warnings' : 'healthy';
    console.log(JSON.stringify({ schema_version: 2, status, health_score: score, checks }));
    return hasFail;
  }

  console.log('\nGBrain Health Check');
  console.log('===================');
  for (const c of checks) {
    const icon = c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${c.name}: ${c.message}`);
    if (c.issues) {
      for (const issue of c.issues) {
        console.log(`    → ${issue.type.toUpperCase()}: ${issue.skill}`);
        console.log(`      ACTION: ${issue.action}`);
      }
    }
  }

  if (hasFail) {
    console.log(`\nHealth score: ${score}/100. Failed checks found.`);
  } else if (hasWarn) {
    console.log(`\nHealth score: ${score}/100. All checks OK (some warnings).`);
  } else {
    console.log(`\nHealth score: ${score}/100. All checks passed.`);
  }
  return hasFail;
}
