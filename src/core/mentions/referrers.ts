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
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
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
async function targetPages(engine: BrainEngine, scope: ReferrerScope, union?: boolean): Promise<{ sources: string[]; slugs: string[] }> {
  const targets = [{ slug: scope.slug, source_id: scope.sourceId }];
  if (union ?? await isIdentityUnionEnabled(engine)) {
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
/** The caller's read filters, shared by the single-target CTE and its batched variant. */
function referrerFilters(scope: Pick<ReferrerScope, 'excludePrivate' | 'eligibility' | 'includeQuarantined'>) {
  return {
    targetPriv: scope.excludePrivate ? ` AND ${privatePagesFilterFragment('t')}` : '',
    linkPriv: scope.excludePrivate ? ` AND ${privateLinkOriginFilterFragment('l')}` : '',
    pagePriv: scope.excludePrivate ? ` AND ${privatePagesFilterFragmentFast('f')}` : '',
    pageTrust: ` AND ${pageEligibleSql('f', scope.eligibility)}${scope.includeQuarantined ? '' : ` AND ${quarantineFilterFragment('f')}`}`,
  };
}

function referrersCte(scope: ReferrerScope): string {
  const { targetPriv, linkPriv, pagePriv, pageTrust } = referrerFilters(scope);
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
    `SELECT id, title, left(${boundedBodyPrefixSql('pages')}, 4000) AS body,
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
  opts: { type?: string; limit: number; cursor?: [string | null, string, string] | null; recordMetadata?: boolean; pageStatus?: boolean }): Promise<{ rows: Array<ReferenceRow & RecordMetadata>; total: number; truncated: boolean; cursor: string | null }> {
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
  const page = raw.slice(0, opts.limit);
  const rows: Array<ReferenceRow & RecordMetadata> = await hydrate(engine, page, scope.keepVisibility);
  if (opts.recordMetadata) {
    const meta = await readRecordMetadata(engine, page.map(r => Number(r.id)), scope);
    page.forEach((r, i) => Object.assign(rows[i]!, meta.get(Number(r.id)) ?? {}));
  } else if (opts.pageStatus) {
    const status = await readPageStatusByRef(engine, rows, scope);
    rows.forEach(r => { const value = status.get(`${r.source_id}:${r.slug}`); if (value) r.page_status = value; });
  }
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


// ---------------------------------------------------------------------------
// Records: the referring pages of enrolled record types, for many entities at once
// ---------------------------------------------------------------------------

/** Record rows per target page (all of them when it has this many or fewer). */
export const RECORD_ROWS_PER_TARGET = 5;
/** Record rows per call, allotted to target pages in input order. */
export const RECORD_ROWS_PER_CALL = 24;
/** `amends` / `supersedes` entries kept per record row. */
export const RECORD_LINKS_CAP = 5;
/** A frontmatter `status` longer than this, or not a string, is not shown. */
export const PAGE_STATUS_MAX_CHARS = 40;

/** The metadata a record row adds to a referring page; shared by the record view and its `get_backlinks` continuation. */
export interface RecordMetadata {
  /** The page's own frontmatter `status` (a string up to PAGE_STATUS_MAX_CHARS), only when set. */
  page_status?: string;
  /** Records this page amends (an `amends` link), each with the terms-start date its link records (`since`), when recorded. */
  amends?: Array<{ slug: string; since?: string }>;
  /** Records this page replaces as a whole (a `supersedes` link). */
  supersedes?: Array<{ slug: string }>;
}

/** One record: the referring page, its own date labeled as a page date with its source, and its record metadata. */
export interface RecordRow extends RecordMetadata {
  slug: string;
  title: string;
  /** The page's own date (when it was written or dated), not when its terms take effect. */
  date: string | null;
  date_source: string;
}

export interface RecordGroupRaw {
  canonical_type: string;
  total: number;
  rows: RecordRow[];
  /** The cursor that continues this type after the last shown row (null when no row is shown). */
  cursor: string | null;
  /** Why rows < total: the per-page cap, or the per-call cap (an earlier entity in the call took the rows). */
  capped?: 'per_page' | 'per_call';
}

export interface TargetReferences {
  /** Distinct referring pages, every type (the card's `referenced_by_count`). */
  referenced_by_count: number;
  /** Record groups, one per enrolled type with at least one record, newest group first. Absent when nothing is enrolled. */
  records?: RecordGroupRaw[];
}

export interface RecordTarget { slug: string; sourceId: string }

/** Enrolled types as pack-canonical types (a stored alias maps to its type), in enrollment order. */
export function canonicalRecordTypes(types: string[], pack: PackTypes | null): string[] {
  const pairs = typeAliasPairs(pack);
  return [...new Set(types.map(t => pairs.canonical[pairs.stored.indexOf(t)] ?? t))];
}

/**
 * The batched variant of `referrersCte`: the same membership, filters and
 * date, with a target index `i` on every row so many entities are read in
 * one statement. Params $1..$3 are the targets (sources, slugs, indexes);
 * $4 referrer sources; $5/$6 the stored type aliases and their canonical types.
 */
function referrersCteBatched(scope: Pick<ReferrerScope, 'excludePrivate' | 'eligibility' | 'includeQuarantined'>): string {
  const { targetPriv, linkPriv, pagePriv, pageTrust } = referrerFilters(scope);
  return `WITH tgt AS MATERIALIZED (
      SELECT k.i, t.id FROM pages t JOIN unnest($1::text[], $2::text[], $3::int[]) AS k(s, g, i) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${targetPriv}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT tg.i, l.from_page_id AS id FROM links l JOIN tgt tg ON l.to_page_id = tg.id WHERE true${linkPriv}
    ),
    typed AS MATERIALIZED (
      SELECT r.i, f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($6::text[])[array_position($5::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM refs r JOIN pages f ON f.id = r.id
       WHERE f.deleted_at IS NULL AND f.source_id = ANY($4::text[])
         AND NOT EXISTS (SELECT 1 FROM tgt x WHERE x.i = r.i AND x.id = f.id)${pagePriv}${pageTrust}
    )`;
}

/** A frontmatter `status` as `page_status`: a string, trimmed, at most PAGE_STATUS_MAX_CHARS; anything else is not shown. */
export function pageStatusValue(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value && value.length <= PAGE_STATUS_MAX_CHARS ? value : undefined;
}

/**
 * F3: `page_status` of live pages by `(source_id, slug)`, keyed
 * `source_id:slug`, one statement. A private page (for an untrusted caller)
 * or a quarantined page (unless the caller may read quarantined pages) gets
 * none.
 */
export async function readPageStatusByRef(engine: BrainEngine, refs: Array<{ source_id: string; slug: string }>,
  scope: { excludePrivate: boolean; includeQuarantined?: boolean }): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!refs.length) return out;
  const priv = scope.excludePrivate ? ` AND ${privatePagesFilterFragment('p')}` : '';
  const quarantine = scope.includeQuarantined ? '' : ` AND ${quarantineFilterFragment('p')}`;
  const rows = await engine.executeRaw<{ source_id: string; slug: string; status: unknown }>(
    `SELECT p.source_id, p.slug, p.frontmatter->'status' AS status
       FROM pages p JOIN unnest($1::text[], $2::text[]) AS u(s, g) ON p.source_id = u.s AND p.slug = u.g
      WHERE p.deleted_at IS NULL AND p.frontmatter ? 'status'${priv}${quarantine}`,
    [refs.map(r => r.source_id), refs.map(r => r.slug)]);
  for (const row of rows) {
    const value = pageStatusValue(row.status);
    if (value) out.set(`${row.source_id}:${row.slug}`, value);
  }
  return out;
}

/**
 * The record metadata of referring pages: `page_status` from frontmatter,
 * `amends` and `supersedes` links to pages the caller can see (targets in the
 * caller's referrer sources, link origins under the same privacy rule as the
 * referrer read), and each amends link's
 * `since` from the temporal relationship state for the caller's scope
 * (`world` for untrusted callers, so a date whose only evidence is private
 * stays hidden).
 */
export async function readRecordMetadata(engine: BrainEngine, pageIds: number[],
  scope: Pick<ReferrerScope, 'referrerSources' | 'excludePrivate' | 'includeQuarantined'>): Promise<Map<number, RecordMetadata>> {
  const out = new Map<number, RecordMetadata>();
  if (!pageIds.length) return out;
  const linkPriv = scope.excludePrivate ? ` AND ${privateLinkOriginFilterFragment('l')}` : '';
  const targetPriv = scope.excludePrivate ? ` AND ${privatePagesFilterFragment('t')}` : '';
  const targetQuarantine = scope.includeQuarantined ? '' : ` AND ${quarantineFilterFragment('t')}`;
  const [status, links] = await Promise.all([
    engine.executeRaw<{ id: number; status: unknown }>(`SELECT id, frontmatter->'status' AS status FROM pages WHERE id = ANY($1::int[])`, [pageIds]),
    engine.executeRaw<{ from_id: number; slug: string; link_type: string; since: string | null }>(
      `SELECT DISTINCT l.from_page_id AS from_id, t.slug, l.link_type,
              CASE WHEN l.link_type = 'amends' THEN to_char(r.first_start, 'YYYY-MM-DD') END AS since
         FROM links l JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL AND t.source_id = ANY($3::text[])${targetPriv}${targetQuarantine}
         LEFT JOIN link_relationships r ON r.from_page_id = l.from_page_id AND r.to_page_id = l.to_page_id
              AND r.link_type = l.link_type AND r.scope = $2
        WHERE l.from_page_id = ANY($1::int[]) AND l.link_type IN ('amends', 'supersedes')${linkPriv}
        ORDER BY l.from_page_id, t.slug`, [pageIds, scope.excludePrivate ? 'world' : 'all', scope.referrerSources]).catch(() => []),
  ]);
  for (const row of status) {
    const value = pageStatusValue(row.status);
    if (value) out.set(Number(row.id), { page_status: value });
  }
  for (const link of links) {
    const id = Number(link.from_id);
    const meta = out.get(id) ?? {};
    if (link.link_type === 'amends') {
      const list = meta.amends ?? [];
      const existing = list.find(a => a.slug === link.slug);
      if (existing) { if (!existing.since && link.since) existing.since = link.since; }
      else if (list.length < RECORD_LINKS_CAP) list.push({ slug: link.slug, ...(link.since ? { since: link.since } : {}) });
      meta.amends = list;
    } else {
      const list = meta.supersedes ?? [];
      if (!list.some(s => s.slug === link.slug) && list.length < RECORD_LINKS_CAP) list.push({ slug: link.slug });
      meta.supersedes = list;
    }
    out.set(id, meta);
  }
  return out;
}

interface RecordCandidate { i: number; id: number; slug: string; source_id: string; canonical_type: string; d: string | null }

/**
 * `referenced_by_count` and the enrolled-type records of many target pages in
 * one batched read. Each target expands like the single-target read (its
 * identity co-members under `entity_identity.union`), and its rows, totals
 * and cursors equal `readReferrerPage(…, { type })` for that target: records
 * are filtered by type inside the membership query, before ORDER BY, LIMIT
 * and hydration. Rows per target are capped at RECORD_ROWS_PER_TARGET, newest
 * page date first across the target's record types; the call cap is applied
 * after, in target order, before hydration. Targets repeating a page reuse
 * its result without taking more of the call cap.
 */
export async function readTargetReferences(engine: BrainEngine,
  scope: Omit<ReferrerScope, 'slug' | 'sourceId'>, targets: RecordTarget[],
  opts: { recordTypes: string[]; perTarget?: number; perCall?: number; isExpired?: () => boolean }): Promise<TargetReferences[]> {
  const keyOf = (t: RecordTarget) => `${t.sourceId}\0${t.slug}`;
  const unique: RecordTarget[] = [];
  const index = new Map<string, number>();
  for (const t of targets) if (!index.has(keyOf(t))) { index.set(keyOf(t), unique.length); unique.push(t); }
  if (!unique.length) return [];
  const union = await isIdentityUnionEnabled(engine);
  const expanded = await Promise.all(unique.map(t => targetPages(engine, { ...scope, slug: t.slug, sourceId: t.sourceId }, union)));
  const sources: string[] = [];
  const slugs: string[] = [];
  const idx: number[] = [];
  expanded.forEach((e, i) => e.slugs.forEach((slug, j) => { sources.push(e.sources[j]!); slugs.push(slug); idx.push(i); }));
  const pairs = typeAliasPairs(scope.pack);
  const recordTypes = canonicalRecordTypes(opts.recordTypes, scope.pack);
  const base = [sources, slugs, idx, scope.referrerSources, pairs.stored, pairs.canonical];
  const expired = () => opts.isExpired?.() === true;
  const counts = await engine.executeRaw<{ i: number; canonical_type: string | null; n: number }>(
    `${referrersCteBatched(scope)}
     SELECT i, NULL::text AS canonical_type, count(*)::int AS n FROM typed GROUP BY i
     UNION ALL
     SELECT i, canonical_type, count(*)::int AS n FROM typed WHERE canonical_type = ANY($7::text[]) GROUP BY i, canonical_type`,
    [...base, recordTypes]);
  if (expired()) throw new ReferencesDeadlineError();
  const perTarget = opts.perTarget ?? RECORD_ROWS_PER_TARGET;
  const candidates = recordTypes.length ? await engine.executeRaw<RecordCandidate>(
    `${referrersCteBatched(scope)}
     SELECT x.i, x.id, x.slug, x.source_id, x.canonical_type, ${dateText('x.d')} AS d
       FROM (SELECT DISTINCT i FROM tgt) q CROSS JOIN LATERAL (
         SELECT * FROM typed t WHERE t.i = q.i AND t.canonical_type = ANY($7::text[])
          ORDER BY t.d DESC NULLS LAST, t.source_id, t.slug LIMIT $8
       ) x
      ORDER BY x.i, x.d DESC NULLS LAST, x.source_id, x.slug`, [...base, recordTypes, perTarget]) : [];
  if (expired()) throw new ReferencesDeadlineError();
  let left = opts.perCall ?? RECORD_ROWS_PER_CALL;
  const kept: RecordCandidate[] = [];
  const callCut = new Set<number>();
  for (let i = 0; i < unique.length; i++) {
    const mine = candidates.filter(c => Number(c.i) === i);
    const rows = mine.slice(0, Math.max(0, left));
    if (rows.length < mine.length) callCut.add(i);
    left -= rows.length;
    kept.push(...rows);
  }
  const hydrated = await hydrateRecords(engine, kept, scope);
  if (expired()) throw new ReferencesDeadlineError();
  const results = unique.map((_, i): TargetReferences => {
    const total = counts.find(c => Number(c.i) === i && c.canonical_type === null)?.n ?? 0;
    if (!recordTypes.length) return { referenced_by_count: Number(total) };
    const typeTotals = counts.filter(c => Number(c.i) === i && c.canonical_type !== null);
    const mine = kept.map((k, j) => ({ k, row: hydrated[j]! })).filter(x => Number(x.k.i) === i);
    const groups = typeTotals.map((c): RecordGroupRaw & { newest: string } => {
      const shown = mine.filter(x => x.k.canonical_type === c.canonical_type);
      const last = shown[shown.length - 1]?.k;
      const capped = shown.length >= Number(c.n) ? undefined : callCut.has(i) ? 'per_call' as const : 'per_page' as const;
      return { canonical_type: c.canonical_type!, total: Number(c.n), rows: shown.map(x => x.row),
        cursor: last ? encodeCursor({ date: last.d, source_id: last.source_id, slug: last.slug }) : null,
        ...(capped ? { capped } : {}), newest: shown[0]?.k.d ?? '' };
    }).sort((a, b) => b.newest.localeCompare(a.newest) || recordTypes.indexOf(a.canonical_type) - recordTypes.indexOf(b.canonical_type))
      .map(({ newest: _n, ...g }) => g);
    return { referenced_by_count: Number(total), records: groups };
  });
  return targets.map(t => results[index.get(keyOf(t))!]!);
}

async function hydrateRecords(engine: BrainEngine, rows: RecordCandidate[],
  scope: Pick<ReferrerScope, 'referrerSources' | 'excludePrivate' | 'includeQuarantined'>): Promise<RecordRow[]> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map(r => Number(r.id)))];
  const [pages, meta] = await Promise.all([
    engine.executeRaw<{ id: number; title: string | null; date_source: string }>(
      `SELECT id, title, CASE WHEN effective_date IS NULL THEN 'updated_at' ELSE COALESCE(effective_date_source, 'effective_date') END AS date_source
         FROM pages WHERE id = ANY($1::int[])`, [ids]),
    readRecordMetadata(engine, ids, scope),
  ]);
  const byId = new Map(pages.map(p => [Number(p.id), p]));
  return rows.map(r => {
    const page = byId.get(Number(r.id));
    return { slug: r.slug, title: page?.title ?? r.slug, date: r.d, date_source: page?.date_source ?? 'updated_at', ...(meta.get(Number(r.id)) ?? {}) };
  });
}

/** The records/count phase ran past its deadline; callers show the unavailable marker. */
export class ReferencesDeadlineError extends Error {
  constructor() { super('references deadline'); this.name = 'ReferencesDeadlineError'; }
}
