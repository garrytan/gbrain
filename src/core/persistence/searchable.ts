/**
 * Wave B: when a segmented page write becomes searchable. A segmented write
 * records `searchable` in its committed outcome: `true` when its publication
 * sealed the text projection (every replace with its chunks staged, and every
 * create within SEGMENTED_CREATE_SEAL_MAX_BYTES), `'pending'` when the page
 * published unsealed and its projection is built after commit (a larger
 * create, a deferred retirement), `false` for a quarantined page. A pending
 * outcome is re-read here whenever the receipt is served (the put_page reply,
 * get_write_request): `true` once the page's projection is sealed, else
 * `'pending'` with the poll interval and the receipt read that tells, then
 * `gbrain projections drain` as the fallback when no process builds it.
 */
import type { OperationContext } from '../ops/contract.ts';
import { cliRenderContext, renderAction, type RenderContext } from '../agent-output.ts';

/** The poll interval for a pending projection: about 4 KB of body per millisecond of building it, within [1 s, 5 s]. */
export function searchableRetryAfterMs(bodyBytes: number): number {
  return Math.min(5_000, Math.max(1_000, Math.round(bodyBytes / 4_000)));
}

/** Whether search sees a segmented page now: its text projection is sealed at its current revision. */
export async function segmentedPageSearchable(engine: OperationContext['engine'], sourceId: string, slug: string): Promise<true | 'pending'> {
  const [page] = await engine.executeRaw<{ sealed: boolean }>(`SELECT text_projection_revision=knowledge_revision AS sealed FROM pages
    WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, [sourceId, slug]);
  return page?.sealed ? true : 'pending';
}

/**
 * The fields that replace a committed receipt's `searchable: 'pending'`, read now; empty when the receipt is not a
 * committed write with a pending projection.
 */
export async function liveSearchable(ctx: Pick<OperationContext, 'engine' | 'remote' | 'transport' | 'isCallable'>,
  receipt: { request_id: string; state: string; source_id: string; slug: string; searchable: unknown }): Promise<Record<string, unknown>> {
  if (receipt.state !== 'committed' || receipt.searchable !== 'pending') return {};
  const [page] = await ctx.engine.executeRaw<{ sealed: boolean; body_bytes: string | null }>(`SELECT text_projection_revision=knowledge_revision AS sealed,
      body_bytes::text AS body_bytes FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, [receipt.source_id, receipt.slug]);
  if (!page) return { searchable: false };
  if (page.sealed) return { searchable: true };
  const retryAfterMs = searchableRetryAfterMs(Number(page.body_bytes ?? 0));
  const render: RenderContext = ctx.remote === false ? cliRenderContext()
    : { transport: ctx.transport ?? 'stdio', isCallable: ctx.isCallable ?? (() => false), preapproved: () => false };
  return {
    searchable: 'pending',
    searchable_retry_after_ms: retryAfterMs,
    searchable_fix: renderAction({
      argv: ['gbrain', 'write-request', '--', receipt.request_id], mcp: { tool: 'get_write_request', arguments: { request_id: receipt.request_id } },
      consent: [], actor: 'agent', requires_exclusive: false,
      why: `The write committed, but search does not see ${receipt.slug} yet: its chunks and keyword index are built after commit. `
        + `Read this receipt again after ${retryAfterMs} ms; searchable turns true once search sees the page.`,
      then: { argv: ['gbrain', 'projections', 'drain'], consent: [], actor: 'agent', requires_exclusive: false,
        why: `Only if searchable is still "pending" after a minute: no running gbrain process is building the page (a brain with no resident writer, `
          + 'or a build that died). This builds every queued page now, then read the receipt again.' },
    }, render),
  };
}
