/**
 * The reference fields compact entity rows carry (`entity names` rows and
 * their identity siblings, `context_pack` cards and the full card's record
 * view), from one batched referrer read (mentions/referrers.ts):
 *
 * - `referenced_by_count` and a row-level `next` to the full card, under
 *   `entity.names_references` (default on);
 * - `records`: the referring pages of the enrolled record types
 *   (`entity.record_types`, empty by default), one group per type with its
 *   `total` and, when rows < total, a `next` that returns exactly the rest.
 *   Rows are newest page date first; the order never says which record
 *   governs, and `date` is the page's own date, not when its terms start.
 *
 * Bounded (RECORD_ROWS_PER_TARGET per page, RECORD_ROWS_PER_CALL per call)
 * and under a cooperative deadline: a failed or late read marks every row
 * `references_unavailable` and emits one degraded notice, never an empty list.
 */
import type { BrainEngine } from '../engine.ts';
import { inertText, type Notice } from '../agent-output.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';
import { loadSourcePack, type PackTypes } from '../mentions/policy.ts';
import { readEntityReferencesConfig, type EntityReferencesConfig } from '../entity-references-config.ts';
import {
  PAGE_MAX_LIMIT, ReferencesDeadlineError, canonicalRecordTypes, readTargetReferences,
  type RecordGroupRaw, type RecordRow, type RecordTarget,
} from '../mentions/referrers.ts';

/** Records and counts give up after this long; the rows say so. */
export const REFERENCES_DEADLINE_MS = 2000;
let deadlineOverride: number | null = null;
let delayForTests = 0;

/** Test seam: a shorter deadline and an injected delay before the read. */
export function __setReferencesTimingForTests(opts: { deadlineMs?: number | null; delayMs?: number }): () => void {
  const prev = { deadlineOverride, delayForTests };
  deadlineOverride = opts.deadlineMs ?? null;
  delayForTests = opts.delayMs ?? 0;
  return () => { deadlineOverride = prev.deadlineOverride; delayForTests = prev.delayForTests; };
}

export type ReferencesUnavailable = 'deadline' | 'read_failed';

export interface RecordGroupView {
  canonical_type: string;
  total: number;
  rows: RecordRow[];
  /** Why rows < total: `per_page` (RECORD_ROWS_PER_TARGET) or `per_call` (RECORD_ROWS_PER_CALL, taken by earlier entities). */
  capped?: 'per_page' | 'per_call';
  /** The call that returns exactly the remaining records of this type (`requires_surface` when this connection cannot call it). */
  next?: { tool: 'get_backlinks'; arguments: Record<string, unknown>; requires_surface?: 'starter' };
}

/** What a row gains: absent fields are switched off by config. */
export interface RowReferences {
  referenced_by_count?: number;
  next?: { tool: 'entity'; arguments: { name: string; source_id?: string } };
  records?: RecordGroupView[];
  /** The count and records could not be read in time (or failed); not "no references". */
  references_unavailable?: ReferencesUnavailable;
}

export interface ReferencesRequest {
  remote: boolean;
  excludePrivate: boolean;
  surfaceCeiling?: 'verbs' | 'starter' | 'full';
  eligibility?: ReadEligibility;
  /**
   * `names`: count and card `next` under `entity.names_references`, records when enrolled.
   * `pack` (context_pack cards): count and records, only when enrolled. `full_card`: records only (it has its own count).
   */
  surface: 'names' | 'pack' | 'full_card';
  config?: EntityReferencesConfig;
  /** Receives the info notice naming enrolled record types the schema pack does not declare. */
  emitNotice?: (n: Notice) => void;
}

/** Whether this request computes anything (no read when every field is off). */
export function referencesWanted(config: EntityReferencesConfig, surface: ReferencesRequest['surface']): boolean {
  return config.recordTypes.length > 0 || (surface === 'names' && config.namesRow);
}

/**
 * The reference fields for each target page, in target order. Fail-soft:
 * a deadline or read failure marks every target unavailable (one notice).
 */
export async function readRowReferences(engine: BrainEngine, sourceId: string, targets: RecordTarget[], req: ReferencesRequest):
  Promise<{ rows: RowReferences[]; notice: Notice | null; config: EntityReferencesConfig }> {
  const config = req.config ?? await readEntityReferencesConfig(engine);
  if (!targets.length || !referencesWanted(config, req.surface)) return { rows: targets.map(() => ({})), notice: null, config };
  const deadlineMs = deadlineOverride ?? REFERENCES_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const isExpired = () => Date.now() >= deadlineAt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let undeclared: string[] = [];
  const late = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), deadlineMs); });
  const read = (async () => {
    if (delayForTests) await new Promise(r => setTimeout(r, delayForTests));
    if (isExpired()) throw new ReferencesDeadlineError();
    const pack = await loadSourcePack(engine, sourceId);
    undeclared = await undeclaredRecordTypes(engine, sourceId, config.recordTypes, pack).catch(() => []);
    return readTargetReferences(engine, { referrerSources: [sourceId], excludePrivate: req.excludePrivate, pack,
      keepVisibility: req.remote ? ['world'] : ['private', 'world'], eligibility: req.eligibility },
    targets, { recordTypes: canonicalRecordTypes(config.recordTypes, pack), isExpired });
  })();
  let raw: Awaited<typeof read> | ReferencesUnavailable;
  try {
    const won = await Promise.race([read, late]);
    raw = won === 'deadline' ? 'deadline' : won;
  } catch (e) {
    raw = e instanceof ReferencesDeadlineError ? 'deadline' : 'read_failed';
  } finally {
    clearTimeout(timer);
  }
  read.catch(() => {});
  if (typeof raw === 'string') {
    const reason = raw;
    return { rows: targets.map(() => ({ references_unavailable: reason })), notice: referencesUnavailableNotice(reason), config };
  }
  if (undeclared.length) req.emitNotice?.(undeclaredRecordTypesNotice(undeclared));
  const rows = raw.map((r, i): RowReferences => {
    const slug = targets[i]!.slug;
    const out: RowReferences = {};
    if (req.surface === 'names' ? config.namesRow : req.surface === 'pack' && config.recordTypes.length > 0) out.referenced_by_count = r.referenced_by_count;
    if (req.surface === 'names' && config.namesRow) out.next = { tool: 'entity', arguments: { name: slug } };
    if (r.records) out.records = r.records.map(g => recordGroupView(g, slug, sourceId, req.surfaceCeiling));
    return out;
  });
  return { rows, notice: null, config };
}

function recordGroupView(g: RecordGroupRaw, slug: string, sourceId: string, surfaceCeiling: ReferencesRequest['surfaceCeiling']): RecordGroupView {
  const view: RecordGroupView = { canonical_type: g.canonical_type, total: g.total, rows: g.rows };
  const remaining = g.total - g.rows.length;
  if (remaining <= 0) return view;
  if (g.capped) view.capped = g.capped;
  view.next = { tool: 'get_backlinks', arguments: { slug, source_id: sourceId, type: g.canonical_type, group: 'page',
    limit: Math.min(remaining, PAGE_MAX_LIMIT), ...(g.cursor ? { cursor: g.cursor } : {}) },
  ...(surfaceCeiling === 'verbs' ? { requires_surface: 'starter' as const } : {}) };
  return view;
}

/** One degraded notice for a call whose reference read did not finish. */
export function referencesUnavailableNotice(reason: ReferencesUnavailable): Notice {
  return {
    code: 'references_unavailable', kind: 'degraded',
    why: reason === 'deadline'
      ? 'The reference count and records for these entities did not finish in time; rows marked references_unavailable are unread, not empty.'
      : 'The reference count and records for these entities could not be read; rows marked references_unavailable are unread, not empty.',
  };
}

/** The `context_pack` records block: page dates, newest first; the order never says which record governs. */
export const RECORDS_HEADER = '## Records that reference these entities (page date = when the page was written, newest first; the order does not say which record governs)';

export interface PackCardReferences extends RowReferences {
  sibling_records?: Array<{ slug: string; title: string } & RowReferences>;
}

/**
 * `context_pack` (pull verb only, never the ambient push path): the count and
 * records of each card's page and its identity siblings, side by side, in one
 * batched read. Nothing is read unless record types are enrolled.
 */
export async function readPackReferences(engine: BrainEngine, sourceId: string, cards: Array<{ entity: { slug: string; title: string; source_id?: string } }>,
  req: Omit<ReferencesRequest, 'surface' | 'excludePrivate'>): Promise<{ bySlug: Map<string, PackCardReferences>; notice: Notice | null }> {
  const bySlug = new Map<string, PackCardReferences>();
  const config = req.config ?? await readEntityReferencesConfig(engine);
  if (!cards.length || !referencesWanted(config, 'pack')) return { bySlug, notice: null };
  const { resolveExcludePrivatePages } = await import('../search/private-visibility.ts');
  const excludePrivate = await resolveExcludePrivatePages(engine, req.remote ? undefined : false);
  // #6723: each card reads its own source (one batch per source); the map is keyed `<source_id>:<slug>`.
  const bySource = new Map<string, typeof cards>();
  for (const c of cards) bySource.set(c.entity.source_id ?? sourceId, [...(bySource.get(c.entity.source_id ?? sourceId) ?? []), c]);
  let notice: Notice | null = null;
  for (const [src, group] of bySource) {
    const part = await readSourcePackReferences(engine, src, group, { ...req, excludePrivate, config });
    for (const [slug, refs] of part.bySlug) bySlug.set(`${src}:${slug}`, refs);
    notice ??= part.notice;
  }
  return { bySlug, notice };
}

async function readSourcePackReferences(engine: BrainEngine, sourceId: string, cards: Array<{ entity: { slug: string; title: string } }>,
  req: Omit<ReferencesRequest, 'surface'> & { config: EntityReferencesConfig }): Promise<{ bySlug: Map<string, PackCardReferences>; notice: Notice | null }> {
  const bySlug = new Map<string, PackCardReferences>();
  const { excludePrivate, config } = req;
  const { readIdentitySiblings } = await import('../mentions/siblings.ts');
  const siblings = await Promise.all(cards.map(c => readIdentitySiblings(engine, sourceId, c.entity, { excludePrivate, excludeQuarantined: true })));
  const targets: RecordTarget[] = [];
  cards.forEach((c, i) => targets.push({ slug: c.entity.slug, sourceId }, ...siblings[i]!.pages.map(p => ({ slug: p.slug, sourceId }))));
  const refs = await readRowReferences(engine, sourceId, targets, { ...req, excludePrivate, surface: 'pack', config });
  let at = 0;
  cards.forEach((c, i) => {
    const own: PackCardReferences = { ...refs.rows[at++] };
    const sib = siblings[i]!.pages.map(p => ({ slug: p.slug, title: p.title, ...refs.rows[at++] }));
    if (sib.length) own.sibling_records = sib;
    bySlug.set(c.entity.slug, own);
  });
  return { bySlug, notice: refs.notice };
}

function recordLine(owner: string, type: string, r: RecordRow): string {
  const parts = [`page date ${r.date ? r.date.slice(0, 10) : 'unknown'} (${r.date_source})`];
  if (r.page_status) parts.push(`status: ${r.page_status}`);
  if (r.amends?.length) parts.push(`amends ${r.amends.map(a => a.since ? `${a.slug} (terms start ${a.since})` : a.slug).join(', ')}`);
  if (r.supersedes?.length) parts.push(`supersedes ${r.supersedes.map(s => s.slug).join(', ')}`);
  return `- ${owner}: ${type} ${r.slug} "${inertText(r.title, 160)}" — ${parts.join('; ')}`;
}

/** The packed-text lines for one card's records (its page, then each sibling), with each type's total when rows were cut. */
export function renderRecordLines(card: { entity: { slug: string } } & PackCardReferences): string[] {
  const lines: string[] = [];
  const add = (owner: string, refs: RowReferences) => {
    if (refs.references_unavailable) { lines.push(`- ${owner}: records unavailable (${refs.references_unavailable}); unread, not empty`); return; }
    for (const g of refs.records ?? []) {
      for (const r of g.rows) lines.push(recordLine(owner, g.canonical_type, r));
      if (g.rows.length < g.total) lines.push(`- ${owner}: ${g.total - g.rows.length} more ${g.canonical_type} records (get_backlinks type ${g.canonical_type})`);
    }
  };
  add(card.entity.slug, card);
  for (const s of card.sibling_records ?? []) add(s.slug, s);
  return lines;
}

/** Enrolled record types that are neither declared by the source's schema pack (name or alias) nor the stored type of any live page. */
export async function undeclaredRecordTypes(engine: BrainEngine, sourceId: string, types: string[], pack: PackTypes | null): Promise<string[]> {
  const declared = new Set((pack?.page_types ?? []).flatMap(pt => [pt.name, ...(pt.aliases ?? [])]));
  const unknown = types.filter(t => !declared.has(t));
  if (!unknown.length) return [];
  const present = new Set((await engine.executeRaw<{ type: string }>(
    'SELECT DISTINCT type FROM pages WHERE source_id = $1 AND type = ANY($2::text[]) AND deleted_at IS NULL', [sourceId, unknown])).map(r => r.type));
  return unknown.filter(t => !present.has(t));
}

/** An enrolled type the pack does not declare lists no records: say so instead of showing nothing. */
export function undeclaredRecordTypesNotice(types: string[]): Notice {
  const shown = types.map(t => inertText(t, 60)).join(', ');
  return {
    code: 'record_types_undeclared', kind: 'info',
    why: `entity.record_types names ${shown}, which neither this source's schema pack declares nor any page here uses, so no record of that type is listed.`,
    fix: { argv: ['gbrain', 'config', 'get', 'entity.record_types'], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Shows the enrolled record types; set it to page types the schema pack declares (gbrain config set entity.record_types <types>).' },
  };
}

