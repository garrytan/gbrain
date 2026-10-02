/**
 * S9 proposal accept / undo: a CHECKED supersede of one fact by another.
 *
 * Unlike `expireSuperseded` (write-single.ts), which warns and continues, a
 * checked supersede applies the database change (expired_at, valid_until,
 * superseded_by on the old fact), the struck `## Facts` fence row and the
 * proposal's status as one unit, and fails the whole operation otherwise; the
 * proposal then stays `pending`. Before and after state (the three fields,
 * the fence row and the page revision) are stored on the proposal so `undo`
 * can restore them, refusing when either fact or the fence row changed since.
 *
 * Unmanaged brains: under the source filesystem lock and the page lock, the
 * database writes run in one transaction whose last step publishes the file
 * (atomic .tmp + parse-validate + rename); a failed commit restores the file.
 * Managed brains: the same plan runs as a coordinator mutation (operation
 * `decide_proposal`), whose publication makes the file and database one unit.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { formatFenceDate, parseFactsFence, type ParsedFact } from '../facts-fence.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { sanitizeText } from '../batch-rows.ts';
import { contentHash } from '../utils.ts';
import { withPageLock } from '../page-lock.ts';
import { assertSourceFilesystemActive, withSourceFilesystemLock } from '../minions/source-filesystem.ts';
import { resolvePageWriteTarget } from '../write-through.ts';
import { OperationError } from '../ops/contract.ts';
import { getProposal, transitionProposal, type ProposalRow } from '../ai/decide/proposals-store.ts';
import { strikeFenceRow, supersededFact } from './forget.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';

export const DECIDE_PROPOSAL_OPERATION = 'decide_proposal';

export interface PairFact {
  id: number;
  source_id: string;
  entity_slug: string | null;
  visibility: string;
  fact: string;
  expired_at: string | null;
  valid_until: string | null;
  superseded_by: number | null;
  row_num: number | null;
  source_markdown_slug: string | null;
}

export interface FactFields { expired_at: string | null; valid_until: string | null; superseded_by: number | null; fact_sha256: string }
export interface FenceState { slug: string; row_num: number; row: ParsedFact; page_revision: string | null; file: boolean }
export interface SupersedeState { old: FactFields; new: FactFields; fence: FenceState | null }

export type ProposalAction = 'accept' | 'undo';
export interface ProposalActionResult {
  id: number;
  action: ProposalAction | 'reject';
  status: 'accepted' | 'rejected' | 'stale' | 'undone' | 'refused' | 'not_found';
  reason?: string;
}

export class ProposalConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ProposalConflictError'; }
}

const iso = (v: unknown): string | null => v === null || v === undefined ? null : new Date(v as string).toISOString();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function loadPairFact(engine: BrainEngine, id: number, lock = false): Promise<PairFact | null> {
  const [r] = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, source_id, entity_slug, visibility, fact, expired_at, valid_until, superseded_by, row_num, source_markdown_slug
       FROM facts WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!r) return null;
  return {
    id: Number(r.id), source_id: String(r.source_id), entity_slug: (r.entity_slug as string | null) ?? null, visibility: String(r.visibility),
    fact: String(r.fact), expired_at: iso(r.expired_at), valid_until: iso(r.valid_until),
    superseded_by: r.superseded_by === null || r.superseded_by === undefined ? null : Number(r.superseded_by),
    row_num: r.row_num === null || r.row_num === undefined ? null : Number(r.row_num), source_markdown_slug: (r.source_markdown_slug as string | null) ?? null,
  };
}

export function factFields(f: PairFact): FactFields {
  return { expired_at: f.expired_at, valid_until: f.valid_until, superseded_by: f.superseded_by, fact_sha256: sha(f.fact) };
}

const sameFields = (a: FactFields, b: FactFields) => a.expired_at === b.expired_at && a.valid_until === b.valid_until
  && a.superseded_by === b.superseded_by && a.fact_sha256 === b.fact_sha256;

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
export const sameRow = (a: ParsedFact | undefined, b: ParsedFact | undefined) => a !== undefined && b !== undefined && stableJson(a) === stableJson(b);

/** Why an accept can no longer apply (the proposal becomes `stale`), or null. */
export function staleReason(proposal: Pick<ProposalRow, 'source_id'>, oldF: PairFact | null, newF: PairFact | null, nowMs: number): string | null {
  if (!oldF || !newF) return 'fact_missing';
  const active = (f: PairFact) => f.expired_at === null && (f.valid_until === null || new Date(f.valid_until).getTime() > nowMs);
  if (!active(oldF)) return 'old_fact_inactive';
  if (!active(newF)) return 'new_fact_inactive';
  if (oldF.source_id !== proposal.source_id || newF.source_id !== proposal.source_id || oldF.entity_slug !== newF.entity_slug || oldF.visibility !== newF.visibility) return 'scope_changed';
  return null;
}

/** The old fact's fence row struck as superseded (with `#N` when the new fact lives on the same page). */
export function planAcceptFence(body: string, oldF: PairFact, newF: PairFact, today: string): { body: string; before: ParsedFact; after: ParsedFact } | null {
  if (oldF.row_num === null || !oldF.source_markdown_slug) return null;
  const before = parseFactsFence(body).facts.find((f) => f.rowNum === oldF.row_num);
  if (!before) return null;
  const newRow = newF.source_markdown_slug === oldF.source_markdown_slug && newF.row_num !== null ? newF.row_num : null;
  const struck = strikeFenceRow(body, oldF.row_num, (f) => supersededFact(f, today, newRow));
  if (struck === null) return null;
  const after = parseFactsFence(struck).facts.find((f) => f.rowNum === oldF.row_num);
  return after ? { body: struck, before, after } : null;
}

/** The accepted fence row restored; `changed` when the row is no longer the one accept wrote. */
export function planUndoFence(body: string, fence: FenceState, after: FenceState): { body: string } | 'changed' {
  const current = parseFactsFence(body).facts.find((f) => f.rowNum === fence.row_num);
  if (!sameRow(current, after.row)) return 'changed';
  const restored = strikeFenceRow(body, fence.row_num, () => fence.row);
  return restored === null ? 'changed' : { body: restored };
}

/** Undo refusal: either fact (or the fence row) changed since accept. */
export function undoRefusal(state: { before: SupersedeState; after: SupersedeState }, oldF: PairFact | null, newF: PairFact | null): string | null {
  if (!oldF || !newF) return 'fact_missing';
  if (!sameFields(factFields(oldF), state.after.old)) return 'old_fact_changed';
  if (!sameFields(factFields(newF), state.after.new)) return 'new_fact_changed';
  return null;
}

// ---------------------------------------------------------------------------
// Database units (shared by the unmanaged and managed paths)
// ---------------------------------------------------------------------------

async function expireOld(tx: BrainEngine, proposal: ProposalRow): Promise<void> {
  const rows = await tx.executeRaw<{ id: number }>(
    `UPDATE facts SET expired_at = now(), valid_until = LEAST(COALESCE(valid_until, now()), now()), superseded_by = $3
      WHERE id = $1 AND source_id = $2 AND expired_at IS NULL RETURNING id`,
    [proposal.old_fact_id, proposal.source_id, proposal.new_fact_id]);
  if (rows.length !== 1) throw new ProposalConflictError('the old fact changed during accept');
}

/** Record the after state (read back inside the transaction) and move the proposal to accepted. */
async function finishAccept(tx: BrainEngine, proposal: ProposalRow, before: SupersedeState, fenceAfter: FenceState | null): Promise<void> {
  const [oldF, newF] = await Promise.all([loadPairFact(tx, proposal.old_fact_id), loadPairFact(tx, proposal.new_fact_id)]);
  const after: SupersedeState = { old: factFields(oldF!), new: factFields(newF!), fence: fenceAfter };
  if (!await transitionProposal(tx, proposal.id, 'pending', 'accepted', { before: JSON.stringify(before), after: JSON.stringify(after) })) {
    throw new ProposalConflictError('the proposal is no longer pending');
  }
}

async function applyUndoDb(tx: BrainEngine, proposal: ProposalRow, before: SupersedeState, after: SupersedeState): Promise<void> {
  const rows = await tx.executeRaw<{ id: number }>(
    `UPDATE facts SET expired_at = $3::timestamptz, valid_until = $4::timestamptz, superseded_by = $5
      WHERE id = $1 AND source_id = $2 AND superseded_by IS NOT DISTINCT FROM $6 RETURNING id`,
    [proposal.old_fact_id, proposal.source_id, before.old.expired_at, before.old.valid_until, before.old.superseded_by, after.old.superseded_by]);
  if (rows.length !== 1) throw new ProposalConflictError('the old fact changed during undo');
  if (!await transitionProposal(tx, proposal.id, 'accepted', 'undone')) throw new ProposalConflictError('the proposal is no longer accepted');
}

function parseStates(p: ProposalRow): { before: SupersedeState; after: SupersedeState } | null {
  try { return p.before_state && p.after_state ? { before: JSON.parse(p.before_state), after: JSON.parse(p.after_state) } : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Unmanaged path
// ---------------------------------------------------------------------------

function publishFile(filePath: string, body: string): void {
  const tmp = `${filePath}.tmp`;
  assertSourceFilesystemActive();
  writeFileSync(tmp, body, 'utf-8');
  if (parseFactsFence(readFileSync(tmp, 'utf-8')).warnings.length > 0) {
    rmSync(tmp, { force: true });
    throw new ProposalConflictError('the rewritten facts fence failed validation');
  }
  renameSync(tmp, filePath);
}

/** Mirror the page body the fence change produced (the #4696 rule: keep the old hash so sync re-imports). */
async function mirrorBody(tx: BrainEngine, slug: string, sourceId: string, body: string, fromFile: boolean): Promise<string | null> {
  const page = await tx.getPage(slug, { sourceId });
  if (!page) return null;
  if (fromFile) {
    const reparsed = parseMarkdown(body, `${slug}.md`);
    await tx.refreshPageBody(slug, sourceId, sanitizeText(reparsed.compiled_truth), sanitizeText(reparsed.timeline), page.content_hash || contentHash(page));
  } else {
    await tx.refreshPageBody(slug, sourceId, body, page.timeline ?? '', contentHash({ ...page, compiled_truth: body }));
  }
  return (await tx.readPageSnapshot(slug, { sourceId }))?.revision ?? null;
}

async function withFenceLocks<T>(engine: BrainEngine, slug: string | null, sourceId: string, run: (filePath: string | null) => Promise<T>): Promise<T> {
  if (!slug) return run(null);
  const target = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!target.ok) return withPageLock(slug, () => run(null), { timeoutMs: 5_000 });
  return withSourceFilesystemLock(engine, target.writeRoot, () => withPageLock(slug, () => run(target.filePath), { timeoutMs: 5_000 }));
}

async function acceptUnmanaged(engine: BrainEngine, proposal: ProposalRow): Promise<ProposalActionResult> {
  const first = await loadPairFact(engine, proposal.old_fact_id);
  return withFenceLocks(engine, first?.source_markdown_slug ?? null, proposal.source_id, async (filePath) => {
    const fresh = await getProposal(engine, proposal.id);
    if (!fresh || fresh.status !== 'pending') return { id: proposal.id, action: 'accept', status: 'refused', reason: fresh?.status ?? 'not_found' };
    const [oldF, newF] = await Promise.all([loadPairFact(engine, fresh.old_fact_id), loadPairFact(engine, fresh.new_fact_id)]);
    const stale = staleReason(fresh, oldF, newF, Date.now());
    if (stale) {
      await transitionProposal(engine, fresh.id, 'pending', 'stale');
      return { id: fresh.id, action: 'accept', status: 'stale', reason: stale };
    }
    const slug = oldF!.source_markdown_slug;
    const fileBody = filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
    const snapshot = slug ? await engine.readPageSnapshot(slug, { sourceId: fresh.source_id }) : null;
    const body = fileBody ?? snapshot?.page.compiled_truth ?? null;
    const plan = slug && body !== null ? planAcceptFence(body, oldF!, newF!, formatFenceDate(new Date())) : null;
    const fence = (row: ParsedFact, revision: string | null): FenceState => ({ slug: slug!, row_num: oldF!.row_num!, row, page_revision: revision, file: fileBody !== null });
    const before: SupersedeState = { old: factFields(oldF!), new: factFields(newF!), fence: plan ? fence(plan.before, snapshot?.revision ?? null) : null };
    let published = false;
    try {
      await engine.transaction(async (tx) => {
        const revision = plan ? await mirrorBody(tx, slug!, fresh.source_id, plan.body, fileBody !== null) : null;
        await expireOld(tx, fresh);
        await finishAccept(tx, fresh, before, plan ? fence(plan.after, revision) : null);
        if (plan && fileBody !== null) { publishFile(filePath!, plan.body); published = true; }
      });
    } catch (err) {
      if (published) writeFileSync(filePath!, fileBody!, 'utf-8');
      throw err;
    }
    return { id: fresh.id, action: 'accept', status: 'accepted' };
  });
}

async function undoUnmanaged(engine: BrainEngine, proposal: ProposalRow): Promise<ProposalActionResult> {
  const first = await loadPairFact(engine, proposal.old_fact_id);
  return withFenceLocks(engine, first?.source_markdown_slug ?? null, proposal.source_id, async (filePath) => {
    const fresh = await getProposal(engine, proposal.id);
    if (!fresh || fresh.status !== 'accepted') return { id: proposal.id, action: 'undo', status: 'refused', reason: fresh?.status ?? 'not_found' };
    const states = parseStates(fresh);
    if (!states) return { id: fresh.id, action: 'undo', status: 'refused', reason: 'no_recorded_state' };
    const [oldF, newF] = await Promise.all([loadPairFact(engine, fresh.old_fact_id), loadPairFact(engine, fresh.new_fact_id)]);
    const refusal = undoRefusal(states, oldF, newF);
    if (refusal) return { id: fresh.id, action: 'undo', status: 'refused', reason: refusal };
    const { before, after } = states;
    let plan: { body: string } | null = null;
    let fileBody: string | null = null;
    if (before.fence && after.fence) {
      fileBody = before.fence.file && filePath && existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
      if (before.fence.file && fileBody === null) return { id: fresh.id, action: 'undo', status: 'refused', reason: 'fence_file_missing' };
      const body = fileBody ?? (await engine.getPage(before.fence.slug, { sourceId: fresh.source_id }))?.compiled_truth ?? null;
      const planned = body === null ? 'changed' : planUndoFence(body, before.fence, after.fence);
      if (planned === 'changed') return { id: fresh.id, action: 'undo', status: 'refused', reason: 'fence_changed' };
      plan = planned;
    }
    let published = false;
    try {
      await engine.transaction(async (tx) => {
        if (plan) await mirrorBody(tx, before.fence!.slug, fresh.source_id, plan.body, fileBody !== null);
        await applyUndoDb(tx, fresh, before, after);
        if (plan && fileBody !== null) { publishFile(filePath!, plan.body); published = true; }
      });
    } catch (err) {
      if (published) writeFileSync(filePath!, fileBody!, 'utf-8');
      throw err;
    }
    return { id: fresh.id, action: 'undo', status: 'undone' };
  });
}

// ---------------------------------------------------------------------------
// Managed path: coordinator mutation `decide_proposal`
// ---------------------------------------------------------------------------

/** Coordinator preparer: the same plan as the unmanaged path, published by the coordinator as one unit. */
export async function prepareProposalMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as { proposal_id?: number; action?: ProposalAction } | null;
  const id = Number(p?.proposal_id);
  if (row.operation !== DECIDE_PROPOSAL_OPERATION || !Number.isSafeInteger(id) || (p?.action !== 'accept' && p?.action !== 'undo') || row.authority.remote) {
    throw new OperationError('permission_denied', 'Unsupported decide proposal intent.');
  }
  const action = p.action;
  const proposal = await getProposal(engine, id);
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  const observedRevision = snapshot?.revision ?? null;
  const done = (outcome: Record<string, unknown>): PreparedMutation => ({ observedRevision, noop: true, apply: async () => outcome });
  if (!proposal || proposal.source_id !== row.source_id) return done({ id, action, status: 'refused', reason: 'not_found' });
  if (proposal.status !== (action === 'accept' ? 'pending' : 'accepted')) return done({ id, action, status: 'refused', reason: proposal.status });
  const [oldF, newF] = await Promise.all([loadPairFact(engine, proposal.old_fact_id), loadPairFact(engine, proposal.new_fact_id)]);
  const unchanged = async (tx: BrainEngine) => {
    const current = await getProposal(tx, id, true);
    const [o, n] = await Promise.all([loadPairFact(tx, proposal.old_fact_id, true), loadPairFact(tx, proposal.new_fact_id, true)]);
    if (current?.status !== proposal.status || !o || !n || !oldF || !newF || !sameFields(factFields(o), factFields(oldF)) || !sameFields(factFields(n), factFields(newF))) {
      throw new OperationError('revision_conflict', 'The proposal or its facts changed during preparation.');
    }
  };
  const pageFor = async (body: string): Promise<PreparedMutation | undefined> => {
    if (!snapshot) return undefined;
    const page = await preparePage(engine, { ...row, intent: { ...row.intent, content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags), expected_revision: observedRevision, force: false } }, config);
    if (page.observedRevision !== observedRevision) throw new OperationError('revision_conflict', 'The fact page changed during preparation.');
    return page;
  };
  if (action === 'accept') {
    const stale = staleReason(proposal, oldF, newF, Date.now());
    if (stale) return { observedRevision, validate: unchanged, apply: async (tx) => {
      await transitionProposal(tx, id, 'pending', 'stale');
      return { id, action, status: 'stale', reason: stale };
    } };
    const plan = oldF!.source_markdown_slug === row.slug && snapshot ? planAcceptFence(snapshot.page.compiled_truth, oldF!, newF!, formatFenceDate(new Date())) : null;
    const page = plan ? await pageFor(plan.body) : undefined;
    const fence = (r: ParsedFact, revision: string | null): FenceState => ({ slug: row.slug, row_num: oldF!.row_num!, row: r, page_revision: revision, file: page?.file !== undefined });
    const before: SupersedeState = { old: factFields(oldF!), new: factFields(newF!), fence: plan ? fence(plan.before, observedRevision) : null };
    return { observedRevision, file: page?.file, validate: async (tx) => { await unchanged(tx); await page?.validate?.(tx); }, apply: async (tx) => {
      // The page projection re-stamps the struck row's expiry from the fence, so the after state is read once it ran.
      await expireOld(tx, proposal);
      await page?.apply(tx);
      const revision = plan ? (await tx.readPageSnapshot(row.slug, { sourceId: row.source_id }))?.revision ?? null : null;
      await finishAccept(tx, proposal, before, plan ? fence(plan.after, revision) : null);
      return { id, action, status: 'accepted' };
    } };
  }
  const states = parseStates(proposal);
  if (!states) return done({ id, action, status: 'refused', reason: 'no_recorded_state' });
  const refusal = undoRefusal(states, oldF, newF);
  if (refusal) return done({ id, action, status: 'refused', reason: refusal });
  const { before, after } = states;
  let page: PreparedMutation | undefined;
  if (before.fence && after.fence) {
    const planned = snapshot && before.fence.slug === row.slug ? planUndoFence(snapshot.page.compiled_truth, before.fence, after.fence) : 'changed';
    if (planned === 'changed') return done({ id, action, status: 'refused', reason: 'fence_changed' });
    page = await pageFor(planned.body);
  }
  return { observedRevision, file: page?.file, validate: async (tx) => { await unchanged(tx); await page?.validate?.(tx); }, apply: async (tx) => {
    await page?.apply(tx);
    await applyUndoDb(tx, proposal, before, after);
    return { id, action, status: 'undone' };
  } };
}

async function preparePage(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const { preparePageMutation } = await import('../persistence/page-prepare.ts');
  return preparePageMutation(engine, row, config);
}

async function submitManaged(engine: BrainEngine, proposal: ProposalRow, action: ProposalAction, config: GBrainConfig): Promise<ProposalActionResult> {
  const { initializeLocalPersistence, requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
  const { submissionAuthority } = await import('../persistence/authority.ts');
  const { admitWrite } = await import('../persistence/journal.ts');
  const { assertPersistenceAccepting, waitForWrite, writeResponse } = await import('../persistence/service.ts');
  const { getWorktreeBinding } = await import('../persistence/ownership.ts');
  const sourceId = proposal.source_id;
  const ctx = { engine, sourceId, remote: false as const, config, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  assertPersistenceAccepting(engine);
  await initializeLocalPersistence(ctx as never);
  const principal = await requestPrincipalForContext(ctx as never);
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation, archived FROM sources WHERE id = $1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The proposal source is not active.');
  const oldF = await loadPairFact(engine, proposal.old_fact_id);
  const slug = oldF?.source_markdown_slug ?? oldF?.entity_slug ?? 'memory/unattributed';
  const authority = await submissionAuthority(ctx as never, DECIDE_PROPOSAL_OPERATION, sourceId, source.incarnation, slug);
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  const writeThrough = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  const binding = snapshot && writeThrough ? await getWorktreeBinding(engine, sourceId) : null;
  if (!writeThrough) authority.databaseOnlyReason = 'disabled_by_config';
  const intent = { proposal_id: proposal.id, action };
  const row = await admitWrite(engine, {
    principal, operation: DECIDE_PROPOSAL_OPERATION, sourceId, sourceIncarnation: source.incarnation, slug, pageId: snapshot?.page.id ?? null,
    requestId: randomUUID(), callerIntent: intent, intent, authority, worktreeId: binding?.worktree_id ?? null, topologyGeneration: binding?.topology_generation ?? null,
  });
  const finished = await waitForWrite(engine, row, config, 30_000);
  writeResponse(finished);
  const out = finished.outcome as unknown as ProposalActionResult;
  return { id: out.id, action: out.action, status: out.status, ...(out.reason ? { reason: out.reason } : {}) };
}

async function managed(engine: BrainEngine): Promise<boolean> {
  const { managedPersistenceEnabled } = await import('../persistence/ownership.ts');
  return managedPersistenceEnabled(engine);
}

/** Accept or undo one proposal through the brain's supersede write path. */
export async function applyProposalAction(engine: BrainEngine, id: number, action: ProposalAction, config?: GBrainConfig): Promise<ProposalActionResult> {
  const proposal = await getProposal(engine, id);
  if (!proposal) return { id, action, status: 'not_found' };
  const want = action === 'accept' ? 'pending' : 'accepted';
  if (proposal.status !== want) return { id, action, status: 'refused', reason: proposal.status };
  if (await managed(engine)) return submitManaged(engine, proposal, action, config ?? ({ engine: engine.kind } as GBrainConfig));
  return action === 'accept' ? acceptUnmanaged(engine, proposal) : undoUnmanaged(engine, proposal);
}

export async function rejectProposal(engine: BrainEngine, id: number): Promise<ProposalActionResult> {
  const proposal = await getProposal(engine, id);
  if (!proposal) return { id, action: 'reject', status: 'not_found' };
  if (await transitionProposal(engine, id, 'pending', 'rejected')) return { id, action: 'reject', status: 'rejected' };
  return { id, action: 'reject', status: 'refused', reason: (await getProposal(engine, id))?.status ?? 'not_found' };
}
