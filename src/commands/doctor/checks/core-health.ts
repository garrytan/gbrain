/**
 * Core-health check cluster — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import { dirname, isAbsolute, join, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, statSync } from 'fs';
import type { BrainEngine } from '../../../core/engine.ts';
import { REPAIR_SOURCE_CONFIG_SQL } from '../../../core/source-config-sql.ts';
import { loadConfig } from '../../../core/config.ts';
import type { ProgressReporter } from '../../../core/progress.ts';
import type { Check } from '../../doctor.ts';

/**
 * Doctor check: takes.weight grid integrity (v0.32 — EXP-2).
 *
 * Pure helper — no `process.exit`, no side effects beyond the SQL probe.
 * `runDoctor` calls this and pushes the result onto its check list.
 * Tests can target this directly with a stubbed engine (codex review #7).
 *
 * Branches:
 *   - takes table doesn't exist (fresh brain pre-v37) → warn, "skipped"
 *   - 0 takes total → ok, "no takes yet" (avoids divide-by-zero)
 *   - off_grid / total > 10% → fail
 *   - off_grid / total > 1%  → warn
 *   - else → ok
 *
 * Tolerance matches migration v48: any value with abs(weight - on_grid) > 1e-3
 * is genuinely off-grid (the 0.05 grid is 5e-2; float32 noise is ~1e-7).
 */
const WHOKNOWS_FIXTURE_RELATIVE_PATH = 'test/fixtures/whoknows-eval.jsonl';

function isGbrainSourceRoot(dir: string): boolean {
  return (
    existsSync(join(dir, 'src', 'cli.ts')) &&
    existsSync(join(dir, 'skills', 'RESOLVER.md'))
  );
}

export function resolveWhoknowsFixturePath(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string | null {
  if (env.GBRAIN_WHOKNOWS_FIXTURE_PATH) {
    return isAbsolute(env.GBRAIN_WHOKNOWS_FIXTURE_PATH)
      ? env.GBRAIN_WHOKNOWS_FIXTURE_PATH
      : resolvePath(process.cwd(), env.GBRAIN_WHOKNOWS_FIXTURE_PATH);
  }

  try {
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let i = 0; i < 10; i++) {
      if (isGbrainSourceRoot(dir)) return join(dir, WHOKNOWS_FIXTURE_RELATIVE_PATH);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Some bundlers/runtimes may not expose a normal file: import URL.
    // Doctor should surface an override hint instead of fabricating a path.
  }

  return null;
}

/**
 * v0.33: whoknows_health — verify the eval fixture is present at the
 * documented path. Lightweight; just checks file existence and row count,
 * not the eval gate outcome (that runs via `gbrain eval whoknows`).
 *
 * Surface is intentionally narrow: a missing fixture means the eval
 * cannot run at all, which is the highest-leverage signal. Hit-rate
 * regression detection lives in `gbrain eval whoknows --json` and is
 * the job of the eval command, not the doctor sweep.
 */
export async function whoknowsHealthCheck(_engine: BrainEngine): Promise<Check> {
  try {
    const fixturePath = resolveWhoknowsFixturePath();
    if (!fixturePath) {
      return {
        name: 'whoknows_health',
        status: 'warn',
        message: 'whoknows eval fixture path could not be resolved. Set GBRAIN_WHOKNOWS_FIXTURE_PATH to the absolute path for test/fixtures/whoknows-eval.jsonl.',
      };
    }
    if (!existsSync(fixturePath)) {
      return {
        name: 'whoknows_health',
        status: 'warn',
        message: `whoknows eval fixture missing at ${fixturePath}. Fix: hand-label 10 queries you'd actually run, format {query, expected_top_3_slugs, notes}.`,
      };
    }
    const stat = statSync(fixturePath);
    if (stat.size === 0) {
      return {
        name: 'whoknows_health',
        status: 'warn',
        message: 'whoknows eval fixture exists but is empty. The eval cannot pass without queries.',
      };
    }
    const raw = readFileSync(fixturePath, 'utf-8');
    const rows = raw
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith('#') && !t.startsWith('//');
      });
    if (rows.length < 5) {
      return {
        name: 'whoknows_health',
        status: 'warn',
        message: `whoknows eval fixture has only ${rows.length} row(s); ENG-D2 recommends 10. Fix: add more hand-labeled queries.`,
      };
    }
    return {
      name: 'whoknows_health',
      status: 'ok',
      message: `whoknows eval fixture present (${rows.length} queries). Run \`gbrain eval whoknows test/fixtures/whoknows-eval.jsonl\` to grade.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'whoknows_health',
      status: 'warn',
      message: `Could not check whoknows fixture: ${msg}`,
    };
  }
}

/**
 * Doctor check: pgvector availability.
 *
 * Use the active engine instead of the module-level Postgres singleton.
 * PGLite exposes pg_extension through its engine connection, but does not
 * connect db.ts's Postgres singleton; using db.getConnection() here turns a
 * healthy PGLite brain into a false warning.
 */
export async function pgvectorCheck(engine: BrainEngine): Promise<Check> {
  try {
    const ext = await engine.executeRaw<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    if (ext.length > 0) {
      return { name: 'pgvector', status: 'ok', message: 'Extension installed' };
    }
    return { name: 'pgvector', status: 'fail', message: 'Extension not found. Run: CREATE EXTENSION vector;' };
  } catch {
    return { name: 'pgvector', status: 'warn', message: 'Could not check pgvector extension' };
  }
}

/**
 * Doctor check: JSONB columns are not double-encoded as strings.
 *
 * This check is valid on both Postgres and PGLite. Route through
 * engine.executeRaw() so embedded PGLite brains are checked through their
 * actual connection instead of the unrelated Postgres singleton.
 */
export async function jsonbIntegrityCheck(
  engine: BrainEngine,
  progress?: Pick<ProgressReporter, 'heartbeat'>,
): Promise<Check> {
  try {
    const targets: Array<{ table: string; col: string; expected: 'object' | 'array'; jsonPayloadOnly?: boolean }> = [
      { table: 'pages',                    col: 'frontmatter',    expected: 'object' },
      { table: 'raw_data',                 col: 'data',           expected: 'object' },
      { table: 'ingest_log',               col: 'pages_updated',  expected: 'array'  },
      { table: 'files',                    col: 'metadata',       expected: 'object' },
      { table: 'page_versions',            col: 'frontmatter',    expected: 'object' },
      // Subagent persistence — second double-encode site (historical damage
      // rows from the pre-v0.42.53.0 positional bind; write paths fixed in
      // #2375). Mirrors repair-jsonb's targets incl. jsonPayloadOnly: these
      // columns can legitimately hold jsonb STRING scalars (persistToolExec
      // binds pre-serialized string payloads as-is), so only JSON-container
      // content counts as damage.
      { table: 'subagent_messages',        col: 'content_blocks', expected: 'array',  jsonPayloadOnly: true },
      { table: 'subagent_tool_executions', col: 'input',          expected: 'object', jsonPayloadOnly: true },
      { table: 'subagent_tool_executions', col: 'output',         expected: 'object', jsonPayloadOnly: true },
    ];
    let totalBad = 0;
    const breakdown: string[] = [];
    for (const { table, col, jsonPayloadOnly } of targets) {
      progress?.heartbeat(`jsonb_integrity.${table}.${col}`);
      // Skip targets whose table doesn't exist on this brain (subagent_*
      // tables are v0.15+; pre-v0.15 brains naturally lack them).
      const existsRows = await engine.executeRaw<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [table],
      );
      if (!existsRows[0]?.exists) continue;
      const damage = jsonPayloadOnly
        ? `jsonb_typeof(${col}) = 'string' AND (${col} #>> '{}') ~ '^[[:space:]]*[\\[{]' AND pg_input_is_valid(${col} #>> '{}', 'jsonb')`
        : `jsonb_typeof(${col}) = 'string'`;
      const rows = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${damage}`,
      );
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) { totalBad += n; breakdown.push(`${table}.${col}=${n}`); }
    }
    if (totalBad === 0) {
      return { name: 'jsonb_integrity', status: 'ok', message: 'All JSONB columns store objects/arrays' };
    }
    return {
      name: 'jsonb_integrity',
      status: 'warn',
      message: `${totalBad} row(s) double-encoded (${breakdown.join(', ')}). Fix: gbrain repair-jsonb`,
    };
  } catch {
    return { name: 'jsonb_integrity', status: 'warn', message: 'Could not check JSONB integrity' };
  }
}

/**
 * Per-channel push-context visibility (harness hook adapters). Groups
 * context_volunteer_events by channel over the last 7 days so the operator
 * can see which adapters (ambient reflex / op / watch / claude-code / codex)
 * are actually firing. Engine-aware SIBLING of buildRetrievalReflexCheck
 * (which is engine-free and heartbeat-file based) — deliberately a separate
 * check so the existing builder keeps its signature.
 *
 * Info-only (never warn/fail on quiet channels — most installs use a subset).
 * The message distinguishes the two "installed but nothing happens" classes:
 * a hook script that never registered (restart the harness session) vs a
 * registered adapter whose channel went quiet. Pre-v117 brains (no events
 * table) return ok with a note instead of throwing. A serve started before
 * this build logs hook traffic as 'reflex' — restart serve after upgrade.
 */
export async function checkVolunteerChannels(
  engine: BrainEngine,
  opts: { sourceIds?: string[] } = {},
): Promise<Check> {
  const name = 'volunteer_channels';
  try {
    // Source scoping (cross-model P1): remote source-bound callers pass their
    // authorized ids — an unqualified aggregate would leak other sources'
    // activity counts/timestamps. Local trusted doctor passes none (brain-wide).
    // Unscoped shape: no source_id predicate → the composite
    // (source_id, volunteered_at DESC) index can't range-scan and this
    // seq-scans the table. Accepted DELIBERATELY for the local info check
    // (table is TTL-pruned at 90 days) — do NOT reuse on a hot path.
    const scoped = Array.isArray(opts.sourceIds) && opts.sourceIds.length > 0;
    const rows = await engine.executeRaw<{ channel: string; n: string | number; last_fired: string | Date | null }>(
      scoped
        ? `SELECT channel, count(*)::int AS n, max(volunteered_at) AS last_fired
             FROM context_volunteer_events
            WHERE source_id = ANY($1::text[])
              AND volunteered_at > now() - interval '7 days'
            GROUP BY channel
            ORDER BY channel`
        : `SELECT channel, count(*)::int AS n, max(volunteered_at) AS last_fired
             FROM context_volunteer_events
            WHERE volunteered_at > now() - interval '7 days'
            GROUP BY channel
            ORDER BY channel`,
      scoped ? [opts.sourceIds] : [],
    );
    const channels: Record<string, { count: number; last_fired: string | null }> = {};
    for (const r of rows) {
      channels[r.channel] = {
        count: Number(r.n),
        last_fired: r.last_fired ? new Date(r.last_fired).toISOString() : null,
      };
    }
    const active = Object.keys(channels);

    // RT reconciliation: server-side delivery counts fire at the response
    // write — a hook client that timed out / hit its deadline / trimmed to
    // nothing still gets counted. The hook's own heartbeat records those
    // degradations, so surface the degraded rate next to the counts: a
    // "healthy" channel with a mostly-degraded heartbeat is delivery failure.
    let heartbeatNote = '';
    let heartbeat: { user_prompt_ok: number; user_prompt_degraded: number } | undefined;
    try {
      const { readHeartbeatTail } = await import('../../hook.ts');
      const tail = await readHeartbeatTail(200);
      // Same 7-day window as the event counts (a month-old degraded streak
      // must not indict a healthy current week), and a minimum sample floor
      // so one bad entry can't trigger the caution.
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const up = tail.filter(
        (e) => e.event === 'user-prompt' && Date.parse(e.ts ?? '') >= cutoff,
      );
      if (up.length >= 5) {
        const degraded = up.filter((e) => e.outcome !== 'ok').length;
        heartbeat = { user_prompt_ok: up.length - degraded, user_prompt_degraded: degraded };
        if (degraded > up.length / 2) {
          heartbeatNote = ` — CAUTION: the hook heartbeat shows ${degraded}/${up.length} user-prompt events degraded this week, so server-side counts may overstate what was actually injected`;
        }
      }
    } catch { /* heartbeat surface is best-effort */ }

    // Engine-aware quiet-channel guidance: the harness-hook lane rides the
    // PGLite serve socket — on a Postgres brain, "check your registration and
    // restart" can never make the channel fire (pull-mode covers Postgres).
    const cfg = (() => { try { return loadConfig(); } catch { return null; } })();
    const quietGuidance =
      cfg?.engine === 'pglite'
        ? 'if a hook adapter is installed, confirm its registration landed and the harness session was RESTARTED (hooks snapshot at session start); a serve older than this build logs NOTHING for the hook lane — restart serve on the new build to activate the feedback loop'
        : 'note: the harness-hook channels require a PGLite serve socket — on this engine the hook lane stays quiet by design (pull-mode retrieval covers it)';
    const message = active.length
      ? `push-context channels active (7d): ${active.map((c) => `${c}=${channels[c].count}`).join(', ')}${heartbeatNote}`
      : `no push-context activity in 7 days — ${quietGuidance}`;
    return {
      name,
      status: 'ok',
      message,
      details: { window_days: 7, channels, ...(heartbeat ? { hook_heartbeat: heartbeat } : {}) },
    };
  } catch (e) {
    // Discriminate table-absent (pre-v117 brain) from transient failures —
    // a connection blip on a fully-migrated brain must not be misreported
    // as an old schema. Info-only either way; never block doctor.
    const msg = e instanceof Error ? e.message : String(e);
    const tableAbsent = /does not exist|undefined table|no such table|42P01/i.test(msg);
    return {
      name,
      status: 'ok',
      message: tableAbsent
        ? 'volunteer-events table not available (pre-v117 brain) — per-channel push visibility inactive'
        : `volunteer_channels query failed (info-only check; may or may not be transient): ${msg}`,
      details: { window_days: 7, channels: {} },
    };
  }
}

export async function takesWeightGridCheck(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ off_grid: string | number; total: string | number }>(
      `SELECT
         count(*) FILTER (WHERE weight IS NOT NULL
                          AND abs(weight::numeric - ROUND(weight::numeric * 20) / 20) > 0.001)::int AS off_grid,
         count(*)::int AS total
       FROM takes`,
    );
    const total = Number(rows[0]?.total ?? 0);
    const offGrid = Number(rows[0]?.off_grid ?? 0);
    if (total === 0) {
      return { name: 'takes_weight_grid', status: 'ok', message: 'No takes yet' };
    }
    const ratio = offGrid / total;
    if (ratio > 0.10) {
      return {
        name: 'takes_weight_grid',
        status: 'fail',
        message: `${offGrid}/${total} takes off the 0.05 grid (${(ratio * 100).toFixed(1)}%). Fix: gbrain apply-migrations --yes`,
      };
    }
    if (ratio > 0.01) {
      return {
        name: 'takes_weight_grid',
        status: 'warn',
        message: `${offGrid}/${total} takes off the 0.05 grid (${(ratio * 100).toFixed(1)}%). Fix: gbrain apply-migrations --yes`,
      };
    }
    return {
      name: 'takes_weight_grid',
      status: 'ok',
      message: offGrid === 0
        ? `${total} take(s) on grid`
        : `${total} take(s) on grid (${offGrid} within tolerance)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // takes table missing on a fresh pre-v37 brain — warn, don't fail.
    return {
      name: 'takes_weight_grid',
      status: 'warn',
      message: `Could not check takes weight grid: ${msg}`,
    };
  }
}

/**
 * Child-table orphan detection (closes #1063).
 *
 * The autopilot `orphans` phase (src/core/cycle.ts:runPhaseOrphans) detects
 * orphan PAGES (pages with no inbound links via the page-graph). It does NOT
 * scan FK-child tables for orphan rows. When a bulk page delete leaves
 * orphans in `content_chunks` / `page_versions` / `tags` / `takes` / etc.
 * — whether from pre-FK migrations, race conditions, or a code path that
 * bypassed cascade — they persist indefinitely until manual SQL cleanup.
 *
 * All ten FK-to-pages tables declare `ON DELETE CASCADE` in the live schema
 * (verified via `pg_constraint` snapshot in the issue body), so finding any
 * orphan row is by definition unexpected. The check ships paste-ready
 * cleanup SQL when orphans surface.
 *
 * Excluded: `files.page_id` and `links.origin_page_id` — both declared as
 * `ON DELETE SET NULL`, so a NULL value is a valid state (file/link survives
 * after page deletion); only NOT-NULL-but-page-missing is an orphan there.
 * The check encodes that distinction for the two SET NULL columns.
 *
 * Pure helper for parity with `takesWeightGridCheck` so tests can target it
 * directly without driving the full `runDoctor` pipeline.
 */
export async function childTableOrphansCheck(engine: BrainEngine): Promise<Check> {
  // (table, fk_column, allow_null). When allow_null=true, NULL is a valid
  // state (FK was declared ON DELETE SET NULL); the orphan predicate filters
  // out NULL values. When false, NULL is impossible by NOT NULL constraint;
  // any value not in pages.id is an orphan.
  const targets: Array<{ table: string; col: string; allowNull: boolean }> = [
    { table: 'content_chunks',   col: 'page_id',          allowNull: false },
    { table: 'page_versions',    col: 'page_id',          allowNull: false },
    { table: 'tags',             col: 'page_id',          allowNull: false },
    { table: 'takes',            col: 'page_id',          allowNull: false },
    { table: 'raw_data',         col: 'page_id',          allowNull: false },
    { table: 'timeline_entries', col: 'page_id',          allowNull: false },
    { table: 'links',            col: 'from_page_id',     allowNull: false },
    { table: 'links',            col: 'to_page_id',       allowNull: false },
    { table: 'links',            col: 'origin_page_id',   allowNull: true  },
    { table: 'files',            col: 'page_id',          allowNull: true  },
  ];
  let totalOrphans = 0;
  const breakdown: string[] = [];
  const cleanupSql: string[] = [];
  const errors: string[] = [];
  for (const { table, col, allowNull } of targets) {
    try {
      // NOT IN subquery is portable across postgres + PGLite. The `pages.id`
      // subquery covers every existing parent row.
      const nullFilter = allowNull ? `${col} IS NOT NULL AND ` : '';
      const rows = await engine.executeRaw<{ n: string | number }>(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${nullFilter}${col} NOT IN (SELECT id FROM pages)`,
      );
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) {
        totalOrphans += n;
        breakdown.push(`${table}.${col}=${n}`);
        cleanupSql.push(
          `DELETE FROM ${table} WHERE ${nullFilter}${col} NOT IN (SELECT id FROM pages);`,
        );
      }
    } catch (e) {
      // Table or column may not exist on older schemas — skip and continue.
      // Aggregate the errors so doctor surfaces "could not check N tables"
      // when a real failure shape appears (network, lock, syntax).
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${table}.${col}: ${msg.slice(0, 80)}`);
    }
  }
  if (totalOrphans === 0 && errors.length === 0) {
    return {
      name: 'child_table_orphans',
      status: 'ok',
      message: 'All FK-child tables clean (10 tables checked)',
    };
  }
  if (totalOrphans === 0 && errors.length > 0) {
    return {
      name: 'child_table_orphans',
      status: 'warn',
      message: `Could not check ${errors.length}/10 FK-child tables (older schema or transient error): ${errors.slice(0, 3).join('; ')}`,
    };
  }
  return {
    name: 'child_table_orphans',
    status: 'warn',
    message:
      `${totalOrphans} orphan row(s) in FK-child tables (${breakdown.join(', ')}). ` +
      `Cleanup: ${cleanupSql.join(' ')}`,
  };
}

/**
 * Raw-source persistence guarantee (#1978, warn-only v1).
 *
 * Invariant: every synthesized/derived page (dream_generated:true frontmatter
 * or type:synthesis) must either carry a raw trace or declare an explicit
 * exemption. Accepted traces:
 *   - frontmatter key `raw_trace` / `raw_source` / `source_uri`
 *   - an attached `raw_data` row
 *   - `synthesis_evidence` rows (think-op citations)
 *   - explicit `raw_trace_exempt: true` (reason in `raw_trace_exempt_reason`)
 *
 * v1 is deliberately warn-only — no write path is blocked. Escalation to
 * fail-closed enforcement in the synthesis/import write paths is the v2
 * follow-up once real brains run clean.
 *
 * Pure helper (engine.executeRaw only) for parity with
 * childTableOrphansCheck so tests can target it directly.
 */
export async function rawProvenanceCheck(engine: BrainEngine): Promise<Check> {
  const where = `
        p.deleted_at IS NULL
    AND (COALESCE(p.frontmatter->>'dream_generated', '') = 'true' OR p.type = 'synthesis')
    AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ?| ARRAY['raw_trace', 'raw_source', 'source_uri', 'raw_trace_exempt'])
    AND NOT EXISTS (SELECT 1 FROM raw_data rd WHERE rd.page_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM synthesis_evidence se WHERE se.synthesis_page_id = p.id)`;
  try {
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n FROM pages p WHERE ${where}`,
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n === 0) {
      return {
        name: 'raw_provenance',
        status: 'ok',
        message: 'All synthesized pages carry a raw trace or explicit exemption',
      };
    }
    const sample = await engine.executeRaw<{ slug: string }>(
      `SELECT p.slug FROM pages p WHERE ${where} ORDER BY p.slug LIMIT 5`,
    );
    const slugs = sample.map(r => r.slug).join(', ');
    return {
      name: 'raw_provenance',
      status: 'warn',
      message:
        `${n} synthesized page(s) lack a raw trace (no raw_trace/raw_source/source_uri frontmatter, ` +
        `raw_data row, or synthesis evidence) and carry no raw_trace_exempt marker. e.g. ${slugs}. ` +
        `Fix: stamp raw_source (path/URI of the source material) or raw_trace_exempt: true + ` +
        `raw_trace_exempt_reason in frontmatter. Warn-only (#1978).`,
    };
  } catch {
    return { name: 'raw_provenance', status: 'warn', message: 'Could not check raw provenance (older schema?)' };
  }
}

/**
 * #2829: source `config` is a jsonb OBJECT column (`DEFAULT '{}'::jsonb`), but a
 * re-wrapping bug could store it as a JSON string scalar ("{}", "\"{}\"", ...)
 * that grows a layer on every read→write cycle. Any row where
 * `jsonb_typeof(config) <> 'object'` is corrupted — federation and ACL settings
 * on that source are read off a string instead of the settings object. Surface
 * the affected sources with the repair path. The `gbrain sources` config writers
 * now normalize before write, so any config-writing command self-heals the row
 * (the app unwraps up to 10 nested layers); the SQL below repairs one layer
 * directly for the common case.
 */
export async function checkSourceConfigShape(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ id: string; typ: string | null }>(
      `SELECT id, jsonb_typeof(config) AS typ FROM sources WHERE jsonb_typeof(config) <> 'object'`,
    );
    if (rows.length === 0) {
      return {
        name: 'source_config_shape',
        status: 'ok',
        message: 'All source config values are JSON objects',
      };
    }
    const affected = rows.map((r) => `${r.id} (${r.typ ?? 'null'})`).join(', ');
    return {
      name: 'source_config_shape',
      status: 'warn',
      message:
        `${rows.length} source(s) have a non-object config — a JSON string/scalar ` +
        `instead of an object (the #2829 re-wrapping bug): ${affected}. ` +
        `Federation and ACL settings on these sources won't be read correctly. ` +
        `Repair by running any 'gbrain sources' config write (self-heals nested ` +
        `strings and recoverable arrays), or in SQL: ${REPAIR_SOURCE_CONFIG_SQL}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'source_config_shape', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * #2674 — pglite_scratch_probe: distinguish a damaged PGLite store from a
 * broken WASM runtime.
 *
 * PGLite reports only `Aborted()` to JS (the PANIC goes to its own stderr),
 * so when init fails, the error string cannot say WHICH of the two it is.
 * The probe initializes a throwaway store in a temp dir, round-trips a row,
 * and reads the outcome:
 *
 *   - scratch works, real init failed → the runtime is fine; the failure is
 *     specific to YOUR store. The store-damage verdict is only ASSERTED when
 *     the caller supplies positive evidence (`storeDamageEvidence`: a
 *     damage-class disk diagnosis from `inspectPgliteDataDir`, or a
 *     wasm-abort/corrupt classification of the real init error). engine=null
 *     alone also covers locks and config refusals — blaming the store for
 *     those was the original false-positive defect; without evidence the
 *     message hedges and points at the `pglite_data_dir` diagnosis instead.
 *   - scratch fails too → the runtime cannot start on this machine; report
 *     OS + Bun versions on #223.
 *
 * COST GATE: a PGLite cold start is 5–20s on loaded machines, so this never
 * runs on a routine `gbrain doctor`. It runs only when (a) the real PGLite
 * engine actually failed to open (engine=null, not --fast, configured engine
 * is pglite) AND the disk diagnosis didn't already fully explain the failure
 * (a live lock / missing dir needs no runtime probe), or (b) the operator
 * asks with `--probe-pglite`.
 *
 * `probeFn` is a test seam so message routing can be pinned without paying
 * real cold starts.
 */
export async function checkPgliteScratchProbe(opts: {
  realInitFailed: boolean;
  /**
   * Positive evidence the REAL store is damaged: `inspectPgliteDataDir`
   * verdict wal-corruption-likely/unsupported-layout (buildChecks path) or a
   * wasm-abort/corrupt classification of the actual connect error (remote
   * path). Without it the scratch-ok arm hedges instead of asserting damage.
   */
  storeDamageEvidence?: boolean;
  realStorePath?: string;
  probeFn?: () => Promise<import('../../../core/pglite-engine.ts').PgliteScratchProbeResult>;
}): Promise<Check> {
  const name = 'pglite_scratch_probe';
  try {
    const probe =
      opts.probeFn ??
      (async () => {
        const { probePgliteScratchStore } = await import('../../../core/pglite-engine.ts');
        return probePgliteScratchStore(opts.realStorePath);
      });
    const r = await probe();
    const secs = (r.duration_ms / 1000).toFixed(1);
    if (r.ok) {
      if (opts.realInitFailed && opts.storeDamageEvidence) {
        return {
          name,
          status: 'fail',
          message:
            `A scratch PGLite store initialized, wrote and read back fine on this machine (${secs}s), ` +
            `so the runtime is healthy and YOUR STORE is damaged — not the WASM runtime. ` +
            `Your markdown is unaffected: the DB holds derived data (chunks, embeddings, links, facts) that a re-sync rebuilds. ` +
            `Recover: \`gbrain pglite-repair --dry-run\` to diagnose, \`gbrain pglite-repair --yes\` for in-place WAL repair (data preserved); ` +
            `if that can't fix it, restore a backup of the store directory or run \`gbrain reinit-pglite\` (wipes + re-inits + re-syncs; ` +
            `defaults embedding flags from your config file).`,
          details: { scratch_ok: true, duration_ms: r.duration_ms },
        };
      }
      if (opts.realInitFailed) {
        // Runtime proven healthy, but no independent evidence of store DAMAGE
        // — engine=null also covers locks, config refusals, and transient
        // failures. Hedge rather than convict the store (#2674 review).
        return {
          name,
          status: 'warn',
          message:
            `A scratch PGLite store initialized, wrote and read back fine on this machine (${secs}s), ` +
            `so the WASM runtime is healthy — the failure opening your brain is specific to your store, ` +
            `its lock, or its configuration. See the \`pglite_data_dir\` check for the on-disk diagnosis; ` +
            `\`gbrain pglite-repair --dry-run\` diagnoses without mutating anything.`,
          details: { scratch_ok: true, duration_ms: r.duration_ms },
        };
      }
      return {
        name,
        status: 'ok',
        message: `PGLite runtime healthy: scratch store round-trip in ${secs}s.`,
        details: { scratch_ok: true, duration_ms: r.duration_ms },
      };
    }
    const errLine = (r.error ?? 'unknown error').split('\n')[0];
    if (opts.realInitFailed) {
      return {
        name,
        status: 'fail',
        message:
          `A fresh scratch PGLite store ALSO failed to start (${secs}s), so the WASM runtime cannot run ` +
          `on this machine — your store is not necessarily damaged. Report your OS and Bun versions on ` +
          `https://github.com/garrytan/gbrain/issues/223. Scratch error: ${errLine}`,
        details: { scratch_ok: false, duration_ms: r.duration_ms, error: r.error, verdict: r.verdict },
      };
    }
    return {
      name,
      status: 'warn',
      message:
        `Your real store opened, but a fresh scratch PGLite store failed to initialize (${secs}s) — ` +
        `new stores can't be created on this machine. Report your OS and Bun versions on ` +
        `https://github.com/garrytan/gbrain/issues/223. Scratch error: ${errLine}`,
      details: { scratch_ok: false, duration_ms: r.duration_ms, error: r.error, verdict: r.verdict },
    };
  } catch (e) {
    // Includes the never-touch-the-real-store guard refusal. The probe not
    // running is a diagnostic gap, not a diagnosis — warn, don't fail.
    const msg = e instanceof Error ? e.message : String(e);
    return { name, status: 'warn', message: `scratch probe could not run: ${msg}` };
  }
}

