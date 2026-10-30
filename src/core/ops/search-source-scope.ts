/**
 * The per-request source scope of `search` and `query`: the explicit
 * `source_id` and the narrowing `source_ids` list, resolved through the one
 * trust+grant resolver (`federatedSearchScope`) and the #4620 liveness check.
 *
 * Each `source_ids` entry is authorized exactly as an explicit `source_id`
 * is: a remote caller naming a source outside its grant (or explicit-read
 * set) gets permission_denied for the whole request, and a removed or
 * archived source gets unknown_source. So the list can only narrow a request
 * to sources the caller could already read; the token's grant stays the
 * security boundary. An empty list or blank string is absent (#5390). With
 * `source_id` too, the request reads their intersection (`__all__` keeps the
 * list); an empty intersection searches nothing: the handlers return no rows
 * rather than fall back to the ambient or full scope, and an
 * `empty_retrieval` notice says why.
 */
import { ALL_SOURCES, isValidSourceId } from '../source-id.ts';
import type { OperationContext } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope } from './context.ts';
import { invalidParam } from './op-fix.ts';

export const SOURCE_IDS_PARAM = {
  type: 'array' as const,
  items: { type: 'string' as const },
  description: 'Narrow to these sources (omit or [] for all you can read).',
};

/** `source_ids` as distinct, trimmed source ids; undefined when absent. */
export function parseSourceIdsParam(ctx: OperationContext, tool: 'search' | 'query', raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  // #5390: OpenAI-family MCP clients fill every optional param with an empty value; [] and a blank string mean absent.
  if (Array.isArray(raw) && raw.length === 0) return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const example = ctx.remote === false ? 'source-a,source-b' : ['source-a', 'source-b'];
  if (!Array.isArray(raw)) throw invalidParam(ctx, tool, 'source_ids', '`source_ids` must be an array of source ids.', { example });
  const ids = new Set<string>();
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry.trim() : entry;
    if (id === ALL_SOURCES) {
      throw invalidParam(ctx, tool, 'source_ids', `\`source_ids\` narrows a request to named sources; '${ALL_SOURCES}' is not one. Omit source_ids to read every source you can.`, { example });
    }
    if (typeof id !== 'string' || !isValidSourceId(id)) {
      throw invalidParam(ctx, tool, 'source_ids', `\`source_ids\` entry ${JSON.stringify(entry)} is not a source id (1-32 lowercase letters, digits or interior hyphens).`, { example });
    }
    ids.add(id);
  }
  return [...ids];
}

/** The sources one search/query request reads; `sourceIds: []` means it reads none. */
export async function requestSourceScope(ctx: OperationContext, sourceIdParam: string | undefined, sourceIds: string[] | undefined): Promise<{ sourceId?: string; sourceIds?: string[] }> {
  const scope = federatedSearchScope(ctx, sourceIdParam);
  if (sourceIds === undefined) {
    await assertExplicitSourceLive(ctx, sourceIdParam);
    return scope;
  }
  for (const id of sourceIds) federatedSearchScope(ctx, id);
  for (const id of [sourceIdParam, ...sourceIds]) await assertExplicitSourceLive(ctx, id);
  const narrowed = sourceIdParam === undefined || sourceIdParam === ALL_SOURCES ? sourceIds : sourceIds.filter(id => id === sourceIdParam);
  if (narrowed.length === 0) {
    ctx.emitNotice?.({ code: 'empty_retrieval', kind: 'info', why: `source_ids does not include source_id '${sourceIdParam}', so no source was searched.` });
  }
  return { sourceIds: narrowed };
}
