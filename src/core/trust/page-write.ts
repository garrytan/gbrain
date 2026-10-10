/**
 * Trust on journaled page writes (#5575: A3, CEO-12, CEO-21, ENG-1), used by
 * persistence/page-prepare.ts.
 *
 * - The page's tier is the request's channel tier lowered by the page's own
 *   frontmatter markers (they can only lower).
 * - CEO-21: an ordinary content write below operator_curated stamps the
 *   lower-only `trust_tier` marker into the frontmatter it publishes, at the
 *   lower of the write's tier and the page's stored tier, so the tier survives
 *   the git round trip (sync honors it; an owner restamp needs the marker gone).
 * - ENG-1: gbrain-managed fence edits (remember / takes fence appends, proposal
 *   accept strikes, loop and relink maintenance) and add_timeline_entry rewrite
 *   the page body without authoring it, so the page keeps its stored tier
 *   (withTrustKeep); the fence or timeline row carries the writer's tier and
 *   is gated per row (CEO-27).
 * - CEO-12: an agent write that replaces the body of a higher-tier page lowers
 *   the page and files one `lower_page` trust proposal per page (later edits
 *   fold into it) with the prior owner version to revert to.
 */
import type { BrainEngine } from '../engine.ts';
import { queuePageProjection } from '../page-state/projections.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { frontmatterTrustCaps, requestChannelTrust, stampTrustMarker } from './channel.ts';
import { declaredWriteTrust, readDerivationDeclaration } from './taint.ts';
import { insertTrustProposal, updatePendingTrustProposalAfter } from './proposals.ts';
import { OWNER_TIER_FLOOR, compareTrust, effectiveWriteTrust, minTrust, storedTrustTier, type TrustTier, type WriteTrust } from './tier.ts';

/** Page writes that only edit a gbrain-managed fence (or strike a row) and keep the page's tier. */
const FENCE_EDIT_OPERATIONS = ['remember', 'takes_add', 'takes_update', 'takes_supersede', 'takes_resolve', 'takes_remove',
  'decide_proposal', 'loops_close', 'relink_facts', 'add_timeline_entry'];
/** Page writes whose caller supplies the page content: they stamp the marker and can lower the page (CEO-12). */
const CONTENT_OPERATIONS = ['put_page', 'capture', 'edit_page', 'revert_version', 'restore_page'];

export function isFenceEditWrite(row: Pick<WriteRequest, 'operation' | 'intent'>): boolean {
  return FENCE_EDIT_OPERATIONS.includes(row.operation) || row.intent?.kind === 'managed_facts_entity';
}

/** The tier of one journaled page write, or undefined when the request's channel declares none. */
export function pageWriteTrust(row: Pick<WriteRequest, 'id' | 'operation' | 'authority' | 'intent'>, frontmatter: Record<string, unknown> | null | undefined): WriteTrust | undefined {
  // A managed derived page (atoms, synthesis, concepts, chronicle) carries its derivation declaration (trust/taint.ts).
  const derivation = readDerivationDeclaration(row.intent?.derivation);
  const channel = derivation ? declaredWriteTrust(derivation) : requestChannelTrust(row);
  if (!channel || isFenceEditWrite(row)) return channel;
  const caps = frontmatterTrustCaps(frontmatter);
  return caps.length ? effectiveWriteTrust({ channel: channel.tier, lowerTo: caps, origin: channel.origin ?? { channel: row.operation } }) : channel;
}

/**
 * The tier the page write gate assesses (ENG-18: the tier the page row ends
 * with): a writer below operator_curated cannot raise the page, so the gate
 * sees min(writer, stored). Fence edits are gated per row, not here.
 */
export function pageGateTrust(row: Pick<WriteRequest, 'operation' | 'intent'>, trust: WriteTrust | undefined, stored: TrustTier | null): WriteTrust | undefined {
  if (!trust || isFenceEditWrite(row)) return undefined;
  return stored && compareTrust(trust.tier, OWNER_TIER_FLOOR) < 0 ? { ...trust, tier: minTrust(trust.tier, stored) } : trust;
}

export async function storedPageTier(engine: BrainEngine, sourceId: string, slug: string): Promise<TrustTier | null> {
  const [row] = await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return row ? storedTrustTier(row.trust_tier) : null;
}

/** CEO-21: the marker an ordinary content write stamps (in place); `stored` is the page's tier before the write. */
export function stampPageTrustMarker(row: Pick<WriteRequest, 'operation'>, frontmatter: Record<string, unknown>, trust: WriteTrust | undefined, stored: TrustTier | null): void {
  if (!trust || !CONTENT_OPERATIONS.includes(row.operation)) return;
  const tier = stored ? minTrust(trust.tier, stored) : trust.tier;
  const stamped = stampTrustMarker(frontmatter, tier);
  if (stamped !== frontmatter) frontmatter.trust_tier = stamped.trust_tier;
}

/**
 * CEO-12, inside the publication transaction after the page write: when the
 * write lowered a page's tier, file (or refresh) its `lower_page` proposal.
 * `prior` is the tier and revision read under the page lock before the write.
 */
export async function recordAgentPageLowering(tx: BrainEngine, row: Pick<WriteRequest, 'operation' | 'source_id' | 'slug'>,
  prior: { tier: TrustTier; revision: string | null } | null): Promise<{ proposal_ref: string } | null> {
  if (!prior || !CONTENT_OPERATIONS.includes(row.operation)) return null;
  const snapshot = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  const [page] = snapshot ? await tx.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE id = $1', [snapshot.page.id]) : [];
  if (!snapshot || !page) return null;
  const pageId = Number(snapshot.page.id);
  const after = { tier: storedTrustTier(page.trust_tier), revision: snapshot.revision };
  if (compareTrust(after.tier, prior.tier) >= 0) {
    // A later edit of an already-lowered page folds into its pending item (ENG-22): the revert binds to the newest revision.
    const [pending] = await tx.executeRaw<{ id: number }>(`SELECT id FROM trust_proposals WHERE status = 'pending' AND action = 'lower_page'
      AND target_table = 'pages' AND target_id = $1 LIMIT 1`, [pageId]);
    if (!pending) return null;
    await updatePendingTrustProposalAfter(tx, Number(pending.id), after);
    return { proposal_ref: `tp${pending.id}` };
  }
  const [version] = await tx.executeRaw<{ id: number }>(
    'SELECT id FROM page_versions WHERE page_id = $1 AND trust_tier = $2 ORDER BY id DESC LIMIT 1', [pageId, prior.tier]);
  const proposal = await insertTrustProposal(tx, {
    action: 'lower_page', sourceId: row.source_id, target: { table: 'pages', id: pageId }, proposer: `agent_page_edit:${row.operation}`,
    before: { slug: row.slug, prior_tier: prior.tier, prior_revision: prior.revision, version_id: version ? Number(version.id) : null }, after,
  });
  if (!proposal.created) await updatePendingTrustProposalAfter(tx, proposal.id, after);
  return { proposal_ref: `tp${proposal.id}` };
}

/**
 * L1b contract: chunks render fence rows by their tier relative to the page's
 * (eligibility/fence-overlay.ts), so any tier change of a fact, take or page
 * queues the page's projection rebuild (re-chunk) in the same transaction.
 */
export async function queueTierProjection(tx: BrainEngine, table: 'facts' | 'takes' | 'pages', id: number): Promise<void> {
  const sql = table === 'facts' ? 'SELECT source_id, source_markdown_slug AS slug FROM facts WHERE id = $1 AND source_markdown_slug IS NOT NULL'
    : table === 'takes' ? 'SELECT p.source_id, p.slug FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = $1'
      : 'SELECT source_id, slug FROM pages WHERE id = $1';
  const [page] = await tx.executeRaw<{ source_id: string; slug: string }>(sql, [id]);
  if (page) await queuePageProjection(tx, page.source_id, page.slug, 'trust_tier_changed');
}
