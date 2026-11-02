/**
 * Owner page actions and the checked handler for `lower_page` trust proposals
 * (#5575: CEO-9, CEO-12, CEO-21, ENG-10, ENG-22).
 *
 * - Confirm a page: raise it to user_confirmed. When the page carries the
 *   lower-only `trust_tier` frontmatter marker (CEO-21), the marker is removed
 *   through the canonical page write path (a journaled `trust_owner_page`
 *   mutation on a managed brain, `importFromContent` otherwise) written at
 *   user_confirmed under the promotion capability; otherwise only the tier
 *   column changes.
 * - Revert a page to a version: restore that version's content and its
 *   snapshotted tier (page_versions.trust_tier; legacy versions read as
 *   `unknown`), bound to the page revision the owner approved.
 * - lower_page proposals (inserted by the CEO-12 guard when an agent write
 *   replaced a higher-tier page): accept = the owner endorses the edited page
 *   (confirm it); reject = dismiss, the page stays lowered; revert
 *   (`revertLoweredPage`) = restore the prior owner version's content and tier.
 * - #6550 marker repair (`repairPageMarker`, local CLI only): rewrite a page's
 *   `trust_tier: unknown` marker to its stored tier (removed at owner tiers);
 *   the row keeps its tier. trust/marker-repair.ts decides which pages.
 * - #7891 provenance restore (`restorePageProvenance`, local CLI only): put back
 *   the provenance stamps a remote write rewrote and the lowering marker it
 *   removed (trust/provenance-drift.ts decides), lower the page to match, and
 *   file a `lower_page` proposal so the owner sees it in `gbrain trust review`.
 *
 * Every function here runs after the caller established the owner's
 * confirmation (trust/confirm.ts); each re-checks the page revision it was
 * approved for and refuses with `preview_changed` when the page moved on.
 * Fence rows (facts, takes, timeline) keep their own tiers on these rewrites.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { queueTierProjection, recordAgentPageLowering } from './page-write.ts';
import { plannedDigest, readPageDrift } from './provenance-drift.ts';
import type { GBrainConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { Principal, WriteRequest } from '../persistence/model.ts';
import { serializeMarkdown, serializePageToMarkdown } from '../markdown.ts';
import type { PageType } from '../types.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import type { PageVersion } from '../page-state/version-types.ts';
import { maintenanceAttribution, principalAttribution, withWriteAttribution } from '../persistence/attribution.ts';
import { withCoordinatedWrite, withTrustKeep, withTrustPromotion } from '../persistence/context.ts';
import type { OwnerConfirmation } from './confirm.ts';
import { MEMORY_CONFIRM_SCOPE } from './confirm.ts';
import { pageRef } from './refs.ts';
import {
  decisionResult, registerTrustProposalHandler, transitionTrustProposal, type TrustProposalAction,
  type TrustDecisionContext, type TrustDecisionResult, type TrustProposalRow,
} from './proposals.ts';
import { OWNER_TIER_FLOOR, compareTrust, effectiveWriteTrust, minTrust, storedTrustTier, type TrustTier, type WriteTrust } from './tier.ts';
import { propagateTierLowering } from './propagation.ts';
import { beliefStreamSlugs, lockedBeliefBatch } from '../belief/writers.ts';
import { markBeliefCommits } from '../belief/append.ts';

/** The journaled operation that publishes an owner page action on a managed brain. */
export const TRUST_OWNER_PAGE_OPERATION = 'trust_owner_page';
/** The proposer a provenance restore's `lower_page` proposal names. */
export const PROVENANCE_PROPOSER = 'provenance_repair';
/** Fence projections keep their own tiers when an owner action rewrites the page around them. */
const FENCE_TABLES = ['facts', 'takes', 'timeline_entries'] as const;

export interface PageTrustState {
  pageId: number;
  sourceId: string;
  slug: string;
  tier: TrustTier;
  revision: string;
  hasMarker: boolean;
  snapshot: PageSnapshot;
}

/** The page as an owner action sees it: tier, revision and whether the CEO-21 marker is present. Null when absent or deleted. */
export async function readPageTrustState(engine: BrainEngine, sourceId: string, slug: string): Promise<PageTrustState | null> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot || snapshot.page.deleted_at) return null;
  const [row] = await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE id = $1', [snapshot.page.id]);
  return {
    pageId: snapshot.page.id, sourceId, slug, tier: storedTrustTier(row?.trust_tier), revision: snapshot.revision,
    hasMarker: Object.hasOwn(snapshot.page.frontmatter ?? {}, 'trust_tier'), snapshot,
  };
}

function changedSincePreview(ref: string, what: string): Error {
  return opError('preview_changed', `${ref} changed after you approved ${what}; nothing was changed.`,
    'Run the command again: it shows the page as it is now and asks for a new confirmation.');
}

/** The page with the CEO-21 marker removed (or set to `marker`), as canonical markdown. */
function markdownWithoutMarker(snapshot: PageSnapshot, marker: TrustTier | null = null): string {
  const { trust_tier: _marker, ...rest } = (snapshot.page.frontmatter ?? {}) as Record<string, unknown>;
  const frontmatter = marker ? { ...rest, trust_tier: marker } : rest;
  return serializeMarkdown(frontmatter, snapshot.page.compiled_truth ?? '', snapshot.page.timeline ?? '', {
    type: (snapshot.page.type as PageType) ?? 'note', title: snapshot.page.title ?? '', tags: snapshot.tags,
  });
}

/** One version's canonical markdown, the way revert_version restores it (page-prepare.ts). */
function versionMarkdown(snapshot: PageSnapshot, version: PageVersion): string {
  const page = { ...snapshot.page, compiled_truth: version.compiled_truth, frontmatter: version.frontmatter,
    ...(version.timeline != null ? { timeline: version.timeline } : {}),
    ...(version.title != null ? { title: version.title } : {}),
    ...(version.type != null ? { type: version.type as PageType } : {}) };
  return serializePageToMarkdown(page, version.tags ?? snapshot.tags);
}

export async function readPageVersion(engine: BrainEngine, pageId: number, versionId: number): Promise<(PageVersion & { trust_tier: string | null }) | null> {
  const [version] = await engine.executeRaw<PageVersion & { trust_tier: string | null }>(
    'SELECT * FROM page_versions WHERE id = $1 AND page_id = $2', [versionId, pageId]);
  return version ?? null;
}

/** The most recent version of a page (the content just before its latest archived write). */
export async function latestPageVersionId(engine: BrainEngine, pageId: number): Promise<number | null> {
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM page_versions WHERE page_id = $1 ORDER BY id DESC LIMIT 1', [pageId]);
  return row ? Number(row.id) : null;
}

const ownerTrust = (tier: TrustTier, channel: string, via: OwnerConfirmation['via']): WriteTrust =>
  effectiveWriteTrust({ channel: tier, origin: { channel: `owner:${channel}`, connector: via } });

async function managed(engine: BrainEngine): Promise<boolean> {
  const { managedPersistenceEnabled } = await import('../persistence/ownership.ts');
  return managedPersistenceEnabled(engine);
}

async function attributionFor(engine: BrainEngine, by: Principal | null | undefined) {
  return by ? principalAttribution(by) : maintenanceAttribution(engine);
}

/**
 * A tier-only change of one row (no content column changes), inside the
 * coordinator capability on a managed brain. Raising needs `ceiling`.
 */
export async function setRowTier(engine: BrainEngine, input: {
  table: 'facts' | 'takes' | 'pages'; id: number; sourceId: string; tier: TrustTier; ceiling?: TrustTier;
  expect?: (tx: BrainEngine) => Promise<boolean>; by?: Principal | null; note?: Record<string, unknown>;
  also?: (tx: BrainEngine, publicationId: string) => Promise<void>;
}): Promise<boolean> {
  const attribution = await attributionFor(engine, input.by);
  const enabled = await managed(engine);
  const publicationId = randomUUID();
  const report = { appended: 0 };
  const changed = await engine.transaction(async tx => {
    const run = async () => {
      if (input.expect && !(await input.expect(tx))) return false;
      const [prior] = await tx.executeRaw<{ trust_tier: string }>(`SELECT trust_tier FROM ${input.table} WHERE id = $1`, [input.id]);
      const update = () => tx.executeRaw<{ id: number }>(
        `UPDATE ${input.table} SET trust_tier = $2,
            write_origin = COALESCE(write_origin, '{}'::jsonb) || jsonb_build_object('owner_decision', $3::text::jsonb)
          WHERE id = $1 RETURNING id`, [input.id, input.tier, JSON.stringify({ tier: input.tier, at: new Date().toISOString(), publication_id: publicationId, ...input.note })]);
      const rows = input.ceiling ? await withTrustPromotion(tx, input.ceiling, update) : await update();
      if (rows.length !== 1) return false;
      await queueTierProjection(tx, input.table, input.id);
      // W1 #6783 §12 (b): a lowering reaches what was derived from the row; a raise never does.
      if (prior && compareTrust(input.tier, storedTrustTier(prior.trust_tier)) < 0) await propagateTierLowering(tx, [{ table: input.table, id: input.id }]);
      await input.also?.(tx, publicationId);
      return true;
    };
    // W1 #6783 §6.4: the tier change is recorded as trust.retiered in the row's stream, under its page key.
    const slugs = await beliefStreamSlugs(tx, input.table, [input.id]);
    const recorded = () => lockedBeliefBatch(tx, { sourceId: input.sourceId, slugs, publicationId, op: 'trust_set_tier', report,
      cause: { owner_decision: { tier: input.tier, ...input.note } } }, run);
    return enabled ? withCoordinatedWrite(tx, [input.sourceId], recorded, attribution) : withWriteAttribution(tx, attribution, recorded);
  });
  if (report.appended) await markBeliefCommits(engine, [publicationId]).catch(() => undefined);
  return changed;
}

export interface PageActionInput {
  sourceId: string;
  slug: string;
  /** The page revision the owner approved. */
  expectedRevision: string;
  confirmation: OwnerConfirmation;
  by?: Principal | null;
  config?: GBrainConfig;
  /** A lower_page proposal this action decides, closed in the same transaction. */
  proposal?: { id: number; to: 'accepted' | 'rejected'; after: Record<string, unknown> };
  /** The remote context of a memory_confirm caller (managed admission authority); local CLI otherwise. */
  ctx?: OperationContext;
}

export interface PageActionResult {
  status: 'confirmed' | 'reverted' | 'repaired' | 'restored' | 'unchanged';
  ref: string;
  tier: TrustTier;
  prior_tier: TrustTier;
  marker_removed?: boolean;
  version_id?: number;
}

type OwnerPageIntent = {
  mode: 'confirm' | 'revert' | 'repair_marker' | 'restore_provenance';
  expected_revision: string;
  version_id?: number;
  /** restore_provenance: the digest of the change the preview showed, and whether unattributed damage was included. */
  planned?: string;
  include_ambiguous?: boolean;
  via: OwnerConfirmation['via'];
  proposal?: PageActionInput['proposal'];
};

/** Closes a decided proposal inside the publication transaction, or refuses (it was decided meanwhile). */
async function closeProposal(tx: BrainEngine, proposal: PageActionInput['proposal'], by: Principal | null | undefined): Promise<void> {
  if (!proposal) return;
  if (!(await transitionTrustProposal(tx, proposal.id, 'pending', proposal.to, { after: proposal.after, decidedBy: by ?? null }))) {
    throw opError('preview_changed', `Trust proposal tp${proposal.id} was decided by someone else meanwhile; nothing was changed.`,
      'Run gbrain trust review to see its current state.');
  }
}

/** Raises a page to user_confirmed (removing the CEO-21 marker when present). */
export async function confirmPage(engine: BrainEngine, input: PageActionInput): Promise<PageActionResult> {
  const ref = pageRef(input.sourceId, input.slug);
  const state = await readPageTrustState(engine, input.sourceId, input.slug);
  if (!state) throw opError('page_not_found', `No live page ${ref}.`, 'Check the ref; gbrain trust review lists pages waiting for you.');
  if (state.revision !== input.expectedRevision) throw changedSincePreview(ref, 'its confirmation');
  if (state.tier === 'user_confirmed' && !state.hasMarker) {
    await engine.transaction(tx => closeProposal(tx, input.proposal, input.by));
    return { status: 'unchanged', ref, tier: state.tier, prior_tier: state.tier };
  }
  if (!state.hasMarker) {
    const ok = await setRowTier(engine, {
      table: 'pages', id: state.pageId, sourceId: input.sourceId, tier: 'user_confirmed', ceiling: 'user_confirmed', by: input.by,
      note: { via: input.confirmation.via, action: 'confirm' },
      expect: async tx => (await tx.readPageSnapshot(input.slug, { sourceId: input.sourceId }))?.revision === input.expectedRevision,
      also: tx => closeProposal(tx, input.proposal, input.by),
    });
    if (!ok) throw changedSincePreview(ref, 'its confirmation');
    return { status: 'confirmed', ref, tier: 'user_confirmed', prior_tier: state.tier, marker_removed: false };
  }
  await publishOwnerPage(engine, input, { mode: 'confirm', expected_revision: input.expectedRevision, via: input.confirmation.via, proposal: input.proposal },
    markdownWithoutMarker(state.snapshot), 'user_confirmed');
  return { status: 'confirmed', ref, tier: 'user_confirmed', prior_tier: state.tier, marker_removed: true };
}

/** #6550: the marker a repaired page carries: its stored tier, none at owner tiers (CEO-21 stamps none there). */
export const repairedMarker = (tier: TrustTier): TrustTier | null => compareTrust(tier, OWNER_TIER_FLOOR) >= 0 ? null : tier;

const ACTION_NAMES: Record<OwnerPageIntent['mode'], string> = { confirm: 'its confirmation', revert: 'the revert', repair_marker: 'the marker repair', restore_provenance: 'the provenance restore' };
/** Owner page modes only the trusted local CLI may run. */
const LOCAL_ONLY_MODES: ReadonlyArray<OwnerPageIntent['mode']> = ['repair_marker', 'restore_provenance'];

/** #6550: rewrites the page's marker to `repairedMarker(stored tier)`, bound to the previewed revision; the row keeps its tier. */
export async function repairPageMarker(engine: BrainEngine, input: PageActionInput): Promise<PageActionResult & { marker: TrustTier | null }> {
  const ref = pageRef(input.sourceId, input.slug);
  const state = await readPageTrustState(engine, input.sourceId, input.slug);
  if (!state) throw opError('page_not_found', `No live page ${ref}.`, 'Run gbrain trust backfill --repair-unknown-markers again to see the current candidates.');
  if (state.revision !== input.expectedRevision) throw changedSincePreview(ref, ACTION_NAMES.repair_marker);
  const marker = repairedMarker(state.tier);
  await publishOwnerPage(engine, input, { mode: 'repair_marker', expected_revision: input.expectedRevision, via: input.confirmation.via },
    markdownWithoutMarker(state.snapshot, marker), state.tier);
  return { status: 'repaired', ref, tier: state.tier, prior_tier: state.tier, marker };
}

/** The markdown and tier the provenance restore writes for a page now, refused when it is not the previewed change. */
async function plannedProvenanceRestore(engine: BrainEngine, state: PageTrustState, intent: Pick<OwnerPageIntent, 'planned' | 'include_ambiguous'>): Promise<{ content: string; tier: TrustTier }> {
  const item = await readPageDrift(engine, state.sourceId, state.slug, { includeAmbiguous: intent.include_ambiguous === true });
  const restore = item?.verdict.restore;
  if (!item || !restore || item.verdict.class === 'restamp' || plannedDigest(item) !== intent.planned) throw changedSincePreview(pageRef(state.sourceId, state.slug), ACTION_NAMES.restore_provenance);
  const { page } = state.snapshot;
  assertInlineBody(page, 'gbrain repair provenance');
  return { content: serializeMarkdown(restore.frontmatter, page.compiled_truth ?? '', page.timeline ?? '', {
    type: (page.type as PageType) ?? 'note', title: page.title ?? '', tags: state.snapshot.tags }), tier: minTrust(state.tier, restore.tier) };
}

/** #7891: restores the previewed provenance stamps and lowering marker, bound to the previewed revision and change; only lowers. */
export async function restorePageProvenance(engine: BrainEngine, input: PageActionInput & { planned: string; includeAmbiguous?: boolean }): Promise<PageActionResult> {
  const ref = pageRef(input.sourceId, input.slug);
  const state = await readPageTrustState(engine, input.sourceId, input.slug);
  if (!state) throw opError('page_not_found', `No live page ${ref}.`, 'Preview gbrain repair provenance again to see the current candidates.');
  if (state.revision !== input.expectedRevision) throw changedSincePreview(ref, ACTION_NAMES.restore_provenance);
  const intent: OwnerPageIntent = { mode: 'restore_provenance', expected_revision: input.expectedRevision, via: input.confirmation.via,
    planned: input.planned, include_ambiguous: input.includeAmbiguous === true };
  const { content, tier } = await plannedProvenanceRestore(engine, state, intent);
  await publishOwnerPage(engine, input, intent, content, tier);
  return { status: 'restored', ref, tier, prior_tier: state.tier };
}

/** The tier a version restores: its snapshot tier, `unknown` for legacy versions. */
export const versionTier = (version: { trust_tier?: string | null }): TrustTier => storedTrustTier(version.trust_tier);

/** Restores a version's content and its snapshotted tier. */
export async function revertPageToVersion(engine: BrainEngine, input: PageActionInput & { versionId: number }): Promise<PageActionResult> {
  const ref = pageRef(input.sourceId, input.slug);
  const state = await readPageTrustState(engine, input.sourceId, input.slug);
  if (!state) throw opError('page_not_found', `No live page ${ref}.`, `Check the ref; gbrain history ${input.slug} lists its versions.`);
  if (state.revision !== input.expectedRevision) throw changedSincePreview(ref, 'the revert');
  const version = await readPageVersion(engine, state.pageId, input.versionId);
  if (!version) throw opError('not_found', `Version ${input.versionId} is not in the history of ${ref}.`, `List the page's versions with gbrain history ${input.slug} and pass one of their ids to --version.`);
  const tier = versionTier(version);
  await publishOwnerPage(engine, input, { mode: 'revert', expected_revision: input.expectedRevision, version_id: input.versionId, via: input.confirmation.via, proposal: input.proposal },
    versionMarkdown(state.snapshot, version), tier);
  return { status: 'reverted', ref, tier, prior_tier: state.tier, version_id: input.versionId };
}

/**
 * Publishes an owner page write at `tier`. A content rewrite by an owner-tier
 * writer restamps the page (CEO-12); user_confirmed needs the promotion
 * ceiling, and a lower restored tier lowers it (min with the prior tier).
 */
async function publishOwnerPage(engine: BrainEngine, input: PageActionInput, intent: OwnerPageIntent, markdown: string, tier: TrustTier): Promise<void> {
  if (await managed(engine)) {
    await submitOwnerPage(engine, input, intent);
    return;
  }
  const { importFromContent } = await import('../import-file.ts');
  const attribution = await attributionFor(engine, input.by);
  const trust = ownerTrust(tier, intent.mode, intent.via);
  // A repair mode on an unmanaged checkout renders the repaired row to the page's file in the same transaction, so a
  // re-read of the checkout does not undo it; a file holding an edit the database lacks refuses the page instead.
  const file = LOCAL_ONLY_MODES.includes(intent.mode) ? await ownerRepairFile(engine, input.sourceId, input.slug) : null;
  if (file && !file.ok) {
    if (file.reason === 'file_database_drift') throw changedSincePreview(pageRef(input.sourceId, input.slug), ACTION_NAMES[intent.mode]);
    throw opError('unavailable', `The page file of ${pageRef(input.sourceId, input.slug)} cannot be written (${file.reason}); nothing was changed.`,
      'Fix the checkout (gbrain sources status), then preview the repair again.');
  }
  const writeThrough = file?.ok && file.target ? await import('../write-through.ts') : null;
  await engine.transaction(tx => withWriteAttribution(tx, { ...attribution, trust }, () => withTrustPromotion(tx, tier, () =>
    withTrustKeep(tx, FENCE_TABLES, async () => {
      if ((await tx.readPageSnapshot(input.slug, { sourceId: input.sourceId }))?.revision !== input.expectedRevision) {
        throw changedSincePreview(pageRef(input.sourceId, input.slug), ACTION_NAMES[intent.mode]);
      }
      // forceRechunk: the trust_tier marker is hash-ephemeral, so removing it alone would read as unchanged content.
      const prior = intent.mode === 'restore_provenance' ? await readPageTrustState(tx, input.sourceId, input.slug) : null;
      await importFromContent(tx, input.slug, markdown, { sourceId: input.sourceId, noEmbed: true, preserveGateMarkers: intent.mode !== 'revert', forceRechunk: true, allowEmptyOverwrite: intent.mode === 'revert' });
      if (prior) await recordAgentPageLowering(tx, { operation: TRUST_OWNER_PAGE_OPERATION, source_id: input.sourceId, slug: input.slug }, { tier: prior.tier, revision: prior.revision }, PROVENANCE_PROPOSER);
      if (writeThrough && file?.ok && file.target) {
        const written = await writeThrough.writePageThrough(tx, input.slug, { sourceId: input.sourceId, expectedFileBytes: file.target.expectedFileBytes });
        if (written.skipped === 'file_changed') throw changedSincePreview(pageRef(input.sourceId, input.slug), ACTION_NAMES[intent.mode]);
        if (!written.written) {
          throw opError('unavailable', `The page file of ${pageRef(input.sourceId, input.slug)} could not be written (${written.skipped ?? written.error}); nothing was changed.`,
            'Fix the checkout (gbrain sources status), then preview the repair again.');
        }
      }
      await closeProposal(tx, intent.proposal, input.by);
    }))));
}

/** Write-through outcomes that leave a repair database-only on purpose: no checkout, write-through off, an ignored or db_only target. */
const DATABASE_ONLY_TARGETS = ['no_repo_configured', 'disabled_by_config', 'not_canonical'];

/**
 * The checkout file an owner repair mode on an unmanaged brain renders the page to: `target: null` when the page has
 * none on purpose (DATABASE_ONLY_TARGETS), the bytes the write must still find, or why the page cannot be repaired:
 * `file_database_drift` when the file holds an edit the database lacks (a hand edit sync has not imported), else the
 * unresolvable target (a missing checkout, a path outside the source root) or `url_clone` (a clone gbrain pulls, whose
 * next pull would undo a database-only repair). Read-only.
 */
export async function ownerRepairFile(engine: BrainEngine, sourceId: string, slug: string):
  Promise<{ ok: true; target: { expectedFileBytes: string | null } | null } | { ok: false; reason: string }> {
  const { derivedFileTarget } = await import('../cycle/derived-write-through.ts');
  const resolved = await derivedFileTarget(engine, slug, sourceId);
  if (!resolved.ok) return DATABASE_ONLY_TARGETS.includes(resolved.skipped) ? { ok: true, target: null } : { ok: false, reason: resolved.skipped };
  const { urlCloneReadOnly } = await import('../url-clone.ts');
  if (await urlCloneReadOnly(engine, sourceId)) return { ok: false, reason: 'url_clone' };
  const { replaceableFile } = await import('../facts/file-body-guard.ts');
  const file = await replaceableFile(engine, sourceId, slug, resolved.target.filePath);
  return file.ok ? { ok: true, target: { expectedFileBytes: file.expectedFileBytes } } : { ok: false, reason: 'file_database_drift' };
}

/** Admits the journaled owner page mutation and waits for its publication (the decide_proposal precedent). */
async function submitOwnerPage(engine: BrainEngine, input: PageActionInput, intent: OwnerPageIntent): Promise<void> {
  const { initializeLocalPersistence, requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
  const { submissionAuthority } = await import('../persistence/authority.ts');
  const { admitWrite } = await import('../persistence/journal.ts');
  const { assertPersistenceAccepting, waitForWrite, writeResponse } = await import('../persistence/service.ts');
  const { getWorktreeBinding } = await import('../persistence/ownership.ts');
  const config = input.config ?? ({ engine: engine.kind } as GBrainConfig);
  const ctx = input.ctx ?? ({ engine, sourceId: input.sourceId, remote: false, config, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext);
  assertPersistenceAccepting(engine);
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation, archived FROM sources WHERE id = $1', [input.sourceId]);
  if (!source || source.archived) throw opError('source_changed', `Source ${input.sourceId} is archived or missing; nothing was changed.`, 'Restore the source first (the user\'s call).');
  const authority = await submissionAuthority(ctx, TRUST_OWNER_PAGE_OPERATION, input.sourceId, source.incarnation, input.slug);
  const snapshot = await engine.readPageSnapshot(input.slug, { sourceId: input.sourceId });
  const writeThrough = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  const binding = snapshot && writeThrough ? await getWorktreeBinding(engine, input.sourceId) : null;
  if (!writeThrough) authority.databaseOnlyReason = 'disabled_by_config';
  const row = await admitWrite(engine, {
    principal, operation: TRUST_OWNER_PAGE_OPERATION, sourceId: input.sourceId, sourceIncarnation: source.incarnation, slug: input.slug,
    pageId: snapshot?.page.id ?? null, requestId: randomUUID(), callerIntent: intent, intent, authority,
    worktreeId: binding?.worktree_id ?? null, topologyGeneration: binding?.topology_generation ?? null,
  });
  writeResponse(await waitForWrite(engine, row, config, 30_000));
}

/**
 * The coordinator preparer for `trust_owner_page` (persistence/service.ts).
 * The resident owner re-validates here: a remote request needs a recorded
 * memory_confirm scope; the page must still be at the approved revision.
 */
export async function prepareTrustOwnerPageMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const intent = row.intent as unknown as OwnerPageIntent | null;
  if (row.operation !== TRUST_OWNER_PAGE_OPERATION || !intent || !Object.hasOwn(ACTION_NAMES, intent.mode) || typeof intent.expected_revision !== 'string'
    || (row.authority.remote && (LOCAL_ONLY_MODES.includes(intent.mode) || !(row.authority.scopes ?? []).includes(MEMORY_CONFIRM_SCOPE)))) {
    throw opError('confirmation_required', 'This owner page action is not confirmed by the owner; nothing was changed.',
      'Run the gbrain trust command on the brain host in an interactive terminal.');
  }
  const ref = pageRef(row.source_id, row.slug);
  const state = await readPageTrustState(engine, row.source_id, row.slug);
  if (!state || state.revision !== intent.expected_revision) throw changedSincePreview(ref, ACTION_NAMES[intent.mode]);
  let content: string;
  let tags: string[] | undefined;
  let tier: TrustTier = 'user_confirmed';
  if (intent.mode === 'revert') {
    const version = Number.isSafeInteger(intent.version_id) ? await readPageVersion(engine, state.pageId, intent.version_id!) : null;
    if (!version) throw opError('not_found', `Version ${String(intent.version_id)} is not in the history of ${ref}.`, `List versions with gbrain history ${row.slug}.`);
    content = versionMarkdown(state.snapshot, version);
    tags = version.tags ?? undefined;
    tier = versionTier(version);
  } else if (intent.mode === 'repair_marker') {
    tier = state.tier;
    content = markdownWithoutMarker(state.snapshot, repairedMarker(tier));
  } else if (intent.mode === 'restore_provenance') ({ content, tier } = await plannedProvenanceRestore(engine, state, intent));
  else content = markdownWithoutMarker(state.snapshot);
  // The request keeps its own operation, so page-prepare stamps no CEO-21 marker and files no lower_page item for it.
  const { preparePageMutation } = await import('../persistence/page-prepare.ts');
  const page = await preparePageMutation(engine, row, config, { content, expectedRevision: intent.expected_revision, ...(tags ? { tags } : {}) });
  const apply = page.apply;
  page.trust = ownerTrust(tier, intent.mode, intent.via);
  page.apply = (tx, preimage) => withTrustPromotion(tx, tier, () => withTrustKeep(tx, FENCE_TABLES, async () => {
    const outcome = await apply(tx, preimage);
    if (intent.mode === 'restore_provenance') await recordAgentPageLowering(tx, row, { tier: state.tier, revision: state.revision }, PROVENANCE_PROPOSER);
    await closeProposal(tx, intent.proposal, { kind: row.principal_kind as Principal['kind'], id: row.principal_id });
    return { ...outcome, trust_action: intent.mode, trust_tier: tier };
  }));
  return page;
}

// ---------------------------------------------------------------------------
// lower_page proposals (CEO-12)
// ---------------------------------------------------------------------------

export interface LowerPageState {
  slug: string;
  prior_tier: TrustTier;
  prior_revision: string | null;
  version_id: number | null;
  /** The latest agent edit (after_state). */
  edited_revision: string | null;
  edited_tier: TrustTier;
}

export function lowerPageState(proposal: TrustProposalRow): LowerPageState {
  const b = proposal.before_state;
  const a = proposal.after_state;
  return {
    slug: String(b.slug ?? ''), prior_tier: storedTrustTier(b.prior_tier),
    prior_revision: typeof b.prior_revision === 'string' ? b.prior_revision : null,
    version_id: b.version_id === null || b.version_id === undefined ? null : Number(b.version_id),
    edited_revision: typeof a.revision === 'string' ? a.revision : null, edited_tier: storedTrustTier(a.tier),
  };
}

async function staleUnlessAt(engine: BrainEngine, proposal: TrustProposalRow, state: LowerPageState): Promise<PageTrustState | TrustDecisionResult> {
  const page = state.slug ? await readPageTrustState(engine, proposal.source_id, state.slug) : null;
  if (!page || page.pageId !== proposal.target_id) return decisionResult(proposal, 'accept', 'stale', { reason: 'page_missing' });
  if (state.edited_revision && page.revision !== state.edited_revision) return decisionResult(proposal, 'accept', 'stale', { reason: 'page_changed_since' });
  return page;
}

/** Revert decision of a lower_page proposal: restore the prior owner version's content and tier. */
export async function revertLoweredPage(engine: BrainEngine, proposal: TrustProposalRow, ctx: TrustDecisionContext): Promise<TrustDecisionResult> {
  const state = lowerPageState(proposal);
  if (state.version_id === null) return decisionResult(proposal, 'reject', 'refused', { reason: 'no_prior_version' });
  const page = await staleUnlessAt(engine, proposal, state);
  if (!('pageId' in page)) return { ...page, decision: 'reject' };
  const result = await revertPageToVersion(engine, {
    sourceId: proposal.source_id, slug: state.slug, expectedRevision: page.revision, versionId: state.version_id,
    confirmation: ctx.confirmation, by: ctx.decidedBy, config: ctx.config,
    proposal: { id: proposal.id, to: 'rejected', after: { ...proposal.after_state, resolution: 'reverted', restored_tier: state.prior_tier } },
  });
  return decisionResult(proposal, 'reject', 'rejected', { reason: 'reverted', detail: { ...result } });
}

/** The actions this module registers handlers for (trust/decide.ts loads every handler module through these). */
export const PAGE_HANDLER_ACTIONS: readonly TrustProposalAction[] = ['lower_page'];

registerTrustProposalHandler('lower_page', {
  async accept(engine, proposal, ctx) {
    const state = lowerPageState(proposal);
    const page = await staleUnlessAt(engine, proposal, state);
    if (!('pageId' in page)) return page;
    const result = await confirmPage(engine, {
      sourceId: proposal.source_id, slug: state.slug, expectedRevision: page.revision, confirmation: ctx.confirmation,
      by: ctx.decidedBy, config: ctx.config,
      proposal: { id: proposal.id, to: 'accepted', after: { ...proposal.after_state, resolution: 'confirmed' } },
    });
    return decisionResult(proposal, 'accept', 'accepted', { detail: { ...result } });
  },
  async reject(engine, proposal, ctx) {
    return await transitionTrustProposal(engine, proposal.id, 'pending', 'rejected', { after: { ...proposal.after_state, resolution: 'dismissed' }, decidedBy: ctx.decidedBy })
      ? decisionResult(proposal, 'reject', 'rejected', { reason: 'dismissed' })
      : decisionResult(proposal, 'reject', 'refused', { reason: 'not_pending' });
  },
});
