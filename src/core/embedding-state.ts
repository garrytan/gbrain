/**
 * Embedding state, derived (#6696 B3): where every piece of indexed text
 * stands against the registry-ACTIVE embedding column, read from the rows
 * themselves (no stored status column, no migration).
 *
 * Unit: one `content_chunks` row, plus one unit per page that has no chunk
 * row. Each unit is in exactly one state; the classifier SQL lives once in
 * `src/core/engine-sql/chunks.ts` (`chunkEmbeddingState` /
 * `chunklessPageState`, next to `staleChunkWhere`) and both engines delegate
 * to it. Precedence for a chunk: deleted page, quarantined page, stored
 * vector, embed job predicate, else embed_skip. For a chunkless live page:
 * quarantined, embed_skip, healable body, else empty.
 *
 * - `embedded`: a chunk on a live, unquarantined page whose active column
 *   holds a vector (vectors retained on an embed_skip page count: vector
 *   search reads them).
 * - `pending`: a chunk the embed job selects (`staleChunkWhere`: active vector
 *   NULL, page live, no `embed_skip`) on an unquarantined page.
 *   `gbrain embed --stale` drains it. On a brain keyless by choice keyword
 *   search is the configured retrieval and reads these chunks, so they are
 *   not counted as unsearchable there.
 * - `keyword_only`: a chunk with no vector on a live `embed_skip` page, or an
 *   `embed_skip` page with no chunk rows. By design (#4306: never purged; its
 *   text feeds keyword search). The import gate sets the marker for a body
 *   over the effective `content_sanity.bytes_block`, so removing the marker
 *   alone is undone on the next import; the exits are splitting the page or
 *   an operator-approved threshold override followed by a re-import.
 * - `quarantined`: the chunks of a live page carrying the `quarantine` marker,
 *   or the page itself when it has none (the gate writes zero chunks). Hidden
 *   from search; doctor `quarantined_pages` owns the warning.
 * - `empty`: a live page with no chunk rows and an empty body
 *   (`compiled_truth` and `timeline` both ''): nothing to index.
 * - `deleted_page_chunks`: chunks on a soft-deleted page. The purge lifecycle
 *   (`gbrain pages purge-deleted`, the autopilot purge phase, 72 h) removes
 *   them; past that window they are overdue.
 * - `chunkless_healable`: a live page with body text, no markers and no chunk
 *   rows (`listChunklessPagesWithContent`'s predicate): `gbrain embed --stale`
 *   chunks it before embedding.
 *
 * Unstamped pending chunks (`embedding_pending_since` NULL: written by a binary
 * older than the v221 stamp) carry no age; the summary reports their count,
 * this writer's version and a `created_at` lower bound, and never warns on it.
 */
import type { BrainEngine } from './engine.ts';
import type { Action } from './agent-output.ts';
import { embeddingsDisabled } from './embedding-disabled.ts';
import { SOFT_DELETE_TTL_HOURS } from './destructive-guard.ts';
import { DEFAULT_BYTES_BLOCK } from './content-sanity.ts';
import { loadConfig } from './config.ts';
import { embeddingEnablement } from './readiness.ts';
import { VERSION } from '../version.ts';

export type EmbeddingState = 'embedded' | 'pending' | 'keyword_only' | 'quarantined' | 'empty' | 'deleted_page_chunks' | 'chunkless_healable';

export { EMBEDDING_STATES } from './engine-sql/chunks.ts';

/** The states `unsearchable` sums (pending drops out on a brain keyless by choice). */
export const UNSEARCHABLE_STATES: readonly EmbeddingState[] = ['pending', 'quarantined', 'empty', 'chunkless_healable'];

/** Hours a soft-deleted page waits before the purge lifecycle removes it (`pages purge-deleted` default). */
export const DELETED_PAGE_PURGE_WINDOW_HOURS = SOFT_DELETE_TTL_HOURS;

export const EMBEDDING_STATE_DOCS = 'docs/guides/troubleshooting.md#embedding-state';

/** What the engine's classifier returns (`BrainEngine.readEmbeddingStateCounts`). */
export interface EmbeddingStateCounts {
  active_column: string;
  /** `unknown` only in ops mode without a covering partial index on the active column. */
  basis: 'exact' | 'estimated' | 'unknown';
  /** The partial index (`WHERE <active column> IS NULL`) ops mode reads through; null when none (or full mode). */
  covering_index: string | null;
  counts: Partial<Record<EmbeddingState, number>>;
  /** States this mode does not count (ops: the anti-join states no index backs). */
  omitted: EmbeddingState[];
  /** Embedded chunks on pages the embed job serves (no embed_skip); null in ops mode. */
  eligible_embedded: number | null;
  deleted_overdue: number;
  embed_skip_pages: number;
  embed_skip_marker_bytes: number;
  unstamped_pending: number;
  unstamped_created_at_min: Date | null;
}

/** One `(page, state)` row (`BrainEngine.listEmbeddingStateRows`). */
export interface EmbeddingStateRow {
  slug: string;
  source_id: string;
  state: EmbeddingState;
  chunks: number;
  /** Chunk text bytes, or the body bytes of a page with no chunk rows. */
  bytes: number;
  embed_skip_reason: string | null;
  marker_bytes: number | null;
  quarantine_reason: string | null;
  deleted_at: Date | null;
  overdue: boolean;
}

export interface EmbeddingStateSummary {
  status: 'known' | 'unknown';
  basis: 'exact' | 'estimated' | 'unknown';
  reason?: string;
  active_column: string;
  counts: Partial<Record<EmbeddingState, number>>;
  /** pending + quarantined + empty + chunkless_healable (never keyword_only or deleted_page_chunks); null when unknown. */
  unsearchable: number | null;
  [k: string]: unknown;
}

/**
 * The brain's embedding state. `mode: 'ops'` counts only what an index backs
 * (Postgres and PGLite alike: the covering partial index for the active
 * column, the frontmatter GIN index, the deleted-at purge index; `embedded` is
 * a planner estimate) and reports `status: 'unknown'` with
 * `reason: 'no_covering_index'` rather than scan; `empty` and
 * `chunkless_healable` are omitted there (`unsearchable_complete: false`).
 * `mode: 'full'` counts every state exactly. `sourceIds` is the caller's
 * resolved scope (sourceScopeOpts); absent means brain-wide.
 */
export async function readEmbeddingState(engine: BrainEngine, opts: { mode: 'ops' | 'full'; sourceIds?: string[] }): Promise<EmbeddingStateSummary> {
  const raw = await engine.readEmbeddingStateCounts({ mode: opts.mode, sourceIds: opts.sourceIds, purgeWindowHours: DELETED_PAGE_PURGE_WINDOW_HOURS });
  if (raw.basis === 'unknown') {
    return { status: 'unknown', basis: 'unknown', reason: 'no_covering_index', active_column: raw.active_column, counts: {}, unsearchable: null, mode: opts.mode };
  }
  const disabled = await embeddingsDisabled(engine);
  const parts = UNSEARCHABLE_STATES.filter(state => !(disabled && state === 'pending'));
  const counts = raw.counts;
  const pending = counts.pending ?? 0;
  const threshold = await effectiveBlockThreshold(engine);
  return {
    status: 'known',
    basis: raw.basis,
    ...(disabled ? { reason: 'embeddings_disabled' } : {}),
    active_column: raw.active_column,
    counts,
    unsearchable: parts.reduce((sum, state) => sum + (counts[state] ?? 0), 0),
    unsearchable_complete: parts.every(state => counts[state] !== undefined),
    omitted_states: raw.omitted,
    mode: opts.mode,
    embeddings_enabled: !disabled,
    units: 'content_chunks rows, plus one unit per page with no chunk rows',
    covering_index: raw.covering_index,
    coverage: raw.eligible_embedded === null
      ? { basis: 'estimated', ratio: ratio(counts.embedded, pending) }
      : { basis: 'exact', embedded: raw.eligible_embedded, eligible: raw.eligible_embedded + pending, ratio: ratio(raw.eligible_embedded, pending) },
    keyword_only: { reason: 'embed_skip', pages: raw.embed_skip_pages, marker_bytes: raw.embed_skip_marker_bytes, threshold_bytes: threshold },
    deleted_page_chunks: { within_window: (counts.deleted_page_chunks ?? 0) - raw.deleted_overdue, past_window: raw.deleted_overdue, window_hours: DELETED_PAGE_PURGE_WINDOW_HOURS },
    unstamped_pending: { count: raw.unstamped_pending, created_at_lower_bound: raw.unstamped_created_at_min?.toISOString() ?? null, writer_version: VERSION },
  };
}

function ratio(embedded: number | undefined, pending: number): number | null {
  const total = (embedded ?? 0) + pending;
  return total === 0 ? null : Math.round(((embedded ?? 0) / total) * 10_000) / 10_000;
}

/** The effective `content_sanity.bytes_block` the import gate applies (env > file > DB > default, capped at the page ceiling). */
async function effectiveBlockThreshold(engine: BrainEngine): Promise<number> {
  try {
    return await (await import('./import-screen.ts')).effectiveBytesBlock(engine);
  } catch {
    return DEFAULT_BYTES_BLOCK;
  }
}

/** `gbrain pages unsearchable` for one state: the read-only check every fix verifies with. */
export function embeddingStateVerify(sourceId: string, state: EmbeddingState): { argv: string[] } {
  return { argv: ['gbrain', 'pages', 'unsearchable', '--source', sourceId, '--state', state, '--json'] };
}

/**
 * The exit for one state, built only from existing commands (agent operator
 * protocol: argv, consent, actor, why, requires_exclusive, read-only verify,
 * docs). Null for `embedded`, which needs none. Without `sourceId` the
 * commands run brain-wide; pass `verify` then (doctor verifies with itself).
 */
export function embeddingStateFix(state: EmbeddingState, ctx: { sourceId?: string; slug?: string; markerBytes?: number | null; blockBytes?: number; embeddingsEnabled: boolean; verify?: { argv: string[] } }): Action | null {
  const verify = ctx.verify ?? embeddingStateVerify(ctx.sourceId ?? 'default', state);
  const base = { verify, docs: EMBEDDING_STATE_DOCS, requires_exclusive: false };
  const source = ctx.sourceId ? ['--source', ctx.sourceId] : [];
  switch (state) {
    case 'embedded':
      return null;
    case 'pending':
    case 'chunkless_healable': {
      if (!ctx.embeddingsEnabled) return keylessFix(verify);
      const run = ['gbrain', 'embed', '--stale', '--catch-up', ...source];
      return { ...base, argv: [...run, '--yes'], preview_argv: [...run, '--dry-run'], consent: ['paid'], actor: 'agent',
        why: state === 'pending'
          ? 'These chunks have no vector in the active embedding column, so vector search cannot see them. The catch-up drain embeds them; it sends their text to the embedding provider and costs money.'
          : 'These pages have body text but no chunk rows, so neither keyword nor vector search can read their body. `embed --stale` chunks them first, then embeds the new chunks; it sends their text to the embedding provider and costs money.',
        user_message: 'Some notes are not indexed for search yet. Indexing them sends their text to your embedding provider and costs a little money. OK to run it?' };
    }
    case 'keyword_only': {
      // A marker written under an older, lower limit: the free backfill clears it; raising the limit to the marker would lower it.
      if (ctx.markerBytes && ctx.blockBytes && ctx.markerBytes <= ctx.blockBytes) {
        const reindex = ['gbrain', 'reindex', '--oversized', ...source];
        return { ...base, argv: reindex, preview_argv: [...reindex, '--dry-run'], consent: [], actor: 'agent',
          why: `This page was marked embed_skip under an older, lower size limit; at ${ctx.markerBytes} bytes it is under the current content_sanity.bytes_block (${ctx.blockBytes}). The backfill removes the stale marker and re-chunks it on the CPU at no cost; a page over 1 MiB then waits for the user's approval before paid embedding.` };
      }
      const threshold = ctx.markerBytes && ctx.markerBytes > 0 ? String(ctx.markerBytes + 1) : null;
      const why = 'The import gate marked this page embed_skip because its body exceeds content_sanity.bytes_block; keyword search still reads its chunks. Removing the marker alone is undone on the next import. Two exits: split the page into smaller pages, or raise the threshold (a brain-wide setting the operator approves) and re-import, which embeds it.';
      const reimport: Action = { ...base, argv: ['gbrain', 'sync', ...source, '--full'], consent: ['paid'], actor: 'agent',
        why: 'Re-imports the source so the gate re-assesses the page under the new threshold, drops the marker and embeds the page.' };
      if (!threshold) return { ...base, ask_user: true, argv: ['gbrain', 'config', 'get', 'content_sanity.bytes_block'], consent: [], actor: 'user', why,
        user_message: 'An oversized page is searchable by keyword only. Split it into smaller pages, or raise the size limit for embedding and re-import it?' };
      return { ...base, ask_user: true, argv: ['gbrain', 'config', 'set', 'content_sanity.bytes_block', threshold], consent: [], actor: 'user', why,
        user_message: `A page of ${ctx.markerBytes} bytes is searchable by keyword only. Split it into smaller pages, or raise the size limit for embedding to ${threshold} bytes and re-import it (embedding costs a little money)?`,
        then: reimport };
    }
    case 'quarantined':
      return { ...base, ask_user: true, argv: ctx.slug ? ['gbrain', 'quarantine', 'clear', ctx.slug, ...(ctx.sourceId ? ['--source-id', ctx.sourceId] : []), '--force'] : ['gbrain', 'quarantine', 'list', '--json'],
        preview_argv: ['gbrain', 'quarantine', 'list', '--json'], consent: ctx.slug ? ['paid'] : [], actor: 'user',
        why: 'The content-quality gate hid this page as junk, so it has no searchable chunks. Clearing is the owner\'s judgement for a false positive; it re-imports and embeds the page.',
        user_message: 'A page was hidden from search as junk. Review it and clear it if it is a false positive?' };
    case 'empty':
      return { ...base, ask_user: true, argv: ctx.slug ? ['gbrain', 'delete', ctx.slug, ...source, '--force'] : ['gbrain', 'list', '--json'],
        consent: ['destructive'], actor: 'user',
        why: 'The page has no body text, so there is nothing to index. Writing content to it chunks it on the next write; delete it only if it is a stub nobody needs (soft delete, restorable).',
        user_message: 'A page is empty, so there is nothing to search. Add content to it, or delete the empty stub?' };
    case 'deleted_page_chunks':
      return { ...base, argv: ['gbrain', 'pages', 'purge-deleted', '--yes'], preview_argv: ['gbrain', 'pages', 'purge-deleted', '--dry-run', '--json'],
        consent: ['destructive'], actor: 'agent',
        why: `These chunks belong to soft-deleted pages; search never reads them. The purge lifecycle hard-deletes pages soft-deleted more than ${DELETED_PAGE_PURGE_WINDOW_HOURS}h ago (brain-wide, irreversible), taking their chunks with them.` };
  }
}

function keylessFix(verify: { argv: string[] }): Action {
  try {
    const cfg = loadConfig();
    if (cfg) {
      return { ...embeddingEnablement(cfg), verify, docs: EMBEDDING_STATE_DOCS };
    }
  } catch { /* unreadable config: the read-only fallback below */ }
  return { argv: ['gbrain', 'doctor', '--only', 'embeddings', '--json'], consent: [], actor: 'agent', verify, docs: EMBEDDING_STATE_DOCS, requires_exclusive: false,
    why: 'Embeddings are disabled on this brain by choice; keyword search reads these chunks. The embeddings check names the command that turns embeddings on, if the user wants them.' };
}
