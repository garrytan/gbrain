/**
 * v0.43.0.0 migration — MEMORY_VERBS v1 (Cathedral 1).
 *
 * PITCH-ONLY. There is NO schema or data migration: the five frozen memory
 * verbs (recall/remember/entity/synthesize/forget) ride the existing facts,
 * pages, and typed-graph tables. This entry exists solely so `gbrain
 * post-upgrade` / the self-upgrade NOTIFY channel actively tells an existing
 * install that the verbs landed and how to switch a harness onto them — the
 * propagation path the verbs otherwise lacked (the default surface stays
 * `full`, so an upgrade alone does NOT steer agents to the verbs).
 *
 * The orchestrator is a no-op that reports `complete` immediately —
 * idempotent by construction (it does nothing), so apply-migrations records
 * the ledger row and moves on.
 */

import type { Migration, OrchestratorOpts, OrchestratorResult } from './types.ts';

async function orchestrator(_opts: OrchestratorOpts): Promise<OrchestratorResult> {
  // No schema/data work — MEMORY_VERBS v1 is a façade over existing tables.
  return { version: '0.43.0', status: 'complete', phases: [] };
}

export const v0_43_0: Migration = {
  version: '0.43.0',
  featurePitch: {
    headline:
      'Five memory verbs — recall, remember, entity, synthesize, forget — are now the agent-facing memory protocol (MEMORY_VERBS v1).',
    description:
      'Point any MCP harness at `gbrain serve --surface verbs` to expose exactly these five self-describing tools instead of the full op wall: remember(fact, provenance) writes durable facts; recall(query|entity, budget_tokens) returns budget-packed memory; entity(name) is a zero-LLM card; synthesize(question) is the explicitly-expensive cross-page answer; forget(id) expires a fact. Existing `gbrain serve` (full surface) keeps working and now also lists the verbs, but `--surface verbs` is the clean agent surface. Set a default with `gbrain config set mcp_surface verbs`. Verify any endpoint with `gbrain protocol conformance`; see usage with `gbrain protocol stats`. Full contract: docs/protocol/MEMORY_VERBS_v1.md.',
  },
  orchestrator,
};
