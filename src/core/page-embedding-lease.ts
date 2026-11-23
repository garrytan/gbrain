/**
 * One provider call per chunk content version (gbrain-evals#180, N14).
 *
 * Every path that embeds a page's vector-less chunks (the post-write embedding
 * effect, `gbrain embed --stale`, the embed-backfill job, phase-end embeds)
 * reads which chunks lack a vector, calls the provider and installs. Two paths
 * that read the same page before either installs both send its chunks, so
 * each path holds this page's lease from that read through its install. A
 * path that finds the lease held waits for it, then reads again and embeds
 * only the chunks still missing a vector.
 *
 * The lease is a `gbrain_cycle_locks` row (`embed-page:<page id>`) written with
 * plain statements, so it holds across processes and through a transaction
 * pooler without pinning a connection during the provider call. The holder
 * refreshes it and renews it once more inside its install transaction, which
 * installs nothing when that renewal matches no row. A waiter gives up at its
 * deadline or after one TTL and gets a busy lease instead of the page. A holder
 * that dies leaves a row that expires after the TTL; every release deletes the
 * expired `embed-page:` rows.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { BrainEngine } from './engine.ts';
import { opError, type OperationError } from './ops/contract.ts';
import { readFix } from './ops/op-fix.ts';
import { quoteIdentifier } from './search/embedding-column.ts';
import { chunkGenerationFilter } from './search/safe-chunks.ts';

export const PAGE_EMBEDDING_LEASE_TTL_MINUTES = 2;
const LEASE_REFRESH_MS = 30_000;
const LEASE_WAIT_MAX_MS = 1_000;

/**
 * Test seams: `contended` runs each time a path finds a page's lease held by another path, before it waits;
 * `waitBoundMs` replaces the default wait bound (one TTL).
 */
export const pageEmbeddingLeaseProbe: { contended?: (pageId: number) => void; waitBoundMs?: number } = {};

/** Every page embedding lease id starts with this; the writer admin fingerprint leaves these rows out (admin-intent.ts). */
export const PAGE_EMBEDDING_LEASE_PREFIX = 'embed-page:';

/**
 * SQL predicate on `gbrain_cycle_locks.id` that leaves page embedding leases out. Activation's legacy-lock inspection,
 * deactivation's lease blockers and shared-skill activation's quiescence check use it: a lease only dedupes provider
 * calls and guards vector installs, which ran unleased before it existed; its holders run inside a lock, job lease or
 * effect claim those checks already see, and an expired row (a crashed holder's) must not block them.
 */
export const NOT_PAGE_EMBEDDING_LEASE = `id NOT LIKE '${PAGE_EMBEDDING_LEASE_PREFIX}%'`;

export function pageEmbeddingLeaseId(pageId: number): string {
  return `${PAGE_EMBEDDING_LEASE_PREFIX}${pageId}`;
}

/**
 * A page's embedding lease. `busy`: another path held it through the whole wait, nothing was taken and the
 * caller leaves the page to that path. Otherwise `assertHeld(tx)` renews it inside the install transaction and
 * throws `lock_busy` when the renewal matches no row (it expired and was taken or deleted), so nothing installs.
 */
export type PageEmbeddingLease = AsyncDisposable & ({ busy: true } | { busy: false; assertHeld(tx: Pick<BrainEngine, 'executeRaw'>): Promise<void> });

/** The retryable error for a page whose embedding lease another path holds (`lost`: this holder's lease was taken over). */
export function pageEmbeddingLeaseUnavailable(pageId: number, lost: boolean): OperationError {
  return opError('lock_busy', lost ? 'This page\'s embedding lease was lost before the install.' : 'Another path is embedding this page.',
    lost ? `The embedding lease of page ${pageId} expired and was taken or reclaimed by another path, so this attempt installed no vectors; that path or the next embed run embeds the page.`
      : `Another path held the embedding lease of page ${pageId} through the whole wait, so this attempt sent nothing to the provider; that path embeds the page, and a retry embeds only what it leaves.`,
    { fix: readFix('Shows the gbrain_cycle_locks rows, embed-page leases included, with holder and expiry, read-only.', { argv: ['gbrain', 'status', '--section', 'locks', '--json'] }) });
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Takes page `pageId`'s embedding lease, waiting while another path holds it until `deadline` (epoch ms) or one
 * TTL, whichever is sooner, and returning a busy lease then. `whileWaiting` runs before each wait (an effect
 * renews its claim there); an abort of `signal` ends the wait by throwing its reason. Bind the result with
 * `await using` in the scope that ends with the install: leaving it releases the lease.
 */
export async function acquirePageEmbeddingLease(engine: BrainEngine, pageId: number,
  opts: { signal?: AbortSignal; deadline?: number; whileWaiting?: () => Promise<void> } = {}): Promise<PageEmbeddingLease> {
  const id = pageEmbeddingLeaseId(pageId);
  const token = randomUUID();
  const take = async () => (await engine.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
     VALUES ($1, $2, $3, now(), now() + make_interval(mins => $4::int), now(), $5::uuid)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id, holder_pid = EXCLUDED.holder_pid, holder_host = EXCLUDED.holder_host, acquired_at = now(),
       ttl_expires_at = EXCLUDED.ttl_expires_at, last_refreshed_at = now(), acquisition_token = EXCLUDED.acquisition_token
     WHERE gbrain_cycle_locks.ttl_expires_at < now()
     RETURNING id`, [id, process.pid, hostname(), PAGE_EMBEDDING_LEASE_TTL_MINUTES, token])).length > 0;
  const bound = Math.min(opts.deadline ?? Infinity, Date.now() + (pageEmbeddingLeaseProbe.waitBoundMs ?? PAGE_EMBEDDING_LEASE_TTL_MINUTES * 60_000));
  for (let waitMs = 50; !await take(); waitMs = Math.min(waitMs * 2, LEASE_WAIT_MAX_MS)) {
    pageEmbeddingLeaseProbe.contended?.(pageId);
    if (Date.now() >= bound) return { busy: true, [Symbol.asyncDispose]: async () => {} };
    await opts.whileWaiting?.();
    await pause(Math.min(waitMs, Math.max(0, bound - Date.now())), opts.signal);
    opts.signal?.throwIfAborted();
  }
  let lost = false;
  const renew = async (exec: Pick<BrainEngine, 'executeRaw'>) => {
    if (!lost) lost = (await exec.executeRaw(`UPDATE gbrain_cycle_locks SET ttl_expires_at = now() + make_interval(mins => $3::int), last_refreshed_at = now()
      WHERE id = $1 AND acquisition_token = $2::uuid RETURNING id`, [id, token, PAGE_EMBEDDING_LEASE_TTL_MINUTES])).length === 0;
    return !lost;
  };
  const refresh = setInterval(() => {
    renew(engine).then(held => { if (!held) clearInterval(refresh); }, () => { /* the install's renewal decides */ });
  }, LEASE_REFRESH_MS);
  refresh.unref?.();
  return {
    busy: false,
    assertHeld: async tx => { if (!await renew(tx)) throw pageEmbeddingLeaseUnavailable(pageId, true); },
    [Symbol.asyncDispose]: async () => {
      clearInterval(refresh);
      await engine.executeRaw(`DELETE FROM gbrain_cycle_locks
        WHERE (id = $1 AND acquisition_token = $2::uuid) OR (id LIKE '${PAGE_EMBEDDING_LEASE_PREFIX}%' AND ttl_expires_at < now())`, [id, token])
        .catch(() => { /* the TTL is the backstop */ });
    },
  };
}

/**
 * The chunks of `existing` (the page's chunks, read under its lease) that still lack a vector and match a listed
 * stale row's text, each merged over that row. A chunk another path embedded since the listing drops out.
 */
export function stillPendingChunks<C extends { chunk_index: number; chunk_text: string; embedded_at?: Date | string | null; embedding_is_null?: boolean },
  S extends { chunk_index: number; chunk_text: string }>(existing: readonly C[], selected: ReadonlyMap<number, S>): Array<S & C> {
  return existing.filter(c => (!c.embedded_at || c.embedding_is_null === true) && selected.get(c.chunk_index)?.chunk_text === c.chunk_text)
    .map(c => ({ ...selected.get(c.chunk_index)!, ...c }));
}

/** Chunk indexes of the page's live rows with no vector in `column`, read while the caller holds the page's lease. */
export async function vectorlessChunkIndexes(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, column: string): Promise<Set<number>> {
  const rows = await engine.executeRaw<{ chunk_index: number }>(
    `SELECT cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND cc.${quoteIdentifier(column)} IS NULL AND ${chunkGenerationFilter('p', 'cc')}`, [pageId]);
  return new Set(rows.map(row => Number(row.chunk_index)));
}
