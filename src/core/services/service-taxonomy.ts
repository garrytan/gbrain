/**
 * Machine-checked service taxonomy for src/core/services (direction O8,
 * 2026-07-06 next-wave spec).
 *
 * This is the no-churn first slice of the O8 service-directory taxonomy:
 * every flat service file is assigned to a named domain here instead of being
 * physically moved into subdirectories (a later slice; moving files now would
 * conflict with in-flight PRs via import-path churn). The domain names are the
 * intended physical subdirectories for that later move.
 *
 * Ratchet contract, enforced by test/service-taxonomy.test.ts:
 * - Every .ts file directly under src/core/services must be assigned to
 *   exactly ONE domain below. A NEW service file fails the conformance test
 *   until it is consciously assigned — it can never land unclassified.
 * - Entries may only be REMOVED when their file is deleted or renamed; stale
 *   or double-listed entries fail the test.
 * - Each domain's file list stays sorted, and each domain carries a one-line
 *   module-boundary note.
 */

/** One-line module-boundary note per domain. */
export const SERVICE_DOMAINS = {
  retrieval: 'Read-side context assembly: retrieve/read context, routes, selectors, planners, budgets, and retrieval explainability.',
  governance: 'Write-side governance: writeback routing, canonical write sessions/patches, scope and trust policy, ledgers, and provenance.',
  'memory-inbox': 'Memory Inbox candidate lifecycle: signals, scoring, dedup, contradiction/supersession, target proposals, and promotion.',
  'agent-session': 'Agent/session memory: capture envelopes, compression, classification, activation planning, and session-derived writeback.',
  orientation: 'Orientation surfaces: context atlas, context maps, and workspace/atlas cards and bundles.',
  notes: 'Note structure: manifests, sections, structural graph, and structural pagination.',
  personal: 'Personal memory surface: profile/episode capture, export visibility, personal write targets, and data connectors.',
  tasks: 'Task memory: task threads, attempts, decisions, and decision-packet projections.',
  maintenance: 'Background upkeep: dream cycle, doctor, backfills, forgetting, strength, health, reports, and watched questions.',
  infra: 'Cross-cutting plumbing: import/ingest, source registry, embeddings, setup/readiness, runners, and contract manifests.',
} as const;

export type ServiceDomain = keyof typeof SERVICE_DOMAINS;

/**
 * Assignment of every service file (basename) to its domain.
 * Keep each list sorted; the conformance test enforces it.
 */
export const SERVICE_TAXONOMY: Readonly<Record<ServiceDomain, readonly string[]>> = {
  retrieval: [
    'assertion-frontier-retrieval-service.ts',
    'broad-synthesis-route-service.ts',
    'core-memory-blocks-service.ts',
    'corpus-lane-service.ts',
    'memory-activation-policy-service.ts',
    'memory-why-service.ts',
    'personal-episode-lookup-route-service.ts',
    'personal-profile-lookup-route-service.ts',
    'precision-lookup-route-service.ts',
    'production-retrieval-dependencies-service.ts',
    'read-context-budget-service.ts',
    'read-context-service.ts',
    'retrieval-request-planner-service.ts',
    'retrieval-route-selector-service.ts',
    'retrieval-selector-service.ts',
    'retrieve-context-budget-service.ts',
    'retrieve-context-graph-frontier-service.ts',
    'retrieve-context-service.ts',
    'scenario-memory-request-planner-service.ts',
    'selector-first-push-context-service.ts',
  ],
  governance: [
    'agent-trust-explain-service.ts',
    'assertion-pipeline-service.ts',
    'canonical-handoff-service.ts',
    'canonical-page-patch-service.ts',
    'canonicalize-path-preview-service.ts',
    'contamination-trace-service.ts',
    'expired-write-session-fallback-service.ts',
    'memory-access-policy-service.ts',
    'memory-mutation-ledger-service.ts',
    'memory-redaction-plan-service.ts',
    'memory-scenario-classifier-service.ts',
    'memory-trust-service.ts',
    'memory-writeback-router-service.ts',
    'mixed-scope-bridge-service.ts',
    'mixed-scope-disclosure-service.ts',
    'page-provenance-service.ts',
    'proof-agent-service.ts',
    'scope-gate-service.ts',
    'system-of-record-reconciler-service.ts',
    'target-snapshot-hash-service.ts',
    'trust-contract-service.ts',
  ],
  'memory-inbox': [
    'candidate-resolution-state-service.ts',
    'candidate-signal-service.ts',
    'canonical-target-proposal-draft-service.ts',
    'canonical-target-proposal-review-service.ts',
    'duplicate-memory-review-service.ts',
    'historical-validity-service.ts',
    'inbox-lead-service.ts',
    'map-derived-candidate-service.ts',
    'memory-candidate-dedup-service.ts',
    'memory-candidate-scoring-service.ts',
    'memory-inbox-contradiction-service.ts',
    'memory-inbox-promotion-service.ts',
    'memory-inbox-service.ts',
    'memory-inbox-supersession-service.ts',
    'negative-memory-projection-service.ts',
    'procedural-memory-service.ts',
  ],
  'agent-session': [
    'agent-session-activation-planner-service.ts',
    'agent-session-activation-service.ts',
    'agent-session-capture-envelope-service.ts',
    'agent-session-classifier-service.ts',
    'agent-session-compression-service.ts',
    'agent-session-maintenance-service.ts',
    'agent-session-memory-service.ts',
    'agent-session-writeback-service.ts',
  ],
  orientation: [
    'atlas-orientation-bundle-service.ts',
    'atlas-orientation-card-service.ts',
    'context-atlas-overview-service.ts',
    'context-atlas-report-service.ts',
    'context-atlas-service.ts',
    'context-map-code-lane-service.ts',
    'context-map-explain-service.ts',
    'context-map-path-service.ts',
    'context-map-query-service.ts',
    'context-map-report-service.ts',
    'context-map-service.ts',
    'workspace-corpus-card-service.ts',
    'workspace-orientation-bundle-service.ts',
    'workspace-project-card-service.ts',
    'workspace-system-card-service.ts',
  ],
  notes: [
    'note-manifest-service.ts',
    'note-section-service.ts',
    'note-structural-graph-service.ts',
    'structural-entry-pagination.ts',
  ],
  personal: [
    'episode-capture-service.ts',
    'personal-data-connector-service.ts',
    'personal-export-visibility-service.ts',
    'personal-write-target-service.ts',
  ],
  tasks: [
    'decision-packet-projection-service.ts',
    'task-memory-service.ts',
  ],
  maintenance: [
    'anticipation-service.ts',
    'autopilot-service.ts',
    'brain-loop-audit-service.ts',
    'code-claim-verification-service.ts',
    'doctor-remediation-service.ts',
    'doctor-service.ts',
    'dream-cycle-maintenance-service.ts',
    'dream-cycle-runner-service.ts',
    'dream-replay-canary-service.ts',
    'embed-backfill-job-service.ts',
    'embedding-backfill-service.ts',
    'lifecycle-forgetting-engine-service.ts',
    'lifecycle-forgetting-service.ts',
    'maintenance-runtime-db-adapter.ts',
    'maintenance-runtime-service.ts',
    'memory-operations-health-service.ts',
    'memory-review-report-service.ts',
    'memory-strength-service.ts',
    'watched-question-service.ts',
  ],
  infra: [
    'import-service.ts',
    'installed-agent-readiness-service.ts',
    'operation-conformance-service.ts',
    'page-embedding.ts',
    'raw-canonical-document-generator-service.ts',
    'restricted-runner-service.ts',
    'service-taxonomy.ts',
    'setup-agent-trust-ux-service.ts',
    'skill-surface-manifest-service.ts',
    'source-registry-service.ts',
  ],
};
