/**
 * GBRA-156: `sources_not_readable`, the refusal of an unscoped remote read
 * that came back empty because its readable sources hold no page it may read
 * (and, for recall and query, no world fact) while other sources hold such
 * pages. Private pages count on neither side when remote reads exclude them.
 *
 * A connection with no source grant (a legacy token minted without --sources,
 * whose hasSourceGrant is false, or an unbound agent stdio connection) reads the default source plus the
 * federated ones. A new source is not federated by default, so such a
 * connection could answer every search with an empty result that reads like
 * a clean miss. That empty answer is refused instead, naming the host
 * command that makes the pages readable without naming any source the
 * connection cannot read. A scope that holds pages but matched nothing, and a
 * brain where no source holds a page, read as before. A connection whose
 * operator granted it sources (every OAuth client carries at least its bound
 * source), a connection bound to a source, or a read that names a source is
 * never refused here: that scope is deliberate. The refusal only ever
 * narrows what a call returns, and federation never exposes private pages.
 */
import type { OperationContext } from './ops/contract.ts';
import { opError } from './ops/contract.ts';
import { federatedSearchScope } from './ops/context.ts';
import { hostFix } from './ops/op-fix.ts';
import { privatePagesFilterFragment, resolveExcludePrivatePages } from './search/private-visibility.ts';

const UNSCOPED_READ_OPS: ReadonlySet<string> = new Set(['search', 'query', 'recall', 'list_pages']);

function namesSources(params: Record<string, unknown>): boolean {
  const ids = params.source_ids;
  return params.source_id !== undefined || (Array.isArray(ids) ? ids.length > 0 : typeof ids === 'string' && ids.trim() !== '');
}

/** Throws `sources_not_readable` for an empty unscoped remote read whose scope holds nothing it could read. */
export async function assertUnscopedReadReachesPages(op: string, params: Record<string, unknown>, ctx: OperationContext): Promise<void> {
  if (ctx.remote === false || !UNSCOPED_READ_OPS.has(op) || namesSources(params)) return;
  if (ctx.explicitReadBinding || (ctx.auth !== undefined && (ctx.auth.allowedSources !== undefined || ctx.auth.hasSourceGrant !== false))) return;
  let refuse = false;
  try {
    const scope = federatedSearchScope(ctx);
    const readable = scope.sourceIds ?? (scope.sourceId !== undefined ? [scope.sourceId] : null);
    if (!readable) return;
    const readableFacts = op === 'recall' || op === 'query'
      ? ` OR EXISTS (SELECT 1 FROM facts WHERE source_id = ANY($1::text[]) AND visibility = 'world')`
      : '';
    const visible = await resolveExcludePrivatePages(ctx.engine, ctx.remote) ? ` AND ${privatePagesFilterFragment('p')}` : '';
    const [row] = await ctx.engine.executeRaw<{ refuse: boolean }>(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM pages p WHERE p.source_id = ANY($1::text[]) AND p.deleted_at IS NULL${visible})${readableFacts} THEN false
                   ELSE EXISTS (SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id
                                 WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE AND NOT (p.source_id = ANY($1::text[]))${visible})
              END AS refuse`,
      [readable],
    );
    refuse = row?.refuse === true;
  } catch {
    return;
  }
  if (!refuse) return;
  throw opError('sources_not_readable',
    `This connection reads only the default source and federated sources, and none of them holds a page, so this ${op} could only come back empty.`,
    'Other sources on this brain hold pages, but they are not federated and this connection has no source grant. Ask the user which source these connections should read; '
      + 'the brain host\'s operator federates it (command in fix) or grants this connection its sources (`gbrain auth rescope --token <name> --sources <ids>`).',
    {
      why: 'A connection with no source grant reads the default source plus federated sources, and a new source is not federated unless `sources add --federated` or `sources federate` made it so.',
      fix: {
        ...hostFix(ctx, ['gbrain', 'sources', 'federate', '<source>'],
          'Makes the source readable by every connection without a source grant; only the trusted CLI on the brain host changes federation.'),
        inputs: [{ name: 'source', how: 'Ask the user which source these connections should read (`gbrain sources list` on the brain host shows them).' }],
      },
    });
}
