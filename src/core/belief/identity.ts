/**
 * Identity events outside a publication diff (docs/designs/BELIEF_LEDGER.md
 * section 3) and the slug-at-time lookup replay uses.
 *
 * A cheap rename (`updateSlug`) keeps the page row, so the publication's batch
 * pairs the two sides by page id and records `page.renamed` itself. The
 * fallback rename (#5431) materializes the destination as a new row and moves
 * the old row's identity onto it; `recordFallbackRename` gives the destination
 * the old page's lifetime, so the rename is one `page.renamed` and the history
 * stays on one lifetime.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { assertHeldPageKeys } from '../page-state/guards.ts';
import { appendBeliefEvents } from './append.ts';
import { lifetimeRef, pageKey } from './keys.ts';
import { coverageActive, currentStateHash, readLedgerSource, streamSubjectDrafts } from './ledger.ts';
import { endLifetime, renameLifetime } from './lifetimes.ts';
import { keyedSubjects, type Subject } from './subjects.ts';

/** One stream's current subjects, keyed as the ledger keys them now, with its state hash. */
async function keyedStream(tx: BrainEngine, sourceId: string, incarnation: string, slug: string) {
  const { hash, state, lifetimes } = await currentStateHash(tx, sourceId, incarnation, slug);
  const page = state.pages.find(p => p.slug === slug) ?? null;
  const subjects = keyedSubjects({ incarnation, lifetimes, pagesBySlug: new Map(page ? [[slug, page]] : []) }, state,
    id => state.pages.find(p => p.id === id)?.visible === false ? 'private' : 'world').filter(s => s.stream === slug);
  return { hash, page, lifetimes, subjects, writerTier: state.writerTier };
}

/**
 * The fallback rename's transaction, with both slugs' page keys held: `moves`
 * carries the stale row's identity onto the destination row, then the
 * destination takes the stale row's lifetime (the destination's own lifetime,
 * minted by its import, ends). One `page.renamed` is appended, plus the
 * subject events that make the surviving lifetime describe the destination:
 * each destination row's belief is `*.transferred` from the ended lifetime,
 * and a stale belief the destination does not hold is retracted. Returns the
 * publication id when it appended.
 */
export async function recordFallbackRename(tx: BrainEngine, input: { sourceId: string; staleSlug: string; newSlug: string; fromPageId: number; toPageId: number },
  moves: () => Promise<void>): Promise<string | null> {
  const source = await readLedgerSource(tx, input.sourceId);
  if (!source || !coverageActive(source.coverage)) { await moves(); return null; }
  assertHeldPageKeys(tx, [{ sourceId: input.sourceId, slug: input.staleSlug }, { sourceId: input.sourceId, slug: input.newSlug }]);
  const stale = await keyedStream(tx, input.sourceId, source.incarnation, input.staleSlug);
  const dest = await keyedStream(tx, input.sourceId, source.incarnation, input.newSlug);
  const lifetime = stale.lifetimes.get(input.fromPageId)!;
  const absorbed = dest.lifetimes.get(input.toPageId) ?? null;
  await moves();
  if (absorbed && absorbed !== lifetime) await endLifetime(tx, absorbed);
  await renameLifetime(tx, lifetime, input.newSlug, input.toPageId);
  const after = await keyedStream(tx, input.sourceId, source.incarnation, input.newSlug);
  // Each destination belief moves onto the surviving lifetime: by its rows, else (its row merged into an equal stale row) by its key; one with neither ends.
  const transfers = new Map<string, { from: Subject; fromLifetime: string | null }>();
  const ended: Subject[] = [];
  const rowsAfter = new Set(after.subjects.flatMap(a => a.rowIds.map(id => `${a.kind}:${id}`)));
  for (const s of dest.subjects) {
    if (s.rowIds.some(id => rowsAfter.has(`${s.kind}:${id}`))) { for (const id of s.rowIds) transfers.set(`${s.kind}:${id}`, { from: s, fromLifetime: absorbed }); continue; }
    const target = absorbed ? after.subjects.find(a => a.kind === s.kind && a.key === s.key.split(lifetimeRef(absorbed)).join(lifetimeRef(lifetime))) : undefined;
    if (target) for (const id of target.rowIds) { if (!transfers.has(`${target.kind}:${id}`)) transfers.set(`${target.kind}:${id}`, { from: s, fromLifetime: absorbed }); }
    else ended.push(s);
  }
  const cause = { op: 'rename_fallback' };
  const publicationId = randomUUID();
  const appended = await appendBeliefEvents(tx, [{ sourceId: input.sourceId, incarnation: source.incarnation, lifetime, slug: input.newSlug, stream: input.newSlug,
    subjectKind: 'page', subjectKey: pageKey(lifetime), eventType: 'page.renamed', trustTier: after.page?.tier || 'unknown',
    visibility: after.page?.visible === false ? 'private' : 'world', value: { old_slug: input.staleSlug, new_slug: input.newSlug, ...(absorbed && absorbed !== lifetime ? { absorbed_lifetime: absorbed } : {}) },
    stateHash: after.hash, cause },
  ...streamSubjectDrafts({ sourceId: input.sourceId, incarnation: source.incarnation, slug: input.newSlug, lifetime, op: cause.op, writerTier: after.writerTier,
    stateHash: after.hash, before: stale.subjects, after: after.subjects, transfers }),
  ...streamSubjectDrafts({ sourceId: input.sourceId, incarnation: source.incarnation, slug: input.newSlug, lifetime: absorbed, op: cause.op, writerTier: after.writerTier,
    stateHash: after.hash, before: ended, after: [], transfers: new Map() })],
  { publicationId, origin: await readManagedMode(tx) ? 'live' : 'unmanaged', purgesPossible: source.purgesPossible });
  return appended ? publicationId : null;
}

/**
 * The slug a page lifetime had at `at`, from its own events (each carries the
 * stream slug at recording time); null when the lifetime had no event by then.
 * Replay resolves a rename this way: before it, the old slug.
 */
export async function lifetimeSlugAt(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, lifetime: string, at: Date): Promise<string | null> {
  const [row] = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM belief_events
    WHERE source_id = $1 AND page_lifetime = $2::uuid AND subject_kind = 'page' AND recorded_at <= $3::timestamptz ORDER BY id DESC LIMIT 1`,
  [sourceId, lifetime, at.toISOString()]);
  return row?.slug ?? null;
}

/**
 * The page lifetime that held `slug` at `at`: the lifetime of the newest page
 * event recorded at that slug by then, unless that lifetime had moved to
 * another slug by then. Null when no page held it.
 */
export async function lifetimeAtSlug(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, at: Date): Promise<string | null> {
  const [row] = await engine.executeRaw<{ lifetime: string }>(`SELECT e.page_lifetime::text AS lifetime FROM belief_events e
    WHERE e.source_id = $1 AND e.slug = $2 AND e.subject_kind = 'page' AND e.page_lifetime IS NOT NULL AND e.recorded_at <= $3::timestamptz
    ORDER BY e.id DESC LIMIT 1`, [sourceId, slug, at.toISOString()]);
  if (!row) return null;
  return await lifetimeSlugAt(engine, sourceId, row.lifetime, at) === slug ? row.lifetime : null;
}
