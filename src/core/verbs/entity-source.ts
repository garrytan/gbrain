/**
 * #6723: which sources an `entity` or `context_pack` lookup reads, in order.
 *
 * - An explicit `source_id` pins the lookup to that one source. The grant
 *   check and liveness check are the same ones `recall` runs
 *   (federatedSearchScope + assertExplicitSourceLive), and their refusals
 *   come back as recall's selector errors: `scope_denied`, `not_found`,
 *   `invalid_params`.
 * - Without a pin the lookup walks the caller's read scope: the home source
 *   first (the ambient binding when one is in force, else the connection's
 *   source), then every other readable source sorted by id, so the same
 *   brain always resolves a name the same way. A stdio connection bound by
 *   GBRAIN_SOURCE or .gbrain-source walks the sources it may name
 *   explicitly; a thin client sends its ambient source as `prefer_source_id`,
 *   which only reorders the walk and never adds a source to it.
 * - Sources outside the scope are never read, so they look exactly like a
 *   miss. A remote `__all__` stays fail-closed (it names no real source); a
 *   trusted local `__all__` walks every live source.
 */
import type { Notice } from '../agent-output.ts';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError, verbError } from '../ops/contract.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam } from '../ops/context.ts';
import { ALL_SOURCES } from '../source-id.ts';

export interface EntitySources {
  /** Sources probed per name: home first, then the rest sorted by id. */
  sources: string[];
  /** The first probe; follow-ups for a hit here need no source_id. */
  home: string;
  /** The ambient binding that chose `home` (stdio binding or a thin client's prefer_source_id). */
  ambient?: { sourceId: string; via: string };
}

/** Recall's selector errors for a refused explicit source (scope_denied / not_found / invalid_params). */
function selectorError(error: unknown): unknown {
  if (!(error instanceof OperationError)) return error;
  const code = error.code === 'permission_denied' ? 'scope_denied'
    : error.code === 'unknown_source' ? 'not_found'
      : error.code === 'invalid_params' ? 'invalid_params' : null;
  if (code === null) return error;
  return Object.assign(verbError(code, error.message,
    error.suggestion ?? 'Choose a permitted active source, or omit source_id to use your existing scope.',
    error.detail ?? error.code), error.fix ? { fix: error.fix } : {});
}

/** One explicit source the caller may read (a pin, or one source-qualified entity). */
export async function explicitEntitySource(ctx: OperationContext, raw: unknown, opName: string): Promise<string> {
  try {
    const sourceId = parseSourceIdParam(raw, opName);
    if (sourceId === undefined) throw verbError('invalid_params', `${opName}: source_id is required.`, 'Pass a source id from sources_list.');
    federatedSearchScope(ctx, sourceId);
    await assertExplicitSourceLive(ctx, sourceId);
    return sourceId;
  } catch (error) {
    throw selectorError(error);
  }
}

export async function entitySources(ctx: OperationContext, p: { source_id?: unknown; prefer_source_id?: unknown }, opName: string): Promise<EntitySources> {
  if (p.source_id !== undefined && p.source_id !== null) {
    const sourceId = await explicitEntitySource(ctx, p.source_id, opName);
    return { sources: [sourceId], home: sourceId };
  }
  let prefer: string | undefined;
  try {
    prefer = parseSourceIdParam(p.prefer_source_id, opName);
  } catch (error) {
    throw selectorError(error);
  }
  const scope = federatedSearchScope(ctx, undefined);
  let readable = scope.sourceIds ?? (scope.sourceId !== undefined ? [scope.sourceId] : [ctx.sourceId ?? 'default']);
  if (ctx.remote === false && readable.length === 1 && readable[0] === ALL_SOURCES) {
    readable = (await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(r => r.id);
  }
  const binding = ctx.auth?.allowedSources === undefined ? ctx.explicitReadBinding : undefined;
  if (binding && readable.length === 1 && readable[0] === binding.sourceId) readable = binding.sourceIds;
  const ambient = prefer !== undefined ? { sourceId: prefer, via: 'the client\'s GBRAIN_SOURCE or .gbrain-source' }
    : binding ? { sourceId: binding.sourceId, via: binding.via } : undefined;
  const wanted = ambient?.sourceId ?? ctx.sourceId;
  const home = wanted !== undefined && readable.includes(wanted) ? wanted : readable[0] ?? 'default';
  const rest = [...new Set(readable)].filter(s => s !== home).sort();
  return { sources: [home, ...rest], home, ...(ambient ? { ambient } : {}) };
}

/**
 * context_pack's `entity_refs`: source-qualified entities
 * (`[{source_id, slug}]`), each checked like a pin. Anything else is
 * invalid_params naming the expected shape.
 */
export async function entityRefs(ctx: OperationContext, raw: unknown, max: number): Promise<Array<{ name: string; sourceId: string }>> {
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : null;
  const valid = items?.every(r => r && typeof r === 'object' && typeof (r as { slug?: unknown }).slug === 'string' && (r as { slug: string }).slug.trim());
  if (!items || !valid || items.length > max) {
    throw verbError('invalid_params', `context_pack: entity_refs must be 1 to ${max} objects with source_id and slug.`,
      'Pass entity_refs: [{"source_id": "wiki", "slug": "people/alice-example"}], the source_id and slug a card or pointer returned.');
  }
  const out: Array<{ name: string; sourceId: string }> = [];
  for (const r of items as Array<{ source_id?: unknown; slug: string }>) {
    out.push({ name: r.slug.trim(), sourceId: await explicitEntitySource(ctx, r.source_id, 'context_pack') });
  }
  return out;
}

/**
 * `source_binding_narrowed` for a lookup whose ambient source had no hit for
 * some names: says which binding chose the first source and where the names
 * were found instead (or that they were found nowhere this connection reads).
 * Null when no ambient binding was in force or it had every hit.
 */
export function ambientMissNotice(op: string, walk: EntitySources, misses: Array<{ name: string; foundIn?: string }>): Notice | null {
  if (!walk.ambient || misses.length === 0) return null;
  const { sourceId, via } = walk.ambient;
  const readable = walk.sources.includes(sourceId);
  const parts = misses.slice(0, 5).map(m => m.foundIn ? `'${m.name}' resolved in source '${m.foundIn}'` : `'${m.name}' was not found in any source this connection reads`);
  return {
    code: 'source_binding_narrowed',
    kind: 'info',
    why: `This ${op} lookup prefers source '${sourceId}' (set by ${via}), `
      + (readable ? `which has no match for ${misses.length === 1 ? 'one name' : `${misses.length} names`}` : 'which this connection cannot read')
      + `; the lookup read the other sources this connection can read: ${parts.join('; ')}${misses.length > 5 ? '; …' : ''}.`
      + ' Each result names its source_id; pass source_id to read one source only.',
  };
}
