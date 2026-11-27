/**
 * Guest notes, slice 4 (GBRA-504, decision J1): the brain owner keeps a guest note as an owner page.
 *
 * promote_guest_note (CLI: gbrain guests promote) runs only for the owner: the trusted local CLI outside
 * enforced-member mode and outside an --as preview, or a remote or stdio caller that reads as the owner (bound to
 * config access.owner_member, speaking for no one else). Everyone else is refused guest_promotion_owner_only before
 * anything is read. The owner page is a normal put_page through the caller's own write path (git first where the target
 * source has a repository, database-only where it has none), carrying the guest note's type, title, body and readers
 * plus 'promoted_from: <guest source>:<slug>' for people reading it. The link itself lives in guest_promotions (one row
 * per guest page and target; a link whose target page was purged no longer counts as kept, and promoting again rewrites
 * the page and that one link), which
 * guest rows read as guest.promoted (guests/marker.ts), and which refuses the broker's delete of the note
 * (guests/admission.ts refuseRemoteGuestDelete). The guest page and its mark are never changed.
 */
import { normalizeSlug } from '../utils.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { federatedSearchScope } from '../ops/context.ts';
import { serializeMarkdown } from '../markdown.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import { currentCallerAccess } from '../search/private-visibility.ts';
import type { PageType } from '../types.ts';
import type { BrainEngine } from '../engine.ts';

const DOCS = 'docs/guides/write-refusals.md#guest_promotion_owner_only';

export function guestPromotionOwnerOnly(slug: unknown): OperationError {
  const command = typeof slug === 'string' && slug.trim() ? 'gbrain guests promote ' + slug.trim().toLowerCase() : 'gbrain guests promote with the note\'s slug';
  return new OperationError('guest_promotion_owner_only', 'Only the brain owner can keep a guest note as an owner page, so nothing was read or written.',
    'Do not retry. Ask the brain owner; if they want to keep the note, they run ' + command + ' on the brain host.', DOCS);
}

/**
 * The owner, and only the owner, may promote (see the module comment). Enforced-member mode never reaches here as a
 * trusted local caller: its gate (cli/enforced-member-classes.ts) refuses gbrain guests and promote_guest_note.
 */
export function isGuestPromotionOwner(ctx: Pick<OperationContext, 'remote' | 'viaSubagent' | 'accessIdentity' | 'applyRemoteReadPolicy'>): boolean {
  if (ctx.viaSubagent) return false;
  if (ctx.remote === false) return !ctx.applyRemoteReadPolicy && !ctx.accessIdentity?.length;
  const access = currentCallerAccess();
  return access.owner === true && !access.actor;
}

const text = (value: unknown, name: string, required = false): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new OperationError('invalid_params', name + ' must be a non-empty string.', 'Pass ' + name + ' as a page slug or source id.');
  return value.trim();
};

async function guestNote(ctx: OperationContext, slug: string, guestSource: string | undefined): Promise<{ id: number; source_id: string }> {
  const rows = await ctx.engine.listGuestNotes(slug, guestSource);
  const scope = ctx.remote === false ? null : federatedSearchScope(ctx, guestSource);
  const readable = scope ? scope.sourceIds ?? (scope.sourceId !== undefined ? [scope.sourceId] : null) : null;
  const found = rows.filter(r => !readable || readable.includes(r.source_id));
  if (!found.length) {
    throw new OperationError('page_not_found', 'No live guest note ' + slug + (guestSource ? ' in source ' + guestSource : '') + ' is visible here, so nothing was promoted.',
      'Pass the slug of a page in a guest source (find_pages or gbrain guests promote --help); a deleted note is restored by the brain owner first.');
  }
  if (found.length > 1) {
    throw new OperationError('invalid_params', 'Guest note ' + slug + ' exists in several guest sources (' + found.map(r => r.source_id).join(', ') + ').',
      'Pass guest_source naming the one to promote.');
  }
  return { id: Number(found[0]!.id), source_id: found[0]!.source_id };
}

/**
 * Records the promotion link: relinks the one row for this guest page and target, else inserts it. A concurrent
 * promotion that inserted the same link first keeps its row (ON CONFLICT on guest_promotions_link_key, v314), so the
 * second call succeeds instead of failing on the unique key after its page was written.
 */
export async function linkGuestPromotion(engine: Pick<BrainEngine, 'executeRaw'>, link: { guestPageId: number; targetSource: string; targetSlug: string;
  by: { kind: string; id: string }; requestId: string | null }): Promise<void> {
  await engine.executeRaw(`WITH relinked AS (UPDATE guest_promotions SET promoted_by_kind = $4, promoted_by_id = $5, promoted_at = now(), request_id = $6
      WHERE guest_page_id = $1 AND target_source_id = $2 AND target_slug = $3 RETURNING id)
    INSERT INTO guest_promotions (guest_page_id, target_source_id, target_slug, promoted_by_kind, promoted_by_id, request_id)
    SELECT $1, $2, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM relinked) ON CONFLICT DO NOTHING`,
    [link.guestPageId, link.targetSource, link.targetSlug, link.by.kind, link.by.id, link.requestId]);
}

export async function promoteGuestNote(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isGuestPromotionOwner(ctx)) throw guestPromotionOwnerOnly(p.slug);
  const slug = text(p.slug, 'slug', true)!.toLowerCase();
  const note = await guestNote(ctx, slug, text(p.guest_source, 'guest_source'));
  const { pageMutationSource, submitPageMutation, requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
  const targetSource = pageMutationSource(ctx, { source_id: p.source_id }, 'put_page');
  if ((await ctx.engine.executeRaw('SELECT 1 FROM guest_sources WHERE source_id = $1', [targetSource])).length) {
    throw new OperationError('invalid_params', 'Source ' + targetSource + ' is a guest source; a promoted note becomes an owner page in an owner source.',
      'Pass source_id naming one of your own sources, or omit it to use your write source.');
  }
  const target = normalizeSlug(text(p.to, 'to') ?? slug);
  const result = { guest: { source_id: note.source_id, slug }, page: { source_id: targetSource, slug: target } };
  const [kept] = await ctx.engine.executeRaw(`SELECT 1 FROM guest_promotions g WHERE g.guest_page_id = $1 AND g.target_source_id = $2 AND g.target_slug = $3
    AND EXISTS (SELECT 1 FROM pages t WHERE t.source_id = g.target_source_id AND t.slug = g.target_slug)`, [note.id, targetSource, target]);
  if (kept) return { status: 'already_promoted', ...result };
  const page = await ctx.engine.getPage(slug, { sourceId: note.source_id });
  if (!page) throw new OperationError('page_not_found', 'Guest note ' + slug + ' was deleted while it was promoted; nothing was written.', 'Ask the brain owner to restore it, then promote it again.');
  assertInlineBody(page, 'promote_guest_note');
  const readers = page.frontmatter?.readable_by;
  const content = serializeMarkdown({ ...(readers !== undefined ? { readable_by: readers } : {}), promoted_from: note.source_id + ':' + slug },
    page.compiled_truth ?? '', page.timeline ?? '', { type: page.type as PageType, title: page.title, tags: [] });
  if (ctx.dryRun) return { dry_run: true, status: 'would_promote', ...result };
  const link = async (requestId: unknown) => linkGuestPromotion(ctx.engine, { guestPageId: note.id, targetSource, targetSlug: target,
    by: await requestPrincipalForContext(ctx), requestId: typeof requestId === 'string' ? requestId : null });
  const written = await ctx.engine.getPage(target, { sourceId: targetSource });
  if (written?.frontmatter?.promoted_from === note.source_id + ':' + slug) {
    await link(null);
    return { status: 'promoted', ...result, recovered: true };
  }
  const params = { slug: target, content, source_id: targetSource, ...(typeof p.request_id === 'string' ? { request_id: p.request_id } : {}) };
  (await import('../persistence/page-visibility.ts')).assertSubmittedReaders(ctx.remote, target, content);
  const write = await submitPageMutation(ctx, { operation: 'put_page', params });
  await link(write.request_id);
  return { status: 'promoted', ...result, write };
}
