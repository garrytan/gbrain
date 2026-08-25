/**
 * Routing / federation / oauth / locks check cluster — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import { existsSync, readFileSync } from 'fs';
import type { BrainEngine } from '../../../core/engine.ts';
import { gbrainPath } from '../../../core/config.ts';
import { embedBackfillWorkerSurface } from '../../../core/minions/embed-backfill-admission.ts';
import { isUndefinedTableError, isUndefinedColumnError } from '../../../core/utils.ts';
import type { Check } from '../../doctor.ts';

/**
 * v0.37.7.0 — Tier 5K source_routing_health (D5 lock: 200-page total cap).
 *
 * On a multi-source brain, sample up to 200 recent pages across all
 * non-default sources (per-source cap = min(50, ceil(200/N))). Warn
 * when:
 *  - A non-default source has zero pages (silent-collapse-to-default
 *    fingerprint from #1167 + #1222).
 *  - The brain repo has a `.gitignore` file but
 *    `sync.respect_gitignore` is unset/false (info-line nudge for
 *    Tier 4I's opt-in flag).
 *
 * Cost-bounded: total cap of 200 means a 20-source CEO brain pays
 * 20*10 = 200 selects rather than 20*50 = 1000.
 */
export async function checkSourceRoutingHealth(engine: BrainEngine): Promise<Check> {
  try {
    const sources = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id <> 'default'`,
    );
    if (sources.length === 0) {
      return { name: 'source_routing_health', status: 'ok', message: 'Single-source brain (no federation to check)' };
    }
    const perSourceCap = Math.min(50, Math.ceil(200 / Math.max(1, sources.length)));
    const emptySources: string[] = [];
    for (const s of sources) {
      const rows = await engine.executeRaw<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM pages WHERE source_id = $1 LIMIT $2`,
        [s.id, perSourceCap],
      );
      if (Number(rows[0]?.n ?? 0) === 0) {
        emptySources.push(s.id);
      }
    }
    if (emptySources.length > 0) {
      return {
        name: 'source_routing_health',
        status: 'warn',
        message:
          `${emptySources.length} non-default source(s) have zero pages: ${emptySources.join(', ')}. ` +
          `If you've recently run \`gbrain import --source-id <id>\` against these, the writes may have ` +
          `silently fallen to the default source pre-v0.37.7.0. Re-run with --source-id; verify via ` +
          `\`gbrain sources current --json\`.`,
      };
    }
    return {
      name: 'source_routing_health',
      status: 'ok',
      message: `Multi-source brain (${sources.length} non-default source(s)); all populated`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'source_routing_health', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * v0.40 Federated Sync v2 (T12) — federation_health.
 *
 * Per-source dashboard surface for the autopilot/operator.
 * Three-state per-source (then aggregated to single Check):
 *
 *   ok    — all federated sources synced within 1h AND embed coverage >=95%
 *           (or chunks <100), AND failed_jobs_24h < 3
 *   warn  — any source has lag > 1h + federated, OR coverage < 95% with
 *           chunks > 100, OR failed_jobs_24h >= 3
 *   fail  — any source has lag > 24h, OR coverage < 50% with chunks > 1000
 *
 * Single-source brain short-circuits to ok (no federation to check).
 * Each warning carries a paste-ready remediation hint.
 */
export async function checkFederationHealth(engine: BrainEngine): Promise<Check> {
  try {
    const { loadAllSources } = await import('../../../core/sources-load.ts');
    const { computeAllSourceMetrics } = await import('../../../core/source-health.ts');
    const sources = await loadAllSources(engine, { includeArchived: false });
    if (sources.length <= 1) {
      return {
        name: 'federation_health',
        status: 'ok',
        message: 'Single-source brain (no federation to check)',
      };
    }
    const metrics = await computeAllSourceMetrics(engine, sources);

    const warns: string[] = [];
    const fails: string[] = [];
    for (const m of metrics) {
      const embedRemedy = embedBackfillWorkerSurface(engine).status === 'no_worker_surface'
        ? `gbrain embed --stale --source ${m.source_id}`
        : `gbrain jobs submit embed-backfill --params '{"sourceId":"${m.source_id}"}'`;
      // Fail thresholds first (most severe)
      if (m.lag_seconds !== null && m.lag_seconds > 24 * 3600) {
        fails.push(`${m.source_id}: stale ${Math.floor(m.lag_seconds / 3600)}h — run \`gbrain sync trigger --source ${m.source_id}\``);
        continue;
      }
      if (m.embed_coverage_pct < 50 && m.total_chunks > 1000) {
        fails.push(`${m.source_id}: ${m.embed_coverage_pct.toFixed(1)}% embed coverage (${m.total_chunks.toLocaleString()} chunks) — run \`${embedRemedy}\``);
        continue;
      }
      // Warns
      if (m.federated && m.lag_seconds !== null && m.lag_seconds > 3600) {
        warns.push(`${m.source_id}: federated source ${Math.floor(m.lag_seconds / 3600)}h+ stale — run \`gbrain sync trigger --source ${m.source_id}\``);
      }
      if (m.embed_coverage_pct < 95 && m.total_chunks > 100) {
        warns.push(`${m.source_id}: ${m.embed_coverage_pct.toFixed(1)}% embed coverage — run \`${embedRemedy}\``);
      }
      if (m.failed_jobs_24h >= 3) {
        warns.push(`${m.source_id}: ${m.failed_jobs_24h} failures in 24h — check \`gbrain jobs list --status failed\``);
      }
    }

    if (fails.length > 0) {
      return {
        name: 'federation_health',
        status: 'fail',
        message: `${fails.length} federation failure(s):\n  ${fails.join('\n  ')}`,
      };
    }
    if (warns.length > 0) {
      return {
        name: 'federation_health',
        status: 'warn',
        message: `${warns.length} federation warning(s):\n  ${warns.join('\n  ')}`,
      };
    }
    return {
      name: 'federation_health',
      status: 'ok',
      message: `${metrics.length} source(s) healthy (parallel sync, async embed)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'federation_health', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * v0.37.7.0 — Tier 5L oauth_confidential_client_health.
 *
 * Confidential OAuth clients (token_endpoint_auth_method != 'none')
 * MUST have a non-NULL client_secret_hash. v0.34.1.0's #909 fix
 * intentionally NULLs the column for public PKCE clients; if any
 * row claims confidential auth but has NULL hash, that's the
 * regression fingerprint from #1166.
 */
export async function checkOauthConfidentialHealth(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ client_id: string; method: string | null; hash: string | null }>(
      `SELECT client_id,
              token_endpoint_auth_method AS method,
              client_secret_hash AS hash
         FROM oauth_clients`,
    );
    if (rows.length === 0) {
      return { name: 'oauth_confidential_client_health', status: 'ok', message: 'No OAuth clients registered' };
    }
    const broken = rows.filter(r => {
      const isPublic = r.method === 'none';
      return !isPublic && (r.hash == null || r.hash === '');
    });
    if (broken.length > 0) {
      return {
        name: 'oauth_confidential_client_health',
        status: 'fail',
        message:
          `${broken.length} confidential OAuth client(s) have NULL/empty secret hash: ${broken.map(b => b.client_id).slice(0, 5).join(', ')}` +
          (broken.length > 5 ? ` (+${broken.length - 5} more)` : '') +
          `. Fix: \`gbrain auth revoke-client <id> && gbrain auth register-client …\` for each, OR \`gbrain upgrade\` if pre-v0.37.7.0.`,
      };
    }
    return {
      name: 'oauth_confidential_client_health',
      status: 'ok',
      message: `${rows.length} OAuth client(s) registered; all auth shapes consistent`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Pre-OAuth schema (oauth_clients table missing) → ok.
    if (msg.toLowerCase().includes('relation') && msg.toLowerCase().includes('does not exist')) {
      return { name: 'oauth_confidential_client_health', status: 'ok', message: 'OAuth not configured (skipping)' };
    }
    return { name: 'oauth_confidential_client_health', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * oauth_client_scope_health — scoped-client grant hygiene (cathedral-6).
 *
 * Two warn conditions, each a single query (no per-client N+1):
 *
 *  (a) DANGLING FEDERATED GRANTS — a federated read grant id with no
 *      sources row. oauth_clients.federated_read is a TEXT[] with no FK
 *      (only source_id carries ON DELETE RESTRICT), so removing a source
 *      leaves grants pointing at nothing and the client's reads silently
 *      return less than the operator believes was granted.
 *
 *  (b) ORPHANED EMPTY WORKSPACE SOURCES — an auto-created
 *      '<name>-workspace' source (DB-only: no local_path, zero pages, ZERO
 *      FACTS, not archived) that no live client references by write source
 *      or read grant. This is the post-failure / post-revoke residue
 *      heuristic for `gbrain agent register` derived workspaces. A
 *      non-default source WITH pages is normal on every local brain and is
 *      never flagged; a zero-page source WITH facts is a revoked agent's
 *      memory (the primary agent write lane) and is never flagged either —
 *      the `sources remove` hint would cascade the facts away.
 *
 * Pre-OAuth / pre-migration schemas (missing table or missing column)
 * short-circuit to ok — same posture as oauth_confidential_client_health.
 */
export async function checkOauthClientScopeHealth(engine: BrainEngine): Promise<Check> {
  try {
    // Single source of truth for the derived-workspace suffix — lazy import
    // (same pattern as the other checks) so agent-register.ts stays out of
    // doctor's static import graph.
    const { WORKSPACE_SUFFIX } = await import('../../agent-register.ts');
    const dangling = await engine.executeRaw<{ client_id: string; client_name: string | null; grant_id: string }>(
      `SELECT c.client_id, c.client_name, g.grant_id
         FROM oauth_clients c
         CROSS JOIN LATERAL unnest(c.federated_read) AS g(grant_id)
         LEFT JOIN sources s ON s.id = g.grant_id
        WHERE s.id IS NULL AND c.deleted_at IS NULL
        ORDER BY c.client_id, g.grant_id`,
    );
    // A revoked agent's workspace can hold FACTS with zero pages (facts are
    // the primary agent write lane) — such a source is NOT empty and the
    // `gbrain sources remove` recommendation would cascade the facts away.
    const orphanSql = (withFactsExclusion: boolean) =>
      `SELECT s.id
         FROM sources s
        WHERE s.id LIKE '%' || $1
          AND s.local_path IS NULL
          AND COALESCE(s.archived, false) = false
          AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = s.id)
          ${withFactsExclusion ? `AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.source_id = s.id)` : ''}
          AND NOT EXISTS (
            SELECT 1 FROM oauth_clients c
             WHERE c.deleted_at IS NULL
               AND (c.source_id = s.id OR s.id = ANY(c.federated_read))
          )
        ORDER BY s.id`;
    let orphaned: Array<{ id: string }>;
    try {
      orphaned = await engine.executeRaw<{ id: string }>(orphanSql(true), [WORKSPACE_SUFFIX]);
    } catch (e) {
      // Pre-v0.31 brain without the facts table: a source can't hold facts it
      // has no table for — retry without the exclusion. Scoped here (code-first
      // classification + the message must name `facts`) so the dangling-grant
      // arm's findings above aren't lost to the outer catch's schema-degrade.
      const msg = e instanceof Error ? e.message : String(e);
      if (!(isUndefinedTableError(e) && /facts/i.test(msg))) throw e;
      orphaned = await engine.executeRaw<{ id: string }>(orphanSql(false), [WORKSPACE_SUFFIX]);
    }
    const problems: string[] = [];
    if (dangling.length > 0) {
      const byClient = new Map<string, { name: string | null; grants: string[] }>();
      for (const d of dangling) {
        const entry = byClient.get(d.client_id) ?? { name: d.client_name, grants: [] };
        entry.grants.push(d.grant_id);
        byClient.set(d.client_id, entry);
      }
      const shown = [...byClient.entries()].slice(0, 5)
        .map(([id, e]) => `"${e.name ?? id}" (${id}) → ${e.grants.join(', ')}`);
      problems.push(
        `${dangling.length} federated read grant(s) point at missing sources: ${shown.join('; ')}` +
        (byClient.size > 5 ? ` (+${byClient.size - 5} more clients)` : '') +
        `. Fix each with \`gbrain auth rescope-client <client_id>\` (set a federated read list naming only existing sources), or recreate the source.`,
      );
    }
    if (orphaned.length > 0) {
      const shown = orphaned.slice(0, 5).map(o => o.id);
      problems.push(
        `${orphaned.length} empty auto-created workspace source(s) with no live client: ${shown.join(', ')}` +
        (orphaned.length > 5 ? ` (+${orphaned.length - 5} more)` : '') +
        `. May be residue from a revoked or failed \`gbrain agent register\`; verify before removing with \`gbrain sources remove <id>\`.`,
      );
    }
    if (problems.length > 0) {
      return {
        name: 'oauth_client_scope_health',
        status: 'warn',
        message: problems.join('\n'),
      };
    }
    return {
      name: 'oauth_client_scope_health',
      status: 'ok',
      message: 'Scoped-client grants consistent (no dangling federated reads, no orphaned workspace sources)',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Pre-OAuth schema (table missing) or pre-migration schema (column
    // missing) → ok, matching the confidential-client check's posture.
    // CODE-FIRST classification (42P01/42703 via core/utils): a bare message
    // regex would classify e.g. `function unnest(jsonb) does not exist` — a
    // type-drift failure this check exists to catch — as "schema not present"
    // and lie green. Column candidates are the optional oauth-scoping columns
    // this check's queries touch.
    const missingColumn = ['federated_read', 'source_id', 'deleted_at', 'archived', 'local_path']
      .some((c) => isUndefinedColumnError(e, c));
    if (isUndefinedTableError(e) || missingColumn) {
      return { name: 'oauth_client_scope_health', status: 'ok', message: 'OAuth scoping schema not present (skipping)' };
    }
    return { name: 'oauth_client_scope_health', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * v0.37.7.0 — Tier 5M autopilot_lock_scope (PID-safe hint per codex CF11).
 *
 * Detects stale autopilot lockfiles. When `GBRAIN_HOME` is set, the
 * canonical lock path lives under `gbrainPath('autopilot.lock')`.
 * If a hardcoded `~/.gbrain/autopilot.lock` ALSO exists outside the
 * current `GBRAIN_HOME`, that's a pre-v0.37.7.0 leftover or a
 * different brain's lock. Hint includes PID + a `ps -p` check so
 * the user verifies before deleting.
 */
export function checkAutopilotLockScope(): Check {
  try {
    const canonical = gbrainPath('autopilot.lock');
    const home = process.env.HOME || '';
    const legacy = home ? `${home}/.gbrain/autopilot.lock` : '';
    // Same path → nothing to surface.
    if (canonical === legacy || !legacy || !existsSync(legacy)) {
      return { name: 'autopilot_lock_scope', status: 'ok', message: `Lock path: ${canonical}` };
    }
    // legacy lock exists outside GBRAIN_HOME. Read its PID for a safe hint.
    let owningPid: string = 'unknown';
    try {
      const raw = readFileSync(legacy, 'utf8').trim();
      if (/^\d+$/.test(raw)) owningPid = raw;
    } catch { /* unreadable → leave 'unknown' */ }
    return {
      name: 'autopilot_lock_scope',
      status: 'warn',
      message:
        `Stale lockfile outside GBRAIN_HOME: ${legacy} (owning PID: ${owningPid}). ` +
        `Verify with \`ps -p ${owningPid}\` — if the process is dead, \`rm ${legacy}\`. ` +
        `If alive, identify it (\`ps -fp ${owningPid}\`) and stop before deleting.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'autopilot_lock_scope', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * v0.41.6.0 D3 — stale_locks doctor check.
 *
 * Surfaces every row in `gbrain_cycle_locks` whose `ttl_expires_at < NOW()`.
 * The TTL is the canonical staleness signal already trusted by
 * tryAcquireDbLock's UPDATE-on-conflict SQL — when TTL is in the past,
 * the next acquire attempt will sweep the row anyway. Doctor's job is to
 * warn the user proactively so the next sync doesn't get a surprise
 * "Another sync is in progress" with no fix hint.
 *
 * Paste-ready hint per stale lock: names the source-id from the
 * `gbrain-sync:<source>` lock-key shape so users can copy-paste the
 * exact recovery command.
 *
 * Out of scope (filed as v0.41+ follow-up TODO): detection of
 * "wedged but TTL-refreshing" locks where a refresh thread is alive
 * but the main work is blocked. Requires explicit heartbeat probe;
 * speculation until production data shows the case.
 */
export async function checkStaleLocks(
  engine: BrainEngine,
  opts: { fix?: boolean; dryRun?: boolean } = {},
): Promise<Check> {
  try {
    const { listStaleLocks, reapDeadHolderLocks } = await import('../../../core/db-lock.ts');

    // #1972: under `gbrain doctor --fix`, reap dead-holder sync/cycle locks
    // using the SAME namespace-scoped, host-scoped, snapshot-matched reaper the
    // cycle runs at start. This is the self-heal path for no-autopilot brains: a
    // brain that never runs `gbrain dream` never hits the cycle-start sweep, so
    // doctor --fix is how its crashed-sync locks get cleared. DB-only, so it's
    // orthogonal to (and unaffected by) the skills-dir --fix safety gate above.
    // Best-effort: a reap failure falls through to the warn path below.
    let reapedIds: string[] = [];
    if (opts.fix && !opts.dryRun) {
      try {
        reapedIds = (await reapDeadHolderLocks(engine)).reapedIds;
      } catch { /* fall through; listStaleLocks still surfaces remaining locks */ }
    }
    const reapedNote = reapedIds.length > 0
      ? `Reaped ${reapedIds.length} dead-holder lock(s): ${reapedIds.join(', ')}.`
      : null;

    const stale = await listStaleLocks(engine);
    if (stale.length === 0) {
      return {
        name: 'stale_locks',
        status: 'ok',
        message: reapedNote
          ? `${reapedNote} No stale locks remain.`
          : 'No stale locks (no rows with ttl_expires_at < NOW())',
      };
    }
    const lines = stale.slice(0, 10).map(s => {
      const ageH = Math.floor(s.age_ms / 3600_000);
      // Every hint here must be a REAL command: `gbrain dream --break-lock`
      // was advertised for years but dream never implemented the flag —
      // pasting the hint ran a full (paid) dream cycle instead of breaking a
      // lock. Cycle locks: dead-holder rows on THIS host are reaped by
      // `gbrain doctor --fix` (checkStaleLocks above) and swept automatically
      // at the next dream-cycle start; cross-host or live-holder locks have
      // no safe break command by design. The old fallback 'gbrain doctor' was
      // circular (this line IS doctor output) and plain doctor reaps nothing.
      let breakHint =
        'expired lock is swept at the next acquire; if it persists, inspect the gbrain_cycle_locks row';
      if (s.id.startsWith('gbrain-sync:')) {
        breakHint = `gbrain sync --break-lock --source ${s.id.slice('gbrain-sync:'.length)}`;
      } else if (s.id.startsWith('gbrain-cycle:') || s.id === 'gbrain-cycle') {
        breakHint = 'gbrain doctor --fix (reaps dead holders on this host; also swept at next dream start)';
      }
      return `  ${s.id} (pid ${s.holder_pid} on ${s.holder_host}, age ${ageH}h) → ${breakHint}`;
    });
    const tail = stale.length > 10 ? `  ... and ${stale.length - 10} more.` : null;
    const header = opts.fix
      ? `${stale.length} stale lock(s) remain that could not be auto-reaped (live holder, cross-host, or within the PID-reuse grace):`
      : `${stale.length} stale lock(s) detected (ttl_expires_at < NOW()):`;
    return {
      name: 'stale_locks',
      status: 'warn',
      message: [
        reapedNote,
        header,
        ...lines,
        tail,
      ].filter(Boolean).join('\n'),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Pre-v0.30 brains may not have the gbrain_cycle_locks table yet.
    if (/relation .* does not exist|no such table/i.test(msg)) {
      return { name: 'stale_locks', status: 'ok', message: 'gbrain_cycle_locks table not yet provisioned (skipping)' };
    }
    return { name: 'stale_locks', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * v0.38 — cycle_phase_scope check (informational).
 *
 * Renders the static `PHASE_SCOPE` taxonomy from `src/core/cycle.ts` so
 * operators (and future automation) can see at a glance which phases
 * are safe to parallelize per source vs which serialize brain-wide.
 *
 * Always returns 'ok' — this is documentation, not enforcement. The
 * runtime-enforcement TODO is deferred per plan.
 */
export function checkCyclePhaseScope(): Check {
  try {
    // Lazy require to avoid pulling cycle.ts into doctor's import graph
    // for non-cycle-related doctor runs. Same pattern as the existing
    // dynamic imports elsewhere in this file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ALL_PHASES, PHASE_SCOPE } = require('../../../core/cycle.ts') as {
      ALL_PHASES: ReadonlyArray<string>;
      PHASE_SCOPE: Record<string, 'source' | 'global' | 'mixed'>;
    };
    const counts: Record<'source' | 'global' | 'mixed', number> = { source: 0, global: 0, mixed: 0 };
    const breakdown: Record<string, string[]> = { source: [], global: [], mixed: [] };
    for (const phase of ALL_PHASES) {
      const scope = PHASE_SCOPE[phase];
      if (scope) {
        counts[scope]++;
        breakdown[scope].push(phase);
      }
    }
    return {
      name: 'cycle_phase_scope',
      status: 'ok',
      message:
        `Phase taxonomy: ${counts.source} source-scoped, ${counts.global} brain-global, ` +
        `${counts.mixed} mixed. Source-safe: [${breakdown.source.join(', ')}]. ` +
        `Brain-global: [${breakdown.global.join(', ')}]. Mixed: [${breakdown.mixed.join(', ')}].`,
      details: {
        phase_scope_map: PHASE_SCOPE,
        counts,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'cycle_phase_scope', status: 'warn', message: `Check failed: ${msg}` };
  }
}
