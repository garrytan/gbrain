/**
 * Local runtime checks: agent bootstrap, memorable relay and ambient writeback, chat connectors, the dream paid-loop breaker, and the migration / upgrade trail.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { loadCompletedMigrations } from '../../../core/preferences.ts';
import { compareVersions } from '../../migrations/index.ts';
import { bootstrapDoctorChecks } from '../bootstrap-checks.ts';
import { buildMemorableRelayCheck } from './integrations-memorable.ts';
import { buildMemoryWritebackCheck } from './memory-writeback.ts';
import { checkSelfUpgradeHealth, checkUpgradeErrors } from './upgrade-health.ts';
import type { Check } from '../../doctor.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

async function runBootstrapChecks(ctx: DoctorContext): Promise<Check[]> {
  const { engine } = ctx;
  const checks: Check[] = [];

  // 2d. Agent-bootstrap health (plan B2/B4/ENG-4). Filesystem-first; the
  // one engine-dependent pairing check degrades gracefully when engine is
  // null. Emits NOTHING on machines with no bootstrap state, so ordinary
  // brains keep a clean doctor.
  checks.push(...(await bootstrapDoctorChecks(engine)));
  return checks;
}

export const bootstrapChecksEntry: DoctorEntry = {
  name: 'plugin_lane_collision',
  emits: [
    'plugin_lane_collision',
    'bootstrap_harness_health',
    'bootstrap_hooks_heartbeat',
    'bootstrap_push_health',
    'bootstrap_durability_job',
    'bootstrap_serve_lock',
    'bootstrap_hook_schema_pairing',
    'bootstrap_runbook_skew',
    'bootstrap_last_verify',
  ],
  run: runBootstrapChecks,
};

async function runMemorableRelay(ctx: DoctorContext): Promise<Check[]> {
  const { engine, progress } = ctx;
  const checks: Check[] = [];

  // 2e. Memorable relay health — engine-free, file-plane only, so it runs
  // unconditionally (survives --fast and every --scope). Gate off = one quiet
  // ok row; the states it exists to catch are enabled-without-disclosure and
  // enabled-but-never-actually-relaying.
  checks.push(await buildMemorableRelayCheck());

  // 2e-bis. Ambient-writeback health (WP6): resolved mode/TTL/visibility +
  // brain audience, installed instruction blocks (receipt vs live probe vs
  // drift), validity-lapsed count, and the 7d local counters. Off = one
  // quiet ok row (opt-in convention).
  progress.heartbeat('memory_writeback');
  checks.push(await buildMemoryWritebackCheck(engine));
  return checks;
}

export const memorableRelayEntry: DoctorEntry = {
  name: 'memorable_relay_health',
  emits: ['memorable_relay_health', 'memory_writeback'],
  run: runMemorableRelay,
};

async function runConnectors(ctx: DoctorContext): Promise<Check[]> {
  const { engine } = ctx;
  const checks: Check[] = [];

  // 2f. Chat-connector health (D3.2): re-auth-needed / stalled-sync / drift.
  // Credential-gated + auto_sync-gated — emits a plain "ok" (no nag) on brains
  // with no connectors or a manual-only user.
  if (engine) {
    try {
      const { connectorsHealthCheck } = await import('./connectors.ts');
      checks.push(await connectorsHealthCheck(engine));
    } catch {
      // best-effort; a connectors check failure must never break doctor
    }
  }

  // 2g. Dream paid-loop breaker: keys whose submissions keep dying.
  if (engine) {
    try {
      const { dreamPaidLoopCheck } = await import('./dream-breaker.ts');
      checks.push(await dreamPaidLoopCheck(engine));
    } catch (e) {
      checks.push({ name: 'dream_paid_loop', status: 'warn', message: `Could not count dead dream submissions: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return checks;
}

export const connectorsEntry: DoctorEntry = {
  name: 'connectors',
  emits: ['connectors', 'dream_paid_loop'],
  run: runConnectors,
};

async function runMinionsMigration(ctx: DoctorContext): Promise<Check[]> {
  const { engine } = ctx;
  const checks: Check[] = [];

  // 3. Half-migrated Minions detection (filesystem-only).
  // If completed.jsonl has any status:"partial" entry with no later
  // status:"complete" for the same version, the install is mid-migration.
  // Typical cause: v0.11.0 stopgap wrote a partial record but nobody ran
  // `gbrain apply-migrations --yes` afterward. This check fires on every
  // `gbrain doctor` invocation so your OpenClaw's health skill catches it.
  //
  // Forward-progress override: a partial entry for vX.Y.Z is treated as
  // stale (not stuck) if there is a `complete` entry for any vA.B.C >= vX.Y.Z
  // anywhere in the file. The reasoning: if a newer migration successfully
  // landed, the install moved past the older partial — the old record is
  // historical noise from a stopgap that never finished cleanly, but the
  // schema clearly advanced. Without this, every install that went through
  // a v0.11.0 stopgap and then upgraded carries the "MINIONS HALF-INSTALLED"
  // flag forever, even on installs that have been at v0.22+ for months.
  try {
    const completed = loadCompletedMigrations();
    const byVersion = new Map<string, { complete: boolean; partial: boolean }>();
    for (const entry of completed) {
      const seen = byVersion.get(entry.version) ?? { complete: false, partial: false };
      if (entry.status === 'complete') seen.complete = true;
      if (entry.status === 'partial') seen.partial = true;
      byVersion.set(entry.version, seen);
    }
    const completedVersions = Array.from(byVersion.entries())
      .filter(([, s]) => s.complete)
      .map(([v]) => v);
    const stuck = Array.from(byVersion.entries())
      .filter(([v, s]) => {
        if (!s.partial || s.complete) return false;
        // Forward-progress override: if any version >= v has completed, the
        // partial is stale. compareVersions returns 1 when first arg is newer.
        const supersededBy = completedVersions.find(cv => compareVersions(cv, v) >= 0);
        return supersededBy === undefined;
      })
      .map(([v]) => v);

    // v0.31.8 (D19): detect 3-consecutive-partials shape (the apply-migrations
    // wedge condition). The `stuck` filter above already excludes
    // forward-progress-superseded versions, so we only count actual unresolved
    // partials per version. A version with >=3 trailing partials needs
    // `gbrain apply-migrations --force-retry <v>` once before plain --yes
    // will succeed (the 3-consecutive-partials guard in apply-migrations.ts
    // is still active). Without this hint, operators wedged on v0.29.1 (and
    // any future migration that hits the same guard) get "run --yes" advice
    // that won't unstick them.
    const wedged: string[] = [];
    for (const v of stuck) {
      const partialCount = completed.filter(
        e => e.version === v && e.status === 'partial',
      ).length;
      if (partialCount >= 3) wedged.push(v);
    }

    if (wedged.length > 0) {
      // The wedged set is a STRICT subset of the stuck set, so a wedged
      // version is also stuck. Surface the force-retry hint instead of the
      // generic --yes hint; chained with `&&` when multiple versions are
      // wedged so the operator can copy-paste a single line.
      const cmd = wedged.map(v => `gbrain apply-migrations --force-retry ${v}`).join(' && ');
      checks.push({
        name: 'minions_migration',
        status: 'fail',
        message: `WEDGED MIGRATION(s): ${wedged.join(', ')} (>=3 consecutive partials). Run: ${cmd}`,
      });
    } else if (stuck.length > 0) {
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

  // 3b. Upgrade-error trail (v0.13+). See checkUpgradeErrors for the #4517
  // staleness re-verification semantics (binary version + schema ledger).
  const upgradeErrorsCheck = await checkUpgradeErrors(engine);
  if (upgradeErrorsCheck) checks.push(upgradeErrorsCheck);

  // 3b-ter. Self-upgrade health (#3747). Pure local-file check (config +
  // upgrade cache + audit trail; no DB) that was only ever pushed by the
  // REMOTE report (doctor/report-remote.ts) — the local `gbrain doctor`,
  // the surface an operator actually runs on the host, never emitted it,
  // so a wedged auto-upgrade loop was invisible exactly where it would be
  // diagnosed. Sits beside the upgrade_errors trail it complements.
  checks.push(checkSelfUpgradeHealth());
  return checks;
}

export const minionsMigrationEntry: DoctorEntry = {
  name: 'minions_migration',
  emits: ['minions_migration', 'upgrade_errors', 'self_upgrade_health'],
  run: runMinionsMigration,
};
