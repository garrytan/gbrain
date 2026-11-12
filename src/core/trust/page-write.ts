/**
 * Trust on journaled page writes (#5575: A3, CEO-12, CEO-21, ENG-1), used by
 * persistence/page-prepare.ts.
 *
 * - The page's tier is the request's channel tier lowered by the page's own
 *   frontmatter markers (they can only lower).
 * - CEO-21: an ordinary content write below operator_curated stamps the
 *   lower-only `trust_tier` marker into the frontmatter it publishes, at the
 *   lower of the write's tier and the page's stored tier (an unclassified
 *   `unknown` row does not lower it, #6550), so the tier survives
 *   the git round trip (sync honors it; an owner restamp needs the marker gone).
 *   #7905: a derived page a maintenance job publishes (`submit_job` with a
 *   derivation declaration: patterns, concepts, claim-source rewrites) authors
 *   its content too, so it stamps the marker at its declared tier.
 * - ENG-1: gbrain-managed fence edits (remember / takes fence appends, proposal
 *   accept strikes, loop and relink maintenance) and add_timeline_entry rewrite
 *   the page body without authoring it, so the page keeps its stored tier
 *   (withTrustKeep); the fence or timeline row carries the writer's tier and
 *   is gated per row (CEO-27).
 * - CEO-12: an agent write that replaces the body of a higher-tier page lowers
 *   the page and files one `lower_page` trust proposal per page (later edits
 *   fold into it) with the prior owner version to revert to. #7917: so does a
 *   derived page publication that lowers a page.
 * - #7918: a derivation declaration that is present but unreadable (a malformed
 *   input, a missing origin) rates the write `unknown`, never the source default.
 * - GST-2518: a local content write below the page's label guard tier that widens
 *   a privacy label publishes with the stored labels kept (holdPrivacyLabels), and
 *   its `lower_page` proposal carries the labels it asked for; the owner's accept
 *   applies them (trust/page-handlers.ts).
 */
import type { BrainEngine } from '../engine.ts';
import { queuePageProjection } from '../page-state/projections.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { frontmatterTrustCaps, requestChannelTrust, stampTrustMarker } from './channel.ts';
import { declaredWriteTrust, readDerivationDeclaration } from './taint.ts';
import { insertTrustProposal, updatePendingTrustProposalAfter } from './proposals.ts';
import { propagateTierLowering } from './propagation.ts';
import { OWNER_TIER_FLOOR, compareTrust, effectiveWriteTrust, isTrustTier, maxTrust, minTrust, storedTrustTier, type TrustTier, type WriteTrust } from './tier.ts';
import { PRIVACY_ALIASES } from '../search/private-visibility.ts';
import { normalizeReaders } from '../access/principals.ts';
import { asciiLower } from '../edge-whitespace.ts';

/** Page writes that only edit a gbrain-managed fence (or strike a row) and keep the page's tier. */
const FENCE_EDIT_OPERATIONS = ['remember', 'takes_add', 'takes_update', 'takes_supersede', 'takes_resolve', 'takes_remove',
  'decide_proposal', 'loops_close', 'relink_facts', 'add_timeline_entry', 'add_link', 'remove_link', 'trust_release'];
/** Page writes whose caller supplies the page content: they stamp the marker and can lower the page (CEO-12). */
const CONTENT_OPERATIONS = ['put_page', 'capture', 'edit_page', 'append_page', 'revert_version', 'restore_page'];

export function isFenceEditWrite(row: Pick<WriteRequest, 'operation' | 'intent'>): boolean {
  return FENCE_EDIT_OPERATIONS.includes(row.operation) || row.intent?.kind === 'managed_facts_entity';
}

/** The write carries a derivation declaration, readable or not. */
const declaresDerivation = (intent: WriteRequest['intent'] | null | undefined) => intent?.derivation !== undefined && intent?.derivation !== null;

/** The declared tier of a derived write; `unknown` when the declaration is present but unreadable (#7918), undefined when absent. */
export function derivationWriteTrust(intent: WriteRequest['intent'] | null | undefined): WriteTrust | undefined {
  if (!declaresDerivation(intent)) return undefined;
  const derivation = readDerivationDeclaration(intent!.derivation);
  return derivation ? declaredWriteTrust(derivation) : effectiveWriteTrust({ channel: 'unknown', origin: { channel: 'derivation_unreadable' } });
}

/** The tier of one journaled page write, or undefined when the request's channel declares none. */
export function pageWriteTrust(row: Pick<WriteRequest, 'id' | 'operation' | 'authority' | 'intent'>, frontmatter: Record<string, unknown> | null | undefined): WriteTrust | undefined {
  // A managed derived page (atoms, synthesis, concepts, chronicle) carries its derivation declaration (trust/taint.ts).
  const channel = derivationWriteTrust(row.intent) ?? requestChannelTrust(row);
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

/**
 * CEO-21: the marker an ordinary content write stamps (in place); `stored` is the page's tier before the write.
 * #6550: a stored `unknown` means "not classified yet", not "known unverified", so it does not lower the
 * marker: the marker names the writer's tier and the row keeps min(writer, stored) until the backfill
 * classifies it. An explicit `trust_tier: unknown` already in the frontmatter still caps (stampTrustMarker).
 * #7873: an unclassified page's own lowering markers (`storedFrontmatter`, the page before the write) still cap the
 * marker, so a write that removes one (a `ingested_via: webhook` stamp) cannot raise the page when it is re-derived.
 * #7905: a derived page publication (a derivation declaration on a write that is not a fence edit) stamps it as a
 * content write does, so a re-read of the repository cannot rate model-written text at the source default.
 */
export function stampPageTrustMarker(row: Pick<WriteRequest, 'operation' | 'intent'>, frontmatter: Record<string, unknown>, trust: WriteTrust | undefined, stored: TrustTier | null,
  storedFrontmatter?: Record<string, unknown> | null): void {
  if (!trust || isFenceEditWrite(row)) return;
  if (!CONTENT_OPERATIONS.includes(row.operation) && !declaresDerivation(row.intent)) return;
  const prior = stored && stored !== 'unknown' ? [stored] : frontmatterTrustCaps(storedFrontmatter);
  const tier = minTrust(trust.tier, ...prior);
  const stamped = stampTrustMarker(frontmatter, tier);
  if (stamped !== frontmatter) frontmatter.trust_tier = stamped.trust_tier;
}

/** GST-2518: the privacy flag keys (visibility and its aliases) and the readers key a lower-tier write cannot widen alone. */
const PRIVACY_FLAG_KEYS = ['visibility', ...Object.keys(PRIVACY_ALIASES)];
const READERS_KEY = 'readable_by';

/** GST-2518: the labels a held write asked to change: the stored values the page kept and the requested ones (null: absent). */
export interface HeldPrivacyLabels { keys: string[]; kept: Record<string, unknown>; requested: Record<string, unknown> }

/** The held labels a lower_page proposal's after_state carries, or null. */
export function heldPrivacyLabels(state: Record<string, unknown> | null | undefined): HeldPrivacyLabels | null {
  const labels = state?.labels as HeldPrivacyLabels | undefined;
  return labels && Array.isArray(labels.keys) && labels.keys.length && typeof labels.kept === 'object' && typeof labels.requested === 'object' ? labels : null;
}

/** GST-2518: held labels for a person, e.g. `visibility private -> (none)`. */
export function heldLabelsText(labels: HeldPrivacyLabels): string {
  const show = (value: unknown) => value === null || value === undefined ? '(none)' : Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
  return labels.keys.map(key => `${key} ${show(labels.kept[key])} -> ${show(labels.requested[key])}`).join(', ');
}

/** Private by the page's own labels: `visibility: private`, or with no visibility a privacy alias. Independent of visibility.honor_aliases. */
function labelledPrivate(frontmatter: Record<string, unknown>): boolean {
  if (frontmatter.visibility != null) return frontmatter.visibility === 'private';
  return Object.entries(PRIVACY_ALIASES).some(([key, values]) => typeof frontmatter[key] === 'string' && values.includes(asciiLower((frontmatter[key] as string).trim())));
}

/** The incoming readers let someone in that the stored readers did not (none named reads as everyone). */
function readersWidened(stored: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  const before = normalizeReaders(stored);
  if (before === null) return false;
  const after = normalizeReaders(incoming);
  return after === null || after.some(reader => !before.includes(reader));
}

/**
 * GST-2518: the label guard tier when a write must keep the page's privacy labels, else null. It applies to a local content
 * write below operator_curated over a page that is private by its labels or names readers, when the write is below the
 * guard: the stored tier, raised to the prior tier of the page's newest `lower_page` proposal unless the owner accepted it
 * (pending, dismissed, reverted or undone). So an earlier lowering edit, or a rejected or undone widening, does not let an
 * equal-tier write widen the page. Other writes send no query.
 */
export async function privacyLabelGuard(engine: BrainEngine, row: Pick<WriteRequest, 'operation' | 'intent' | 'authority'>, trust: WriteTrust | undefined,
  page: { id: number; frontmatter?: Record<string, unknown> | null } | null, stored: TrustTier | null): Promise<TrustTier | null> {
  if (!trust || !page || !stored || row.authority?.remote === true || !CONTENT_OPERATIONS.includes(row.operation) || isFenceEditWrite(row)
    || compareTrust(trust.tier, OWNER_TIER_FLOOR) >= 0) return null;
  const labels = page.frontmatter ?? {};
  if (!labelledPrivate(labels) && normalizeReaders(labels) === null) return null;
  const [newest] = await engine.executeRaw<{ status: string; prior: string | null }>(`SELECT status, before_state->>'prior_tier' AS prior FROM trust_proposals
    WHERE target_table = 'pages' AND target_id = $1 AND action = 'lower_page' ORDER BY id DESC LIMIT 1`, [Number(page.id)]);
  const guard = newest && newest.status !== 'accepted' && isTrustTier(newest.prior) ? maxTrust(stored, newest.prior) : stored;
  return compareTrust(trust.tier, guard) < 0 ? guard : null;
}

/**
 * GST-2518: in place, puts back the stored labels `frontmatter` would widen: the visibility and alias keys when the stored
 * page is private by them and the incoming one is not, and readable_by when the incoming readers let anyone new in.
 * A narrowing of the other kind is kept. Returns what was kept and asked for, or null when nothing widened.
 */
export function holdPrivacyLabels(frontmatter: Record<string, unknown>, stored: Record<string, unknown> | null | undefined): HeldPrivacyLabels | null {
  if (!stored) return null;
  const guarded = [...(labelledPrivate(stored) && !labelledPrivate(frontmatter) ? PRIVACY_FLAG_KEYS : []), ...(readersWidened(stored, frontmatter) ? [READERS_KEY] : [])];
  const keys = guarded.filter(key => JSON.stringify(stored[key] ?? null) !== JSON.stringify(frontmatter[key] ?? null));
  if (!keys.length) return null;
  const held: HeldPrivacyLabels = { keys, kept: {}, requested: {} };
  for (const key of keys) {
    held.kept[key] = stored[key] ?? null;
    held.requested[key] = frontmatter[key] ?? null;
    if (stored[key] === undefined) delete frontmatter[key];
    else frontmatter[key] = stored[key];
  }
  return held;
}

/** `frontmatter` with `labels` applied: a null value removes the key. */
export function withLabels(frontmatter: Record<string, unknown>, labels: Record<string, unknown>): Record<string, unknown> {
  const out = { ...frontmatter };
  for (const [key, value] of Object.entries(labels)) {
    if (value === null || value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * CEO-12, inside the publication transaction after the page write: when the
 * write lowered a page's tier, file (or refresh) its `lower_page` proposal.
 * `prior` is the tier and revision read under the page lock before the write.
 * Content writes and derived page publications (#7917) file it; another writer
 * that lowers a page on purpose names itself in `proposer`. GST-2518: `labels` (a held write's, with `prior` at the label
 * guard tier) ride the after state, and a later write's after state without them withdraws them.
 */
export async function recordAgentPageLowering(tx: BrainEngine, row: Pick<WriteRequest, 'operation' | 'source_id' | 'slug'> & { intent?: WriteRequest['intent'] | null },
  prior: { tier: TrustTier; revision: string | null } | null, proposer?: string, labels?: HeldPrivacyLabels | null): Promise<{ proposal_ref: string } | null> {
  const derived = !CONTENT_OPERATIONS.includes(row.operation) && declaresDerivation(row.intent);
  if (!prior || !(proposer || CONTENT_OPERATIONS.includes(row.operation) || derived)) return null;
  const snapshot = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  const [page] = snapshot ? await tx.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE id = $1', [snapshot.page.id]) : [];
  if (!snapshot || !page) return null;
  const pageId = Number(snapshot.page.id);
  const after = { tier: storedTrustTier(page.trust_tier), revision: snapshot.revision, ...(labels ? { labels } : {}) };
  if (compareTrust(after.tier, prior.tier) >= 0) {
    // A later edit of an already-lowered page folds into its pending item (ENG-22): the revert binds to the newest revision.
    const [pending] = await tx.executeRaw<{ id: number }>(`SELECT id FROM trust_proposals WHERE status = 'pending' AND action = 'lower_page'
      AND target_table = 'pages' AND target_id = $1 LIMIT 1`, [pageId]);
    if (pending) {
      await updatePendingTrustProposalAfter(tx, Number(pending.id), after);
      return { proposal_ref: `tp${pending.id}` };
    }
    // GST-2518: held labels reach the owner even when the write did not lower the page.
    if (!labels) return null;
  } else {
    // W1 #6783 §12 (b): rows derived from the page follow it down.
    await propagateTierLowering(tx, [{ table: 'pages', id: pageId }]);
  }
  // GST-2518: a held write that changed nothing has no edit to revert.
  const [version] = snapshot.revision === prior.revision ? [] : await tx.executeRaw<{ id: number }>(
    'SELECT id FROM page_versions WHERE page_id = $1 AND trust_tier = $2 ORDER BY id DESC LIMIT 1', [pageId, prior.tier]);
  const proposal = await insertTrustProposal(tx, {
    action: 'lower_page', sourceId: row.source_id, target: { table: 'pages', id: pageId }, proposer: proposer ?? (derived ? `derived_page:${row.operation}` : `agent_page_edit:${row.operation}`),
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
