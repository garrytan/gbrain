/**
 * Large pages (Wave A): leads, snippets and synopses read a bounded prefix,
 * never the whole body. A helper that shows 160-240 characters of a page
 * (exact-slug and alias snippets, relational synopses, the reflex pointer
 * synopsis, the entity card summary, entity-name leads, think anchor rows)
 * reads at most BOUNDED_PREFIX_BYTES of the stored body (fan-out SQL selects
 * `left(compiled_truth, 65536)`), and sanitizes only that prefix
 * (boundedProjectedPrefix in document.ts).
 *
 * Withdrawals: the forget overlay only rewrites facts-fence rows, so a raw
 * prefix with no `gbrain:facts:begin` marker is already what the overlaid
 * body starts with. A prefix that holds a facts fence is replaced by the
 * prefix of the overlaid body, read once per page through the batched
 * snapshot read (the same overlay readPageSnapshot applies), so a withdrawn
 * world fact never shows in a lead. A page the snapshot read no longer
 * returns, or a snapshot read that fails, gets an empty lead (fail closed:
 * a lead is decoration, so the row stays and only its text is withheld).
 * A segmented page has no snapshot body: its row carries the stored
 * `truth_lead` (the same raw prefix), and a lead that holds a facts fence is
 * overlaid alone with the page's withdrawal ledger (the snapshot read returns
 * the ledger and no body), never by reading the page's segments.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { pageSnapshotKey } from '../page-snapshot-batch.ts';
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
import { safeSplitIndex } from '../text-safe.ts';
import { BOUNDED_PREFIX_BYTES, boundedProjectedPrefix } from './document.ts';

/**
 * SQL for the bounded raw prefix of a page's compiled truth that a fan-out
 * query selects instead of the whole column (fixed table aliases only). A
 * segmented page has no `compiled_truth`; its `truth_lead` holds the same raw
 * prefix, so the sanitize path downstream is unchanged. This is the one
 * sanctioned COALESCE of the body column (scripts/check-page-body-readers.ts
 * allows it by name).
 */
export function boundedBodyPrefixSql(alias: string): string {
  return `left(coalesce(${alias}.compiled_truth, ${alias}.truth_lead), ${BOUNDED_PREFIX_BYTES})`;
}

/** The first `maxBytes` UTF-8 bytes of a raw body, cut on a code point; nothing is sanitized. */
export function boundedRawPrefix(body: string | null | undefined, maxBytes: number = BOUNDED_PREFIX_BYTES): string {
  if (typeof body !== 'string') return '';
  let prefix = body.length > maxBytes ? body.slice(0, safeSplitIndex(body, maxBytes)) : body;
  while (Buffer.byteLength(prefix, 'utf8') > maxBytes) {
    prefix = prefix.slice(0, safeSplitIndex(prefix, Math.floor(prefix.length * 0.9)));
  }
  return prefix;
}

/** Whether a raw prefix must be re-read with the withdrawal overlay before it is shown. */
export function prefixNeedsOverlay(prefix: string | null | undefined): boolean {
  return typeof prefix === 'string' && prefix.includes('gbrain:facts:begin');
}

/**
 * Bounds each row's `compiled_truth` to the raw prefix and, for rows whose
 * prefix holds a facts fence, replaces it with the prefix of the
 * withdrawal-overlaid body (one batched snapshot read for all of them; a
 * segmented page's lead is overlaid alone with its ledger).
 * Returns new row objects; the input rows are not mutated.
 */
export async function overlaidBoundedRows<T extends { slug: string; source_id: string; compiled_truth: string | null }>(
  engine: Pick<BrainEngine, 'readPageSnapshotsBatch' | 'executeRaw'>,
  rows: readonly T[],
): Promise<T[]> {
  const bounded = rows.map(row => ({ ...row, compiled_truth: row.compiled_truth == null ? null : boundedRawPrefix(row.compiled_truth) }));
  const leads = new Map(bounded.filter(row => prefixNeedsOverlay(row.compiled_truth)).map(row => [pageSnapshotKey(row.source_id, row.slug), row.compiled_truth!]));
  const pending = [...new Map(bounded.filter(row => prefixNeedsOverlay(row.compiled_truth))
    .map(row => [pageSnapshotKey(row.source_id, row.slug), { slug: row.slug, sourceId: row.source_id }])).values()];
  if (pending.length === 0) return bounded;
  const overlaid = new Map<string, string>();
  const query = <R>(sql: string, params?: unknown[]) => engine.executeRaw<R>(sql, params);
  try {
    for (let rest = pending; rest.length > 0;) {
      const batch = await engine.readPageSnapshotsBatch(rest);
      for (const [key, snapshot] of batch.snapshots) {
        if (!isSegmentedPage(snapshot.page)) overlaid.set(key, boundedRawPrefix(snapshot.page.compiled_truth));
        else overlaid.set(key, boundedRawPrefix((await overlayCanonicalBodies(query, leads.get(key)!, '', snapshot.withdrawals,
          { sourceId: snapshot.page.source_id, marker: snapshot.globalPurges })).compiled_truth));
      }
      rest = rest.slice(Math.max(1, batch.covered));
    }
  } catch {
    overlaid.clear();
  }
  return bounded.map(row => prefixNeedsOverlay(row.compiled_truth)
    ? { ...row, compiled_truth: overlaid.get(pageSnapshotKey(row.source_id, row.slug)) ?? '' }
    : row);
}

/** One page's overlaid raw prefix: the snapshot body when the raw prefix holds a facts fence, else the raw prefix. */
export async function overlaidBoundedPrefix(
  engine: Pick<BrainEngine, 'readPageSnapshotsBatch' | 'executeRaw'>,
  page: { slug: string; source_id: string; compiled_truth: string | null },
): Promise<string> {
  const [row] = await overlaidBoundedRows(engine, [page]);
  return row?.compiled_truth ?? '';
}

/** One page's sanitized, credential-projected lead text: the bounded overlaid prefix through boundedProjectedPrefix. */
export async function projectedLead(
  engine: Pick<BrainEngine, 'readPageSnapshotsBatch' | 'executeRaw'>,
  page: { slug: string; source_id: string; compiled_truth: string | null },
): Promise<string> {
  return boundedProjectedPrefix(await overlaidBoundedPrefix(engine, page));
}

/** The raw lead source of a page read whole (getPage): its compiled truth, or a segmented page's stored `truth_lead` (its body fields throw). */
export async function pageLeadSource(engine: Pick<BrainEngine, 'executeRaw'>, page: Pick<Page, 'id' | 'body_storage' | 'compiled_truth'>): Promise<string | null> {
  if (!isSegmentedPage(page)) return page.compiled_truth;
  const [row] = await engine.executeRaw<{ truth_lead: string | null }>('SELECT truth_lead FROM pages WHERE id = $1', [page.id]);
  return row?.truth_lead ?? null;
}
