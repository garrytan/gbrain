/**
 * GBRA-150: pages a managed sync committed more than `afterSeconds` ago (default: the source's freshness target,
 * `sync.freshness_target_seconds`, 300 s) that search still cannot fully see, each with its reason and fix. A committed
 * import receipt means the page write landed; this read says whether the page then became searchable: its chunks exist
 * and carry a vector (or the brain is keyless by choice), it is not quarantined, and it is still live.
 *
 * Bounded and read-only: the newest committed managed-sync receipts of the source's current incarnation in the last
 * 24 h (at most LANDING_RECEIPT_LIMIT, newest first, through the `persistence_requests_sync_watermark` partial index),
 * the newest receipt per slug only (a later delete explains a missing page), then one page read and one embedding-state
 * read for those slugs (`embedding-state.ts` classifier). A read that times out says `unknown`, never `ok`. Readers:
 * `gbrain sync status` (`landing`) and doctor `sync_landing_gaps`.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { embeddingsDisabled } from '../embedding-disabled.ts';
import { embeddingStateFix, DELETED_PAGE_PURGE_WINDOW_HOURS, type EmbeddingState } from '../embedding-state.ts';
import { readFreshnessTarget } from './sync-freshness.ts';
import { syncRows } from '../engine-sql/managed-sync-store.ts';

export const LANDING_WINDOW_HOURS = 24;
export const LANDING_RECEIPT_LIMIT = 2_000;
export const LANDING_PAGE_LIMIT = 20;
const LANDING_PROBE_MS = 2_000;

export type LandingGapState = 'page_missing' | 'pending_embedding' | 'chunkless' | 'quarantined';
export interface LandingGap {
  slug: string;
  state: LandingGapState;
  /** Whether search finds the page now: by keyword only, or not at all. */
  searchable: 'keyword' | false;
  synced_at: string;
  age_seconds: number;
  why: string;
  fix: Action | null;
}
export type LandingGaps = { status: 'ok'; window_hours: number; after_seconds: number; checked: number; complete: boolean; gaps: number;
  by_state: Partial<Record<LandingGapState, number>>; pages: LandingGap[] } | { status: 'unknown'; reason: string } | { status: 'not_applicable'; reason: string };

const GAP: Partial<Record<EmbeddingState, LandingGapState>> = { pending: 'pending_embedding', chunkless_healable: 'chunkless', quarantined: 'quarantined' };
const ORDER: EmbeddingState[] = ['quarantined', 'chunkless_healable', 'pending'];

/** The landing gaps of one managed source; `not_applicable` without a binding (classic or connector sources keep no receipts). */
export async function readLandingGaps(engine: BrainEngine, sourceId: string, opts: { afterSeconds?: number; limit?: number } = {}): Promise<LandingGaps> {
  const after = opts.afterSeconds ?? (await readFreshnessTarget(engine)).seconds;
  const [binding] = await syncRows<{ worktree_id: string; incarnation: string }>(engine, 'landing_binding', [sourceId]).catch(() => []);
  if (!binding) return { status: 'not_applicable', reason: 'no_managed_binding' };
  let receipts: Array<{ slug: string; kind: string; completed_at: Date | string; age: number | string }>;
  try {
    receipts = await syncRows(engine, 'landing_receipts', [binding.worktree_id, binding.incarnation, LANDING_WINDOW_HOURS], { timeoutMs: LANDING_PROBE_MS, signal: AbortSignal.timeout(LANDING_PROBE_MS + 500) });
  } catch (error) {
    return { status: 'unknown', reason: `receipt read did not answer within ${LANDING_PROBE_MS / 1000} s: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` };
  }
  const imports = receipts.filter(r => r.kind === 'managed_sync_import' && Number(r.age) >= after);
  const base = { status: 'ok' as const, window_hours: LANDING_WINDOW_HOURS, after_seconds: after, checked: imports.length, complete: receipts.length < LANDING_RECEIPT_LIMIT };
  if (!imports.length) return { ...base, gaps: 0, by_state: {}, pages: [] };
  const slugs = imports.map(r => r.slug);
  const live = new Set((await syncRows<{ slug: string }>(engine, 'landing_live_slugs', [sourceId, slugs])).map(p => p.slug));
  const disabled = await embeddingsDisabled(engine);
  const states = ORDER.filter(state => !(disabled && state === 'pending'));
  const rows = live.size ? await engine.listEmbeddingStateRows({ sourceIds: [sourceId], slugs: [...live], states, limit: live.size * states.length, purgeWindowHours: DELETED_PAGE_PURGE_WINDOW_HOURS }) : [];
  const worst = new Map<string, EmbeddingState>();
  for (const row of rows) { const prior = worst.get(row.slug); if (!prior || ORDER.indexOf(row.state) < ORDER.indexOf(prior)) worst.set(row.slug, row.state); }
  const verify = { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] };
  const gaps: LandingGap[] = [];
  for (const receipt of imports) {
    const synced_at = new Date(receipt.completed_at).toISOString(), age_seconds = Math.round(Number(receipt.age));
    if (!live.has(receipt.slug)) {
      gaps.push({ slug: receipt.slug, state: 'page_missing', searchable: false, synced_at, age_seconds, fix: null,
        why: `Sync committed an import of ${receipt.slug}, but no live page has that slug now and no later sync receipt deleted it; a write outside sync removed or renamed it. gbrain sources resolve-path ${sourceId} <file> names the file's state.` });
      continue;
    }
    const state = worst.get(receipt.slug);
    const gap = state ? GAP[state] : undefined;
    if (!state || !gap) continue;
    gaps.push({ slug: receipt.slug, state: gap, searchable: state === 'pending' ? 'keyword' : false, synced_at, age_seconds,
      fix: embeddingStateFix(state, { sourceId, slug: receipt.slug, embeddingsEnabled: !disabled, verify }),
      why: state === 'pending' ? `${receipt.slug} synced ${age_seconds} s ago and is found by keyword, but some of its chunks still have no vector, so vector search misses it.`
        : state === 'chunkless_healable' ? `${receipt.slug} synced ${age_seconds} s ago but has no chunk rows, so search cannot read its body.`
        : `${receipt.slug} synced ${age_seconds} s ago and is quarantined, so search hides it (doctor quarantined_pages names why).` });
  }
  const by_state: Partial<Record<LandingGapState, number>> = {};
  for (const gap of gaps) by_state[gap.state] = (by_state[gap.state] ?? 0) + 1;
  gaps.sort((a, b) => b.age_seconds - a.age_seconds);
  return { ...base, gaps: gaps.length, by_state, pages: gaps.slice(0, opts.limit ?? LANDING_PAGE_LIMIT) };
}
