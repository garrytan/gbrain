/**
 * The doctor check registry (refactor wave 1, W4 doctor): every entry
 * `gbrain doctor` runs, in run order. The order is the output order of
 * `gbrain doctor --json` and is pinned by the W0 registry golden
 * (test/doctor-registry-golden.test.ts); categories come only from
 * src/core/doctor-categories.ts (test/doctor-registry.test.ts fails on an
 * uncategorized entry name or emitted check).
 *
 * Execution groups, in order:
 *   1. Filesystem-first entries: run with or without an engine and under
 *      `--fast`. The resolver-health entry applies `--fix` before it scans.
 *   2. The connection lane: the synthesized `connection` check when there is
 *      no engine, then STOP when `--fast` or no engine.
 *   3. The live connection check, then STOP when it failed.
 *   4. DB entries: each reads `connectedEngine(ctx)`.
 *
 * To add a check: put a `{ name, emits, run }` entry in the topic module
 * under ./checks/, add it here at the position its output should take, and
 * categorize every emitted name in src/core/doctor-categories.ts.
 */

import { resolverHealthEntry, retrievalReflexEntry, skillConformanceEntry } from './checks/skill-group.ts';
import {
  bootstrapChecksEntry,
  memorableRelayEntry,
  connectorsEntry,
  minionsMigrationEntry,
} from './checks/local-runtime.ts';
import { supervisorEntry } from './checks/supervisor-health.ts';
import {
  stubGuardEntry,
  extractionBacklogsEntry,
  homeDirInWorktreeEntry,
  defaultSourcePathEntry,
} from './checks/local-audits.ts';
import {
  pgliteDataDirEntry,
  offlineConnectionEntry,
  dbChecksGateEntry,
  connectionEntry,
  connectionGateEntry,
} from './checks/db-connection.ts';
import {
  pgvectorEntry,
  rlsEntry,
  schemaVersionEntry,
  rlsEventTriggerEntry,
  embeddingsEntry,
} from './checks/schema-health.ts';
import {
  embeddingProviderEntry,
  alternativeProvidersEntry,
  embeddingQueryPrefixEntry,
  embeddingColumnRegistryEntry,
  embeddingEnvOverrideEntry,
  embeddingKeySourceEntry,
} from './checks/embedding-health.ts';
import { projectionResidentEntry } from './checks/projection-readiness.ts';
import {
  graphCoverageEntry,
  orphanRatioEntry,
  staleMentionsEntry,
  timelineHistoryEntry,
} from './checks/graph-health.ts';
import {
  integrityEntry,
  jsonbIntegrityEntry,
  whoknowsEntry,
  crossModalEntry,
  markdownBodyEntry,
} from './checks/data-integrity.ts';
import { contentSanityEntry, quarantineEntry, frontmatterEntry } from './checks/content-quality.ts';
import {
  evalCaptureEntry,
  contradictionsEntry,
  factsExtractionEntry,
  effectiveDateEntry,
  salienceEntry,
} from './checks/knowledge-health.ts';
import { queueHealthEntry, indexAuditEntry, imageAssetsEntry } from './checks/queue-assets.ts';
import { globalMaintenanceTimeoutsEntry } from './checks/global-maintenance-timeouts.ts';
import { legacyJobAuthorityEntry } from './checks/legacy-job-authority.ts';
import { legacyTokenGrantsEntry } from './checks/legacy-token-grants.ts';
import { syncFreshnessEntry, searchModeEntry } from './checks/sync-search.ts';
import { autoChronicleEntry } from './checks/auto-chronicle.ts';
import { factTakeVectorsEntry } from './checks/vector-coverage.ts';
import { decideHealthEntry } from './checks/decide.ts';
import { unlinkedFactsEntry } from './checks/unlinked-facts.ts';
import { plannerStatsEntry } from './checks/planner-stats.ts';
import { harnessWiringDoctorEntry } from './checks/harness-wiring.ts';
import { agentContractEntry } from './checks/agent-contract.ts';
import { STOP_DOCTOR, type DoctorContext, type DoctorEntry } from './context.ts';
import type { Check } from '../doctor.ts';
import { infoCheck } from './check-fix.ts';

export const DOCTOR_CHECK_REGISTRY: readonly DoctorEntry[] = [
  resolverHealthEntry,
  retrievalReflexEntry,
  skillConformanceEntry,
  bootstrapChecksEntry,
  memorableRelayEntry,
  connectorsEntry,
  minionsMigrationEntry,
  supervisorEntry,
  stubGuardEntry,
  extractionBacklogsEntry,
  homeDirInWorktreeEntry,
  defaultSourcePathEntry,
  embeddingKeySourceEntry,
  harnessWiringDoctorEntry,
  agentContractEntry,
  pgliteDataDirEntry,
  projectionResidentEntry,
  offlineConnectionEntry,
  dbChecksGateEntry,
  connectionEntry,
  connectionGateEntry,
  pgvectorEntry,
  rlsEntry,
  schemaVersionEntry,
  rlsEventTriggerEntry,
  embeddingsEntry,
  embeddingProviderEntry,
  alternativeProvidersEntry,
  embeddingQueryPrefixEntry,
  embeddingColumnRegistryEntry,
  embeddingEnvOverrideEntry,
  graphCoverageEntry,
  orphanRatioEntry,
  staleMentionsEntry,
  timelineHistoryEntry,
  integrityEntry,
  jsonbIntegrityEntry,
  whoknowsEntry,
  crossModalEntry,
  markdownBodyEntry,
  contentSanityEntry,
  quarantineEntry,
  frontmatterEntry,
  evalCaptureEntry,
  contradictionsEntry,
  factsExtractionEntry,
  effectiveDateEntry,
  salienceEntry,
  queueHealthEntry,
  globalMaintenanceTimeoutsEntry,
  legacyJobAuthorityEntry,
  legacyTokenGrantsEntry,
  indexAuditEntry,
  imageAssetsEntry,
  syncFreshnessEntry,
  decideHealthEntry,
  unlinkedFactsEntry,
  autoChronicleEntry,
  factTakeVectorsEntry,
  plannerStatsEntry,
  searchModeEntry,
];

const CONNECTION_LANE: ReadonlySet<DoctorEntry> = new Set([offlineConnectionEntry, dbChecksGateEntry, connectionEntry, connectionGateEntry]);

/** Every check name the registry can emit (the `--only` vocabulary). */
export function doctorCheckNames(): Set<string> {
  return new Set(DOCTOR_CHECK_REGISTRY.flatMap((e) => e.emits));
}

/** `--only a,b` / `--only=a,b` (repeatable) → the requested check names, or null when absent. */
export function parseOnlyChecks(args: readonly string[]): Set<string> | null {
  const raw: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only' && i + 1 < args.length) raw.push(args[++i]);
    else if (args[i].startsWith('--only=')) raw.push(args[i].slice('--only='.length));
  }
  if (raw.length === 0) return null;
  return new Set(raw.flatMap((r) => r.split(',')).map((n) => n.trim()).filter(Boolean));
}

/** True when any requested check is a DB check (ordered after the DB-checks early stop). */
export function onlyNeedsEngine(only: ReadonlySet<string>): boolean {
  const gate = DOCTOR_CHECK_REGISTRY.indexOf(dbChecksGateEntry);
  return DOCTOR_CHECK_REGISTRY.some((e, i) => i > gate && e.emits.some((n) => only.has(n)));
}

function selected(entry: DoctorEntry, only: ReadonlySet<string> | null | undefined): boolean {
  return !only || CONNECTION_LANE.has(entry) || entry.emits.some((n) => only.has(n));
}

/** `--only`: keep the requested checks; a requested check that produced nothing says why. */
function onlyResult(checks: Check[], only: ReadonlySet<string>, stopped: boolean): Check[] {
  const missing = [...only].filter((n) => !checks.some((c) => c.name === n));
  const kept = checks.filter((c) => only.has(c.name) || (stopped && missing.length > 0 && c.name === 'connection'));
  for (const name of missing) {
    kept.push(stopped
      ? { name, status: 'warn', message: 'Not run: the database checks stopped early (see the connection check).', fix_unavailable_reason: 'check_errored' }
      : infoCheck(name, 'No finding: this check does not apply to this brain right now.', 'not_applicable'));
  }
  return kept;
}

/**
 * Run the registry in order. A STOP_DOCTOR result ends the run with the checks
 * gathered so far; a completed run finishes the DB-checks progress phase.
 * Under `--only`, entries that emit none of the requested checks are skipped
 * (the connection lane always runs so its early stops still hold).
 */
export async function runDoctorRegistry(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  for (const entry of DOCTOR_CHECK_REGISTRY) {
    if (!selected(entry, ctx.only)) continue;
    const result = await entry.run(ctx);
    if (result === STOP_DOCTOR) return ctx.only ? onlyResult(checks, ctx.only, true) : checks;
    checks.push(...result);
  }
  ctx.progress.finish();
  return ctx.only ? onlyResult(checks, ctx.only, false) : checks;
}
