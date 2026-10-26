/**
 * GBRA-190 G4: forget and forget_fact are fence edits. Git is the parent, so a withdrawal is one coordinated
 * publication: its preparation strikes the claim (`withdrawnFact`: `~~claim~~` and `forgotten: ...`, the overlay's
 * rendering) in the file of every page that carries it, the coordinator publishes those files under one recovery
 * record and one Git commit (the request's page plus a CompanionPage per other page, coordinator.ts), and the
 * publication transaction then writes the ledger row, the expiries and the chunk invalidation (recordFactWithdrawal's
 * `publication` mode). No withdrawal-mirror effect is queued for it; that effect only drains rows queued before.
 *
 * A page's file is struck when the withdrawal applies to it (its subject is '*' or the page's slug, as the read overlay
 * applies it) and the page has a canonical file; a deleted page, or one whose file is missing, gets no file, as the
 * mirror never resurrected one. A file that differs from the database refuses the forget (the uncoordinated-edit
 * refusal every coordinated page write gives) instead of leaving it unstruck.
 */
import { existsSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PageSnapshot, PageWithdrawal } from '../page-state/types.ts';
import { opError, verbError } from '../ops/contract.ts';
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { planFactWithdrawal, recordFactWithdrawal } from '../facts/withdrawal.ts';
import { rebuildPendingPageProjections } from '../page-state/projections.ts';
import { privateProvenanceFilterFragment, resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { remoteForgetRaced, supersessionGuarded } from '../trust/supersede-handlers.ts';
import { materializedPage } from './segmented-apply.ts';
import { prepareFileTarget, snapshotLedger, unreadPageFile } from './page-prepare.ts';
import { pageIdentityError } from './page-identity.ts';
import type { CompanionPage, PageMutationFile, PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

interface ForgetTarget { id: number; entity_slug: string | null; trust_tier?: string | null }

/**
 * A fact saved without an entity says nothing about whom it concerns, so its
 * withdrawal reaches the claim under every entity. When that claim is active
 * on entity-linked facts, forgetting the unlinked copy would silently withdraw
 * them too, and a withdrawn claim cannot be remembered again; refuse and name them.
 * A caller that cannot read private pages never withdraws an active copy it
 * cannot see: the refusal is then one fixed text that names no fact.
 */
export async function refuseForgetReachingOtherCopies(tx: BrainEngine, sourceId: string, fact: ForgetTarget, remote: boolean, excludePrivate: boolean): Promise<void> {
  const id = fact.id;
  if (fact.entity_slug === null) {
    const linked = await tx.executeRaw<{ id: number; entity_slug: string }>(`SELECT l.id,l.entity_slug FROM facts u
      JOIN facts l ON l.source_id=u.source_id AND l.visibility=u.visibility AND l.entity_slug IS NOT NULL AND l.id<>u.id
        AND l.expired_at IS NULL AND (l.valid_until IS NULL OR l.valid_until > now())
        AND gbrain_fact_fingerprint(l.fact)=gbrain_fact_fingerprint(u.fact)
      WHERE u.id=$1 AND u.source_id=$2 AND ($3::boolean=false OR l.visibility='world')${excludePrivate ? ` AND ${privateProvenanceFilterFragment('l')}` : ''}
      ORDER BY l.id LIMIT 5`, [id, sourceId, remote]);
    if (linked.length) {
      const named = linked.map(row => `#${row.id} (${row.entity_slug})`).join(', ');
      throw verbError('invalid_params',
        `claim_linked: fact #${id} was saved without an entity, and the same claim is active as ${named}. Forgetting #${id} would withdraw those facts too, so nothing was forgotten.`,
        `Keep the linked ${linked.length === 1 ? 'fact' : 'facts'}: the copy without an entity needs no cleanup (remember the claim with entity and replaces: "${id}" retires it). To withdraw the claim everywhere, forget ${linked.map(row => `#${row.id}`).join(', ')} first, then #${id}.`);
    }
  }
  if (!excludePrivate) return;
  const hidden = await tx.executeRaw(`SELECT 1 FROM facts u
    JOIN facts l ON l.source_id=u.source_id AND l.visibility=u.visibility AND l.id<>u.id
      AND (u.entity_slug IS NULL OR l.entity_slug=u.entity_slug)
      AND l.expired_at IS NULL AND (l.valid_until IS NULL OR l.valid_until > now())
      AND gbrain_fact_fingerprint(l.fact)=gbrain_fact_fingerprint(u.fact)
    WHERE u.id=$1 AND u.source_id=$2 AND NOT (${privateProvenanceFilterFragment('l')}) LIMIT 1`, [id, sourceId]);
  if (!hidden.length) return;
  throw verbError('invalid_params',
    `claim_linked: the same claim as fact #${id} is active elsewhere in this brain. Forgetting #${id} would withdraw it there too, so nothing was forgotten.`,
    'Keep the fact. To withdraw the claim everywhere, ask the user to forget it on the brain host.');
}

/** The fact a forget names, under the caller's visibility (locked inside a transaction when `lock`); null when it is not visible. */
export async function readForgetTarget(engine: BrainEngine, id: number, sourceId: string, remote: boolean, excludePrivate: boolean, lock = false) {
  const [fact] = await engine.executeRaw<ForgetTarget & { source_markdown_slug: string | null; expired_at: Date | null }>(`SELECT id,entity_slug,source_markdown_slug,expired_at,trust_tier FROM facts
    WHERE id=$1 AND source_id=$2 AND ($3::boolean=false OR visibility='world')${excludePrivate ? ` AND ${privateProvenanceFilterFragment('facts')}` : ''}${lock ? ' FOR UPDATE' : ''}`, [id, sourceId, remote]);
  return fact ?? null;
}

export async function prepareForgetMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig, signal?: AbortSignal): Promise<PreparedMutation> {
  signal?.throwIfAborted();
  const p = row.intent ?? {};
  const id = Number(p.id);
  const rawId = String(p.id ?? '').trim();
  const sourceId = row.source_id;
  const remote = row.authority.remote !== false;
  const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim() : null;
  const excludePrivate = await resolveExcludePrivatePages(engine, remote);
  const missing = () => verbError(row.operation === 'forget' ? 'not_found' : 'fact_not_found',
    `No fact with id "${rawId}".`, 'Ids come from remember/recall. Recall the entity first to find the right fact.');
  if (!Number.isSafeInteger(id) || id <= 0) throw missing();
  const fact = await readForgetTarget(engine, id, sourceId, remote, excludePrivate);
  if (!fact) throw missing();
  if (row.operation === 'forget_fact' && fact.expired_at !== null) {
    throw opError('fact_already_expired', `Fact id ${id} already expired.`, 'Recall the entity to read its current facts; nothing was changed.');
  }
  const plan = await planFactWithdrawal(engine, id, sourceId, remote, excludePrivate);
  if (!plan) throw missing();
  // The files are struck with this timestamp, and the ledger row records it, so the file and the read overlay agree.
  const withdrawnAt = new Date().toISOString();
  const withdrawal: PageWithdrawal = { visibility: plan.visibility, fact_hash: plan.fact_hash, withdrawn_at: withdrawnAt };
  const struck = new Set(plan.affected.map(page => page.slug));
  const strike = async (slug: string, snapshot: PageSnapshot | null): Promise<PageMutationFile | undefined> => {
    if (!snapshot || snapshot.page.deleted_at || !row.worktree_id || !struck.has(slug) || (plan.subject !== '*' && plan.subject !== slug)) return undefined;
    const target = { source_id: sourceId, worktree_id: row.worktree_id, slug, operation: row.operation };
    if (isSegmentedPage(snapshot.page)) {
      // A segmented page's file is streamed from its segments under the ledger plus this withdrawal (export's overlay),
      // never rendered as one string, so a page of any size can be struck.
      const struckFile = await unreadPageFile(engine, snapshot, undefined, { ...snapshotLedger(snapshot), withdrawals: [...snapshot.withdrawals, withdrawal] });
      if (struckFile.hash === (await unreadPageFile(engine, snapshot)).hash) return undefined;
      const file = await prepareFileTarget(engine, target, snapshot, struckFile, undefined, { allowMissing: true, remote });
      return file && file.content !== null && existsSync(file.path) ? file : undefined;
    }
    const page = await materializedPage(engine, snapshot.page);
    const query = <T,>(sql: string, params?: unknown[]) => engine.executeRaw<T & Record<string, unknown>>(sql, params) as Promise<T[]>;
    const bodies = await overlayCanonicalBodies(query, page.compiled_truth, page.timeline ?? '', [...snapshot.withdrawals, withdrawal],
      { sourceId, marker: snapshot.globalPurges });
    if (bodies.compiled_truth === page.compiled_truth && bodies.timeline === (page.timeline ?? '')) return undefined;
    const file = await prepareFileTarget(engine, target, snapshot, serializePageToMarkdown({ ...page, ...bodies }, snapshot.tags), undefined, { allowMissing: true, remote });
    // A removal (a strict page turning private, git-declared.ts) is that transition's own write, never a withdrawal's.
    return file && file.content !== null && existsSync(file.path) ? file : undefined;
  };
  const own = await engine.readPageSnapshot(row.slug, { sourceId, includeDeleted: true });
  if ((own?.page.id ?? null) !== row.page_id) throw pageIdentityError(own != null || row.page_id === null, 'The page of the forgotten fact was deleted or recreated.');
  const file = await strike(row.slug, own);
  const companions: CompanionPage[] = [];
  for (const slug of plan.slugs) {
    if (slug === row.slug) continue;
    signal?.throwIfAborted();
    const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    const companionFile = await strike(slug, snapshot);
    companions.push({ slug, pageId: snapshot?.page.id ?? null, observedRevision: snapshot?.revision ?? null,
      ...(companionFile ? { file: companionFile } : {}), apply: async () => undefined });
  }
  let pages: string[] = [];
  return { observedRevision: own?.revision ?? null, ...(file ? { file } : {}), ...(companions.length ? { companions } : {}),
    validate: async tx => {
      // Under the publication's locks: the fact is still visible, no more trusted than a remote caller, and reaches no other copy.
      const current = await readForgetTarget(tx, id, sourceId, remote, excludePrivate, true);
      if (!current) throw missing();
      if (remote && supersessionGuarded('agent_written', current.trust_tier)) throw remoteForgetRaced(id);
      await refuseForgetReachingOtherCopies(tx, sourceId, current, remote, excludePrivate);
    },
    apply: async tx => {
      // Even an expired legacy fact acquires a ledger row, so a stale import cannot reactivate it.
      pages = (await recordFactWithdrawal(tx, id, sourceId, remote, { requestId: row.id, semanticReview: p.semantic_review !== false, excludePrivate,
        publication: { withdrawnAt, expectedSlugs: plan.slugs } })).pages.map(page => page.slug);
      if (reason) await tx.executeRaw(`UPDATE facts SET context=concat_ws(' | ',NULLIF(context,''),$3::text)
        WHERE id=$1 AND source_id=$2`, [id, sourceId, `forgotten: ${reason}`]);
      return row.operation === 'forget'
        ? { id: rawId, expired: fact.expired_at === null, reason, protocol_version: 1 }
        : { id, expired: true, path: 'legacy_db', reason: reason ?? 'forgotten' };
    },
    // The publication removed the withdrawn pages' chunks; rebuild them now, as a CLI process exits without a
    // resident projection worker. A failed rebuild stays queued as durable projection work.
    afterCommit: async committed => {
      for (let start = 0; start < pages.length; start += 100) {
        await rebuildPendingPageProjections(committed, 100, { pages: { sourceId, slugs: pages.slice(start, start + 100) } }).catch(() => undefined);
      }
    } };
}
