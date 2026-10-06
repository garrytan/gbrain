import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { OperationError } from '../ops/contract.ts';
import { matchesSlugAllowList, slugUnderBoundPrefixes } from '../ops/context.ts';
import { extractPageLinks, isAutoLinkEnabled, isGlobalBasenameEnabled, makeResolver } from '../link-extraction.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { authorizeStoredRequest } from './authority.ts';
import { completeEffect } from './effect-journal.ts';
import { REMOTE_AUTO_LINKS_KEY, REMOTE_MENTION_LINK_SOURCE, type PersistenceEffect } from './effect-model.ts';
import { guardEffectSource } from './effect-recovery.ts';
import type { SqlEngine, WriteAuthority, WriteRequest } from './model.ts';
import { excludesPrivateWrites } from './page-visibility.ts';
import { isRemoteWantedPagesEnabled, replaceWantedLinks } from '../wanted-links.ts';

/** `mcp.remote_auto_links`: unset is on; false/0/no/off (any case) turns the remote `links` effect off. */
export async function isRemoteAutoLinksEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  const value = await engine.getConfig(REMOTE_AUTO_LINKS_KEY);
  return value == null || !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}

export type SkippedLinkTarget = { slug: string; reason: 'cross_source' | 'missing' | 'not_visible' | 'outside_grant' };
/** At most this many skipped targets are recorded on one effect outcome. */
const SKIPPED_TARGET_LIMIT = 50;

/**
 * Plain mention targets of a page body: markdown links, [[wikilinks]] and
 * page-path mentions in compiled_truth only. No frontmatter, no timeline
 * section, no schema-pack verbs; every edge is stored as an untyped `mentions`.
 */
async function mentionTargets(engine: BrainEngine, snapshot: PageSnapshot, sourceId: string) {
  const { page } = snapshot;
  const { candidates } = await extractPageLinks(page.slug, page.compiled_truth, {}, page.type,
    makeResolver(engine, { mode: 'live', sourceId }), { skipFrontmatter: true, pack: null, globalBasename: await isGlobalBasenameEnabled(engine) });
  const targets = new Map<string, string>();
  const skipped: SkippedLinkTarget[] = [];
  for (const candidate of candidates) {
    if (candidate.fromSlug || candidate.targetSlug === page.slug) continue;
    if (candidate.targetSourceId && candidate.targetSourceId !== sourceId) skipped.push({ slug: candidate.targetSlug, reason: 'cross_source' });
    else if (!targets.has(candidate.targetSlug)) targets.set(candidate.targetSlug, candidate.context);
  }
  return { targets, skipped };
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
  const sourceId = effect.source_id;
  const snapshot = await engine.readPageSnapshot(effect.data.slug, { sourceId });
  if (!snapshot || snapshot.page.id !== effect.data.page_id || snapshot.revision !== effect.revision) return skip(engine, 'superseded');
  if (!await isAutoLinkEnabled(engine) || !await isRemoteAutoLinksEnabled(engine)) return skip(engine, 'disabled');
  const { targets, skipped } = await mentionTargets(engine, snapshot, sourceId);
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    await guardEffectSource(tx, effect, hostId);
    try { await authorizeStoredRequest(tx, row, true); }
    catch (error) {
      if (error instanceof OperationError && ['permission_denied', 'source_changed', 'page_not_found'].includes(error.code)) { await skip(tx, error.code); return; }
      throw error;
    }
    await tx.lockPageKeys([{ sourceId, slug: snapshot.page.slug }, ...[...targets.keys()].map(slug => ({ sourceId, slug }))]);
    const [current] = await tx.executeRaw<PersistenceEffect>('SELECT * FROM persistence_effects WHERE id=$1 FOR UPDATE', [effect.id]);
    if (!current || current.state !== 'running' || current.execution_token !== effect.execution_token) return;
    const live = await tx.readPageSnapshot(snapshot.page.slug, { sourceId });
    if (!live || live.page.id !== snapshot.page.id || live.revision !== snapshot.revision) { await skip(tx, 'superseded'); return; }
    const hidePrivate = row.authority.remote && ((row.authority.excludePrivate ?? true) || await excludesPrivateWrites(tx, true));
    const existing = targets.size ? await tx.executeRaw<{ slug: string; visible: boolean }>(`SELECT p.slug,(${privatePagesFilterFragment('p')}) AS visible
      FROM pages p WHERE p.source_id=$1 AND p.slug=ANY($2::text[]) AND p.deleted_at IS NULL`, [sourceId, [...targets.keys()]]) : [];
    const visible = new Map(existing.map(page => [page.slug, page.visible]));
    const granted = await targetGrant(tx, row.authority);
    const wanted = new Map<string, string>();
    for (const [slug, context] of targets) {
      const reason = !visible.has(slug) ? 'missing' : hidePrivate && !visible.get(slug) ? 'not_visible' : !granted(slug) ? 'outside_grant' : null;
      if (reason) skipped.push({ slug, reason });
      else wanted.set(slug, context);
    }
    const owned = await tx.executeRaw<{ id: number; slug: string }>(`SELECT l.id,t.slug FROM links l JOIN pages t ON t.id=l.to_page_id
      WHERE l.link_source=$1 AND l.origin_page_id=$2`, [REMOTE_MENTION_LINK_SOURCE, live.page.id]);
    const obsolete = owned.filter(link => !wanted.has(link.slug)).map(link => link.id);
    const kept = new Set(owned.map(link => link.slug));
    const additions: LinkBatchInput[] = [...wanted].filter(([slug]) => !kept.has(slug)).map(([slug, context]) => ({
      from_slug: live.page.slug, to_slug: slug, from_source_id: sourceId, to_source_id: sourceId, link_type: 'mentions', context,
      link_source: REMOTE_MENTION_LINK_SOURCE, link_kind: 'plain', origin_slug: live.page.slug, origin_source_id: sourceId }));
    if (obsolete.length) await tx.executeRaw('DELETE FROM links WHERE id=ANY($1::bigint[])', [obsolete]);
    const added = additions.length ? await tx.addLinksBatch(additions, { auditSite: 'addLinksBatch' }) : 0;
    // Wanted pages: a missing mention target is recorded so the edge appears once that page is written (core/wanted-links.ts).
    if (await isRemoteWantedPagesEnabled(tx)) {
      await replaceWantedLinks(tx, { pageId: Number(live.page.id), sourceId }, { producers: ['body'], rows: skipped
        .filter(target => target.reason === 'missing')
        .map(target => ({ producer: 'body', ref_kind: 'slug', target_source_id: sourceId, target_ref: target.slug,
          link_type: 'mentions', context: (targets.get(target.slug) ?? '').slice(0, 240) })) });
    }
    await completeEffect(tx, effect, { links: 'committed', added, removed: obsolete.length, skipped_targets: skipped.slice(0, SKIPPED_TARGET_LIMIT),
      ...(skipped.length > SKIPPED_TARGET_LIMIT ? { skipped_target_count: skipped.length } : {}) });
  });
}
