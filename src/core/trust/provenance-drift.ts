/**
 * #7891: pages whose provenance stamps (`source_kind`, `ingested_via`, `ingested_at`) a write rewrote, or whose
 * lowering markers a write removed, before #7892 made those stamps server-owned on remote writes. Read-only; the
 * doctor check `provenance_stamp_drift` and the explicit repair `gbrain repair provenance` both read it.
 *
 * Each live page's history is its `page_versions` rows in id order followed by the live row. A transition from one
 * snapshot to the next was made by the older snapshot's `archived_write_request_id` (the live revision's own
 * `revision_write_request_id` when the archive names none), classified by that request's `authority.remote`, or by its
 * principal kind once receipt compaction removed the request: `remote`, `local`, or `unattributed` (no recorded writer,
 * writes before write attribution). Only remote damage is repaired by default; unattributed damage is `ambiguous` and
 * repaired only with `--include-ambiguous`; local changes are the owner's own edits and are reported, never repaired.
 *
 * - stamps_rewritten: a stamp key changed after the first snapshot, or the live stamp differs from the server-written
 *   `pages` column. The restored value is the trusted column when non-null, else the value just before the first
 *   remote (or ambiguous) change. A later local change of the same key makes the page `needs_review`.
 * - marker_lost: a transition raised the page's lowest frontmatter cap (`frontmatterTrustCaps`), and the live page
 *   still caps above the lost cap while its stored tier is `unknown` or above it (a re-read would raise it). The repair
 *   stamps the lost cap back as the lower-only `trust_tier` marker.
 * - marker_missing (#7918): a classified page whose stored tier is below the owner floor and whose live frontmatter
 *   caps above it, so a re-read of the page (a repository rebuild, a backfill) would raise it. The repair stamps the
 *   stored tier as the marker; the row keeps its tier.
 *
 * Every planned change only lowers: the marker through `stampTrustMarker`, the tier as min(stored, marker).
 */
import type { BrainEngine } from '../engine.ts';
import { digest } from '../persistence/digest.ts';
import { frontmatterTrustCaps, stampTrustMarker } from './channel.ts';
import { OWNER_TIER_FLOOR, compareTrust, minTrust, storedTrustTier, type TrustTier } from './tier.ts';

export const PROVENANCE_STAMP_KEYS = ['source_kind', 'ingested_via', 'ingested_at'] as const;
export type ProvenanceStampKey = typeof PROVENANCE_STAMP_KEYS[number];
export type DriftWriter = 'remote' | 'local' | 'unattributed';
export type DriftClass = 'remote' | 'ambiguous' | 'local' | 'needs_review' | 'restamp';
/** Pages scanned per source by the doctor check. */
export const DRIFT_SCAN_LIMIT = 50_000;
const BATCH = 500;
const REMOTE_PRINCIPALS = ['oauth_client', 'legacy_token', 'local_stdio'];

export interface DriftSnapshot { frontmatter: Record<string, unknown>; writer: DriftWriter; request_id: string | null }
export interface DriftPageInput {
  /** Oldest first; the last entry is the live row. `writer` is who wrote that snapshot (unused for the first). */
  chain: DriftSnapshot[];
  stored: TrustTier;
  columns: Partial<Record<ProvenanceStampKey, string | null>>;
}
export interface DriftChange { key: ProvenanceStampKey | 'cap'; writer: DriftWriter; request_id: string | null; from: unknown; to: unknown }
export interface DriftVerdict {
  class: DriftClass;
  /** Who made the damaging change (absent for `restamp`). */
  writer?: DriftWriter;
  marker_lost: boolean;
  stamps_rewritten: boolean;
  marker_missing: boolean;
  changes: DriftChange[];
  /** The restored stamps (`null` removes the key) and the marker the repair writes; absent for local and needs_review. */
  restore?: { stamps: Partial<Record<ProvenanceStampKey, unknown>>; marker: TrustTier | null; tier: TrustTier; frontmatter: Record<string, unknown> };
  reason?: string;
}

const lowestCap = (fm: Record<string, unknown>): TrustTier | null => {
  const caps = frontmatterTrustCaps(fm);
  return caps.length ? minTrust(caps[0]!, ...caps.slice(1)) : null;
};
/** a ranks above b, where null (no cap) ranks above every tier. */
const capAbove = (a: TrustTier | null, b: TrustTier | null) => b !== null && (a === null || compareTrust(a, b) > 0);
const normStamp = (key: ProvenanceStampKey, value: unknown): unknown => {
  if (value === undefined || value === null || value === '') return null;
  if (key === 'ingested_at') {
    const at = new Date(value instanceof Date ? value : String(value));
    return Number.isNaN(at.getTime()) ? String(value) : at.toISOString();
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
};

/** The repair verdict for one page, or null when nothing drifted. Pure. */
export function analyzePageDrift(input: DriftPageInput, opts: { includeAmbiguous?: boolean } = {}): DriftVerdict | null {
  const { chain, stored } = input;
  const live = chain[chain.length - 1]!.frontmatter;
  const changes: DriftChange[] = [];
  const restoredStamps: Partial<Record<ProvenanceStampKey, unknown>> = {};
  let needsReview: string | undefined;
  for (const key of PROVENANCE_STAMP_KEYS) {
    const events: DriftChange[] = [];
    for (let i = 1; i < chain.length; i++) {
      const from = normStamp(key, chain[i - 1]!.frontmatter[key]);
      const to = normStamp(key, chain[i]!.frontmatter[key]);
      if (from !== to) events.push({ key, writer: chain[i]!.writer, request_id: chain[i]!.request_id, from: chain[i - 1]!.frontmatter[key] ?? null, to: chain[i]!.frontmatter[key] ?? null });
    }
    const column = normStamp(key, input.columns[key]);
    const liveValue = normStamp(key, live[key]);
    const firstDamage = events.findIndex(event => event.writer !== 'local');
    const columnForged = column !== null && liveValue !== null && liveValue !== column;
    if (firstDamage < 0 && !columnForged) { changes.push(...events.filter(event => event.writer === 'local')); continue; }
    const before = firstDamage >= 0 ? events[firstDamage]!.from : undefined;
    const target = column !== null ? input.columns[key]! : before ?? null;
    if (normStamp(key, target) === liveValue) continue;
    if (firstDamage >= 0) {
      changes.push(...events);
      if (events.slice(firstDamage + 1).some(event => event.writer === 'local')) needsReview = `a later local write also changed ${key}`;
    } else changes.push({ key, writer: 'unattributed', request_id: null, from: input.columns[key] ?? null, to: live[key] ?? null });
    restoredStamps[key] = target;
  }
  let lostCap: TrustTier | null = null;
  for (let i = 1; i < chain.length; i++) {
    const from = lowestCap(chain[i - 1]!.frontmatter);
    const to = lowestCap(chain[i]!.frontmatter);
    if (!capAbove(to, from)) continue;
    changes.push({ key: 'cap', writer: chain[i]!.writer, request_id: chain[i]!.request_id, from, to });
    if (chain[i]!.writer !== 'local' && lostCap === null) lostCap = from;
  }
  const damaging = changes.filter(change => change.writer !== 'local' && (change.key !== 'cap' || lostCap !== null));
  const markerLost = lostCap !== null && capAbove(lowestCap(live), lostCap) && (stored === 'unknown' || compareTrust(stored, lostCap) > 0);
  const stampsRewritten = Object.keys(restoredStamps).length > 0;
  const classified = stored !== 'unknown' && compareTrust(stored, OWNER_TIER_FLOOR) < 0;
  const markerMissing = classified && capAbove(lowestCap(live), stored);
  if (!markerLost && !stampsRewritten) {
    if (markerMissing) return { class: 'restamp', marker_lost: false, stamps_rewritten: false, marker_missing: true, changes, ...planRestore(live, {}, null, stored) };
    return changes.some(change => change.writer === 'local')
      ? { class: 'local', writer: 'local', marker_lost: false, stamps_rewritten: false, marker_missing: false, changes } : null;
  }
  const writer: DriftWriter = damaging.some(change => change.writer === 'remote') ? 'remote' : 'unattributed';
  const verdict: DriftVerdict = { class: writer === 'remote' ? 'remote' : 'ambiguous', writer, marker_lost: markerLost, stamps_rewritten: stampsRewritten, marker_missing: markerMissing, changes };
  if (needsReview) return { ...verdict, class: 'needs_review', reason: needsReview };
  if (verdict.class === 'ambiguous' && !opts.includeAmbiguous) return verdict;
  return { ...verdict, ...planRestore(live, restoredStamps, markerLost ? lostCap : null, stored) };
}

function planRestore(live: Record<string, unknown>, stamps: Partial<Record<ProvenanceStampKey, unknown>>, lostCap: TrustTier | null, stored: TrustTier): Pick<DriftVerdict, 'restore'> {
  let frontmatter: Record<string, unknown> = { ...live };
  for (const [key, value] of Object.entries(stamps)) {
    if (value === null || value === undefined) delete frontmatter[key];
    else frontmatter[key] = value;
  }
  const caps = [...frontmatterTrustCaps(frontmatter), ...frontmatterTrustCaps(live), ...(lostCap ? [lostCap] : []), ...(stored !== 'unknown' ? [stored] : [])];
  const cap = caps.length ? minTrust(caps[0]!, ...caps.slice(1)) : null;
  if (cap) frontmatter = stampTrustMarker(frontmatter, cap);
  const marker = typeof frontmatter.trust_tier === 'string' ? frontmatter.trust_tier as TrustTier : null;
  return { restore: { stamps, marker, tier: cap ? minTrust(stored, cap) : stored, frontmatter } };
}

export interface DriftCounts { remote: number; local: number; unattributed: number }
export interface DriftItem { source_id: string; slug: string; page_id: number; revision: string; tier: TrustTier; verdict: DriftVerdict }
export interface SourceDrift {
  source_id: string; scanned: number; truncated: boolean; schema: 'current' | 'pre_attribution' | 'pre_trust';
  marker_lost: DriftCounts; stamps_rewritten: DriftCounts; marker_missing: number; needs_review: number;
  samples: Record<string, string[]>;
  items: DriftItem[];
}

interface LiveRow {
  id: number | string; slug: string; trust_tier: string | null; frontmatter: Record<string, unknown> | string | null; revision: string;
  source_kind: string | null; ingested_via: string | null; ingested_at: string | Date | null; req: string | null; kind: string | null; remote: string | null;
}
interface VersionRow { page_id: number | string; frontmatter: Record<string, unknown> | string | null; req: string | null; kind: string | null; remote: string | null }

const json = (value: Record<string, unknown> | string | null): Record<string, unknown> => typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value ?? {};
function writerOf(req: string | null, remote: string | null, kind: string | null): DriftWriter {
  if (remote === 'true') return 'remote';
  if (remote === 'false') return 'local';
  if (!kind) return 'unattributed';
  return REMOTE_PRINCIPALS.includes(kind) ? 'remote' : 'local';
}

async function columnsOf(engine: BrainEngine, table: string): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = ANY(current_schemas(false))", [table]);
  return new Set(rows.map(row => row.column_name));
}

/** Whether this brain has the columns the scan reads: trust tiers, then write attribution. */
export async function driftSchema(engine: BrainEngine): Promise<SourceDrift['schema']> {
  const pages = await columnsOf(engine, 'pages');
  if (!pages.has('trust_tier')) return 'pre_trust';
  const versions = await columnsOf(engine, 'page_versions');
  return pages.has('revision_write_request_id') && versions.has('archived_write_request_id') ? 'current' : 'pre_attribution';
}

/** Reads one page's history the way the scan does; null when the page is gone. */
export async function readPageDrift(engine: BrainEngine, sourceId: string, slug: string, opts: { includeAmbiguous?: boolean } = {}): Promise<DriftItem | null> {
  const schema = await driftSchema(engine);
  if (schema === 'pre_trust') return null;
  const [row] = await liveRows(engine, schema, sourceId, { slug });
  if (!row) return null;
  const versions = await versionRows(engine, schema, [Number(row.id)]);
  return itemOf(sourceId, row, versions, opts);
}

function liveRows(engine: BrainEngine, schema: SourceDrift['schema'], sourceId: string, at: { after?: number; slug?: string }): Promise<LiveRow[]> {
  const attributed = schema === 'current';
  return engine.executeRaw<LiveRow>(
    `SELECT p.id, p.slug, p.trust_tier, p.frontmatter, p.knowledge_revision::text AS revision, p.source_kind, p.ingested_via, p.ingested_at,
            ${attributed ? "p.revision_write_request_id::text AS req, p.revision_principal_kind AS kind, r.authority->>'remote' AS remote"
              : 'NULL::text AS req, NULL::text AS kind, NULL::text AS remote'}
       FROM pages p ${attributed ? 'LEFT JOIN persistence_requests r ON r.id = p.revision_write_request_id' : ''}
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND ${at.slug !== undefined ? 'p.slug = $2' : 'p.id > $2'}
      ORDER BY p.id LIMIT ${BATCH}`, [sourceId, at.slug ?? at.after ?? 0]);
}

function versionRows(engine: BrainEngine, schema: SourceDrift['schema'], pageIds: number[]): Promise<VersionRow[]> {
  const attributed = schema === 'current';
  return engine.executeRaw<VersionRow>(
    `SELECT v.page_id, v.frontmatter,
            ${attributed ? "v.archived_write_request_id::text AS req, v.archived_principal_kind AS kind, r.authority->>'remote' AS remote"
              : 'NULL::text AS req, NULL::text AS kind, NULL::text AS remote'}
       FROM page_versions v ${attributed ? 'LEFT JOIN persistence_requests r ON r.id = v.archived_write_request_id' : ''}
      WHERE v.page_id = ANY($1::int[]) ORDER BY v.page_id, v.id`, [pageIds]);
}

function itemOf(sourceId: string, row: LiveRow, versions: VersionRow[], opts: { includeAmbiguous?: boolean }): DriftItem | null {
  const chain: DriftSnapshot[] = versions.map((version, index) => {
    const previous = versions[index - 1];
    return { frontmatter: json(version.frontmatter), writer: previous ? writerOf(previous.req, previous.remote, previous.kind) : 'unattributed', request_id: previous?.req ?? null };
  });
  const last = versions[versions.length - 1];
  const liveWriter = last && (last.req || last.kind) ? { writer: writerOf(last.req, last.remote, last.kind), request_id: last.req } : { writer: writerOf(row.req, row.remote, row.kind), request_id: row.req };
  chain.push({ frontmatter: json(row.frontmatter), ...liveWriter });
  const ingestedAt = row.ingested_at instanceof Date ? row.ingested_at.toISOString() : row.ingested_at;
  const verdict = analyzePageDrift({ chain, stored: storedTrustTier(row.trust_tier),
    columns: { source_kind: row.source_kind, ingested_via: row.ingested_via, ingested_at: ingestedAt } }, opts);
  return verdict ? { source_id: sourceId, slug: row.slug, page_id: Number(row.id), revision: row.revision, tier: storedTrustTier(row.trust_tier), verdict } : null;
}

/** One source's drift, bounded to `limit` live pages in id order (`truncated` when more remain). Read-only. */
export async function scanProvenanceDrift(engine: BrainEngine, sourceId: string, opts: { limit?: number; sampleSize?: number; includeAmbiguous?: boolean; slugs?: string[] } = {}): Promise<SourceDrift> {
  const empty = (): DriftCounts => ({ remote: 0, local: 0, unattributed: 0 });
  const schema = await driftSchema(engine);
  const result: SourceDrift = { source_id: sourceId, scanned: 0, truncated: false, schema, marker_lost: empty(), stamps_rewritten: empty(), marker_missing: 0, needs_review: 0, samples: {}, items: [] };
  if (schema === 'pre_trust') return result;
  const limit = opts.limit ?? DRIFT_SCAN_LIMIT;
  const sampleSize = opts.sampleSize ?? 20;
  const sample = (bucket: string, slug: string) => { const list = result.samples[bucket] ??= []; if (list.length < sampleSize) list.push(slug); };
  const record = (item: DriftItem) => {
    const { verdict } = item;
    result.items.push(item);
    if (verdict.marker_missing) { result.marker_missing++; sample('marker_missing', item.slug); }
    if (verdict.class === 'needs_review') { result.needs_review++; sample('needs_review', item.slug); }
    const writer = verdict.writer;
    if (!writer) return;
    if (verdict.marker_lost) { result.marker_lost[writer]++; sample(`marker_lost.${writer}`, item.slug); }
    if (verdict.stamps_rewritten) { result.stamps_rewritten[writer]++; sample(`stamps_rewritten.${writer}`, item.slug); }
    if (verdict.class !== 'local') return;
    if (verdict.changes.some(change => change.key === 'cap')) result.marker_lost.local++;
    if (verdict.changes.some(change => change.key !== 'cap')) result.stamps_rewritten.local++;
    sample('local', item.slug);
  };
  if (opts.slugs?.length) {
    for (const slug of [...new Set(opts.slugs)].sort()) {
      const item = await readPageDrift(engine, sourceId, slug, opts);
      result.scanned++;
      if (item) record(item);
    }
    return result;
  }
  for (let after = 0; ;) {
    const rows = await liveRows(engine, schema, sourceId, { after });
    if (!rows.length) return result;
    const take = rows.slice(0, Math.max(0, limit - result.scanned));
    const versions = await versionRows(engine, schema, take.map(row => Number(row.id)));
    const byPage = new Map<number, VersionRow[]>();
    for (const version of versions) { const list = byPage.get(Number(version.page_id)) ?? []; list.push(version); byPage.set(Number(version.page_id), list); }
    for (const row of take) {
      result.scanned++;
      const item = itemOf(sourceId, row, byPage.get(Number(row.id)) ?? [], opts);
      if (item) record(item);
    }
    if (take.length < rows.length || result.scanned >= limit) { result.truncated = take.length < rows.length || rows.length === BATCH; return result; }
    if (rows.length < BATCH) return result;
    after = Number(rows[rows.length - 1]!.id);
  }
}

/** The digest of the change an item plans, for the preview hash and the write's re-check. */
export const plannedDigest = (item: Pick<DriftItem, 'page_id' | 'revision' | 'verdict'>) =>
  digest(['provenance-v1', item.page_id, item.revision, item.verdict.class, item.verdict.restore?.frontmatter ?? null, item.verdict.restore?.tier ?? null]);
