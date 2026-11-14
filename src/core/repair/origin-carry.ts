/**
 * GST-2689: a page that reads as world by its own label but is hidden from remote callers only because its origin is
 * private (a declared derived_from origin, an atom's source_slug origin, a concept whose provenance atom has one) opens
 * once the origin row is gone. So before an origin row is removed, every live same-source page that would gain a reader
 * gets `visibility: private` through the label door (repair/label-write.ts): tighten-only, the trust tier kept, no lowering
 * proposal filed, a managed file changed in that one line, readable_by kept. The dependents are private-labels.ts
 * dependentsSql('remove'): a page already private, pinned or not lineage-dependent is never returned, a page that names
 * readers is returned when its listed readers would gain it, and a life-chronicle event already fails closed, so it is skipped.
 *
 * Two places run it. delete_page (deletePageCarryingPrivate): a soft delete, local or remote, labels the dependents once
 * the delete committed, as a maintenance write whose batch names the delete's request id (on a managed brain); a failure
 * there is left to the purge. An explicit purge labels them first; when that fails it soft-deletes instead and parks the
 * origin, and when the origin lookup itself fails it soft-deletes and keeps any park (purge_held derived_origin_unchecked). Every expiry (carryPrivateBeforePurge, from purgeDeletedPagesCoordinated) labels the dependents of each expired
 * private origin and parks the ones it could not (persistence/derived-origin-hold.ts), so no purge removes them.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import type { LabelEdit } from '../persistence/label-edit.ts';
import { maintenancePreflight, publishMaintenancePages } from '../persistence/prepared-maintenance.ts';
import { clearDerivedOriginParks, DERIVED_ORIGIN_PARKED_CODE, derivedOriginPurgeHold, parkDerivedOrigin, pruneDerivedOriginParks, readDerivedOriginParks, type DerivedOriginPark } from '../persistence/derived-origin-hold.ts';
import { privacyPartSql, readHonorAliases, withoutCallerAccess } from '../search/private-visibility.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import { filesInCheckout, importAtRevision, writeLabelFile } from './label-write.ts';
import { dependentsSql } from './private-labels.ts';

const bounded = { timeoutMs: 120_000, jitOff: true, prepare: false };
const PREVIEW = 'gbrain repair visibility';
const EDIT: LabelEdit = { set: { visibility: 'private' }, remove: [] };
/** A page whose removal can open another: hidden by the privacy rules itself, or an atom a concept's provenance names. */
const originSql = (alias: string) => `(${alias}.type = 'atom' OR NOT ${privacyPartSql(alias)})`;

interface Origin { id: number; source_id: string; slug: string }
interface Dependent { id: number; origin_id: number; source_id: string; slug: string; deleted: boolean }
interface Failure { code: string | null; reason: string }
export interface CarryBlock extends Failure { slug: string | null }

const failureOf = (error: unknown): Failure => ({ code: typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : null,
  reason: error instanceof Error ? error.message : String(error) });

async function dependentsOf(engine: BrainEngine, origins: Origin[]): Promise<Dependent[]> {
  const rows = await engine.executeRaw<{ id: number; cleared_id: number; source_id: string; slug: string; deleted: boolean }>(
    `SELECT d.id, d.cleared_id, p.source_id, p.slug, p.deleted_at IS NOT NULL AS deleted FROM (${dependentsSql('remove')}) d JOIN pages p ON p.id = d.id WHERE d.category <> 'life_chronicle' ORDER BY d.id`,
    [origins.map(o => o.id), origins.map(o => o.source_id), origins.map(o => o.slug), origins.map(() => '')], bounded);
  return rows.map(row => ({ id: Number(row.id), origin_id: Number(row.cleared_id), source_id: row.source_id, slug: row.slug, deleted: row.deleted === true }));
}

/** Labels each page private through the label door; the failures by page id. */
async function stamp(engine: BrainEngine, pages: Dependent[], batch: string): Promise<Map<number, Failure>> {
  const failed = new Map<number, Failure>();
  const ready: Array<{ page: Dependent; revision: string; content: string }> = [];
  for (const page of pages) {
    const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
    if (!snapshot || Number(snapshot.page.id) !== page.id) { failed.set(page.id, { code: 'page_identity_changed', reason: `${page.slug} changed identity while it was being labelled private.` }); continue; }
    if (isSegmentedPage(snapshot.page)) { failed.set(page.id, { code: 'segmented_page', reason: `${page.slug} is stored in segments, which a label write does not rewrite.` }); continue; }
    ready.push({ page, revision: snapshot.revision,
      content: serializePageToMarkdown({ ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, visibility: 'private' } }, snapshot.tags) });
  }
  for (const sourceId of new Set(ready.map(entry => entry.page.source_id))) {
    const group = ready.filter(entry => entry.page.source_id === sourceId);
    try {
      const authority = await maintenancePreflight(engine, sourceId);
      if (authority) {
        for (let i = 0; i < group.length; i += 200) {
          const part = group.slice(i, i + 200);
          const settled = await publishMaintenancePages(engine, authority, part.map(({ page, revision, content }) => ({ slug: page.slug, content, expectedRevision: revision,
            requestId: randomUUID(), keepTrust: true as const, labelEdit: EDIT })), { batch });
          settled.forEach((entry, index) => { if ('error' in entry) failed.set(part[index]!.page.id, failureOf(entry.error)); });
        }
        continue;
      }
      const files = await filesInCheckout(engine, group.map(entry => entry.page.id));
      for (const { page, revision, content } of group) {
        try {
          const path = files.get(page.id);
          const written = path ? await writeLabelFile(engine, page, { revision, content, edit: EDIT, embed: false, preview: PREVIEW, path })
            : await importAtRevision(engine, page, revision, content, false, PREVIEW);
          if (written === null) failed.set(page.id, { code: 'revision_conflict', reason: `${page.slug} changed while it was being labelled private.` });
          else if (typeof written !== 'string') failed.set(page.id, { code: written.outcome ?? null, reason: written.reason ?? 'the label write was held' });
        } catch (error) { failed.set(page.id, failureOf(error)); }
      }
    } catch (error) { for (const { page } of group) failed.set(page.id, failureOf(error)); }
  }
  return failed;
}

/**
 * Labels private every page each origin is the only privacy of, as if the origin rows were gone; the origins still
 * blocked afterwards, by origin id, with the first page that still would open and why. A soft-deleted dependent is not
 * labelled: it blocks its origin until it is purged or restored. Runs outside any caller's view.
 */
export async function carryPrivate(engine: BrainEngine, origins: Origin[], batch: string): Promise<Map<number, CarryBlock>> {
  if (!origins.length) return new Map();
  return withoutCallerAccess(async () => {
    try {
      await readHonorAliases(engine);
      const pages = [...new Map((await dependentsOf(engine, origins)).map(page => [page.id, page])).values()];
      if (!pages.length) return new Map<number, CarryBlock>();
      const failed = await stamp(engine, pages.filter(page => !page.deleted), batch);
      for (const page of pages) if (page.deleted) failed.set(page.id, { code: 'dependent_soft_deleted',
        reason: `${page.slug} is soft-deleted and private only through this page; kept until ${page.slug} is purged or restored.` });
      const blocked = new Map<number, CarryBlock>();
      for (const page of await dependentsOf(engine, origins)) {
        if (!blocked.has(page.origin_id)) blocked.set(page.origin_id, { slug: page.slug,
          ...(failed.get(page.id) ?? { code: null, reason: `${page.slug} still reads as world without its origin.` }) });
      }
      return blocked;
    } catch (error) {
      return new Map<number, CarryBlock>(origins.map(origin => [origin.id, { slug: null, ...failureOf(error) }]));
    }
  });
}

async function originOf(engine: BrainEngine, sourceId: string, slug: string): Promise<(Origin & { deleted: boolean }) | null> {
  return withoutCallerAccess(async () => {
    await readHonorAliases(engine);
    const [row] = await engine.executeRaw<{ id: number; deleted: boolean }>(`SELECT p.id, p.deleted_at IS NOT NULL AS deleted FROM pages p
      WHERE p.source_id = $1 AND p.slug = $2 AND ${originSql('p')}`, [sourceId, slug], bounded);
    return row ? { id: Number(row.id), source_id: sourceId, slug, deleted: row.deleted === true } : null;
  });
}

const parked = (origin: Origin, block: CarryBlock) => ({ source_id: origin.source_id, slug: origin.slug, page_id: origin.id, blocking_slug: block.slug, code: block.code, reason: block.reason });

/** A request id derived from `requestId`, UUID-shaped, so a replay of the purge request replays its fallback soft delete. */
function derivedRequestId(requestId: string): string {
  const h = createHash('sha256').update(`derived-origin-soft-delete:${requestId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The delete_page handler after validation. A soft delete labels the dependents once it committed and returns the same
 * receipt either way (it names no labelled page and counts none). A purge (trusted local) labels them first; when that
 * fails, the page is soft-deleted instead (already a tombstone: left as it is), parked, and the receipt carries
 * `purge_held`, so nothing that kept the derived pages hidden is removed.
 */
export async function deletePageCarryingPrivate(ctx: OperationContext, p: Record<string, unknown>, sourceId: string): Promise<Record<string, unknown>> {
  const { submitPageMutation } = await import('../persistence/page-mutations.ts');
  const { finishPagePurge } = await import('../persistence/page-purge.ts');
  p.request_id ??= randomUUID();
  const batch = `derived-origin-carry:${String(p.request_id)}`;
  const slug = typeof p.slug === 'string' ? p.slug.toLowerCase() : null;
  if (p.purge !== true) {
    const origin = slug ? await originOf(ctx.engine, sourceId, slug).catch(() => null) : null;
    const result = await submitPageMutation(ctx, { operation: 'delete_page', params: p });
    if (origin && (await originOf(ctx.engine, sourceId, origin.slug).catch(() => null))?.deleted) await carryPrivate(ctx.engine, [origin], batch).catch(() => undefined);
    return finishPagePurge(ctx, result);
  }
  let origin: (Origin & { deleted: boolean }) | null;
  try { origin = slug ? await originOf(ctx.engine, sourceId, slug) : null; }
  catch {
    const held = await submitPageMutation(ctx, { operation: 'delete_page', params: { ...p, purge: false, request_id: derivedRequestId(String(p.request_id)) } });
    return { ...held, purge_held: ORIGIN_UNCHECKED_HOLD };
  }
  const block = origin ? (await carryPrivate(ctx.engine, [origin], batch)).get(origin.id) : undefined;
  if (!origin || !block) {
    if (origin) await clearDerivedOriginParks(ctx.engine, [origin.id]);
    await faultPoint('purge:after_carry', { sourceId, slug: origin?.slug });
    const result = await finishPagePurge(ctx, await submitPageMutation(ctx, { operation: 'delete_page', params: p }));
    if (origin && result.status === 'purged') await clearDerivedOriginParks(ctx.engine, [origin.id]);
    return result;
  }
  await parkDerivedOrigin(ctx.engine, parked(origin, block));
  const result = origin.deleted ? { status: 'held', slug: origin.slug, source_id: sourceId, request_id: p.request_id }
    : await submitPageMutation(ctx, { operation: 'delete_page', params: { ...p, purge: false, request_id: derivedRequestId(String(p.request_id)) } });
  return { ...result, purge_held: { code: DERIVED_ORIGIN_PARKED_CODE,
    message: `Not purged: ${block.slug ?? 'a page derived from it'} is private only through ${origin.slug} and could not be labelled private (${block.code ?? 'error'}: ${block.reason}). `
      + `${origin.slug} is soft-deleted and parked: no purge removes it until that page carries its own label; gbrain doctor names it as derived_origin_parked.` } };
}

/** Hours before its cutoff a tombstone is carried, so none crosses the cutoff while the carry runs and is purged uncarried. */
export const CARRY_LEAD_HOURS = 24;

/**
 * Before a purge: the soft-deleted origins expired or expiring within CARRY_LEAD_HOURS get their dependents labelled
 * private, judged against all of them at once (a page private through two of them opens only when both go); each one
 * still blocked is parked (the purge skips it). The parks written this run, and the origins whose earlier park no longer
 * applies: the caller clears those after its purge, so an origin parked when the purge was previewed stays this run.
 */
export async function carryPrivateBeforePurge(engine: BrainEngine, olderThanHours: number): Promise<{ parks: DerivedOriginPark[]; unparked: Origin[] }> {
  await pruneDerivedOriginParks(engine);
  const origins = await withoutCallerAccess(async () => {
    await readHonorAliases(engine);
    return engine.executeRaw<{ id: number; source_id: string; slug: string }>(`SELECT p.id, p.source_id, p.slug FROM pages p
      WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - ($1 || ' hours')::interval AND ${originSql('p')} ORDER BY p.id`,
      [String(Math.max(0, Math.floor(olderThanHours) - CARRY_LEAD_HOURS))], bounded);
  });
  const parks: DerivedOriginPark[] = [];
  const batch = `derived-origin-carry:purge-${randomUUID()}`;
  const expired = origins.map(row => ({ id: Number(row.id), source_id: row.source_id, slug: row.slug }));
  const blocked = await carryPrivate(engine, expired, batch);
  for (const origin of expired) {
    const block = blocked.get(origin.id);
    if (!block) continue;
    await parkDerivedOrigin(engine, parked(origin, block));
    parks.push({ ...parked(origin, block), parked_at: new Date().toISOString() });
  }
  return { parks, unparked: expired.filter(origin => !blocked.has(origin.id)) };
}

/**
 * A consented manual purge first retries the label for every parked origin and unparks the ones it frees, so its preview
 * and consent list them (otherwise a brain whose only expired pages are parked origins never gets past "nothing to purge").
 */
export async function retryParkedOrigins(engine: BrainEngine, olderThanHours: number): Promise<void> {
  if (!(await readDerivedOriginParks(engine)).length) return;
  await clearDerivedOriginParks(engine, (await carryPrivateBeforePurge(engine, olderThanHours)).unparked.map(origin => origin.id));
}

/** The receipt note of an explicit purge held because its origin lookup failed; it names no page and counts none. */
export const ORIGIN_UNCHECKED_HOLD = { code: 'derived_origin_unchecked',
  message: 'Not purged: whether a page derived from this one would open without it could not be checked, so this page is kept soft-deleted (a parked page stays parked); purge it again once that read works, and the automatic purge checks it before it removes it.' };

/** The receipt note of a purge the in-transaction recheck held; it names no page and counts none. */
export const MID_PURGE_HOLD = { code: DERIVED_ORIGIN_PARKED_CODE,
  message: 'Not purged: a page derived from this one was written during the purge and is not labelled private yet, so this page is kept soft-deleted and parked; the next purge labels it and frees this page, and the one after removes it (gbrain doctor: derived_origin_parked).' };

/**
 * Inside a purge's delete transaction, after the carry: the origins among `ids` (the bulk paths skip parked ones; the
 * single-page purge passes `recheckParked`, so a parked origin whose carry was skipped is held too) that a page would
 * still open without, which means a dependent was written after the carry labelled the rest. The label door cannot write
 * inside this transaction (a managed label is its own publication, a Git label its own commit), so each such origin is
 * parked here, in the same transaction, and the caller skips its row delete; the next purge labels the page and the one
 * after removes the origin. The parks written, by origin.
 */
export async function parkUncarriedInPurge(tx: BrainEngine, ids: readonly number[], opts: { recheckParked?: boolean } = {}): Promise<DerivedOriginPark[]> {
  if (!ids.length) return [];
  return withoutCallerAccess(async () => {
    await readHonorAliases(tx);
    const origins = (await tx.executeRaw<{ id: number; source_id: string; slug: string }>(`SELECT p.id, p.source_id, p.slug FROM pages p
      WHERE p.id = ANY($1::int[]) AND ${originSql('p')}${opts.recheckParked ? '' : ` AND ${derivedOriginPurgeHold('p')}`} ORDER BY p.id`, [[...ids]], bounded))
      .map(row => ({ id: Number(row.id), source_id: row.source_id, slug: row.slug }));
    if (!origins.length) return [];
    const first = new Map<number, Dependent>();
    for (const page of await dependentsOf(tx, origins)) if (!first.has(page.origin_id)) first.set(page.origin_id, page);
    const parks: DerivedOriginPark[] = [];
    for (const origin of origins) {
      const page = first.get(origin.id);
      if (!page) continue;
      const park = { source_id: origin.source_id, slug: origin.slug, page_id: origin.id, blocking_slug: page.slug, code: 'dependent_written_mid_purge',
        reason: `${page.slug} was written while ${origin.slug} was being purged and is private only through it; the next purge labels it.` };
      await parkDerivedOrigin(tx, park);
      parks.push({ ...park, parked_at: new Date().toISOString() });
    }
    return parks;
  });
}
