import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine, LinkBatchInput } from './engine.ts';
import { extractPageLinks, extractEntityRefs, attendanceEvidenceRanges, hasAttendanceEvidence,
  resolvedLinkCandidate, normalizeBasename, LINK_EXTRACTOR_VERSION_TS,
  type LinkExtractionPack, type SlugResolver } from './link-extraction.ts';
import { slugifyPath } from './sync.ts';
import { isValidSourceId } from './source-id.ts';
import { loadActivePackForEngine, approvedSchemaIdentity } from './schema-pack/engine-resolution.ts';
import { invalidatePackCache } from './schema-pack/registry.ts';
import { executeRawJsonb } from './sql-query.ts';
import { applyAttendanceDelta } from './derived-links.ts';

export const ATTENDANCE_REPAIR_PARSER = `attendance-repair-v2:${LINK_EXTRACTOR_VERSION_TS}`;
export const ATTENDANCE_REPAIR_LIMIT = 250;
export const ATTENDANCE_REPAIR_MAX = 1000;
const MAX_REFS = 256;
const MAX_EDGES = 512;
const MAX_BYTES = 256 * 1024;
const CHECKPOINT_OP = 'attendance-repair';
const APPROVAL_LIFETIME_MS = 7 * 86400_000;

export function attendanceRepairHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

interface PagePin { id: string; slug: string; source_id: string; type: string; revision: string }
interface ScanPage extends PagePin { deleted: boolean }
interface OriginPage extends PagePin {
  compiled_truth: string | null;
  timeline: string | null;
  bytes: number;
}
export interface AttendanceEdge {
  id: string;
  from_page_id: string;
  to_page_id: string;
  origin_page_id: string | null;
  link_source: string | null;
  origin_field: string | null;
  link_kind: string | null;
  row_hash: string | null;
}
export interface AttendanceOriginPreview {
  page: PagePin;
  contentHash: string;
  lookupSlugs: string[];
  endpoints: PagePin[];
  adjacentRows: number;
  before: AttendanceEdge[];
  remove: string[];
  add: Array<{ from: string; producer: string; field: string | null; evidenceHash: string }>;
  unchanged: number;
  skipped: number;
  ambiguous: number;
  reason?: string;
}
export interface AttendanceRepairPreview {
  version: 2;
  approvalId: string;
  issuedAt: number;
  parser: string;
  brain: string;
  sourceId: string;
  sourceIncarnation: string;
  ontology: string;
  pack: string;
  direction: 'person_to_meeting' | 'pack_semantics_preserved' | 'pack_unavailable';
  frontmatter: 'report_only';
  afterSlug: string;
  limit: number;
  nextAfterSlug: string;
  complete: boolean;
  window: ScanPage[];
  origins: AttendanceOriginPreview[];
  counts: { scanned: number; eligibleOrigins: number; changed: number; add: number; remove: number; unchanged: number;
    skipped: number; ambiguous: number; conflicts: number; pack_semantics_preserved: number };
  diagnostics: Array<{ originId: string; reason: string }>;
  digest: string;
}
export interface AttendanceRepairAuthority { remote: boolean }

export function assertAttendanceRepairAuthority(authority: AttendanceRepairAuthority) {
  if (authority.remote !== false) throw new Error('Attendance repair requires trusted local authority');
}

export function validateAttendanceRepairScope(sourceId: string, limit = ATTENDANCE_REPAIR_LIMIT, afterSlug = '') {
  if (!isValidSourceId(sourceId)) throw new Error('Attendance repair requires an explicit source ID');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ATTENDANCE_REPAIR_MAX) throw new Error('Attendance repair limit must be 1–1000');
  if (typeof afterSlug !== 'string' || Buffer.byteLength(afterSlug) > 2048 || /[\x00-\x1f\x7f]/.test(afterSlug)) {
    throw new Error('Attendance repair after-slug must be a bounded slug cursor');
  }
}

async function identity(engine: BrainEngine, sourceId: string) {
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
    'SELECT id, incarnation FROM sources WHERE id=ANY($1::text[]) AND archived IS NOT TRUE AND archived_at IS NULL', [[sourceId, 'default']]);
  const source = sources.find(row => row.id === sourceId);
  const brain = sources.find(row => row.id === 'default');
  if (!source || !brain) throw new Error(`Attendance repair requires an existing live source and brain identity: ${!source
    ? `selected source '${sourceId}'` : "literal 'default' identity source"} is missing or archived`);
  return { sourceIncarnation: source.incarnation, brain: attendanceRepairHash(brain.incarnation) };
}

async function ontology(engine: BrainEngine, sourceId: string) {
  const bindings = [await engine.getConfig('schema_pack'), await engine.getConfig(`schema_pack.source.${sourceId}`),
    process.env.GBRAIN_SCHEMA_PACK ?? null];
  try {
    let resolved = await loadActivePackForEngine(engine, { remote: false, sourceId });
    invalidatePackCache(resolved.manifest.name);
    resolved = await loadActivePackForEngine(engine, { remote: false, sourceId });
    const pack = resolved.manifest;
    const overridden = pack.link_types.some(link => link.name === 'attended' && link.inference)
      || pack.frontmatter_links.some(mapping => mapping.page_type === 'meeting'
        && (mapping.link_type === 'attended' || mapping.fields.includes('attendees')));
    return { hash: attendanceRepairHash([bindings, approvedSchemaIdentity(resolved)]), name: pack.name,
      direction: overridden ? 'pack_semantics_preserved' as const : 'person_to_meeting' as const, pack };
  } catch {
    return { hash: attendanceRepairHash(bindings), name: 'unavailable', direction: 'pack_unavailable' as const, pack: null };
  }
}

const PAGE_PIN_SQL = 'id::text, slug, source_id, type, knowledge_revision::text AS revision';

async function readOrigin(engine: BrainEngine, sourceId: string, id: string): Promise<OriginPage> {
  const rows = await engine.executeRaw<OriginPage>(`SELECT ${PAGE_PIN_SQL},
    octet_length(compiled_truth)+octet_length(COALESCE(timeline,'')) AS bytes,
    CASE WHEN octet_length(compiled_truth)+octet_length(COALESCE(timeline,''))<=$3 THEN compiled_truth END AS compiled_truth,
    CASE WHEN octet_length(compiled_truth)+octet_length(COALESCE(timeline,''))<=$3 THEN timeline END AS timeline
    FROM pages WHERE source_id=$1 AND id=$2::bigint AND deleted_at IS NULL`, [sourceId, id, MAX_BYTES]);
  if (!rows.length) throw new Error('Attendance repair origin changed or was deleted');
  return rows[0];
}

async function readEdges(engine: BrainEngine, id: string) {
  const candidates = await engine.executeRaw<{ id: string }>(`WITH candidates AS MATERIALIZED (
      (SELECT id FROM links WHERE from_page_id=$1::bigint LIMIT $2)
      UNION (SELECT id FROM links WHERE to_page_id=$1::bigint LIMIT $2)
      UNION (SELECT id FROM links WHERE origin_page_id=$1::bigint LIMIT $2)
    ) SELECT id::text FROM candidates LIMIT $2`, [id, MAX_EDGES + 1]);
  if (candidates.length > MAX_EDGES || !candidates.length) return { edges: [] as AttendanceEdge[], count: candidates.length };
  const edges = await engine.executeRaw<AttendanceEdge>(`SELECT id::text, from_page_id::text, to_page_id::text,
    origin_page_id::text, link_source, link_kind,
    CASE WHEN octet_length(context)+octet_length(COALESCE(origin_field,''))<=$2 THEN origin_field END AS origin_field,
    CASE WHEN octet_length(context)+octet_length(COALESCE(origin_field,''))<=$2 THEN encode(sha256(convert_to(to_jsonb(l)::text,'UTF8')),'hex') END AS row_hash
    FROM links l WHERE id=ANY($1::bigint[]) AND link_type='attended' ORDER BY l.id`, [candidates.map(row => row.id), MAX_BYTES]);
  return { edges, count: candidates.length };
}

function pagePin(page: PagePin): PagePin {
  return { id: page.id, slug: page.slug, source_id: page.source_id, type: page.type, revision: page.revision };
}

async function prepareOrigin(engine: BrainEngine, page: OriginPage, pack: LinkExtractionPack | null, direction: string, pinnedSlugs: string[] = []) {
  const result: AttendanceOriginPreview = { page: pagePin(page), contentHash: attendanceRepairHash([
    page.compiled_truth, page.timeline, page.bytes]), lookupSlugs: [], endpoints: [], adjacentRows: 0, before: [],
    remove: [], add: [], unchanged: 0, skipped: 0, ambiguous: 0 };
  const additions: LinkBatchInput[] = [];
  const stop = (reason: string) => { result.reason = reason; result.skipped++; return { result, additions: [] as LinkBatchInput[] }; };
  const adjacent = await readEdges(engine, page.id);
  result.before = adjacent.edges;
  result.adjacentRows = adjacent.count;
  if (direction !== 'person_to_meeting') return stop(direction);
  if (page.type !== 'meeting') return stop('origin_type_unsupported');
  if (page.bytes > MAX_BYTES || page.compiled_truth === null) return stop('origin_size_limit');
  if (adjacent.count > MAX_EDGES) return stop('edge_limit');
  if (result.before.some(edge => edge.row_hash === null)) return stop('edge_size_limit');
  const needed = new Set<string>(pinnedSlugs);
  const resolver: SlugResolver = { async resolve() { return null; } };
  const content = `${page.compiled_truth}\n${page.timeline ?? ''}`;
  const first = await extractPageLinks(page.slug, content, {}, page.type, resolver,
    { pack, skipFrontmatter: true, targetType: () => 'person' });
  for (const candidate of first.candidates) {
    if (!candidate.targetSourceId || candidate.targetSourceId === page.source_id) needed.add(candidate.targetSlug);
  }
  if (needed.size > MAX_REFS) return stop('reference_limit');
  const edgeIds = [...new Set(result.before.flatMap(edge => [edge.from_page_id, edge.to_page_id]))].filter(id => id !== page.id);
  const edgeEndpoints = edgeIds.length ? await engine.executeRaw<PagePin>(`SELECT ${PAGE_PIN_SQL} FROM pages
    WHERE source_id=$1 AND id=ANY($2::bigint[]) AND deleted_at IS NULL ORDER BY slug`, [page.source_id, edgeIds]) : [];
  for (const endpoint of edgeEndpoints) needed.add(endpoint.slug);
  if (needed.size > MAX_REFS) return stop('reference_limit');
  result.lookupSlugs = [...needed].sort();
  const endpoints = needed.size ? await engine.executeRaw<PagePin>(`SELECT ${PAGE_PIN_SQL} FROM pages
    WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL ORDER BY slug`, [page.source_id, result.lookupSlugs]) : [];
  result.endpoints = endpoints;
  const index = new Map(endpoints.map(endpoint => [endpoint.slug, endpoint]));
  const ranges = attendanceEvidenceRanges(content);
  const ambiguousBare = extractEntityRefs(content).filter(ref => ref.needsResolution && !ref.slug.includes('/')
    && ref.index !== undefined && hasAttendanceEvidence(ranges, ref.index)
    && [...new Set([slugifyPath(ref.slug), normalizeBasename(ref.slug)])]
      .filter(slug => index.get(slug)?.type === 'person').length !== 1);
  const unresolvedBody = first.candidates.filter(candidate => candidate.canonicalAttendance
    && ((candidate.targetSourceId && candidate.targetSourceId !== page.source_id) || index.get(candidate.targetSlug)?.type !== 'person'));
  if (unresolvedBody.length || ambiguousBare.length) {
    result.ambiguous = unresolvedBody.length + ambiguousBare.length;
    return stop('unresolved_attendees');
  }
  const extracted = await extractPageLinks(page.slug, content, {}, page.type, resolver,
    { pack, skipFrontmatter: true, targetType: (slug, source) => !source || source === page.source_id ? index.get(slug)?.type : undefined });
  const desired = new Map<string, LinkBatchInput>();
  for (const candidate of extracted.candidates) {
    if (candidate.linkType !== 'attended' || (candidate.targetSourceId && candidate.targetSourceId !== page.source_id)) continue;
    const row = resolvedLinkCandidate(candidate, page.slug, page.source_id,
      { fromSlug: candidate.fromSlug ?? page.slug, fromSourceId: page.source_id, toSourceId: page.source_id });
    if (row.to_slug !== page.slug || row.origin_slug !== page.slug || index.get(row.from_slug)?.type !== 'person'
      || row.link_source !== 'markdown') continue;
    desired.set(`${index.get(row.from_slug)!.id}:${row.link_source}`, row);
  }
  const retained = new Set<string>();
  for (const edge of result.before) {
    const canonicalKey = `${edge.from_page_id}:${edge.link_source}`;
    const owned = edge.origin_page_id === page.id && edge.to_page_id === page.id
      && edge.link_source === 'markdown';
    const legacy = edge.from_page_id === page.id && edge.origin_page_id === null && edge.link_source === 'markdown';
    if ((owned || legacy) && !endpoints.some(endpoint => endpoint.id === (owned ? edge.from_page_id : edge.to_page_id)
      && endpoint.type === 'person')) return stop('endpoint_unavailable');
    if (owned) {
      if (desired.has(canonicalKey)) { retained.add(canonicalKey); result.unchanged++; }
      else result.remove.push(edge.id);
    } else if (legacy) {
      if (!desired.has(`${edge.to_page_id}:markdown`)) return stop('legacy_evidence_unproven');
      result.remove.push(edge.id);
    } else result.skipped++;
  }
  for (const [key, row] of desired) {
    if (retained.has(key)) continue;
    additions.push(row);
    result.add.push({ from: index.get(row.from_slug)!.id, producer: row.link_source!, field: row.origin_field ?? null,
      evidenceHash: attendanceRepairHash(row.context ?? '') });
  }
  if (adjacent.count - result.remove.length + result.add.length > MAX_EDGES) return stop('edge_limit');
  return { result, additions };
}

export async function previewAttendanceRepair(engine: BrainEngine, options: AttendanceRepairAuthority & {
  sourceId: string; limit?: number; afterSlug?: string; brainIdentity?: string;
}): Promise<AttendanceRepairPreview> {
  assertAttendanceRepairAuthority(options);
  const limit = options.limit ?? ATTENDANCE_REPAIR_LIMIT;
  const afterSlug = options.afterSlug ?? '';
  validateAttendanceRepairScope(options.sourceId, limit, afterSlug);
  const [{ issued_at }] = await engine.executeRaw<{ issued_at: string }>(
    'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS issued_at');
  const selected = await identity(engine, options.sourceId);
  selected.brain = attendanceRepairHash([selected.brain, options.brainIdentity ?? null]);
  const schema = await ontology(engine, options.sourceId);
  const window = await engine.executeRaw<ScanPage>(`SELECT ${PAGE_PIN_SQL}, deleted_at IS NOT NULL AS deleted
    FROM pages WHERE source_id=$1 AND slug>$2 ORDER BY slug LIMIT $3`, [options.sourceId, afterSlug, limit]);
  const origins: AttendanceOriginPreview[] = [];
  let retainedBytes = 0;
  for (const page of window.filter(page => page.type === 'meeting' && !page.deleted)) {
    const { result } = await prepareOrigin(engine, await readOrigin(engine, options.sourceId, page.id), schema.pack, schema.direction);
    if (attendanceRepairHash(result.page) !== attendanceRepairHash(pagePin(page))) throw new Error('Attendance origin changed during preview');
    if (result.reason) { result.remove = []; result.add = []; }
    retainedBytes += Buffer.byteLength(JSON.stringify(result));
    if (retainedBytes > 16 * 1024 ** 2) throw new Error('Attendance preview exceeds 16 MiB; use a smaller --limit');
    origins.push(result);
  }
  const counts = { scanned: window.length, eligibleOrigins: origins.length, changed: 0, add: 0, remove: 0, unchanged: 0,
    skipped: window.length - origins.length, ambiguous: 0,
    conflicts: 0, pack_semantics_preserved: 0 };
  for (const origin of origins) {
    counts.changed += Number(origin.add.length + origin.remove.length > 0);
    counts.add += origin.add.length; counts.remove += origin.remove.length; counts.unchanged += origin.unchanged;
    counts.skipped += origin.skipped; counts.ambiguous += origin.ambiguous;
    counts.pack_semantics_preserved += Number(origin.reason === 'pack_semantics_preserved');
  }
  const preview: AttendanceRepairPreview = { version: 2, approvalId: randomUUID(), issuedAt: Number(issued_at), parser: ATTENDANCE_REPAIR_PARSER, ...selected,
    sourceId: options.sourceId, ontology: schema.hash, pack: schema.name, direction: schema.direction, afterSlug, limit,
    frontmatter: 'report_only', nextAfterSlug: window.at(-1)?.slug ?? afterSlug, complete: window.length < limit,
    window, origins, counts, diagnostics: origins.filter(origin => origin.reason).slice(0, 20)
      .map(origin => ({ originId: origin.page.id, reason: origin.reason! })), digest: '' };
  preview.digest = attendanceRepairHash({ ...preview, digest: '' });
  return preview;
}

export async function applyAttendanceRepair(engine: BrainEngine, preview: AttendanceRepairPreview,
  options: AttendanceRepairAuthority & { sourceId: string; confirm: string; yes: boolean; backupVerified: boolean; brainIdentity?: string;
    checkpoint: (state: { digest: string; sourceIncarnation: string; ontology: string; committed: number; originId: string | null;
      afterSlug: string; pagesProcessed: number;
      approvedAdded: number; approvedRemoved: number; createdThisRun: number; removedThisRun: number; replayed: number }) => Promise<void>;
  }) {
  assertAttendanceRepairAuthority(options);
  validateAttendanceRepairScope(options.sourceId, preview.limit, preview.afterSlug);
  if (options.yes !== true || options.backupVerified !== true || typeof options.checkpoint !== 'function') {
    throw new Error('Attendance apply requires --yes, --backup-verified and a private checkpoint');
  }
  if (preview.version !== 2 || typeof preview.approvalId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(preview.approvalId)
    || !Number.isSafeInteger(preview.issuedAt) || preview.issuedAt <= 0 || preview.issuedAt > 8640000000000000
    || preview.parser !== ATTENDANCE_REPAIR_PARSER || preview.sourceId !== options.sourceId
    || preview.digest !== options.confirm || preview.digest !== attendanceRepairHash({ ...preview, digest: '' })
    || preview.origins.length > preview.limit || preview.window.length > preview.limit
    || preview.frontmatter !== 'report_only' || preview.nextAfterSlug !== (preview.window.at(-1)?.slug ?? preview.afterSlug)) {
    throw new Error('Attendance preview identity mismatch');
  }
  if (attendanceRepairHash(preview.origins.map(origin => origin.page)) !== attendanceRepairHash(preview.window
    .filter(page => page.type === 'meeting' && !page.deleted).map(pagePin))) throw new Error('Attendance preview window mismatch');
  if (preview.origins.some(origin => origin.lookupSlugs.length > MAX_REFS || origin.endpoints.length > MAX_REFS
    || origin.before.length > MAX_EDGES + 1 || origin.add.length > MAX_REFS || origin.remove.length > MAX_EDGES
    || !/^\d+$/.test(origin.page.id)) || new Set(preview.origins.map(origin => origin.page.id)).size !== preview.origins.length) {
    throw new Error('Attendance preview exceeds repair bounds');
  }
  const initialIdentity = await identity(engine, preview.sourceId);
  const initialSchema = await ontology(engine, preview.sourceId);
  if (attendanceRepairHash([initialIdentity.brain, options.brainIdentity ?? null]) !== preview.brain
    || initialIdentity.sourceIncarnation !== preview.sourceIncarnation || initialSchema.hash !== preview.ontology) {
    throw new Error('Attendance source, brain or ontology changed; preview again');
  }
  let committed = 0;
  let created = 0;
  let removed = 0;
  let replayed = 0;
  let approvedAdded = 0;
  let approvedRemoved = 0;
  let pagesProcessed = 0;
  let originId: string | null = null;
  const pending = [...preview.origins, ...(preview.window.at(-1)?.id !== preview.origins.at(-1)?.page.id || !preview.window.length ? [null] : [])];
  for (const approved of pending) {
    const end = approved ? preview.window.findIndex(page => page.id === approved.page.id) + 1 : preview.window.length;
    const segment = preview.window.slice(pagesProcessed, end);
    const result = await engine.transaction(async tx => {
      await tx.executeRaw("SET LOCAL lock_timeout='5s'");
      await tx.executeRaw("SET LOCAL statement_timeout='10s'");
      await tx.executeRaw('LOCK TABLE config IN SHARE MODE');
      await tx.executeRaw('SELECT id FROM sources WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', [[preview.sourceId, 'default']]);
      await tx.lockPageKeys([...segment.map(page => ({ sourceId: preview.sourceId, slug: page.slug })),
        ...(approved?.lookupSlugs ?? []).map(slug => ({ sourceId: preview.sourceId, slug }))]);
      if (approved) await tx.executeRaw('LOCK TABLE links IN SHARE ROW EXCLUSIVE MODE');
      const actualIdentity = await identity(tx, preview.sourceId);
      const actualSchema = await ontology(tx, preview.sourceId);
      if (attendanceRepairHash([actualIdentity.brain, options.brainIdentity ?? null]) !== preview.brain || actualIdentity.sourceIncarnation !== preview.sourceIncarnation
        || actualSchema.hash !== preview.ontology) throw new Error('Attendance source, brain or ontology changed; preview again');
      const actualSegment = segment.length ? await tx.executeRaw<ScanPage>(`SELECT ${PAGE_PIN_SQL}, deleted_at IS NOT NULL AS deleted
        FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) ORDER BY slug`, [preview.sourceId, segment.map(page => page.slug)]) : [];
      if (attendanceRepairHash(actualSegment) !== attendanceRepairHash(segment)) throw new Error('Attendance scan window changed; preview again');
      const [{ checked_at }] = await tx.executeRaw<{ checked_at: string }>(
        'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS checked_at');
      if (preview.issuedAt > Number(checked_at) || Number(checked_at) - preview.issuedAt >= APPROVAL_LIFETIME_MS) {
        throw new Error('Attendance approval expired or is not yet valid; preview again');
      }
      if (!approved) return { created: 0, removed: 0, replayed: 0 };
      const page = await readOrigin(tx, preview.sourceId, approved.page.id);
      const prepared = await prepareOrigin(tx, page, actualSchema.pack, actualSchema.direction, approved.lookupSlugs);
      if (prepared.result.reason) { prepared.result.remove = []; prepared.result.add = []; }
      if (attendanceRepairHash([prepared.result.page, prepared.result.contentHash, prepared.result.endpoints, prepared.result.lookupSlugs])
        !== attendanceRepairHash([approved.page, approved.contentHash, approved.endpoints, approved.lookupSlugs])) {
        throw new Error('Attendance origin or endpoint changed; preview again');
      }
      const key = attendanceRepairHash([preview.digest, approved.page.id]);
      const receipts = await tx.executeRaw<{ completed_keys: string[]; live: boolean }>(
        `SELECT completed_keys, updated_at > clock_timestamp()-interval '7 days' AND updated_at <= clock_timestamp() AS live
          FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 FOR SHARE`, [CHECKPOINT_OP, key]);
      if (receipts.length) {
        if (!receipts[0].live) throw new Error('Attendance commit proof expired; preview again');
        if (receipts[0].completed_keys[0] !== attendanceRepairHash([prepared.result.before, prepared.result.adjacentRows])) {
          throw new Error('Committed attendance edges changed; preview again');
        }
        return { created: 0, removed: 0, replayed: 1 };
      }
      if (attendanceRepairHash(prepared.result) !== attendanceRepairHash(approved)) throw new Error('Attendance edges or resolution changed; preview again');
      const delta = await applyAttendanceDelta(tx, approved.page, approved.remove, prepared.additions);
      if ((await ontology(tx, preview.sourceId)).hash !== preview.ontology) throw new Error('Attendance ontology changed during repair');
      const after = await readEdges(tx, approved.page.id);
      if (!approved.reason && after.count > MAX_EDGES) throw new Error('Attendance delta exceeded its edge bound');
      await executeRawJsonb(tx, `INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
        VALUES ($1,$2,($3::jsonb)->'keys')`, [CHECKPOINT_OP, key], [{ keys: [attendanceRepairHash([after.edges, after.count])] }]);
      return { ...delta, replayed: 0 };
    });
    pagesProcessed = end;
    if (approved) { committed++; originId = approved.page.id; }
    created += result.created; removed += result.removed; replayed += result.replayed;
    approvedAdded += approved?.add.length ?? 0; approvedRemoved += approved?.remove.length ?? 0;
    await options.checkpoint({ digest: preview.digest, sourceIncarnation: preview.sourceIncarnation,
      ontology: preview.ontology, committed, originId, afterSlug: segment.at(-1)?.slug ?? preview.afterSlug, pagesProcessed, approvedAdded, approvedRemoved,
      createdThisRun: created, removedThisRun: removed, replayed });
  }
  return { committed, pagesProcessed, created, removed, replayed, afterSlug: preview.nextAfterSlug, complete: true };
}
