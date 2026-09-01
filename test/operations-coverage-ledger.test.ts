/**
 * Operations coverage ledger — a shrink-only ratchet mapping every op in the
 * canonical registry (src/core/operations.ts) to a covering test file.
 *
 * How it works:
 * - LEDGER maps op name → repo-relative test file. Each entry is verified
 *   mechanically: the file EXISTS and its text CONTAINS the op name (a stale
 *   rename of either the op or the test file fails here).
 * - UNCOVERED is the conscious allowlist for ops with NO covering test at
 *   seeding time. It is SHRINK-ONLY: its length may never grow past the
 *   seeded literal, and covering one of its ops means moving it to LEDGER.
 * - A new op that lands in NEITHER place fails with instructions.
 *
 * Structural suite (reads repo text, executes no product paths). Seeded by
 * computing real coverage: for each op, every test/ file was searched for the
 * quoted op name and the most specific behavioral hit was chosen; zero-hit
 * ops (verified with an unquoted sweep too) went to UNCOVERED.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { allOperations } from './helpers/ops-registry.ts';

const REPO_ROOT = join(import.meta.dir, '..');

/**
 * op name → repo-relative test file that covers it. Keep entries honest:
 * point at the test that exercises the op (or its direct core), not at a
 * file that merely lists the name.
 */
const LEDGER: Record<string, string> = {
  remember: 'test/memory-verbs-conformance.test.ts',
  entity: 'test/memory-verbs-conformance.test.ts',
  synthesize: 'test/memory-verbs-conformance.test.ts',
  forget: 'test/memory-verbs-conformance.test.ts',
  get_page: 'test/get-page-federated-scope.test.ts',
  put_page: 'test/put-page-provenance.test.ts',
  delete_page: 'test/pages-source-scoping-4329.test.ts',
  list_pages: 'test/list-pages-truncation.test.ts',
  restore_page: 'test/pages-source-scoping-4329.test.ts',
  purge_deleted_pages: 'test/operations-trust-boundary.test.ts',
  capture: 'test/capture-op.test.ts',
  search: 'test/cli-search-dispatch.test.ts',
  query: 'test/query-image-flag.serial.test.ts',
  search_stats: 'test/search-introspection-ops.test.ts',
  search_modes: 'test/search-introspection-ops.test.ts',
  search_tune: 'test/search-introspection-ops.test.ts',
  cache_stats: 'test/quarantine-cache-ops.test.ts',
  search_by_image: 'test/search-by-image-op.test.ts',
  add_tag: 'test/source-id-tx-regression.test.ts',
  remove_tag: 'test/e2e/mechanical.test.ts',
  get_tags: 'test/get-page-federated-scope.test.ts',
  add_link: 'test/link-source-namespaced-regex.test.ts',
  remove_link: 'test/link-source-namespaced-regex.test.ts',
  get_links: 'test/get-page-federated-scope.test.ts',
  get_backlinks: 'test/get-page-federated-scope.test.ts',
  list_link_sources: 'test/link-source-namespaced-regex.test.ts',
  traverse_graph: 'test/regressions/v0_36_frontier_cap.test.ts',
  add_timeline_entry: 'test/timeline-entry-subagent-fence.test.ts',
  get_timeline: 'test/get-timeline-op.test.ts',
  get_stats: 'test/cli-bigint-normalize.test.ts',
  get_health: 'test/doctor-timeline-metric-labels-2298.test.ts',
  run_doctor: 'test/truthful-catalog.e2e-lite.test.ts',
  get_versions: 'test/get-page-federated-scope.test.ts',
  revert_version: 'test/e2e/mechanical.test.ts',
  get_brain_identity: 'test/get-brain-identity.test.ts',
  quarantine_list: 'test/quarantine-cache-ops.test.ts',
  list_skills: 'test/mcp-stdio-gate-list.test.ts',
  get_skill: 'test/skill-catalog-transports.test.ts',
  list_brain_skillpack: 'test/truthful-catalog.e2e-lite.test.ts',
  advisor: 'test/advisor-op-gate.test.ts',
  get_status_snapshot: 'test/get-status-snapshot-op.test.ts',
  sync_brain: 'test/sync-brain-op-source-id.test.ts',
  put_raw_data: 'test/source-id-tx-regression.test.ts',
  get_raw_data: 'test/get-page-federated-scope.test.ts',
  resolve_slugs: 'test/local-federated-search-scope.test.ts',
  get_chunks: 'test/get-page-federated-scope.test.ts',
  log_ingest: 'test/e2e/v0_29-mcp-dispatch-pglite.test.ts',
  get_ingest_log: 'test/e2e/v0_29-mcp-dispatch-pglite.test.ts',
  file_list: 'test/file-upload-engine-context.test.ts',
  file_upload: 'test/file-upload-engine-context.test.ts',
  file_url: 'test/file-upload-engine-context.test.ts',
  submit_job: 'test/submit-queue-state.test.ts',
  get_job: 'test/jobs-ops-token-redaction.test.ts',
  list_jobs: 'test/jobs-ops-token-redaction.test.ts',
  cancel_job: 'test/jobs-ops-token-redaction.test.ts',
  send_job_message: 'test/jobs-sidechannel-fence.test.ts',
  retry_job: 'test/jobs-ops-token-redaction.test.ts',
  submit_agent: 'test/submit-agent.test.ts',
  get_agent_job: 'test/get-agent-job.test.ts',
  get_job_stats: 'test/get-job-stats-op.test.ts',
  find_orphans: 'test/orphans-source-scope.test.ts',
  get_calibration_profile: 'test/calibration-cli.test.ts',
  takes_list: 'test/takes-mcp-allowlist.serial.test.ts',
  takes_search: 'test/takes-mcp-allowlist.serial.test.ts',
  think: 'test/think-pipeline.serial.test.ts',
  takes_scorecard: 'test/takes-write-ops.test.ts',
  takes_calibration: 'test/e2e/takes-postgres.test.ts',
  takes_add: 'test/takes-write-ops.test.ts',
  takes_update: 'test/takes-write-ops.test.ts',
  takes_resolve: 'test/takes-write-ops.test.ts',
  takes_supersede: 'test/takes-write-ops.test.ts',
  whoami: 'test/whoami.test.ts',
  sources_add: 'test/sources-mcp.test.ts',
  sources_list: 'test/sources-mcp.test.ts',
  sources_remove: 'test/sources-mcp.test.ts',
  sources_status: 'test/sources-mcp.test.ts',
  request_tools: 'test/request-tools.test.ts',
  get_recent_salience: 'test/salience-source-scope.test.ts',
  find_anomalies: 'test/salience-source-scope.test.ts',
  get_recent_transcripts: 'test/v0_29-tool-surfaces.test.ts',
  chronicle_day: 'test/chronicle-delight.test.ts',
  chronicle_on_this_day: 'test/chronicle-delight.test.ts',
  chronicle_since: 'test/operations-source-isolation-matrix.test.ts',
  chronicle_last_seen: 'test/operations-source-isolation-matrix.test.ts',
  volunteer_chronicle: 'test/operations-source-isolation-matrix.test.ts',
  ontology_get: 'test/chronicle-ontology-ops.test.ts',
  ontology_propose: 'test/facts-visibility.test.ts',
  ontology_dimensions: 'test/chronicle-ontology-ops.test.ts',
  ontology_conflicts: 'test/chronicle-advisor.test.ts',
  chronicle_backfill: 'test/chronicle-backfill.test.ts',
  volunteer_context: 'test/cli-format-volunteer.test.ts',
  extract_entities: 'test/extraction-review.test.ts',
  extraction_pending: 'test/extraction-review.test.ts',
  extraction_review: 'test/extraction-review.test.ts',
  extract_facts: 'test/extract-facts-embed-warn.serial.test.ts',
  recall: 'test/facts-recall-audit-rows.test.ts',
  context_pack: 'test/ambient-recall.test.ts',
  delta: 'test/ambient-recall.test.ts',
  forget_fact: 'test/e2e/facts-forget.test.ts',
  find_contradictions: 'test/eval-contradictions-integrations.test.ts',
  find_experts: 'test/find-experts-op.test.ts',
  find_trajectory: 'test/operations-find-trajectory.test.ts',
  code_callers: 'test/e2e/code-intel-mcp-ops-pglite.test.ts',
  code_callees: 'test/e2e/code-intel-mcp-ops-pglite.test.ts',
  code_def: 'test/e2e/code-intel-mcp-ops-pglite.test.ts',
  code_refs: 'test/e2e/code-intel-mcp-ops-pglite.test.ts',
  code_blast: 'test/code-intel/recursive-walk.test.ts',
  code_flow: 'test/code-intel/recursive-walk.test.ts',
  code_traversal_cache_clear: 'test/operations-trust-boundary.test.ts',
  migrate_embeddings: 'test/migrate-embeddings-op-contract.serial.test.ts',
  get_active_schema_pack: 'test/operations-schema-pack.test.ts',
  list_schema_packs: 'test/operations-schema-pack.test.ts',
  schema_stats: 'test/operations-schema-pack.test.ts',
  schema_lint: 'test/operations-schema-pack.test.ts',
  schema_graph: 'test/operations-schema-pack.test.ts',
  schema_explain_type: 'test/operations-schema-pack.test.ts',
  schema_review_orphans: 'test/operations-schema-pack.test.ts',
  schema_apply_mutations: 'test/operations-schema-pack.test.ts',
  reload_schema_pack: 'test/operations-schema-pack.test.ts',
  run_onboard: 'test/ops-run-onboard-scope-gate.serial.test.ts',
  run_skillopt: 'test/skillopt/run-skillopt-op.serial.test.ts',
  // Covered by the C1 lifecycle behavioral suite (moved out of UNCOVERED).
  get_job_progress: 'test/jobs-lifecycle-ops.test.ts',
  pause_job: 'test/jobs-lifecycle-ops.test.ts',
  resume_job: 'test/jobs-lifecycle-ops.test.ts',
  replay_job: 'test/jobs-lifecycle-ops.test.ts',
  // v0.47.0.0 gmail open-loop engine (mapped at the second master merge):
  // the ops suite covers remote posture, grant denial, and redaction arms.
  open_loops: 'test/ops-loops.test.ts',
  loops_close: 'test/ops-loops.test.ts',
  loops_mute: 'test/ops-loops.test.ts',
  loops_unmute: 'test/ops-loops.test.ts',
  // v0.46.28.0+ master-wave ops, mapped at the test-gap-wave master merge.
  fetch: 'test/deep-research-fetch.test.ts',
  get_usage: 'test/chat-usage.test.ts',
  entity_identity_link: 'test/entity-identity.test.ts',
  entity_identity_unlink: 'test/entity-identity.test.ts',
  entity_identity_list: 'test/entity-identity.test.ts',
};

/**
 * Ops with NO covering test at seeding time (verified: zero test/ files
 * mention the name, quoted or plain — the jobs sweep in
 * test/jobs-ops-token-redaction.test.ts exercises the four *_job ops only
 * programmatically, which the mechanical text check cannot see). SHRINK-ONLY:
 * cover an op, move it to LEDGER, and drop it from here. Never add entries.
 */
const UNCOVERED: string[] = [
  // v0.46.31.0 chat-connectors wave (arrived via master merge): the two ops
  // are localOnly thin wrappers over the connectors module (which has six
  // behavioral suites, test/connectors-*.test.ts), but no test dispatches
  // the OPS themselves yet. Entered at the test-gap-wave master merge while
  // the four *_job seeds moved to LEDGER — the set still SHRANK (4 → 2).
  'connector_sync',
  'connectors_status',
];

/**
 * The CURRENT length of UNCOVERED. NEVER raise this number; when UNCOVERED
 * shrinks, lower this constant IN THE SAME COMMIT (the module-size ratchet's
 * no-stale-slack convention) so no silent slack accumulates for future
 * entries to hide in.
 */
const UNCOVERED_SEEDED_LENGTH = 2;

describe('operations coverage ledger', () => {
  const opNames = allOperations().map(op => op.name);

  it('every registry op is in the ledger or consciously allowlisted', () => {
    const missing = opNames.filter(
      name => LEDGER[name] === undefined && !UNCOVERED.includes(name),
    );
    if (missing.length > 0) {
      throw new Error(
        `New op(s) with no test coverage entry: ${missing.join(', ')}.\n` +
          `Write a covering test and add a LEDGER entry (op name → test file) in ` +
          `test/operations-coverage-ledger.test.ts — or, if you are consciously ` +
          `shipping it uncovered, add it to the UNCOVERED allowlist AND raise its ` +
          `seeded length (a reviewer-visible decision).`,
      );
    }
    expect(missing).toEqual([]);
  });

  it('ledger entries are honest: each file exists and mentions its op', () => {
    const stale: string[] = [];
    for (const [name, relPath] of Object.entries(LEDGER)) {
      const abs = join(REPO_ROOT, relPath);
      if (!existsSync(abs)) {
        stale.push(`${name} → ${relPath} (file does not exist)`);
        continue;
      }
      if (!readFileSync(abs, 'utf8').includes(name)) {
        stale.push(`${name} → ${relPath} (file never mentions the op name)`);
      }
    }
    if (stale.length > 0) {
      throw new Error(
        `Stale ledger entr${stale.length === 1 ? 'y' : 'ies'} (test renamed/deleted, ` +
          `or op renamed without updating the ledger):\n  ${stale.join('\n  ')}`,
      );
    }
    expect(stale).toEqual([]);
  });

  it('UNCOVERED is shrink-only', () => {
    expect(UNCOVERED.length).toBeLessThanOrEqual(UNCOVERED_SEEDED_LENGTH);
  });

  it('no op sits in BOTH the ledger and the allowlist', () => {
    const both = UNCOVERED.filter(name => LEDGER[name] !== undefined);
    expect(both).toEqual([]);
  });

  it('no stale rows: every ledger key and allowlist entry is a current op', () => {
    const known = new Set(opNames);
    const staleLedgerKeys = Object.keys(LEDGER).filter(name => !known.has(name));
    const staleAllowlist = UNCOVERED.filter(name => !known.has(name));
    expect(staleLedgerKeys).toEqual([]);
    expect(staleAllowlist).toEqual([]);
  });

  it('no duplicate allowlist entries', () => {
    expect(new Set(UNCOVERED).size).toBe(UNCOVERED.length);
  });
});
