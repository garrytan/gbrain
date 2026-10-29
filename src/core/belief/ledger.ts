/**
 * The finalization contract (docs/designs/BELIEF_LEDGER.md section 5.1).
 *
 * Every transaction that commits canonical state wraps its projections in
 * `withBeliefBatch`: the batch reads the logical state of its streams under the
 * page keys the transaction already holds, runs the projections, reads the
 * state again, and `finalizeBeliefEvents` appends one event per logical key
 * whose canonical value changed, last, before the terminal receipt. Guards
 * that decide inside the projections (contest, hold) and identity code paths
 * report through `noteBelief`, so their events exist whether or not any row
 * changed. The batch is inert, and costs one source read, when the source has
 * no active coverage (`gbrain beliefs enable`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { assertHeldPageKeys } from '../page-state/guards.ts';
import { MANAGED_MODE_ROWS_JSON_SQL, managedModeFromRows } from '../persistence/managed-mode.ts';
import { COVERAGE_KEY, heldKey, lifetimeRef, pageKey, sha256Hex, canonicalJson, factKeySubject, slugRef } from './keys.ts';
import { readBeliefState, readFactsById, type RawPage, type RawState } from './state.ts';
import { keyedSubjects, keyFact, pageNeeds, type KeyContext, type Subject } from './subjects.ts';
import { endLifetime, mintLifetime, readOpenLifetimes, renameLifetime, resolveLifetimes } from './lifetimes.ts';
import { appendBeliefEvents, redactionReleasedDraft, type BeliefEventDraft, type BeliefOrigin, type RedactionRelease } from './append.ts';
import { missingPreimages, preimageInvariantEnforced } from './preimages.ts';

export type BeliefNote =
  | { kind: 'contested'; table: string; rowId: number; proposalId: number; guard: string }
  | { kind: 'held'; holdKind: string; fingerprint: string; holdId: number; slug: string; tier: string; valueHash: string }
  | { kind: 'withdrawn'; factIds: number[] }
  | { kind: 'superseded'; oldId: number; newId: number | null }
  | { kind: 'purged'; table: 'facts' | 'takes' | 'pages'; ids: number[]; request: string; derivedWalk?: 'truncated' }
  | { kind: 'transferred'; fromSlug: string; table: 'facts' | 'takes' | 'links'; ids: number[] }
  /** A tier change another writer caused (derived propagation): the batch's own `trust.retiered` for the row carries this cause. */
  | { kind: 'retier_cause'; table: 'facts' | 'takes' | 'pages'; rowId: number; cause: Record<string, unknown> }
  /** The owner confirm released redactions on the row's key (`releaseSuppressedFields`): the batch appends its `redaction.released`. */
  | { kind: 'released'; table: 'facts' | 'takes'; rowId: number; releases: RedactionRelease[] };

export interface BeliefBatchOptions {
  sourceId: string;
  /** Stream slugs; every one must be a page key the transaction holds. */
  slugs: readonly string[];
  /** persistence_requests.id for journaled writes; a fresh UUID per transaction otherwise. */
  publicationId?: string | null;
  op: string;
  /** Overrides the managed/unmanaged origin (an unmanaged projection point passes 'unmanaged'). */
  origin?: BeliefOrigin;
  /** A revision change is `page.published` unless the writer names it (revert). */
  pageEventType?: 'page.reverted' | 'page.view_changed' | 'page.merged';
  /** The event for a page row that is gone after the transaction: purge or retention, else `page.deleted`. */
  hardDeleteEvent?: 'page.purged' | 'page.expired';
  /** Request authority: an owner release of a redaction needs a trusted local (remote = false) write. */
  remote?: boolean;
  /** An explicit owner edit of the batch's fields: the only write that can release a purge redaction (append.ts). */
  ownerEdit?: boolean;
  cause?: Record<string, unknown>;
  /** Filled by the batch: how many events it appended, so the caller marks the commit only when there is one. */
  report?: { appended: number };
}

interface Batch {
  opts: BeliefBatchOptions; publicationId: string; incarnation: string; managed: boolean; purgesPossible: boolean;
  pre: RawState; notes: BeliefNote[];
}

const store = new AsyncLocalStorage<Batch>();

/** A guard or identity path reports a decision to the enclosing batch; a no-op outside one. */
export function noteBelief(note: BeliefNote): void {
  store.getStore()?.notes.push(note);
}

/** The enclosing batch's publication, source and stream slugs, or null outside a batch. */
export function currentBeliefBatch(): { publicationId: string; sourceId: string; slugs: readonly string[] } | null {
  const batch = store.getStore();
  return batch ? { publicationId: batch.publicationId, sourceId: batch.opts.sourceId, slugs: batch.opts.slugs } : null;
}

/** True when an enclosing batch on this async context already records these slugs (a nested writer must not append them twice). */
export function beliefBatchCovers(sourceId: string, slugs: readonly string[]): boolean {
  const outer = store.getStore();
  return !!outer && outer.opts.sourceId === sourceId && slugs.every(slug => outer.opts.slugs.includes(slug));
}

/** True inside any belief batch: a nested writer's own publication commits with the enclosing transaction, not before it. */
export const insideBeliefBatch = (): boolean => !!store.getStore();

/**
 * Coverage and purge probes for one source, in one read. `coverage` is the newest coverage event other than `coverage.restored`.
 * `batch` (a batch beginning) also reads the managed mode and, when coverage is active, switches the transaction to
 * generic plans for the state read that follows, returning the mode to restore (`readBeliefState`'s `planModePrev`).
 */
export async function readLedgerSource(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, opts: { batch?: boolean } = {}): Promise<{ incarnation: string; purgeEpoch: number;
  coverage: string | null; purgesPossible: boolean; managedRows?: Array<{ enabled: unknown }>; planModePrev?: string } | null> {
  const [row] = await tx.executeRaw<Record<string, unknown>>(`${opts.batch ? `SELECT q.*, ${MANAGED_MODE_ROWS_JSON_SQL} AS managed_rows, current_setting('plan_cache_mode') AS plan_mode_prev,
      set_config('plan_cache_mode', CASE WHEN q.coverage IS NOT NULL AND q.coverage <> 'coverage.stopped' THEN 'force_generic_plan'
        ELSE current_setting('plan_cache_mode') END, true) FROM (` : ''}SELECT s.incarnation::text AS incarnation, s.purge_epoch,
      (SELECT e.event_type FROM belief_events e WHERE e.source_id = s.id AND e.subject_kind = 'coverage' AND e.subject_key = $2
        AND e.source_incarnation = s.incarnation AND e.event_type <> 'coverage.restored' ORDER BY e.id DESC LIMIT 1) AS coverage,
      (s.purge_epoch > 0 OR EXISTS (SELECT 1 FROM fact_purges WHERE source_id = s.id) OR EXISTS (SELECT 1 FROM take_purges WHERE source_id = s.id)
        OR EXISTS (SELECT 1 FROM page_purges WHERE source_id = s.id)) AS purges
    FROM sources s WHERE s.id = $1${opts.batch ? ') q' : ''}`, [sourceId, COVERAGE_KEY]);
  if (!row) return null;
  return { incarnation: String(row.incarnation), purgeEpoch: Number(row.purge_epoch), coverage: (row.coverage as string | null) ?? null,
    purgesPossible: row.purges === true,
    ...(opts.batch ? { managedRows: row.managed_rows as Array<{ enabled: unknown }>, planModePrev: String(row.plan_mode_prev) } : {}) };
}

export const coverageActive = (coverage: string | null) => coverage != null && coverage !== 'coverage.stopped';

async function beginBeliefBatch(tx: BrainEngine, opts: BeliefBatchOptions): Promise<Batch | null> {
  const source = await readLedgerSource(tx, opts.sourceId, { batch: true });
  if (!source || !coverageActive(source.coverage)) return null;
  try {
    assertHeldPageKeys(tx, opts.slugs.map(slug => ({ sourceId: opts.sourceId, slug })));
  } catch (error) {
    await tx.executeRaw(`SELECT set_config('plan_cache_mode', $1, true)`, [source.planModePrev]);
    throw error;
  }
  const pre = await readBeliefState(tx, opts.sourceId, opts.slugs, [], undefined, source.planModePrev);
  return { opts, publicationId: opts.publicationId ?? randomUUID(), incarnation: source.incarnation, managed: managedModeFromRows(source.managedRows!).enabled,
    purgesPossible: source.purgesPossible, pre, notes: [] };
}

/** Runs `fn` (the transaction's projections) inside a belief batch and appends its events after it. */
export async function withBeliefBatch<T>(tx: BrainEngine, opts: BeliefBatchOptions, fn: () => Promise<T>): Promise<T> {
  const batch = await beginBeliefBatch(tx, opts);
  if (!batch) return fn();
  const result = await store.run(batch, fn);
  const appended = await finalizeBeliefEvents(tx, batch);
  if (opts.report) opts.report.appended += appended;
  return result;
}

interface Stream { slug: string; pre: RawPage | null; post: RawPage | null }

/** Stream pages matched by id across the transaction: renames, recreates and hard deletes. */
function matchStreams(slugs: readonly string[], pre: RawState, post: RawState): Stream[] {
  const preById = new Map(pre.pages.map(p => [p.id, p]));
  const postIds = new Set(post.pages.map(p => p.id));
  const streams: Stream[] = [];
  const used = new Set<number>();
  for (const page of post.pages) {
    const same = preById.get(page.id);
    const other = same ? null : pre.pages.find(p => p.slug === page.slug && !postIds.has(p.id)) ?? null;
    if (same) used.add(same.id);
    if (other) { used.add(other.id); streams.push({ slug: page.slug, pre: other, post: null }); }
    streams.push({ slug: page.slug, pre: same ?? null, post: page });
  }
  for (const page of pre.pages) if (!used.has(page.id)) streams.push({ slug: page.slug, pre: page, post: null });
  for (const slug of slugs) if (!streams.some(s => s.slug === slug || s.pre?.slug === slug)) streams.push({ slug, pre: null, post: null });
  return streams;
}

/** Ends, renames and mints the stream pages' lifetimes; returns page id -> lifetime for both sides. */
async function streamLifetimes(tx: BrainEngine, sourceId: string, incarnation: string, streams: Stream[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const pairs = streams.flatMap(s => [s.pre, s.post]).filter((p): p is RawPage => !!p).map(p => ({ incarnation, slug: p.slug }));
  const open = await readOpenLifetimes(tx, pairs);
  const fits = (row: { page_id: number | null } | null, id: number) => !!row && (row.page_id == null || row.page_id === id);
  const mint = (page: RawPage) => mintLifetime(tx, { sourceId, incarnation, slug: page.slug, pageId: page.id });
  // Renamed pages keep their lifetimes. Each moving lifetime is parked first, so renames that swap or chain slugs in one
  // transaction neither end one another's lifetimes nor collide on the open-slug index; the slugs they leave read as free.
  const moving = new Map<number, string>();
  for (const { pre, post } of streams) {
    const row = pre && post && pre.slug !== post.slug ? open.get(`${incarnation}\u0000${pre.slug}`) ?? null : null;
    if (row && fits(row, post!.id)) moving.set(post!.id, row.page_lifetime);
  }
  const movingLifetimes = new Set(moving.values());
  const openAt = (slug: string) => { const row = open.get(`${incarnation}\u0000${slug}`) ?? null; return row && movingLifetimes.has(row.page_lifetime) ? null : row; };
  for (const [pageId, lifetime] of moving) await renameLifetime(tx, lifetime, `~moving-${lifetime}`, pageId);
  for (const { pre, post } of streams) {
    if (!pre || post) continue;
    const row = openAt(pre.slug);
    const lifetime = fits(row, pre.id) ? row!.page_lifetime : await mint(pre);
    out.set(pre.id, lifetime);
    await endLifetime(tx, lifetime);
  }
  const renames: Array<[string, RawPage]> = [];
  for (const { pre, post } of streams) {
    if (!post) continue;
    if (pre && pre.slug !== post.slug) {
      const target = openAt(post.slug);
      if (target) await endLifetime(tx, target.page_lifetime);
      const lifetime = moving.get(post.id);
      if (lifetime) { renames.push([lifetime, post]); out.set(post.id, lifetime); }
      else out.set(post.id, await mint(post));
      continue;
    }
    const row = openAt(post.slug);
    if (row && row.page_id === post.id) { out.set(post.id, row.page_lifetime); continue; }
    if (pre && row && row.page_id == null) { out.set(post.id, row.page_lifetime); continue; }
    if (row) await endLifetime(tx, row.page_lifetime);
    out.set(post.id, await mint(post));
  }
  for (const [lifetime, post] of renames) await renameLifetime(tx, lifetime, post.slug, post.id);
  return out;
}

const tierOrUnknown = (tier: string | null | undefined) => tier || 'unknown';

function stateHashOf(page: RawPage | null, lifetime: string | null, subjects: Subject[]): string {
  const live = page && !page.deleted;
  return sha256Hex(canonicalJson({
    page: page ? { lifetime, deleted: page.deleted, revision: page.revision, visible: page.visible, tier: page.tier } : null,
    subjects: subjects.filter(s => live || s.dbOnly).map(s => { const row = [s.kind, s.key, s.vhash, s.tier]; return { row, order: row.join('\u0000') }; })
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0)).map(s => s.row),
  }));
}

function changeType(kind: Subject['kind'], before: Subject, after: Subject): string | null {
  if (before.vhash === after.vhash) return null;
  if (kind === 'take') {
    const resolution = ['resolved_at', 'resolved_outcome', 'resolved_value', 'resolved_unit', 'resolved_source', 'resolved_by', 'resolved_quality']
      .some(f => canonicalJson(before.value[f]) !== canonicalJson(after.value[f]));
    const resolvedAfter = after.value.resolved_at != null || after.value.resolved_quality != null;
    if (resolution) return resolvedAfter ? 'take.resolved' : 'take.unresolved';
    return 'take.revised';
  }
  if (kind === 'link_transition') return 'link.transition_revised';
  return `${kind}.revised`;
}
const assertType = (kind: Subject['kind']) => kind === 'link_transition' ? 'link.transition_added' : `${kind}.asserted`;
const retractType = (kind: Subject['kind']) => kind === 'link_transition' ? 'link.transition_removed' : `${kind}.retracted`;

interface DiffContext {
  opts: BeliefBatchOptions; batch: Batch; writerTier: string; lifetimeAt: (slug: string) => string | null; streamHash: (slug: string) => string;
  cause: (extra?: Record<string, unknown>) => Record<string, unknown>; postSubjects: Subject[];
  /** `kind:rowId` of each row a transfer note moved -> the subject it left and the lifetime of the page it left. */
  transfers: Map<string, { from: Subject; fromLifetime: string | null }>;
}

const TRANSFER_KIND: Record<string, Subject['kind']> = { facts: 'fact', takes: 'take', links: 'link' };

/** The pre-transaction subject of each row a `transferred` note moved, keyed `kind:rowId`. */
function transferSources(notes: BeliefNote[], preSubjects: Subject[], lifetimeOfPreSlug: (slug: string) => string | null): DiffContext['transfers'] {
  const out: DiffContext['transfers'] = new Map();
  for (const note of notes) {
    if (note.kind !== 'transferred') continue;
    const kind = TRANSFER_KIND[note.table]!;
    for (const id of note.ids) {
      const from = preSubjects.find(s => s.kind === kind && s.stream === note.fromSlug && s.rowIds.includes(id));
      if (from) out.set(`${kind}:${id}`, { from, fromLifetime: lifetimeOfPreSlug(note.fromSlug) });
    }
  }
  return out;
}

/**
 * Subject events for one stream between two keyed sides, outside a batch's
 * own diff: the fallback rename re-describes the lifetime it moves onto
 * another row. `transfers` maps `kind:rowId` to the subject the row left.
 */
export function streamSubjectDrafts(input: { sourceId: string; incarnation: string; slug: string; lifetime: string | null; op: string; writerTier: string | null;
  stateHash: string; before: Subject[]; after: Subject[]; transfers: Map<string, { from: Subject; fromLifetime: string | null }> }): BeliefEventDraft[] {
  const opts: BeliefBatchOptions = { sourceId: input.sourceId, slugs: [input.slug], op: input.op };
  const batch: Batch = { opts, publicationId: '', incarnation: input.incarnation, managed: false, purgesPossible: false, notes: [],
    pre: { pages: [], facts: [], takes: [], links: [], transitions: [], writerTier: null } };
  return subjectDrafts({ opts, batch, writerTier: tierOrUnknown(input.writerTier), lifetimeAt: () => input.lifetime, streamHash: () => input.stateHash,
    cause: (extra = {}) => ({ op: input.op, ...extra }), postSubjects: input.after, transfers: input.transfers }, input.slug, input.before, input.after);
}

const RETIER_TABLE: Record<string, string> = { fact: 'facts', take: 'takes', page: 'pages' };
/** The cause fields (minus `op`) another writer attached to this row's tier change, e.g. the inputs of a derived propagation. */
function retierCauseOf(notes: BeliefNote[], s: { kind: string; rowIds: number[] }): Record<string, unknown> {
  const note = notes.find(n => n.kind === 'retier_cause' && n.table === RETIER_TABLE[s.kind] && s.rowIds.includes(n.rowId));
  if (note?.kind !== 'retier_cause') return {};
  const { op: _op, ...rest } = note.cause;
  return rest;
}

/** Subject events of one stream side: asserted/retracted/revised, adoption, replacement links, retiering. */
function subjectDrafts(d: DiffContext, slug: string, before: Subject[], after: Subject[]): BeliefEventDraft[] {
  const { batch, writerTier } = d;
  const withdrawn = new Set(batch.notes.flatMap(n => n.kind === 'withdrawn' ? n.factIds : []));
  const superseded = new Map(batch.notes.flatMap(n => n.kind === 'superseded' ? [[n.oldId, n.newId] as const] : []));
  const purged = new Map(batch.notes.flatMap(n => n.kind === 'purged' ? n.ids.map(id => [`${n.table}:${id}`, n.request] as const) : []));
  const out: BeliefEventDraft[] = [];
  const preMap = new Map(before.map(s => [`${s.kind}\u0000${s.key}`, s]));
  const postMap = new Map(after.map(s => [`${s.kind}\u0000${s.key}`, s]));
  const draft = (s: Subject, eventType: string, value: Record<string, unknown> | null, prior: Subject | null, extra: Record<string, unknown> = {}) => {
    const link = s.kind === 'link' || s.kind === 'link_transition';
    out.push({ sourceId: d.opts.sourceId, incarnation: batch.incarnation, lifetime: d.lifetimeAt(slug), slug, stream: slug,
      subjectKind: s.kind, subjectKey: s.key, eventType, trustTier: link ? writerTier : s.tier, writerTier: link ? null : writerTier,
      tierBasis: link ? 'writer' : 'row', visibility: s.visibility, value, priorHash: prior?.vhash ?? null, stateHash: d.streamHash(slug),
      claimFp: s.claimFp, validFrom: s.validFrom, validUntil: s.validUntil,
      cause: d.cause({ ...(s.rowNum != null ? { row: s.rowNum } : {}), label: s.label, ...extra }) });
  };
  const transferOf = (s: Subject) => s.rowIds.map(id => d.transfers.get(`${s.kind}:${id}`)).find(t => t && t.from.key !== s.key);
  const removed = [...preMap].filter(([id]) => !postMap.has(id)).map(([, s]) => s)
    .filter(s => !s.rowIds.length || !s.rowIds.every(id => d.transfers.has(`${s.kind}:${id}`)));
  const fresh = [...postMap].filter(([id]) => !preMap.has(id)).map(([, s]) => s);
  const transferred = new Set<Subject>();
  for (const s of after) {
    const t = transferOf(s);
    if (!t) continue;
    transferred.add(s);
    draft(s, `${s.kind}.transferred`, s.value, t.from, { from_key: t.from.key, ...(t.fromLifetime ? { from_lifetime: t.fromLifetime } : {}) });
  }
  const adoptedFrom = new Map<Subject, Subject>();
  for (const s of fresh) {
    const parts = s.kind === 'fact' ? factKeySubject(s.key) : null;
    if (!parts || parts.subject.startsWith('S:')) continue;
    const source = removed.find(r => r.kind === 'fact' && factKeySubject(r.key)?.subject === slugRef(batch.incarnation, slug) && factKeySubject(r.key)?.rest === parts.rest);
    if (source) adoptedFrom.set(s, source);
  }
  const adoptedSources = new Set(adoptedFrom.values());
  const replacedBy = new Map<Subject, Subject>();
  for (const r of removed) {
    if ((r.kind !== 'fact' && r.kind !== 'take') || r.rowNum == null || adoptedSources.has(r)) continue;
    const successor = fresh.find(s => s.kind === r.kind && s.rowNum === r.rowNum && !adoptedFrom.has(s));
    if (successor) replacedBy.set(r, successor);
  }
  for (const r of removed) {
    if (adoptedSources.has(r)) continue;
    const purgeRequest = r.rowIds.map(id => purged.get(`${r.kind === 'take' ? 'takes' : 'facts'}:${id}`)).find(Boolean);
    const supersededBy = r.kind === 'fact' ? r.rowIds.map(id => superseded.get(id)).find(v => v !== undefined) : undefined;
    const type = purgeRequest ? `${r.kind}.purged` : r.kind === 'fact' && r.rowIds.some(id => withdrawn.has(id)) ? 'fact.withdrawn'
      : supersededBy !== undefined ? 'fact.superseded' : retractType(r.kind);
    const successorKey = supersededBy != null ? d.postSubjects.find(s => s.kind === 'fact' && s.rowIds.includes(supersededBy))?.key : replacedBy.get(r)?.key;
    draft(r, type, null, r, { ...(successorKey ? { replaced_by: successorKey } : {}), ...(purgeRequest ? { purge_request: purgeRequest } : {}) });
  }
  for (const s of fresh) {
    if (transferred.has(s)) continue;
    const from = adoptedFrom.get(s);
    if (from) { draft(s, 'fact.adopted', s.value, from, { from_key: from.key }); continue; }
    const replaced = [...replacedBy].find(([, v]) => v === s)?.[0];
    draft(s, assertType(s.kind), s.value, null, replaced ? { replaces: replaced.key } : {});
  }
  for (const [id, s] of postMap) {
    const prior = preMap.get(id);
    if (!prior || transferred.has(s)) continue;
    const type = changeType(s.kind, prior, s);
    if (type) draft(s, type, s.value, prior);
    if (prior.tier !== s.tier && s.kind !== 'link' && s.kind !== 'link_transition') draft(s, 'trust.retiered', { from: prior.tier, to: s.tier }, prior, retierCauseOf(batch.notes, s));
  }
  return out;
}

/** The page event of one page stream; `true` when the page's own subjects end or begin with it (no per-subject events). */
function pageDrafts(d: DiffContext, stream: Stream, lifetime: string, after: Subject[], push: (draft: BeliefEventDraft) => void): boolean {
  const { pre: p0, post: p1 } = stream;
  const page = p1 ?? p0!;
  const base = { sourceId: d.opts.sourceId, incarnation: d.batch.incarnation, lifetime, slug: page.slug, stream: page.slug, subjectKind: 'page' as const,
    subjectKey: pageKey(lifetime), writerTier: d.writerTier, visibility: page.visible ? 'world' : 'private', stateHash: d.streamHash(page.slug), cause: d.cause() };
  const emit = (eventType: string, value: Record<string, unknown>, tier: string) => push({ ...base, eventType, trustTier: tier, value });
  if (p0 && !p1) {
    const purge = d.batch.notes.find(n => n.kind === 'purged' && n.table === 'pages' && n.ids.includes(p0.id));
    const type = purge ? 'page.purged' : d.opts.hardDeleteEvent ?? 'page.deleted';
    push({ ...base, eventType: type, trustTier: p0.tier, value: type === 'page.purged' ? null : { revision_before: p0.revision, hard: true },
      purged: type === 'page.purged', cause: purge?.kind === 'purged' ? d.cause({ purge_request: purge.request, ...(purge.derivedWalk ? { derived_walk: purge.derivedWalk } : {}) }) : base.cause });
    return true;
  }
  if (!p0 && p1) {
    const counts = { facts: after.filter(s => s.kind === 'fact').length, takes: after.filter(s => s.kind === 'take').length,
      links: after.filter(s => s.kind === 'link').length, link_transitions: after.filter(s => s.kind === 'link_transition').length };
    emit('page.published', { revision_before: null, revision_after: p1.revision, snapshot: !p1.large, counts, ...(p1.deleted ? { deleted: true } : {}) }, p1.tier);
    return !p1.large;
  }
  let silenced = false;
  if (p0!.slug !== p1!.slug) emit('page.renamed', { old_slug: p0!.slug, new_slug: p1!.slug }, p1!.tier);
  if (!p0!.deleted && p1!.deleted) { emit('page.deleted', { revision_before: p0!.revision, revision_after: p1!.revision }, p0!.tier); silenced = true; }
  else if (p0!.deleted && !p1!.deleted) { emit('page.restored', { revision_before: p0!.revision, revision_after: p1!.revision }, p1!.tier); silenced = true; }
  else if (p0!.revision !== p1!.revision) emit(d.opts.pageEventType ?? 'page.published', { revision_before: p0!.revision, revision_after: p1!.revision }, p1!.tier);
  else if (p0!.visible !== p1!.visible) emit('page.visibility_changed', { visible: p1!.visible }, p1!.tier);
  else if (d.opts.pageEventType === 'page.view_changed' && p0!.content_hash !== p1!.content_hash) {
    emit('page.view_changed', { revision_before: p0!.revision, revision_after: p1!.revision, materialized: true }, p1!.tier);
  }
  if (p0!.tier !== p1!.tier) push({ ...base, eventType: 'trust.retiered', trustTier: p1!.tier, value: { from: p0!.tier, to: p1!.tier },
    cause: d.cause(retierCauseOf(d.batch.notes, { kind: 'page', rowIds: [p1!.id] })) });
  return silenced || (p0!.deleted && p1!.deleted);
}

/** Appends the batch's events, last in its transaction. */
export async function finalizeBeliefEvents(tx: BrainEngine, batch: Batch): Promise<number> {
  const { opts, pre } = batch;
  const post = await readBeliefState(tx, opts.sourceId, opts.slugs, pre.pages.map(p => p.id), pre);
  const streams = matchStreams(opts.slugs, pre, post);
  const added = streams.filter(s => s.post && !opts.slugs.includes(s.post.slug)).map(s => ({ sourceId: opts.sourceId, slug: s.post!.slug }));
  if (added.length) assertHeldPageKeys(tx, added);
  const writerTier = tierOrUnknown(post.writerTier ?? pre.writerTier);
  const lifetimes = await streamLifetimes(tx, opts.sourceId, batch.incarnation, streams);
  const contestedFactIds = batch.notes.flatMap(n => n.kind === 'contested' && n.table === 'facts' ? [n.rowId] : []);
  const extraFacts = await readFactsById(tx, contestedFactIds.filter(id => !post.facts.some(f => f.id === id) && !pre.facts.some(f => f.id === id)));
  const needs = [...pageNeeds(opts.sourceId, batch.incarnation, pre), ...pageNeeds(opts.sourceId, batch.incarnation, post),
    ...extraFacts.flatMap(f => f.entity_page_id != null && f.entity_slug ? [{ sourceId: opts.sourceId, incarnation: batch.incarnation, slug: f.entity_slug, pageId: f.entity_page_id }] : [])]
    .filter(n => !lifetimes.has(n.pageId));
  for (const [id, lifetime] of await resolveLifetimes(tx, needs)) lifetimes.set(id, lifetime);
  const visibilityIn = (state: RawState) => (pageId: number) => state.pages.find(p => p.id === pageId)?.visible === false ? 'private' : 'world';
  const ctx = (side: 'pre' | 'post'): KeyContext => ({ incarnation: batch.incarnation, lifetimes,
    pagesBySlug: new Map(streams.flatMap(s => { const p = side === 'pre' ? s.pre : s.post; return p ? [[p.slug, p] as const] : []; })) });
  const preSubjects = keyedSubjects(ctx('pre'), pre, visibilityIn(pre));
  const postSubjects = keyedSubjects(ctx('post'), post, visibilityIn(post), { state: pre, subjects: preSubjects });
  const postPageAt = (slug: string) => streams.find(s => s.post?.slug === slug)?.post ?? null;
  const lifetimeAt = (slug: string) => { const page = postPageAt(slug); return page ? lifetimes.get(page.id) ?? null : null; };
  const subjectsByStream = new Map<string, Subject[]>();
  for (const subject of postSubjects) {
    const list = subjectsByStream.get(subject.stream);
    if (list) list.push(subject); else subjectsByStream.set(subject.stream, [subject]);
  }
  const hashes = new Map<string, string>();
  const streamHash = (slug: string) => {
    let hash = hashes.get(slug);
    if (hash === undefined) {
      const page = postPageAt(slug);
      hash = stateHashOf(page, page ? lifetimes.get(page.id)! : null, subjectsByStream.get(slug) ?? []);
      hashes.set(slug, hash);
    }
    return hash;
  };
  const preLifetimeAt = (slug: string) => { const page = streams.find(s => s.pre?.slug === slug)?.pre; return page ? lifetimes.get(page.id) ?? null : null; };
  const d: DiffContext = { opts, batch, writerTier, lifetimeAt, streamHash, postSubjects, transfers: transferSources(batch.notes, preSubjects, preLifetimeAt),
    cause: (extra = {}) => ({ op: opts.op, ...(opts.publicationId ? { request: opts.publicationId } : {}), ...opts.cause, ...extra }) };
  const drafts: BeliefEventDraft[] = [];

  for (const stream of streams) {
    const page = stream.post ?? stream.pre;
    if (!page) continue;
    const before = stream.pre ? preSubjects.filter(s => !s.dbOnly && s.stream === stream.pre!.slug) : [];
    const after = stream.post ? postSubjects.filter(s => !s.dbOnly && s.stream === stream.post!.slug) : [];
    const silenced = pageDrafts(d, stream, lifetimes.get(page.id)!, after, draft => drafts.push(draft));
    if (!silenced) drafts.push(...subjectDrafts(d, page.slug, before, after));
  }
  // A renamed page's database-only facts follow it: their pre side is diffed under the slug the page moved to, so a rename moves no key.
  const renamedTo = new Map(streams.flatMap(s => s.pre && s.post && s.pre.slug !== s.post.slug ? [[s.pre.slug, s.post.slug] as const] : []));
  const dbPre = preSubjects.filter(s => s.dbOnly), dbPost = postSubjects.filter(s => s.dbOnly);
  const dbStream = (s: Subject) => renamedTo.get(s.stream) ?? s.stream;
  for (const slug of new Set([...dbPre.map(dbStream), ...dbPost.map(s => s.stream)])) {
    drafts.push(...subjectDrafts(d, slug, dbPre.filter(s => dbStream(s) === slug), dbPost.filter(s => s.stream === slug)));
  }

  // A contested fact outside the batch's streams is keyed and hashed as its own stream holds it now (its page's lifetime when the page exists).
  const extraStreams = new Map<string, Awaited<ReturnType<typeof currentStateHash>>>();
  for (const f of extraFacts) {
    const stream = f.sms ?? f.entity_slug;
    if (stream && !extraStreams.has(stream)) extraStreams.set(stream, await currentStateHash(tx, opts.sourceId, batch.incarnation, stream));
  }
  for (const note of batch.notes) {
    if (note.kind === 'contested') drafts.push(...contestedDraft(d, note, { pre, post, preSubjects, postSubjects, extraFacts, extraStreams, lifetimes }));
    else if (note.kind === 'held') {
      const page = postPageAt(note.slug);
      const lifetime = lifetimeAt(note.slug);
      drafts.push({ sourceId: opts.sourceId, incarnation: batch.incarnation, lifetime, slug: note.slug, stream: note.slug,
        subjectKind: note.holdKind === 'take' ? 'take' : 'fact', subjectKey: heldKey(lifetime ? lifetimeRef(lifetime) : slugRef(batch.incarnation, note.slug), note.holdKind, note.fingerprint), eventType: 'trust.held',
        trustTier: note.tier, tierBasis: 'writer', visibility: page && !page.visible ? 'private' : 'world', value: { value_hash: note.valueHash },
        stateHash: streamHash(note.slug), cause: d.cause({ hold: `wh${note.holdId}` }) });
    } else if (note.kind === 'released') {
      const s = postSubjects.find(x => x.kind === (note.table === 'facts' ? 'fact' : 'take') && x.rowIds.includes(note.rowId));
      if (s) drafts.push(redactionReleasedDraft({ sourceId: opts.sourceId, incarnation: batch.incarnation, lifetime: lifetimeAt(s.stream), slug: s.stream, stream: s.stream,
        subjectKind: s.kind as BeliefEventDraft['subjectKind'], subjectKey: s.key, trustTier: s.tier, visibility: s.visibility, stateHash: streamHash(s.stream) }, note.releases, batch.publicationId));
    }
  }
  if (preimageInvariantEnforced()) {
    const needs = streams.flatMap(s => s.pre && s.post && s.pre.id === s.post.id && s.pre.revision !== s.post.revision && !s.pre.large && !s.post.large
      ? [{ pageId: s.post.id, slug: s.pre.slug, revision: s.pre.revision }] : []);
    const missing = await missingPreimages(tx, needs);
    if (missing.length) {
      throw new Error(`belief preimage invariant: ${missing.map(m => `${m.slug} moved off revision ${m.revision} with no page_versions row for it`).join('; ')} (op ${opts.op}; BELIEF_LEDGER.md section 14 item 8)`);
    }
  }
  return appendBeliefEvents(tx, drafts, { publicationId: batch.publicationId, origin: opts.origin ?? (batch.managed ? 'live' : 'unmanaged'),
    writerTier, remote: opts.remote, ownerEdit: opts.ownerEdit, purgesPossible: batch.purgesPossible || batch.notes.some(n => n.kind === 'purged') });
}

/** `trust.contested` on the held row's key: its tier as trust_tier, the challenger's as writer_tier (section 6.1). */
function contestedDraft(d: DiffContext, note: Extract<BeliefNote, { kind: 'contested' }>, s: { pre: RawState; post: RawState; preSubjects: Subject[];
  postSubjects: Subject[]; extraFacts: Awaited<ReturnType<typeof readFactsById>>; extraStreams: Map<string, Awaited<ReturnType<typeof currentStateHash>>>;
  lifetimes: Map<number, string> }): BeliefEventDraft[] {
  const cause = d.cause({ proposal: `tp${note.proposalId}`, guard: note.guard });
  const base = { sourceId: d.opts.sourceId, incarnation: d.batch.incarnation, eventType: 'trust.contested', writerTier: d.writerTier, value: null };
  if (note.table === 'pages') {
    const page = s.post.pages.find(p => p.id === note.rowId) ?? s.pre.pages.find(p => p.id === note.rowId);
    if (!page) return [];
    return [{ ...base, lifetime: s.lifetimes.get(page.id)!, slug: page.slug, stream: page.slug, subjectKind: 'page', subjectKey: pageKey(s.lifetimes.get(page.id)!),
      trustTier: page.tier, visibility: page.visible ? 'world' : 'private', stateHash: d.streamHash(page.slug), cause }];
  }
  if (note.table !== 'facts' && note.table !== 'takes') return [];
  const kind = note.table === 'facts' ? 'fact' : 'take';
  const subject = [...s.postSubjects, ...s.preSubjects].find(x => x.kind === kind && x.rowIds.includes(note.rowId));
  if (subject) return [{ ...base, lifetime: d.lifetimeAt(subject.stream), slug: subject.stream, stream: subject.stream, subjectKind: kind, subjectKey: subject.key,
    trustTier: subject.tier, visibility: subject.visibility, claimFp: subject.claimFp, stateHash: d.streamHash(subject.stream), cause }];
  const fact = kind === 'fact' ? s.extraFacts.find(f => f.id === note.rowId) : undefined;
  if (!fact) return [];
  const stream = fact.sms ?? fact.entity_slug ?? '';
  const own = s.extraStreams.get(stream);
  const page = own?.state.pages.find(p => p.slug === stream) ?? null;
  const lifetimes = new Map([...s.lifetimes, ...own?.lifetimes ?? []]);
  const key = keyFact({ incarnation: d.batch.incarnation, lifetimes, pagesBySlug: new Map(page ? [[stream, page]] : []) }, fact).key;
  return [{ ...base, lifetime: page ? lifetimes.get(page.id) ?? null : null, slug: stream, stream, subjectKind: 'fact', subjectKey: key, trustTier: fact.tier,
    visibility: fact.visibility, claimFp: fact.fp, stateHash: own?.hash ?? d.streamHash(stream), cause }];
}

/** The current belief-set hash of one stream, for the doctor drift check and reconcile. */
export async function currentStateHash(tx: BrainEngine, sourceId: string, incarnation: string, slug: string,
  opts: { readOnly?: boolean } = {}): Promise<{ hash: string; state: RawState; lifetimes: Map<number, string> }> {
  const state = await readBeliefState(tx, sourceId, [slug]);
  const lifetimes = opts.readOnly ? await peekLifetimes(tx, pageNeeds(sourceId, incarnation, state)) : await resolveLifetimes(tx, pageNeeds(sourceId, incarnation, state));
  const page = state.pages.find(p => p.slug === slug) ?? null;
  const ctx: KeyContext = { incarnation, lifetimes, pagesBySlug: new Map(page ? [[slug, page]] : []) };
  const subjects = keyedSubjects(ctx, state, id => state.pages.find(p => p.id === id)?.visible === false ? 'private' : 'world').filter(s => s.stream === slug);
  return { hash: stateHashOf(page, page ? lifetimes.get(page.id)! : null, subjects), state, lifetimes };
}

/** resolveLifetimes without writes (a read-only drift scan): a page with no fitting open lifetime gets a placeholder, so its hash cannot match a recorded one. */
async function peekLifetimes(tx: BrainEngine, needs: ReturnType<typeof pageNeeds>): Promise<Map<number, string>> {
  const open = await readOpenLifetimes(tx, needs);
  return new Map(needs.map(n => {
    const row = open.get(`${n.incarnation}\u0000${n.slug}`);
    return [n.pageId, row && (row.page_id == null || row.page_id === n.pageId) ? row.page_lifetime : `unminted:${n.pageId}`];
  }));
}

export { stateHashOf };

/**
 * The journaled operations that are a direct edit of a page's facts or takes (design 6.5: a trusted local write that
 * sets the field). Only these, from a local caller and with no internal intent `kind` (the `put_page` rows of
 * import, file repair, quarantine clear, reconcile and managed maintenance carry one), can release a purge
 * redaction; sync (`submit_job`), gate release, held accept, backfill, revert, restore and retention never do.
 * append.ts still requires the writer tier at or above OWNER_TIER_FLOOR, and the trust channel records these verbs
 * as agent_written even from the local CLI, so today `trust confirm` is the release that reaches it.
 *
 * append_page stays out (#7123). The redaction release is this list's only consumer (`ownerEdit` reaches nothing else;
 * the ledger attributes every publication by its `op`, so an append's events say `append_page` either way). An append
 * cannot set a fact or take field (its text refuses fence markers), so as an owner edit it could only release a
 * redaction on a field its publication re-derives from text the owner did not edit. Its intent's `kind` keeps it out
 * a second time. Pinned by test/belief-ledger-append-owner.test.ts.
 */
const OWNER_EDIT_OPERATIONS: ReadonlySet<string> = new Set(['put_page', 'edit_page', 'takes_update', 'takes_resolve']);
let allowlistDropped = false;
/** Tests: the forced probe that drops the allowlist, so every local publication counts as an owner edit. */
export function __dropOwnerEditAllowlistForTests(dropped: boolean): void { allowlistDropped = dropped; }

/** The batch options of one journaled page publication (single or group member). */
export function publicationBeliefOptions(row: { id: string; source_id: string; slug: string; operation: string; authority: { remote?: boolean }; intent?: Record<string, unknown> | null },
  additionalKeys: readonly { sourceId: string; slug: string }[] = [], report?: { appended: number }): BeliefBatchOptions {
  return { sourceId: row.source_id, slugs: [...new Set([row.slug, ...additionalKeys.filter(k => k.sourceId === row.source_id).map(k => k.slug)])],
    publicationId: row.id, op: row.operation, remote: row.authority.remote !== false,
    ...(row.authority.remote === false && (allowlistDropped || OWNER_EDIT_OPERATIONS.has(row.operation) && row.intent?.kind == null) ? { ownerEdit: true } : {}),
    ...(row.operation === 'revert_version' ? { pageEventType: 'page.reverted' as const } : {}),
    ...(row.operation === 'trust_release' ? { cause: { hold: `wh${row.intent?.hold_id}` } } : {}),
    ...(row.operation === 'delete_page' && row.intent?.retention === true ? { hardDeleteEvent: 'page.expired' as const } : {}), ...(report ? { report } : {}) };
}
