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
} from './checks/embedding-health.ts';
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
import { syncFreshnessEntry, searchModeEntry } from './checks/sync-search.ts';
import { decideHealthEntry } from './checks/decide.ts';
import { STOP_DOCTOR, type DoctorContext, type DoctorEntry } from './context.ts';
import type { Check } from '../doctor.ts';

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
  pgliteDataDirEntry,
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
  indexAuditEntry,
  imageAssetsEntry,
  syncFreshnessEntry,
  decideHealthEntry,
  searchModeEntry,
];

/**
 * Run the registry in order. A STOP_DOCTOR result ends the run with the checks
 * gathered so far; a completed run finishes the DB-checks progress phase.
 */
export async function runDoctorRegistry(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  for (const entry of DOCTOR_CHECK_REGISTRY) {
    const result = await entry.run(ctx);
    if (result === STOP_DOCTOR) return checks;
    checks.push(...result);
  }
  ctx.progress.finish();
  return checks;
}
