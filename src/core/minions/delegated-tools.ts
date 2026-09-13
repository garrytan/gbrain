import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { ToolDef, SubagentHandlerData } from './types.ts';
import { buildBrainTools } from './tools/brain-allowlist.ts';
import { effectiveDelegation, DelegationDeniedError, type DelegationSnapshot } from './delegated-policy.ts';

export async function applyDelegatedData(engine: BrainEngine, snapshot: DelegationSnapshot | null, jobId: number, data: SubagentHandlerData): Promise<void> {
  if (!snapshot) return;
  const effective = await effectiveDelegation(engine, snapshot, jobId);
  data.source_id = effective.sourceId;
  data.allowed_tools = effective.tools;
  data.allowed_slug_prefixes = effective.slugPrefixes;
  data.brain_id = effective.brainId ?? undefined;
}

/** A stored/replayed tool call gets the fresh grant before touching brain state. */
export function guardDelegatedTools(engine: BrainEngine, config: GBrainConfig, snapshot: DelegationSnapshot | null, jobId: number, tools: ToolDef[], registryOverride: boolean, deferEmbeds = false): ToolDef[] {
  if (!snapshot) return tools;
  return tools.map(tool => ({ ...tool, async execute(input, toolCtx) {
    const effective = await effectiveDelegation(engine, snapshot, jobId);
    const opName = tool.name.replace(/^brain_/, '');
    if (!effective.tools.includes(opName)) throw new DelegationDeniedError(['delegated_tool_withdrawn']);
    const current = registryOverride ? tool : buildBrainTools({
      subagentId: jobId, engine, config, sourceId: effective.sourceId,
      brainId: effective.brainId ?? undefined, allowedSlugPrefixes: effective.slugPrefixes, deferEmbeds,
      delegatedAuth: { clientId: effective.clientId, scopes: effective.scopes,
        sourceId: effective.sourceId, allowedSources: effective.readSources },
    }).find(candidate => candidate.name === tool.name);
    if (!current) throw new DelegationDeniedError(['delegated_tool_unavailable']);
    return current.execute(input, toolCtx);
  } }));
}
