import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import type { SubagentHandlerData, ToolDef } from '../types.ts';
import type { LocalSubagentCapability } from '../local-subagent.ts';
import { buildBrainTools } from '../tools/brain-allowlist.ts';

/**
 * Tool registry bound to ONE job as the owning subagent. An injected registry (test seam) wins. Otherwise:
 * brain_id (per-call brain override), allowed_slug_prefixes (trusted-workspace allow-list; flows to the put_page
 * schema AND the OperationContext so the model's schema and the server-side check stay in sync) and source_id
 * (#1586: cycle-resolved source scope for tool-call OperationContexts) come from the job data, and the
 * job-bound local subagent capability (if any) is threaded to every tool call. `deferEmbeds` is the oneshot
 * rebuild (#4216): the embed network call leaves the model path and the standing embed machinery backfills.
 */
export function jobBrainTools(
  injected: ToolDef[] | undefined,
  jobId: number,
  data: SubagentHandlerData,
  engine: BrainEngine,
  config: GBrainConfig,
  localSubagent: LocalSubagentCapability | undefined,
  deferEmbeds = false,
): ToolDef[] {
  return injected ?? buildBrainTools({
    subagentId: jobId,
    localSubagent,
    engine,
    config,
    brainId: data.brain_id,
    allowedSlugPrefixes: data.allowed_slug_prefixes,
    sourceId: data.source_id,
    ...(deferEmbeds ? { deferEmbeds: true } : {}),
  });
}
