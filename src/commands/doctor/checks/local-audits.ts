/**
 * Filesystem-first audits: stub guard, sync failures, slug fallback, extraction / conversation backlogs, home-dir-in-worktree, npm squat, PGLite leftovers, default source path, FTS reindex, multi-source drift and orphan clones.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { applyExtractAtomsNoPricing, readExtractAtomsNoPricing } from '../../../core/cycle/extract-atoms-cost-gate.ts';
import { join } from 'path';
import { gbrainPath } from '../../../core/config.ts';
import { multiSourceDriftCheck, multiSourceDriftNotVerified } from '../schema-pack-checks.ts';
import { computeConversationFormatCoverageCheck } from './conversation-coverage.ts';
import {
  computeExtractHealthCheck,
  computeExtractAtomsBacklogCheck,
  computeAtomProvenanceDriftCheck,
} from './extraction-sync.ts';
import { buildHomeDirInWorktreeCheck } from './home-worktree.ts';
import {
  computeNightlyQualityProbeHealthCheck,
  computeConversationFactsBacklogCheck,
  computeConversationParserProbeHealthCheck,
} from './search-eval.ts';
import type { Check } from '../../doctor.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

async function runStubGuard(ctx: DoctorContext): Promise<Check[]> {
  const { engine, orphanRatioSourceId } = ctx;
  const checks: Check[] = [];

  // 3b-tris. Stub-guard fire count (last 24h). The v0.34.5 stub guard in
  // fence-write.ts refuses to spawn unprefixed entity pages (bare `alice.md`
  // at brain root); the #4108 arm refuses pages for fallback-resolved slugs
  // no live page backs. Fires append per-arm `reason` lines to
  // ~/.gbrain/audit/stub-guard-YYYY-Www.jsonl (pre-#4108 lines lack one and
  // count as unprefixed). The v0.36 sunset criterion covers 'unprefixed'
  // ONLY; the fallback_resolution arm never sunsets.
  //
  // WARN at >10 fires/24h — at that rate the resolver is probably missing
  // a case (typo prefix, alias, non-Latin script). Operators should grep
  // the audit log for the slugs that hit it and either add the missing
  // resolver branch or document them as legitimate bare-slug ingestion.
  try {
    const { readRecentStubGuardEvents } = await import('../../../core/facts/stub-guard-audit.ts');
    const events = readRecentStubGuardEvents({ sinceMs: 24 * 60 * 60 * 1000 });
    const fallbackCount = events.filter((e) => e.reason === 'fallback_resolution').length;
    const reasonSplit = `unprefixed=${events.length - fallbackCount}, fallback_resolution=${fallbackCount}`;
    if (events.length > 10) {
      // Surface the top 3 slugs that hit it so operators have somewhere to start.
      const slugCounts = new Map<string, number>();
      for (const e of events) slugCounts.set(e.slug, (slugCounts.get(e.slug) ?? 0) + 1);
      const topSlugs = [...slugCounts.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([slug, n]) => `${slug}(${n})`).join(', ');
      checks.push({
        name: 'stub_guard_24h',
        status: 'warn',
        message:
          `Stub guard fired ${events.length}x in last 24h (${reasonSplit}; top: ${topSlugs}). ` +
          `If this stays elevated, the prefix-expansion in resolveEntitySlug is ` +
          `missing a case. Check ~/.gbrain/audit/stub-guard-*.jsonl for the slugs ` +
          `that hit it.`,
      });
    } else if (events.length > 0) {
      checks.push({
        name: 'stub_guard_24h',
        status: 'ok',
        message: `Stub guard fired ${events.length}x in last 24h (${reasonSplit}; below WARN threshold of 10).`,
      });
    }
    // Zero hits is the goal — emit no check at all so the doctor output stays clean.
  } catch {
    // Audit read failure is best-effort; skip silently.
  }

  // 3c. Sync failure trail (Bug 9). sync.ts gates the `sync.last_commit`
  // bookmark when per-file parse errors happen, and appends each failure
  // to ~/.gbrain/sync-failures.jsonl with the commit hash + exact error.
  // Without this doctor check, users see "sync blocked" and have no
  // surface showing which files to fix.
  try {
    const { checkSyncFailures } = await import('./sync-failures.ts');
    const check = await checkSyncFailures(engine, { remote: false, sourceIds: orphanRatioSourceId ? [orphanRatioSourceId] : undefined });
    if (check) checks.push(check);
  } catch {
    checks.push({ name: 'sync_failures', status: 'warn', message: 'Durable sync failure state could not be read; health is unknown.' });
  }
  try {
    const { checkManagedSyncBacklog } = await import('./managed-sync-backlog.ts');
    const check = await checkManagedSyncBacklog(engine, orphanRatioSourceId ? [orphanRatioSourceId] : undefined);
    if (check) checks.push(check);
  } catch { /* managed backlog is informational; doctor's other checks report persistence health */ }

  // 3d. Slug-fallback audit (v0.32.7 CJK wave, codex C7). Informational
  // count of pages where importFromFile fell back to a frontmatter slug
  // because the path slugified empty (emoji / Thai / Arabic / exotic-script
  // filenames). NOT routed through sync-failures.jsonl — that surface
  // gates bookmark advancement, info rows don't fit there.
  try {
    const { readRecentSlugFallbacks } = await import('../../../core/audit-slug-fallback.ts');
    const fallbacks = readRecentSlugFallbacks(7);
    if (fallbacks.length > 0) {
      checks.push({
        name: 'slug_fallback_audit',
        status: 'ok',
        message: `info: ${fallbacks.length} slug fallback${fallbacks.length === 1 ? '' : 's'} in the last 7 days (SLUG_FALLBACK_FRONTMATTER).`,
      });
    }
  } catch {
    // Best-effort; audit-log read failure shouldn't stop doctor.
  }
  return checks;
}

export const stubGuardEntry: DoctorEntry = {
  name: 'stub_guard_24h',
  emits: ['stub_guard_24h', 'sync_failures', 'managed_sync_backlog', 'slug_fallback_audit'],
  run: runStubGuard,
};

async function runExtractionBacklogs(ctx: DoctorContext): Promise<Check[]> {
  const { engine } = ctx;
  const checks: Check[] = [];

  // 3d.05 Malformed-path pages. DB pages whose backing FILENAME contains
  // bracket/control characters (markdown-link syntax as a literal filename).
  // Sync refuses to import such markdown paths; this check is the discovery
  // surface for rows ingested before that gate. Two-tier remediation matches
  // core/sync.ts: POISONED rows (`](`/control chars) reconcile away on a full
  // sync; bare-bracket rows are kept (deleting them while their file exists
  // would be data loss) and need a rename + re-sync.
  if (engine) {
    try {
      const { hasMalformedPathSegment, isPoisonedPath } = await import('../../../core/sync.ts');
      const candidates = await engine.executeRaw<{ slug: string; source_id: string; source_path: string }>(
        `SELECT slug, source_id, source_path FROM pages
          WHERE source_path IS NOT NULL AND deleted_at IS NULL
            AND (source_path LIKE '%[%' OR source_path LIKE '%]%'
                 OR source_path ~ '[[:cntrl:]]')`,
        [],
      );
      const malformed = candidates.filter(r => hasMalformedPathSegment(r.source_path));
      if (malformed.length > 0) {
        const poisoned = malformed.filter(r => isPoisonedPath(r.source_path)).length;
        const bare = malformed.length - poisoned;
        const preview = malformed.slice(0, 3).map(r => r.slug).join(', ');
        checks.push({
          name: 'malformed_path_pages',
          status: 'warn',
          message:
            `${malformed.length} page(s) backed by malformed filenames (bracket/control ` +
            `characters) pollute search: ${preview}` +
            `${malformed.length > 3 ? `, and ${malformed.length - 3} more` : ''}. ` +
            (poisoned > 0 ? `${poisoned} junk row(s): run a full 'gbrain sync' to reconcile them away. ` : '') +
            (bare > 0 ? `${bare} bare-bracket row(s) are kept — rename the backing file(s) and re-sync.` : ''),
        });
      }
    } catch {
      // Best-effort; a schema without source_path shouldn't stop doctor.
    }
  }

  // 3d.1 Nightly quality probe (v0.40.1.0 Track D / T7). Reads the last
  // 7 days of quality-probe-YYYY-Www.jsonl audit events. SKIPPED with
  // paste-ready enable hint when the feature is opt-in disabled (default).
  // WARN on any FAIL / ERROR / BUDGET_EXCEEDED row in the window; OK when
  // all rows are PASS. The probe itself is wired into autopilot, NOT into
  // doctor — doctor just surfaces what the probe wrote.
  try {
    const { readRecentQualityProbeEvents } = await import('../../../core/audit-quality-probe.ts');
    const { loadConfig } = await import('../../../core/config.ts');
    const { resolveProbeEnabled } = await import('../../../core/cycle/nightly-quality-probe.ts');
    let probeEnabled = false;
    try {
      // Dual-plane read, matching the autopilot gate: the DB row (what the
      // enable hint's `gbrain config set` writes) wins; file plane fallback.
      let dbVal: string | null = null;
      try {
        dbVal = engine ? await engine.getConfig('autopilot.nightly_quality_probe.enabled') : null;
      } catch { /* DB unavailable → file plane only */ }
      const cfg = loadConfig();
      probeEnabled = resolveProbeEnabled(dbVal, (cfg as any)?.autopilot?.nightly_quality_probe?.enabled);
    } catch { /* config unavailable → treat as disabled */ }
    const events = readRecentQualityProbeEvents(7);
    const check = computeNightlyQualityProbeHealthCheck(probeEnabled, events);
    checks.push(check);
  } catch {
    // Best-effort; audit-log read failure shouldn't stop doctor.
  }

  // 3d.3 v0.42 — extract_health. Reads extract_rollup_7d (migration v106)
  // for per-kind aggregates. Empty rollup → OK. High halt rate per kind
  // → WARN. Rollup write failures → WARN (audit JSONL is the SoT, but
  // operator should know the DB cache is degraded). See plan A5 + D-EXTRACT-32.
  if (engine) {
    try {
      // An explicit extract_atoms cap that refused an unpriced model is an
      // expected limit in the rollup, not a halt; the overlay names the fix.
      const check = await computeExtractHealthCheck(engine);
      applyExtractAtomsNoPricing(check, await readExtractAtomsNoPricing(engine).catch(() => []));
      checks.push(check);
    } catch {
      // Best-effort; rollup-table missing on pre-v106 brains is normal
      // and is already handled inside computeExtractHealthCheck.
    }
  }

  // 3d.2 v0.41.11.0 — conversation_facts_backlog. 3-state status:
  // SKIPPED-with-enable-hint when the cycle phase is disabled (opt-out
  // users don't get noise debt); OK at backlog=0; WARN at backlog>10
  // with a paste-ready fix command. Emits a Remediation when WARN.
  if (engine) {
    try {
      const check = await computeConversationFactsBacklogCheck(engine);
      // Wire a remediation step on WARN so `gbrain doctor --remediate`
      // picks it up. The CLI command honors --max-cost-usd; the
      // remediation step caps at $5 default (matches doctor's max_usd
      // default for the remediate flow).
      if (check.status === 'warn') {
        try {
          const { makeRemediationStep } = await import('../../../core/remediation-step.ts');
          const remediation = makeRemediationStep({
            id: 'conversation_facts_backfill',
            job: 'extract-conversation-facts',
            params: { sourceId: 'default', maxCostUsd: 5 },
            severity: 'medium',
            est_seconds: 600,
            est_usd_cost: 5,
            rationale:
              'Backfill facts for conversation/meeting/slack/email pages so chunker-loses-anchor recall misses get a topical-header-rich facts row to bind to.',
          });
          check.remediation = [remediation];
          check.remediation_status = 'remediable';
        } catch {
          // remediation factory unavailable → check still surfaces backlog
        }
      }
      checks.push(check);
    } catch {
      // Best-effort; backlog query failure shouldn't stop doctor.
    }
  }

  // 3d.2b issue #1678 — extract_atoms_backlog. Surfaces the silent
  // pack-gated-phase backlog: when the active pack doesn't run extract_atoms
  // but eligible pages pile up, WARN with the `--drain` command. OK when the
  // pack runs the phase (routine cycle drains it) or there's no backlog.
  if (engine) {
    try {
      checks.push(await computeExtractAtomsBacklogCheck(engine));
    } catch {
      // Best-effort; backlog query failure shouldn't stop doctor.
    }
    // The mirror of the backlog check: atoms whose source_hash no longer
    // resolves to any live page (#4566). Same best-effort posture.
    try {
      checks.push(await computeAtomProvenanceDriftCheck(engine));
    } catch {
      // Best-effort; provenance query failure shouldn't stop doctor.
    }
  }

  // 3d.3 v0.41.13.0 — conversation_format_coverage. Peeled to
  // doctor/checks/conversation-coverage.ts (#4193) so it is unit-testable;
  // summary-only conversation pages report separately instead of counting
  // as parser misses. Error handling lives inside the compute function.
  if (engine) {
    checks.push(await computeConversationFormatCoverageCheck(engine));
  }

  // 3d.4 v0.41.13.0 — progressive_batch_audit_health. Reads last 7
  // days of `~/.gbrain/audit/progressive-batch-YYYY-Www.jsonl` and
  // surfaces operations that aborted with `abort_*` verdicts so
  // operators see what went wrong without grep'ing the JSONL by hand.
  try {
    const { readRecentProgressiveBatchEvents } = await import(
      '../../../core/progressive-batch/audit.ts'
    );
    const events = readRecentProgressiveBatchEvents(7);
    const aborts = events.filter((e) => e.verdict !== 'proceed');
    if (aborts.length === 0) {
      checks.push({
        name: 'progressive_batch_audit_health',
        status: 'ok',
        message:
          events.length === 0
            ? 'No progressive-batch operations in the last 7 days'
            : `${events.length} progressive-batch events; 0 aborts`,
      });
    } else {
      const reasonsCounted: Record<string, number> = {};
      for (const e of aborts) {
        const key = e.abort_reason ?? e.verdict;
        reasonsCounted[key] = (reasonsCounted[key] ?? 0) + 1;
      }
      const breakdown = Object.entries(reasonsCounted)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      checks.push({
        name: 'progressive_batch_audit_health',
        status: 'warn',
        message:
          `${aborts.length}/${events.length} progressive-batch events aborted in last 7d. ` +
          `Breakdown: ${breakdown}. ` +
          `Inspect: cat ~/.gbrain/audit/progressive-batch-*.jsonl | jq 'select(.verdict != "proceed")'`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'progressive_batch_audit_health',
      status: 'ok',
      message: `Skipped (audit file unreachable): ${(err as Error)?.message ?? String(err)}`,
    });
  }

  // 3d.5 v0.41.13.0 — conversation_parser_probe_health. Mode-gated
  // per D10: ON when search.mode=tokenmax, opt-in for other modes.
  // Surfaces the last 7 days of nightly-probe audit events; warn on any
  // non-pass outcome (fail / budget_exceeded / adversarial_false_positive).
  // (Until the autopilot wire-up this was a hardcoded "Skipped" stub.)
  try {
    const { readRecentParserProbeEvents } = await import('../../../core/audit-parser-probe.ts');
    let parserProbeEnabled = false;
    try {
      let dbVal: string | null = null;
      let dbMode: string | null = null;
      try {
        dbVal = engine ? await engine.getConfig('autopilot.conversation_parser_probe.enabled') : null;
        dbMode = engine ? await engine.getConfig('search.mode') : null;
      } catch { /* DB unavailable → file plane only */ }
      const { loadConfig } = await import('../../../core/config.ts');
      const fileVal = (loadConfig() as any)?.autopilot?.conversation_parser_probe?.enabled;
      const flagOn = dbVal != null ? dbVal === 'true' : fileVal === true;
      parserProbeEnabled = flagOn || dbMode === 'tokenmax';
    } catch { /* config unavailable → treat as disabled */ }
    const parserEvents = readRecentParserProbeEvents(7);
    checks.push(computeConversationParserProbeHealthCheck(parserProbeEnabled, parserEvents));
  } catch {
    // Best-effort; audit-log read failure shouldn't stop doctor.
  }
  return checks;
}

export const extractionBacklogsEntry: DoctorEntry = {
  name: 'malformed_path_pages',
  emits: [
    'malformed_path_pages',
    'nightly_quality_probe_health',
    'extract_health',
    'conversation_facts_backlog',
    'extract_atoms_backlog',
    'atom_provenance_drift',
    'conversation_format_coverage',
    'progressive_batch_audit_health',
    'conversation_parser_probe_health',
  ],
  run: runExtractionBacklogs,
};

async function runHomeDirInWorktree(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];

  // 3e. home_dir_in_worktree (v0.35.8.0; peeled to doctor/checks/home-worktree.ts).
  // Walks up from `gbrainPath()` toward $HOME looking for a VALIDATED `.git`
  // marker (#4683: an empty/invalid `.git` git itself rejects no longer warns).
  // Honors GBRAIN_HOME via gbrainPath().
  try {
    checks.push(buildHomeDirInWorktreeCheck(
      gbrainPath(),
      process.env.HOME || '',
      Boolean(process.env.GBRAIN_HOME),
    ));
  } catch {
    // Best-effort filesystem-hygiene check; never block doctor.
  }

  // 3f. npm_squat (#505). The npm registry name `gbrain` belongs to an
  // unrelated third-party package — this project is NOT distributed on npm.
  // A reflexive `npm i -g gbrain` / `bun add -g gbrain` installs something
  // unrelated that can shadow the real binary on PATH. Classify every
  // `gbrain` that `which -a` finds (pure helpers in
  // src/core/npm-squat-check.ts) and warn when an unrelated install wins on
  // PATH or the entry is broken. Skips silently when gbrain isn't on PATH
  // at all (e.g. running via `bun src/cli.ts`).
  try {
    const { execSync } = await import('node:child_process');
    let candidates: string[] = [];
    try {
      candidates = execSync('which -a gbrain', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // `which` exits non-zero when gbrain isn't on PATH (or is missing
      // entirely on this platform) — nothing to check.
    }
    const { assessGbrainBinaries } = await import('../../../core/npm-squat-check.ts');
    const assessment = assessGbrainBinaries(candidates);
    if (assessment.status !== 'skip') {
      checks.push({
        name: 'npm_squat',
        status: assessment.status,
        message: assessment.message,
      });
    }
  } catch {
    // Best-effort environment check; never block doctor.
  }

  // 3g. pglite_leftovers (#3856). A pglite -> postgres migration leaves the
  // old engine store (`brain.pglite/`) under the gbrain home forever — dead
  // weight roughly the size of the live DB that nothing surfaces, silently
  // riding along in any backup that archives the home dir. Assessment is a
  // pure helper (src/core/pglite-leftovers-check.ts); it warns ONLY for a
  // durable postgres engine, and skips while `migrate-manifest.json` exists
  // (an in-flight/interrupted migration can make `brain.pglite` the LIVE
  // target while the durable engine still reads postgres — #3194) and for
  // everything else (fail open).
  // The engine is read from config.json DIRECTLY, not loadConfig(): a
  // transient DATABASE_URL (#427) can make a live PGLite brain resolve as
  // postgres for one process, and deletion advice must never rest on an
  // env override (Codex review P1).
  // Warn-only by design: WHEN the abandoned store is safe to drop is a
  // policy question (#3856), so the legacy store's remediation is a verified
  // manual delete — no CLI command is named that does not exist (#3697).
  // Engine graduation's retained copy of the recorded run names
  // `gbrain migrate --discard-source`, which asks before it deletes.
  try {
    const { readFileSync } = await import('node:fs');
    const durableEngine = (
      JSON.parse(readFileSync(join(gbrainPath(), 'config.json'), 'utf8')) as { engine?: unknown }
    ).engine;
    const { assessPgliteLeftovers, SIZE_WALK_MAX_ENTRIES } = await import('../../../core/pglite-leftovers-check.ts');
    const { readGraduationManifestSummary, TERMINAL_MANIFEST_STATES } = await import('../../../core/persistence/graduation-serve-guard.ts');
    const manifest = readGraduationManifestSummary();
    const leftovers = assessPgliteLeftovers(
      typeof durableEngine === 'string' ? durableEngine : undefined,
      gbrainPath(),
      SIZE_WALK_MAX_ENTRIES,
      manifest ? { inFlight: !TERMINAL_MANIFEST_STATES.has(manifest.state), retainedPath: `${manifest.dataDir}.graduated-${manifest.runId}` } : null,
    );
    if (leftovers.status !== 'skip') {
      const copy = leftovers.retained?.[0];
      // The recorded, graduated run's copy has its own confirmation-gated command; any other retained copy is a manual delete.
      const recorded = manifest?.state === 'graduated' ? leftovers.retained?.find(r => r.path.includes(`.graduated-${manifest.runId}`)) : undefined;
      const { discardArgv } = await import('../../../core/persistence/graduation-errors.ts');
      const verify = { argv: ['gbrain', 'doctor', '--only', 'pglite_leftovers', '--json'] };
      checks.push({
        name: 'pglite_leftovers',
        status: leftovers.status,
        message: leftovers.message,
        ...(copy ? {
          details: { retained: leftovers.retained },
          fix: recorded ? {
            argv: discardArgv(), preview_argv: discardArgv(['--dry-run']), consent: [], actor: 'agent', requires_exclusive: false,
            verify, docs: 'docs/guides/move-to-postgres.md#discard-the-retained-copy',
            why: `${recorded.path} is the PGLite brain engine graduation moved to Postgres; it still holds private memory and token hashes. The command changes nothing on its own: it prints what it deletes (the copy, the tombstone and the intent marker) with the user's question and a plan_hash, and exits 3. Only the approved \`--yes --expect <plan_hash>\` run deletes them, which ends the option to roll back.`,
          } : {
            argv: ['rm', '-rf', copy.path], consent: ['destructive'], actor: 'agent', requires_exclusive: false,
            verify, docs: 'docs/guides/move-to-postgres.md#after-the-move',
            why: `${copy.path} is the PGLite brain engine graduation moved to Postgres; it still holds private memory and token hashes. Deleting it frees the disk and ends the option to roll back.`,
            user_message: `After moving your brain to Postgres, gbrain kept the old local copy at ${copy.path}. It still contains your private memory and access-token hashes. Should I delete it? You could then no longer roll back to it.`,
          },
        } : {}),
      });
    }
  } catch {
    // Best-effort filesystem-hygiene check; never block doctor (a missing/
    // unparseable config.json lands here and skips, same fail-open posture).
  }
  // Engine graduation state (filesystem only; src/commands/doctor/checks/engine-graduation.ts).
  try {
    const { graduationStateCheck } = await import('./engine-graduation.ts');
    const graduation = graduationStateCheck();
    if (graduation) checks.push(graduation);
  } catch {
    // Best-effort: a malformed manifest or marker never blocks doctor.
  }
  return checks;
}

export const homeDirInWorktreeEntry: DoctorEntry = {
  name: 'home_dir_in_worktree',
  emits: ['home_dir_in_worktree', 'npm_squat', 'pglite_leftovers', 'graduation_interrupted'],
  run: runHomeDirInWorktree,
};

async function runDefaultSourcePath(ctx: DoctorContext): Promise<Check[]> {
  const { engine } = ctx;
  const checks: Check[] = [];

  // 3a-bis. default_source_local_path (#4739, narrowed). A null
  // default.local_path is the DESIGNED fallback topology (pages nest under
  // sync.repo_path), so this only warns when that fallback demonstrably
  // fails: file-backed default pages with no resolvable root, or a
  // sync.repo_path the #2018 leak guard silently skips. Logic lives in
  // doctor/checks/default-source-path.ts (module-dir rule).
  if (engine !== null) try {
    const { defaultSourceLocalPathCheck } = await import('./default-source-path.ts');
    const dspCheck = await defaultSourceLocalPathCheck(engine!);
    if (dspCheck) checks.push(dspCheck);
  } catch {
    // Best-effort. A broken sources table should not stop doctor.
  }

  // 3a-ter. fts_reindex_incomplete (#4795). An interrupted
  // `reindex-search-vector` leaves the trigger language flipped with rows
  // still un-backfilled; the command's marker row stays set until it
  // completes. Logic lives in doctor/checks/fts-reindex.ts (module-dir rule).
  if (engine !== null) try {
    const { ftsReindexIncompleteCheck } = await import('./fts-reindex.ts');
    const ftsCheck = await ftsReindexIncompleteCheck(engine!);
    if (ftsCheck) checks.push(ftsCheck);
  } catch {
    // Best-effort. A missing config table should not stop doctor.
  }

  // 3b-multi-source. Multi-source drift (v0.31.8 — D8 + D17 + OV12 + OV13).
  // Pre-v0.30.3 putPage misrouted multi-source writes to (default, slug).
  // For each non-default source with local_path set, walk the FS and surface
  // slugs that exist at default but NOT at the intended source. Only runs
  // on multi-source brains (sources count > 1). Single-source brains skip.
  // Engine is nullable in runDoctor (--fast / DB-down skip the DB phase);
  // bail silently here when engine is null since the check needs DB access.
  if (engine !== null) try {
    const { findMisroutedPages } = await import('../../../core/multi-source-drift.ts');
    const sources = await engine!.executeRaw<{ id: string; local_path: string | null }>(
      `SELECT id, local_path FROM sources`,
    );
    const nonDefaultWithPath = sources.filter(s => s.id !== 'default' && s.local_path);
    if (sources.length > 1 && nonDefaultWithPath.length > 0) {
      const result = await findMisroutedPages(
        engine!,
        nonDefaultWithPath.map(s => ({ id: s.id, local_path: s.local_path as string })),
      );
      checks.push(multiSourceDriftCheck(result, nonDefaultWithPath.length, 'local'));
    }
  } catch (e) {
    // A broken sources table must not stop doctor, but the check still
    // reports that it verified nothing (#5432).
    checks.push(multiSourceDriftNotVerified(e));
  }

  // 3c. Orphan clone temp dirs (v0.28 P1). `gbrain sources add --url` clones
  // into $GBRAIN_HOME/clones/.tmp/<id>-<rand>/ and renames atomically; if the
  // process is SIGKILL'd between clone-finish and rename, the temp dir
  // orphans. Surface entries older than 24h so operators notice before the
  // disk fills. The autopilot purge phase nukes these on its cadence; this
  // check just makes the state visible.
  try {
    const fs = await import('fs');
    const cfg = await import('../../../core/config.ts');
    const tmpRoot = cfg.gbrainPath('clones', '.tmp');
    if (fs.existsSync(tmpRoot)) {
      const STALE_MS = 24 * 3600 * 1000;
      const now = Date.now();
      const stale: { name: string; ageHours: number }[] = [];
      for (const ent of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
        const full = join(tmpRoot, ent.name);
        try {
          const st = fs.lstatSync(full);
          const age = now - st.mtimeMs;
          if (age > STALE_MS) {
            stale.push({ name: ent.name, ageHours: Math.floor(age / 3600_000) });
          }
        } catch {
          /* skip unreadable */
        }
      }
      if (stale.length === 0) {
        checks.push({
          name: 'orphan_clones',
          status: 'ok',
          message: `No stale clone temp dirs in ${tmpRoot}.`,
        });
      } else {
        checks.push({
          name: 'orphan_clones',
          status: 'warn',
          message:
            `${stale.length} stale clone temp dir(s) in ${tmpRoot}: ` +
            stale.map(s => `${s.name} (${s.ageHours}h)`).join(', ') +
            `. Run \`gbrain sources purge-orphan-clones\` or wait for the autopilot purge phase.`,
        });
      }
    }
  } catch {
    // Filesystem read failure is non-fatal.
  }
  return checks;
}

export const defaultSourcePathEntry: DoctorEntry = {
  name: 'default_source_local_path',
  emits: ['default_source_local_path', 'fts_reindex_incomplete', 'multi_source_drift', 'orphan_clones'],
  run: runDefaultSourcePath,
};
