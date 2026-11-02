import { createHash } from 'node:crypto';
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import { unmanagedBeliefPoint } from '../belief/projection-point.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { OperationError } from '../ops/contract.ts';
import { matchesSlugAllowList, slugUnderBoundPrefixes } from '../ops/context.ts';
import { extractPageLinks, isAutoLinkEnabled, isGlobalBasenameEnabled, makeResolver, type PageLinksResult } from '../link-extraction.ts';
import { protectedRegions } from '../fence-scan.ts';
import { PROTECTED_PAIRS, sanitizeRemoteBody } from '../remote-body.ts';
import { confirmBodyPin, openSegmentedBody, readBodyRange, type BodyAudience } from '../page-body/read-range.ts';
import { privacyPartSql } from '../search/private-visibility.ts';
import { authorizeStoredRequest } from './authority.ts';
import { completeEffect } from './effect-journal.ts';
import { REMOTE_AUTO_LINKS_KEY, REMOTE_MENTION_LINK_SOURCE, type AppendedRange, type PersistenceEffect } from './effect-model.ts';
import { guardEffectSource } from './effect-recovery.ts';
import type { SqlEngine, WriteAuthority, WriteRequest } from './model.ts';
import { excludesPrivateWrites, writerReadPolicySql } from './page-visibility.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { extractSegmentedPageLinks } from '../page-body/segment-links.ts';
import { inlineRegions } from '../page-body/tail-digest.ts';
import { validateSlug } from '../utils.ts';
import { isRemoteWantedPagesEnabled, replaceWantedLinks } from '../wanted-links.ts';

/** `mcp.remote_auto_links`: unset is on; false/0/no/off (any case) turns the remote `links` effect off. */
export async function isRemoteAutoLinksEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  const value = await engine.getConfig(REMOTE_AUTO_LINKS_KEY);
  return value == null || !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}

export type SkippedLinkTarget = { slug: string; reason: 'cross_source' | 'invalid_slug' | 'missing' | 'not_visible' | 'outside_grant' };
/** At most this many skipped targets are recorded on one effect outcome. */
const SKIPPED_TARGET_LIMIT = 50;

/**
 * Plain mention targets of a page body: markdown links, [[wikilinks]] and
 * page-path mentions in compiled_truth only. No frontmatter, no timeline
 * section, no schema-pack verbs; every edge is stored as an untyped `mentions`.
 * A segmented page's compiled truth is read block by block (page-body/segment-links.ts).
 * #7008: a target validateSlug refuses (`../x`, a backslash, an encoded separator)
 * is skipped as invalid_slug here, before any page key is locked, so it never
 * fails the effect or costs the page its valid edges; control characters in the
 * recorded slug are escaped so the outcome stays storable.
 */
async function mentionTargets(engine: BrainEngine, snapshot: PageSnapshot, sourceId: string) {
  const { page } = snapshot;
  const resolver = makeResolver(engine, { mode: 'live', sourceId });
  const opts = await mentionOptions(engine);
  const { candidates } = isSegmentedPage(page)
    ? await extractSegmentedPageLinks(engine, { id: Number(page.id), slug: page.slug, source_id: sourceId, type: page.type, frontmatter: {} }, resolver,
      { ...opts, regions: ['truth'] })
    : await extractPageLinks(page.slug, page.compiled_truth, {}, page.type, resolver, opts);
  return mentionCandidates(candidates, page.slug, sourceId);
}

const mentionOptions = async (engine: BrainEngine) => ({ skipFrontmatter: true, pack: null, globalBasename: await isGlobalBasenameEnabled(engine) });

/** The plain mention targets among extracted candidates (no frontmatter edge, never the page itself), each with its first context. */
function mentionCandidates(candidates: PageLinksResult['candidates'], pageSlug: string, sourceId: string) {
  const targets = new Map<string, string>();
  const skipped: SkippedLinkTarget[] = [];
  for (const candidate of candidates) {
    if (candidate.fromSlug || candidate.targetSlug === pageSlug) continue;
    if (!validSlug(candidate.targetSlug)) {
      const slug = candidate.targetSlug.replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
      if (!skipped.some(target => target.slug === slug)) skipped.push({ slug, reason: 'invalid_slug' });
    } else if (candidate.targetSourceId && candidate.targetSourceId !== sourceId) skipped.push({ slug: candidate.targetSlug, reason: 'cross_source' });
    else if (!targets.has(candidate.targetSlug)) targets.set(candidate.targetSlug, candidate.context);
  }
  return { targets, skipped };
}

function validSlug(slug: string): boolean {
  try { validateSlug(slug); return true; } catch { return false; }
}

/** The writer's slug confinement, stored and current, applied to link targets. */
async function targetGrant(tx: SqlEngine, a: WriteAuthority): Promise<(slug: string) => boolean> {
  const checks: Array<(slug: string) => boolean> = [];
  if (a.slugPrefixes != null) checks.push(slug => slugUnderBoundPrefixes(a.slugPrefixes!, slug));
  if (a.delegated || a.restrictedNamespace) checks.push(slug => !!a.delegatedPrefixes?.length && matchesSlugAllowList(slug, a.delegatedPrefixes));
  let live: unknown = null;
  if (a.principal.kind === 'oauth_client') {
    const [row] = await tx.executeRaw<{ prefixes: unknown }>(`SELECT ${a.delegated ? 'delegated_slug_prefixes' : 'bound_slug_prefixes'} AS prefixes
      FROM oauth_clients WHERE client_id=$1`, [a.principal.id]);
    live = row?.prefixes ?? null;
  } else if (a.principal.kind === 'local_cli' || a.principal.kind === 'local_stdio') {
    const [row] = await tx.executeRaw<{ prefixes: unknown }>("SELECT grant_ceiling->'slugPrefixes' AS prefixes FROM persistence_local_writers WHERE id=$1::uuid", [a.principal.id]);
    live = row?.prefixes ?? null;
  }
  if (live != null) {
    const prefixes = Array.isArray(live) && live.every(value => typeof value === 'string') ? live as string[] : [];
    checks.push(slug => a.delegated ? matchesSlugAllowList(slug, prefixes) : slugUnderBoundPrefixes(prefixes, slug));
  }
  return slug => checks.every(check => check(slug));
}

/**
 * The `links` effect of a remote page write: reconciles the page's plain
 * mention edges (link_source `mcp-remote-mention`, origin = the page) against
 * the targets that exist at execution time, in the page's source, visible to
 * the writer and inside its slug grant. Only this producer's edges are added
 * or removed. A changed or deleted page, a revoked grant or a disabled config
 * finishes the effect as skipped with its reason. The links table carries no
 * writer guard or row attribution, so the source guard and the page keys of
 * the page and its targets are what serialize this with publications.
 */
export async function runLinksEffect(engine: BrainEngine, effect: PersistenceEffect, hostId: string): Promise<void> {
  const skip = (tx: SqlEngine, reason: string) => completeEffect(tx, effect, { links: 'skipped', reason });
  const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [effect.request_id]);
  if (!row || row.state !== 'committed' || !effect.data.slug) return skip(engine, 'invalid_write_request');
  if (effect.data.range) return runAppendLinksEffect(engine, effect, row, effect.data.range, hostId);
  const sourceId = effect.source_id;
  const snapshot = await engine.readPageSnapshot(effect.data.slug, { sourceId });
  if (!snapshot || snapshot.page.id !== effect.data.page_id || snapshot.revision !== effect.revision) return skip(engine, 'superseded');
  if (!await isAutoLinkEnabled(engine) || !await isRemoteAutoLinksEnabled(engine)) return skip(engine, 'disabled');
  const { targets, skipped } = await mentionTargets(engine, snapshot, sourceId);
  const beliefs = unmanagedBeliefPoint(sourceId, [snapshot.page.slug], 'remote_auto_links');
  await engine.transaction(async tx => {
    const live = await lockedPage(tx, effect, row, snapshot, targets, hostId);
    if (!live) return;
    if (live.revision !== snapshot.revision) { await skip(tx, 'superseded'); return; }
    const { wanted, owned, hidden } = await writableTargets(tx, row, live, targets, skipped);
    const obsolete = owned.filter(link => !wanted.has(link.slug)).map(link => link.id);
    const kept = new Set(owned.map(link => link.slug));
    const additions = mentionEdges(live.page.slug, sourceId, wanted, kept);
    const added = await beliefs.run(tx, async () => {
      if (obsolete.length) await tx.executeRaw('DELETE FROM links WHERE id=ANY($1::bigint[])', [obsolete]);
      return additions.length ? await tx.addLinksBatch(additions, { auditSite: 'addLinksBatch' }) : 0;
    });
    // Wanted pages: a missing mention target is recorded so the edge appears once that page is written (core/wanted-links.ts).
    if (await isRemoteWantedPagesEnabled(tx)) {
      await replaceWantedLinks(tx, { pageId: Number(live.page.id), sourceId }, { producers: ['body'], rows: skipped
        .filter(target => target.reason === 'missing' && !hidden.has(target.slug))
        .map(target => ({ producer: 'body', ref_kind: 'slug', target_source_id: sourceId, target_ref: target.slug,
          link_type: 'mentions', context: (targets.get(target.slug) ?? '').slice(0, 240) })) });
    }
    await completeEffect(tx, effect, linksOutcome(added, obsolete.length, skipped));
  });
  await beliefs.commit(engine);
}

/**
 * #7122: the `links` effect of a remote append_page reads only the truth bytes the append added (`data.range`), as
 * the writer may read them, and adds plain mention edges to the pages that exist, are visible to the writer and are
 * inside its grant, exactly as runLinksEffect does. It never removes an edge or replaces wanted rows: the rest of the
 * page was not read. A later write moves the revision but leaves the appended bytes in place unless it rewrote them, so
 * at a later revision the effect still runs when those bytes hash as appended, and is skipped as superseded otherwise
 * (a remote rewrite's own effect reconciles the whole page). A write that lands between the read and the page lock is
 * decided the same way under the lock, once: the effect never retries because the page moved.
 */
async function runAppendLinksEffect(engine: BrainEngine, effect: PersistenceEffect, row: WriteRequest, range: AppendedRange, hostId: string): Promise<void> {
  const skip = (tx: SqlEngine, reason: string) => completeEffect(tx, effect, { links: 'skipped', reason });
  const sourceId = effect.source_id;
  const snapshot = await engine.readPageSnapshot(effect.data.slug!, { sourceId });
  if (!snapshot || snapshot.page.id !== effect.data.page_id) return skip(engine, 'superseded');
  if (!await isAutoLinkEnabled(engine) || !await isRemoteAutoLinksEnabled(engine)) return skip(engine, 'disabled');
  const audience: BodyAudience = row.authority.remote ? 'remote' : 'trusted';
  const text = await appendedText(engine, snapshot, range, snapshot.revision !== effect.revision, audience);
  if (text === null) return skip(engine, 'superseded');
  const { page } = snapshot;
  const { candidates } = await extractPageLinks(page.slug, text, {}, page.type, makeResolver(engine, { mode: 'live', sourceId }), await mentionOptions(engine));
  const { targets, skipped } = mentionCandidates(candidates, page.slug, sourceId);
  const beliefs = unmanagedBeliefPoint(sourceId, [page.slug], 'remote_auto_links');
  await engine.transaction(async tx => {
    const live = await lockedPage(tx, effect, row, snapshot, targets, hostId);
    if (!live) return;
    // Another write (on a busy log, another append) landed between the read and the page lock, which now holds writers off:
    // the range is read again at the live revision and applies only when it still reads as before, so the effect never retries.
    if (live.revision !== snapshot.revision && await appendedText(tx, live, range, true, audience) !== text) { await skip(tx, 'superseded'); return; }
    const { wanted, owned } = await writableTargets(tx, row, live, targets, skipped);
    const additions = mentionEdges(live.page.slug, sourceId, wanted, new Set(owned.map(link => link.slug)));
    const added = await beliefs.run(tx, async () => additions.length ? await tx.addLinksBatch(additions, { auditSite: 'addLinksBatch' }) : 0);
    await completeEffect(tx, effect, linksOutcome(added, 0, skipped));
  });
  await beliefs.commit(engine);
}

/**
 * The appended truth bytes [start, end) as `audience` reads them; null when the stored bytes there no longer hash as
 * appended. A segmented range is hash-checked only with `verify` (the page moved since the append: the splice's offsets
 * are exact); an inline one always, since it is in memory and publication may have rewritten bytes before it. A segmented page is read through readBodyRange, which loads
 * only the segments the range overlaps (the remote audience gets the read projection: protected, private and withdrawn
 * text never reaches it). An inline truth (bounded by the inline threshold) is read raw, as the append stored it; its
 * protected regions are found over the whole truth and cut out of the range before the remote sanitizer.
 */
async function appendedText(engine: BrainEngine, snapshot: PageSnapshot, range: AppendedRange, verify: boolean, audience: BodyAudience): Promise<string | null> {
  const { page } = snapshot;
  if (isSegmentedPage(page)) {
    const body = await openSegmentedBody(engine, { pageId: Number(page.id), pin: { revision: snapshot.revision } });
    const read = async (as: BodyAudience) => {
      const parts: Buffer[] = [];
      for await (const piece of readBodyRange(engine, { pageId: body.pageId, space: 'stored', start: range.start, end: range.end, audience: as, region: 'truth', body })) parts.push(piece.bytes);
      return Buffer.concat(parts);
    };
    if (verify && sha256Hex(await read('trusted')) !== range.sha256) return null;
    const text = (await read(audience)).toString('utf8');
    await confirmBodyPin(engine, body);
    return text;
  }
  const truth = Buffer.from((await inlineRegions(engine, Number(page.id))).truth, 'utf8');
  if (sha256Hex(truth.subarray(range.start, range.end)) !== range.sha256) return null;
  if (audience === 'trusted') return truth.subarray(range.start, range.end).toString('utf8');
  const text = truth.toString('utf8');
  const from = truth.subarray(0, range.start).toString('utf8').length;
  const { regions, truncatedAt } = protectedRegions(text, PROTECTED_PAIRS);
  const to = Math.min(truth.subarray(0, range.end).toString('utf8').length, truncatedAt === -1 ? Infinity : truncatedAt);
  let visible = '';
  let at = from;
  for (const region of regions) {
    if (region.end <= at) continue;
    if (region.start >= to) break;
    if (region.start > at) visible += text.slice(at, region.start);
    at = region.end;
  }
  if (at < to) visible += text.slice(at, to);
  return sanitizeRemoteBody(visible);
}

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * The effect's transaction up to its page check: source guard, the stored request's authority (a revoked grant
 * finishes the effect as skipped), the page keys of the page and its targets, and the claim. Returns the live page,
 * or null when the effect finished or lost its claim.
 */
async function lockedPage(tx: BrainEngine, effect: PersistenceEffect, row: WriteRequest, snapshot: PageSnapshot, targets: Map<string, string>, hostId: string): Promise<PageSnapshot | null> {
  const skip = (reason: string) => completeEffect(tx, effect, { links: 'skipped', reason });
  const sourceId = effect.source_id;
  await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
  await guardEffectSource(tx, effect, hostId);
  try { await authorizeStoredRequest(tx, row, true); }
  catch (error) {
    if (error instanceof OperationError && ['permission_denied', 'source_changed', 'page_not_found'].includes(error.code)) { await skip(error.code); return null; }
    throw error;
  }
  await tx.lockPageKeys([{ sourceId, slug: snapshot.page.slug }, ...[...targets.keys()].map(slug => ({ sourceId, slug }))]);
  const [current] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [effect.id]);
  if (!current || current.state !== 'running' || current.execution_token !== effect.execution_token) return null;
  const live = await tx.readPageSnapshot(snapshot.page.slug, { sourceId });
  if (!live || live.page.id !== snapshot.page.id) { await skip('superseded'); return null; }
  return live;
}

/**
 * The targets that get an edge: existing pages of the source, visible to the writer (a remote writer that excludes
 * private pages never links one) and inside its slug grant; the rest are added to `skipped` with the reason. A page
 * the writer may not read under the member-access part (GBRA-218; no operator hatch relaxes it) is skipped as
 * `missing`, so the receipt cannot tell it from an absent page, and is returned in `hidden` so it is never recorded
 * as wanted. Also the edges this producer already owns from the page.
 */
async function writableTargets(tx: BrainEngine, row: WriteRequest, live: PageSnapshot, targets: Map<string, string>, skipped: SkippedLinkTarget[]) {
  const sourceId = live.page.source_id;
  const hidePrivate = row.authority.remote && ((row.authority.excludePrivate ?? true) || await excludesPrivateWrites(tx, true));
  const readable = row.authority.remote && targets.size ? await writerReadPolicySql(tx, row.authority, 'p', false) : 'TRUE';
  const existing = targets.size ? await tx.executeRaw<{ slug: string; readable: boolean; visible: boolean }>(`SELECT p.slug,(${readable}) AS readable,
    (${privacyPartSql('p')}) AS visible
    FROM pages p WHERE p.source_id=$1 AND p.slug=ANY($2::text[]) AND p.deleted_at IS NULL`, [sourceId, [...targets.keys()]]) : [];
  const found = new Map(existing.filter(page => page.readable).map(page => [page.slug, page.visible]));
  const hidden = new Set(existing.filter(page => !page.readable).map(page => page.slug));
  const granted = await targetGrant(tx, row.authority);
  const wanted = new Map<string, string>();
  for (const [slug, context] of targets) {
    const reason = !found.has(slug) ? 'missing' : hidePrivate && !found.get(slug) ? 'not_visible' : !granted(slug) ? 'outside_grant' : null;
    if (reason) skipped.push({ slug, reason });
    else wanted.set(slug, context);
  }
  const owned = await tx.executeRaw<{ id: number; slug: string }>(`SELECT l.id,t.slug FROM links l JOIN pages t ON t.id=l.to_page_id
    WHERE l.link_source=$1 AND l.origin_page_id=$2`, [REMOTE_MENTION_LINK_SOURCE, live.page.id]);
  return { wanted, owned, hidden };
}

/** Plain `mentions` edges from the page to each wanted target it does not already have from this producer. */
function mentionEdges(slug: string, sourceId: string, wanted: Map<string, string>, kept: Set<string>): LinkBatchInput[] {
  return [...wanted].filter(([target]) => !kept.has(target)).map(([target, context]) => ({
    from_slug: slug, to_slug: target, from_source_id: sourceId, to_source_id: sourceId, link_type: 'mentions', context,
    link_source: REMOTE_MENTION_LINK_SOURCE, link_kind: 'plain', origin_slug: slug, origin_source_id: sourceId }));
}

function linksOutcome(added: number, removed: number, skipped: SkippedLinkTarget[]): Record<string, unknown> {
  return { links: 'committed', added, removed, skipped_targets: skipped.slice(0, SKIPPED_TARGET_LIMIT),
    ...(skipped.length > SKIPPED_TARGET_LIMIT ? { skipped_target_count: skipped.length } : {}) };
}
