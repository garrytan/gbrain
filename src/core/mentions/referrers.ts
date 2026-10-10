/**
 * Pages that link to an entity, one row per referring page: the entity card's
 * `referenced_by` groups and `get_backlinks {group: "page"}` both read this
 * one helper, so a card group and its continuation agree on membership,
 * order, privacy and identity union.
 *
 * - Every link source counts (mentions included), unlike `backlink_count`.
 * - Rows are ordered by `(date DESC, source_id, slug)` where date is
 *   `COALESCE(effective_date, updated_at)`; paging is a keyset cursor.
 * - Grouping is by the referring page's pack-canonical type (stored type
 *   mapped through the pack's type aliases; untyped pages are `untyped`).
 *   A `type` filter accepts a canonical type or a stored type.
 * - Untrusted callers never see a private or derived-private referrer, nor a
 *   link whose origin page is private, in rows or counts.
 * - With `entity_identity.union` on, links to the page's identity co-members
 *   count as links to the page.
 * - #5575: a quarantined referrer is left out (rows and counts) unless an
 *   authorized `include_quarantined` read asked; the caller's eligibility
 *   (floor, activation control on proactive reads) applies before LIMIT; each
 *   row carries its page's `trust_tier` + `origin` (+ `unconfirmed` when
 *   flagged), which text renderers label the preview with.
 */

import type { BrainEngine } from '../engine.ts';
import { privateLinkOriginFilterFragment, privatePagesFilterFragment, privatePagesFilterFragmentFast } from '../search/private-visibility.ts';
import { isIdentityUnionEnabled, listEntityIdentities } from '../entity-identity.ts';
import { stripTakesFence } from '../takes-fence.ts';
import { stripFactsFence } from '../facts-fence.ts';
import { redactFindings } from '../secret-scan.ts';
import { typeAliasPairs, type PackTypes } from './policy.ts';
import { quarantineFilterFragment, isQuarantined } from '../quarantine.ts';
import { activationSuppressedSql, pageEligibleSql } from '../eligibility/sql.ts';
import { trustFields, type TrustFields } from '../eligibility/labels.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';

export const PREVIEW_CHARS = 160;
export const GROUP_ROW_CAP = 10;
export const CARD_ROW_CAP = 50;
export const PAGE_DEFAULT_LIMIT = 50;
export const PAGE_MAX_LIMIT = 500;

export interface ReferenceRow extends TrustFields {
  slug: string;
  source_id: string;
  title: string;
  type: string | null;
  canonical_type: string;
  date: string | null;
  /** `effective_date` provenance (event_date, date, published, filename, fallback) or `updated_at`. */
  date_source: string;
  /** First 160 characters of body text, private fences stripped and secrets redacted. Not evidence: fetch the page. */
  preview: string;
  /** Only on an authorized include_quarantined read: the referrer is quarantined; its preview renders as external data. */
  quarantined?: true;
}

export interface ReferrerScope {
  /** The entity page. */
  slug: string;
  sourceId: string;
  /** Sources a referring page may live in (the caller's read scope). */
  referrerSources: string[];
  excludePrivate: boolean;
  pack: PackTypes | null;
  /** Visibility kept in previews (world only for untrusted callers). */
  keepVisibility: ('private' | 'world')[];
  /** #5575: the caller's read eligibility: rows below the floor, or flagged under activation control, are left out. */
  eligibility?: ReadEligibility;
  /** An authorized include_quarantined read keeps quarantined referrers; every other read leaves them out. */
  includeQuarantined?: boolean;
}

interface RawRow { id: number; slug: string; source_id: string; type: string | null; canonical_type: string;
  d: string | null; gtotal?: number }

/** The entity page plus, under `entity_identity.union`, its identity co-members. */
async function targetPages(engine: BrainEngine, scope: ReferrerScope): Promise<{ sources: string[]; slugs: string[] }> {
  const targets = [{ slug: scope.slug, source_id: scope.sourceId }];
  if (await isIdentityUnionEnabled(engine)) {
    try {
      const members = await listEntityIdentities(engine, { slug: scope.slug, slugSourceId: scope.sourceId, sourceId: scope.sourceId,
        allowedSources: scope.referrerSources, excludePrivate: scope.excludePrivate });
      for (const m of members) if (!targets.some(t => t.slug === m.slug && t.source_id === m.source_id)) targets.push({ slug: m.slug, source_id: m.source_id });
    } catch { /* the union never breaks the base read */ }
  }
  return { sources: targets.map(t => t.source_id), slugs: targets.map(t => t.slug) };
}

/**
 * The shared CTE `typed`: one row per referring page with its canonical type
 * and date. Params $1..$5 are fixed (target sources, target slugs, referrer
 * sources, stored type aliases, their canonical types; all bound as text[]).
 * The target's own privacy is checked once in `tgt`, and the referring page
 * ids are collected once in `refs`, so a hub with thousands of inbound links
 * costs one hashed membership test per candidate page.
 */
function referrersCte(scope: ReferrerScope): string {
  const targetPriv = scope.excludePrivate ? ` AND ${privatePagesFilterFragment('t')}` : '';
  const linkPriv = scope.excludePrivate ? ` AND ${privateLinkOriginFilterFragment('l')}` : '';
  const pagePriv = scope.excludePrivate ? ` AND ${privatePagesFilterFragmentFast('f')}` : '';
  const pageTrust = ` AND ${pageEligibleSql('f', scope.eligibility)}${scope.includeQuarantined ? '' : ` AND ${quarantineFilterFragment('f')}`}`;
  return `WITH tgt AS MATERIALIZED (
      SELECT t.id FROM pages t JOIN unnest($1::text[], $2::text[]) AS k(s, g) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${targetPriv}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT l.from_page_id AS id FROM links l WHERE l.to_page_id IN (SELECT id FROM tgt)${linkPriv}
    ),
    typed AS MATERIALIZED (
      SELECT f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($5::text[])[array_position($4::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM pages f
       WHERE f.id IN (SELECT id FROM refs)
         AND f.deleted_at IS NULL AND f.source_id = ANY($3::text[])
         AND f.id NOT IN (SELECT id FROM tgt)${pagePriv}${pageTrust}
    )`;
}

/** A timestamp as UTC ISO text with microseconds (a cursor compares at full precision). */
const dateText = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function preview(body: string | null, keep: ('private' | 'world')[]): string {
  if (!body) return '';
  const clean = redactFindings(stripFactsFence(stripTakesFence(body), { keepVisibility: keep }), { highEntropy: true }).text
    .replace(/^---[\s\S]*?---\s*/, '')
    .replace(/^\s*#\s[^\n]*\n?/, '');
  const text = clean.replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
}

async function hydrate(engine: BrainEngine, rows: RawRow[], keep: ('private' | 'world')[]): Promise<ReferenceRow[]> {
  if (!rows.length) return [];
  const pages = new Map((await engine.executeRaw<{ id: number; title: string | null; body: string | null; date_source: string;
    trust_tier: string; write_origin: unknown; flagged: boolean; frontmatter: Record<string, unknown> | null }>(
    `SELECT id, title, left(compiled_truth, 4000) AS body,
            CASE WHEN effective_date IS NULL THEN 'updated_at' ELSE COALESCE(effective_date_source, 'effective_date') END AS date_source,
            trust_tier, write_origin, ${activationSuppressedSql('pages', 'pages')} AS flagged, frontmatter
       FROM pages WHERE id = ANY($1::int[])`, [rows.map(r => r.id)])).map(r => [Number(r.id), r]));
  return rows.map(r => {
    const page = pages.get(Number(r.id));
    const fields = page ? trustFields(page.trust_tier, page.write_origin) : { trust_tier: 'unknown' as const, origin: 'unrecorded' };
    return {
      slug: r.slug, source_id: r.source_id, title: page?.title ?? r.slug, type: r.type || null, canonical_type: r.canonical_type,
      date: r.d, date_source: page?.date_source ?? 'updated_at', preview: preview(page?.body ?? null, keep), ...fields,
      ...(page?.flagged === true ? { unconfirmed: true as const } : {}),
      ...(isQuarantined(page?.frontmatter) ? { quarantined: true as const } : {}),
    };
  });
}

export function encodeCursor(row: Pick<ReferenceRow, 'date' | 'source_id' | 'slug'>): string {
  return Buffer.from(JSON.stringify([row.date, row.source_id, row.slug])).toString('base64url');
}

export function decodeCursor(cursor: string): [string | null, string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 3 && (v[0] === null || typeof v[0] === 'string') && typeof v[1] === 'string' && typeof v[2] === 'string') {
      return v as [string | null, string, string];
    }
  } catch { /* invalid */ }
  return null;
}

/** Canonical and stored types observed among the entity's referrers (for the unknown-type error). */
export async function referrerTypes(engine: BrainEngine, scope: ReferrerScope): Promise<string[]> {
  const t = await targetPages(engine, scope);
  const pairs = typeAliasPairs(scope.pack);
  const rows = await engine.executeRaw<{ canonical_type: string; type: string | null }>(
    `${referrersCte(scope)} SELECT DISTINCT canonical_type, type FROM typed`,
    [t.sources, t.slugs, scope.referrerSources, pairs.stored, pairs.canonical]);
  return [...new Set(rows.flatMap(r => [r.canonical_type, ...(r.type ? [r.type] : [])]))].sort();
}

/** One page of referring pages (newest first), optionally of one type. */
export async function readReferrerPage(engine: BrainEngine, scope: ReferrerScope,
  opts: { type?: string; limit: number; cursor?: [string | null, string, string] | null }): Promise<{ rows: ReferenceRow[]; total: number; truncated: boolean; cursor: string | null }> {
  const t = await targetPages(engine, scope);
  const pairs = typeAliasPairs(scope.pack);
  const params: unknown[] = [t.sources, t.slugs, scope.referrerSources, pairs.stored, pairs.canonical, opts.type ?? null];
  const typeFilter = `($6::text IS NULL OR canonical_type = $6 OR type = $6)`;
  const [count] = await engine.executeRaw<{ n: number }>(`${referrersCte(scope)} SELECT count(*)::int AS n FROM typed WHERE ${typeFilter}`, params);
  let after = '';
  if (opts.cursor) {
    params.push(opts.cursor[0], opts.cursor[1], opts.cursor[2]);
    after = ` AND ((d IS NOT DISTINCT FROM $7::timestamptz AND (source_id, slug) > ($8::text, $9::text))
                OR ($7::timestamptz IS NOT NULL AND (d < $7::timestamptz OR d IS NULL)))`;
  }
  params.push(opts.limit + 1);
  const raw = await engine.executeRaw<RawRow>(
    `${referrersCte(scope)}
     SELECT id, slug, source_id, type, canonical_type, ${dateText('d')} AS d FROM typed
      WHERE ${typeFilter}${after}
      ORDER BY d DESC NULLS LAST, source_id, slug LIMIT $${params.length}`, params);
  const truncated = raw.length > opts.limit;
  const rows = await hydrate(engine, raw.slice(0, opts.limit), scope.keepVisibility);
  return { rows, total: Number(count?.n ?? 0), truncated, cursor: truncated ? encodeCursor(rows[rows.length - 1]!) : null };
}

export interface ReferenceGroup {
  canonical_type: string;
  total: number;
  rows: ReferenceRow[];
}

/**
 * The card's groups: every canonical type with its total, newest rows first,
 * at most GROUP_ROW_CAP per group and CARD_ROW_CAP across the card (spread so
 * every group shows rows before any group shows more). Groups are ordered by
 * their newest row.
 */
export async function readReferrerGroups(engine: BrainEngine, scope: ReferrerScope): Promise<{ total: number; groups: ReferenceGroup[] }> {
  const t = await targetPages(engine, scope);
  const pairs = typeAliasPairs(scope.pack);
  // Per-type totals by hash aggregate, then a bounded top-N per type (no full sort of the referrers).
  const raw = await engine.executeRaw<RawRow>(
    `${referrersCte(scope)},
     counts AS (SELECT canonical_type, count(*)::int AS n FROM typed GROUP BY canonical_type)
     SELECT x.id, x.slug, x.source_id, x.type, c.canonical_type, ${dateText('x.d')} AS d, c.n AS gtotal
       FROM counts c CROSS JOIN LATERAL (
         SELECT * FROM typed t WHERE t.canonical_type = c.canonical_type ORDER BY t.d DESC NULLS LAST, t.source_id, t.slug LIMIT $6
       ) x
      ORDER BY c.canonical_type, x.d DESC NULLS LAST, x.source_id, x.slug`,
    [t.sources, t.slugs, scope.referrerSources, pairs.stored, pairs.canonical, GROUP_ROW_CAP]);
  const byType = new Map<string, RawRow[]>();
  for (const r of raw) byType.set(r.canonical_type, [...(byType.get(r.canonical_type) ?? []), r]);
  const order = [...byType.entries()].sort(([a, x], [b, y]) => (y[0]!.d ?? '').localeCompare(x[0]!.d ?? '') || a.localeCompare(b));
  // Water-fill: raise a per-group quota until the card cap is reached.
  const quota = new Map(order.map(([type]) => [type, 0]));
  let used = 0;
  for (let level = 1; level <= GROUP_ROW_CAP && used < CARD_ROW_CAP; level++) {
    for (const [type, rows] of order) {
      if (used >= CARD_ROW_CAP) break;
      if (rows.length >= level) { quota.set(type, level); used++; }
    }
  }
  const kept = order.flatMap(([type, rows]) => rows.slice(0, quota.get(type)));
  const hydrated = await hydrate(engine, kept, scope.keepVisibility);
  const groups: ReferenceGroup[] = order.map(([type, rows]) => ({
    canonical_type: type, total: Number(rows[0]!.gtotal ?? rows.length), rows: hydrated.filter(r => r.canonical_type === type),
  }));
  return { total: groups.reduce((n, g) => n + g.total, 0), groups };
}

