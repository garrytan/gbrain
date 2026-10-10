import { realpathSync } from 'node:fs';
import { enterClaimStep, type ClaimPhaseClock } from './claim-phase.ts';
import { boundedReads } from './bounded-reads.ts';
import { join } from 'node:path';
import type { BrainEngine, FactRow } from '../engine.ts';
import { loadConfig, type GBrainConfig } from '../config.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { fenceOperationError, scanCanonicalFences } from '../fence-repair/refusal.ts';
import { normalizeClaimWhitespace, parseFactsFence } from '../facts-fence.ts';
import { submissionAuthority, authorizeStoredRequest, authorizeWrite } from './authority.ts';
import { currentVerifiedLocalWriter, localHostId, registerLocalWriter } from './identity.ts';
import { getWorktreeBinding, managedPersistenceEnabled, type WorktreeBinding } from './ownership.ts';
import { checkOwner, ownerUnavailableError } from './owner-refusal.ts';
import { admitWrite, assertReplayIntent, getWriteRequest, intentDigest } from './journal.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';
import { preparePageMutation, prepareFileTarget } from './page-prepare.ts';
import { prepareTakesMutation } from './takes-prepare.ts';
import { digest } from './digest.ts';
import type { PreparedMutation } from './coordinator.ts';
import { isTerminal, type WriteAuthority, type WriteRequest } from './model.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { nativeLockCapability } from './native-lock.ts';
import { assertPhysicalRoot } from './physical-root.ts';
import { isConnectorSourceKind } from './connector-identity.ts';
import { MaintenanceWriteWait } from './maintenance-wait.ts';
import { declaredWriteTrust, lowerToDerivedTier, readDerivationDeclaration, recordTaintEdges, type DerivationDeclaration } from '../trust/taint.ts';

export interface MaintenanceAuthority {
  writer: WriteAuthority;
  binding: WorktreeBinding | null;
  /** #5854: the job's publish wait (one wait per job, bounded by its deadline); a fresh 30 s budget when absent. */
  wait?: MaintenanceWriteWait;
}

function ownerStatusFix(sourceId: string): Action {
  return readFix('Shows the source\'s canonical binding, owner host and any pending recovery.',
    { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });
}

function receiptFix(row: WriteRequest): Action {
  return readFix('The receipt is the record of what this maintenance request did; read it before planning another.',
    { argv: ['gbrain', 'write-request', '--', row.request_id] });
}

function maintenanceRequestId(value: unknown): string {
  const key = digest(value);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
}

/**
 * The cheap up-front part of a managed maintenance preflight, for runs that
 * resolve `maintenancePreflight` lazily at their first write: refuses a
 * caller the coordinator cannot accept (a remote job or writer) and an
 * inactive source before any provider work, dry runs included. Returns
 * whether the brain is managed; needs no canonical owner.
 */
export async function maintenanceCallerPreflight(engine: BrainEngine, sourceId: string): Promise<boolean> {
  if (!await managedPersistenceEnabled(engine)) return false;
  assertPersistenceAccepting(engine);
  const job = currentSubmissionAuthority();
  if (job && job.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    throw trustedCliRequired('Managed fact maintenance requires a local writer; remote maintenance jobs are not supported.');
  }
  const [source] = await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw opError('source_changed', 'The maintenance source is not active.',
    `Source '${sourceId}' is missing or archived, so maintenance submitted nothing and no model was called. Check it with the command in fix; restore an archived source with gbrain sources restore ${sourceId} before running maintenance on it.`,
    { fix: readFix('Lists registered sources, archived ones included.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  return true;
}

export async function maintenancePreflight(engine: BrainEngine, sourceId: string, root?: string,
  opts: { deadlineAtMs?: number | null } = {}): Promise<MaintenanceAuthority | null> {
  if (!await managedPersistenceEnabled(engine)) return null;
  assertPersistenceAccepting(engine);
  const job = currentSubmissionAuthority();
  const verified = currentVerifiedLocalWriter();
  if (job && job.kind !== 'application' || verified?.remote) {
    throw trustedCliRequired('Managed maintenance requires a registered local CLI writer; remote maintenance jobs are not supported.');
  }
  if (!verified) await registerLocalWriter(engine, 'cli');
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; kind: string | null }>(
    "SELECT incarnation,archived,local_path,config->>'kind' AS kind FROM sources WHERE id=$1", [sourceId]);
  if (!source || source.archived) throw opError('source_changed', 'The maintenance source is not active.',
    `Source '${sourceId}' is missing or archived, so maintenance submitted nothing. Check it with the command in fix; restore an archived source with gbrain sources restore ${sourceId} before running maintenance on it.`,
    { fix: readFix('Lists registered sources, archived ones included.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  const writer = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext,
    'submit_job', sourceId, source.incarnation, 'maintenance');
  if (writer.slugPrefixes !== null) throw opError('permission_denied', 'Managed maintenance requires a source-wide grant.',
    `The CLI writer registration is limited to slug prefixes, but maintenance on '${sourceId}' writes anywhere in the source. Review the grant with the command in fix; widening it is the user's decision.`,
    { fix: readFix('Shows the CLI writer registration and its source, operation and slug-prefix grant.', { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'] }) });
  const binding = await getWorktreeBinding(engine, sourceId);
  // An unbound Google or GitHub source publishes database-only, exactly as its own connector sync does
  // (its local_path is the connector's state directory, not a canonical checkout).
  if (!binding && isConnectorSourceKind(source.kind)) {
    writer.databaseOnlyReason = 'connector_database';
    return { writer, binding: null, wait: new MaintenanceWriteWait(opts.deadlineAtMs) };
  }
  const writeThrough = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  const configuredRoot = source.local_path || (sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  if (writeThrough && (root || configuredRoot || binding)) {
    const hostId = localHostId();
    const owner = checkOwner(binding, source.incarnation, hostId);
    if (owner.reason) throw ownerUnavailableError({ sourceId, reason: owner.reason, binding, incarnation: source.incarnation, hostId, remote: false, work: 'maintenance' });
    if (root && realpathSync(root) !== realpathSync(join(owner.binding.local_path, owner.binding.relative_path))) {
      throw opError('source_changed', 'The maintenance directory is not the canonical source root.',
        `Run maintenance for '${sourceId}' against its registered canonical root (the command in fix shows it), or without a directory argument; nothing was submitted.`,
        { fix: ownerStatusFix(sourceId) });
    }
    await nativeLockCapability();
    assertPhysicalRoot(owner.binding.local_path, { worktreeId: owner.binding.worktree_id, coordinationPath: owner.binding.coordination_path });
  }
  if (!writeThrough) writer.databaseOnlyReason = 'disabled_by_config';
  else if (!binding) writer.databaseOnlyReason = 'no_repo_configured';
  return { writer, binding: writeThrough ? binding : null, wait: new MaintenanceWriteWait(opts.deadlineAtMs) };
}

async function validateMaintenance(engine: BrainEngine, authority: MaintenanceAuthority, slug: string): Promise<void> {
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>(
    'SELECT incarnation,archived FROM sources WHERE id=$1', [authority.writer.sourceId]);
  if (!source || source.archived || source.incarnation !== authority.writer.sourceIncarnation) {
    throw opError('source_changed', 'The accepted maintenance source changed.',
      `Source '${authority.writer.sourceId}' was archived or replaced after maintenance started, so nothing more was submitted for it. Check it with the command in fix, then run the maintenance command again so it preflights the current source.`,
      { fix: readFix('Lists registered sources, archived ones included.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  }
  // A connector preflighted as unbound publishes database-only; one claimed since then must use its owner.
  if (authority.writer.databaseOnlyReason === 'connector_database' && await getWorktreeBinding(engine, authority.writer.sourceId)) {
    throw opError('source_changed', 'The connector source gained a canonical owner after maintenance preflight.', 'Rerun the maintenance command.');
  }
  await authorizeWrite(engine, authority.writer, 'submit_job', slug);
  await authorizePageVisibility(engine, authority.writer, slug);
}

async function submitMaintenance(engine: BrainEngine, authority: MaintenanceAuthority, slug: string,
  intent: Record<string, unknown>, requestId: string, file = true): Promise<Record<string, unknown>> {
  await validateMaintenance(engine, authority, slug);
  const wait = authority.wait ??= new MaintenanceWriteWait();
  const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
  if (prior) {
    await authorizeStoredRequest(engine, prior);
    assertReplayIntent(prior, intentDigest({ operation: 'submit_job', sourceId: authority.writer.sourceId, slug, callerIntent: intent }));
    return writeResponse(wait.observe(await waitForWrite(engine, prior, loadConfig() ?? { engine: engine.kind }, wait.ms())));
  }
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: authority.writer.sourceId, includeDeleted: true });
  // A deleted-page intent (extract_facts expiring a soft-deleted page's facts) admits only a page that is still soft-deleted.
  if (intent.deleted_page === true && !snapshot?.page.deleted_at) {
    throw opError('page_identity_changed', 'The deleted page was restored or purged before maintenance admitted its request.',
      `Page ${slug} in '${authority.writer.sourceId}' is no longer soft-deleted, so nothing was submitted for it. Run maintenance again to plan from the current pages.`);
  }
  // #5876: only a Life Chronicle event its extractor retired may be restored by a later generation.
  if (snapshot?.page.deleted_at && intent.deleted_page !== true && !(intent.restore_retired === true && snapshot.page.frontmatter?.retired_by === 'life-chronicle')) {
    throw opError('page_not_found', 'Maintenance cannot restore a deleted page.',
      `Page ${slug} in '${authority.writer.sourceId}' was deleted after maintenance read it, and maintenance never recreates deleted pages; nothing was submitted. Run maintenance again to plan from the current pages.`);
  }
  if ((snapshot?.revision ?? null) !== intent.expected_revision) throw opError('revision_conflict', 'The maintenance target changed before admission.',
    `Page ${slug} in '${authority.writer.sourceId}' changed after maintenance read it; nothing was submitted. Run maintenance again so it works from the current revision.`);
  // #6278: the same fence scan the canonical projection runs, over the whole
  // submitted body and timeline, before a request exists. A fence defect the
  // write would not clear (a second facts fence in the timeline survives
  // every adoption, which replaces only the first fence) is refused here with
  // its fence reason, so maintenance skips the page instead of admitting a
  // request that fails at preparation; the census already lists the stored
  // defect as a repair candidate. A repair whose postimage is clean passes.
  if (typeof intent.content === 'string') {
    const scan = scanCanonicalFences(parseMarkdown(intent.content, slug));
    if (scan.defects.length) throw fenceOperationError(scan.defects[0]!, slug, authority.writer.sourceId);
  }
  const row = await admitWrite(engine, { principal: authority.writer.principal, requestId, operation: 'submit_job',
    sourceId: authority.writer.sourceId, sourceIncarnation: authority.writer.sourceIncarnation, slug,
    pageId: snapshot?.page.id ?? null, authority: authority.writer, callerIntent: intent, intent,
    worktreeId: file ? authority.binding?.worktree_id : null, topologyGeneration: file ? authority.binding?.topology_generation : null });
  return writeResponse(wait.observe(await waitForWrite(engine, row, loadConfig() ?? { engine: engine.kind }, wait.ms())));
}

/** #5523: a Life Chronicle timeline row projected onto the depth page in the same publication. */
export interface MaintenanceEventProjection { depth_slug: string; date: string; summary: string; }

/** `derivation` (#5575 I2): the deriver's taint declaration; the page and its edges are stamped from it at publication. */
export async function publishMaintenancePage(engine: BrainEngine, authority: MaintenanceAuthority, slug: string,
  content: string, options: { requestId?: string; expectedRevision: string | null; file?: boolean;
    eventProjection?: MaintenanceEventProjection; derivation?: DerivationDeclaration }): Promise<Record<string, unknown>> {
  const projection = options.eventProjection ? { event_projection: options.eventProjection } : {};
  const derivation = options.derivation ? { derivation: options.derivation } : {};
  return submitMaintenance(engine, authority, slug, { kind: 'managed_maintenance_page', content,
    expected_revision: options.expectedRevision, ...projection, ...derivation }, options.requestId ?? maintenanceRequestId({ authority: authority.writer,
    slug, content, revision: options.expectedRevision, file: options.file ?? true, ...projection, ...derivation }), options.file);
}

/** A maintenance request with its own intent kind, keyed by the intent (a retry replays its receipt). */
export async function submitMaintenanceIntent(engine: BrainEngine, authority: MaintenanceAuthority, slug: string,
  intent: Record<string, unknown> & { kind: string; expected_revision: string | null }, requestId?: string): Promise<Record<string, unknown>> {
  return submitMaintenance(engine, authority, slug, intent, requestId ?? maintenanceRequestId({ authority: authority.writer, slug, intent }));
}

/**
 * A database-only maintenance request under a caller-chosen request id: a
 * preview-approved item (`gbrain repair extractor-facts`) replays its own id
 * after a crash. No worktree is bound, so no file is staged.
 */
export async function submitDatabaseMaintenanceIntent(engine: BrainEngine, authority: MaintenanceAuthority, slug: string,
  intent: Record<string, unknown> & { kind: string; expected_revision: string | null }, requestId: string): Promise<Record<string, unknown>> {
  return submitMaintenance(engine, authority, slug, intent, requestId, false);
}

/** `derivation` (#5575 I2): the deriver's taint declaration, stamped onto the output page. */
export async function stampMaintenancePage(engine: BrainEngine, authority: MaintenanceAuthority, slug: string,
  cycleDate: string, rawSource?: string, rawTraceExemptReason?: string, seat?: string | null, derivation?: DerivationDeclaration): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: authority.writer.sourceId });
  if (!snapshot) throw opError('page_not_found', 'A maintenance output page disappeared.',
    `Output page ${slug} in '${authority.writer.sourceId}' no longer exists, so it was not stamped. Confirm with the command in fix, then run maintenance again to regenerate it if it is still wanted.`,
    { fix: readFix('Shows whether the page exists in this source now.', { argv: ['gbrain', 'get', '--source', authority.writer.sourceId, '--', slug] }) });
  const firstDate = snapshot.page.frontmatter.dream_created_cycle_date || snapshot.page.frontmatter.dream_cycle_date || cycleDate;
  const { seat: _staleSeat, ...kept } = snapshot.page.frontmatter;
  const page = { ...snapshot.page, frontmatter: { ...(seat === null ? kept : snapshot.page.frontmatter), dream_generated: true,
    dream_cycle_date: firstDate, dream_created_cycle_date: firstDate, ...(rawSource ? { raw_source: rawSource } : {}),
    ...(rawTraceExemptReason ? { raw_trace_exempt: true, raw_trace_exempt_reason: rawTraceExemptReason } : {}),
    ...(seat ? { seat } : {}) } };
  await publishMaintenancePage(engine, authority, slug, serializePageToMarkdown(page, snapshot.tags), { expectedRevision: snapshot.revision,
    ...(derivation ? { derivation } : {}) });
}

export async function verifyMaintenanceOutputs(engine: BrainEngine, authority: MaintenanceAuthority,
  refs: Array<{ slug: string; source_id: string }>): Promise<number> {
  for (const ref of refs) {
    if (ref.source_id !== authority.writer.sourceId) throw opError('permission_denied', 'A maintenance output belongs to another source.',
      `Output ${ref.slug} is in source '${ref.source_id}', but this maintenance run is authorized only for '${authority.writer.sourceId}'; outputs were not verified. Run maintenance separately per source, and report this to the user if it repeats, since a phase must only emit pages in its own source.`);
    await validateMaintenance(engine, authority, ref.slug);
    const snapshot = await engine.readPageSnapshot(ref.slug, { sourceId: ref.source_id });
    if (!snapshot) throw opError('page_not_found', 'A maintenance output page disappeared.',
      `Output page ${ref.slug} in '${ref.source_id}' no longer exists, so it was not verified. Confirm with the command in fix, then run maintenance again to regenerate it if it is still wanted.`,
      { fix: readFix('Shows whether the page exists in this source now.', { argv: ['gbrain', 'get', '--source', ref.source_id, '--', ref.slug] }) });
    if (authority.binding) await prepareFileTarget(engine, { source_id: ref.source_id, slug: ref.slug,
      worktree_id: authority.binding.worktree_id }, snapshot, serializePageToMarkdown(snapshot.page, snapshot.tags));
  }
  return authority.binding ? refs.length : 0;
}

export interface FactSnapshot { id: number; value: Record<string, unknown>; }
interface EvidencePage { slug: string; revision: string; id: number; }

/** Whole fact rows as comparable snapshots; `lock` takes FOR UPDATE inside a transaction. */
export async function readFacts(engine: BrainEngine, sourceId: string, ids: number[], lock = false): Promise<FactSnapshot[]> {
  const rows = await engine.executeRaw<FactSnapshot>(`SELECT f.id,jsonb_build_object(
      'source_id',f.source_id,'entity_slug',f.entity_slug,'source_markdown_slug',f.source_markdown_slug,'row_num',f.row_num,
      'fact',f.fact,'kind',f.kind,'visibility',f.visibility,'notability',f.notability,'context',f.context,
      'valid_from',f.valid_from,'valid_until',f.valid_until,'expired_at',f.expired_at,'superseded_by',f.superseded_by,
      'consolidated_at',f.consolidated_at,'consolidated_into',f.consolidated_into,
      'source',f.source,'source_session',f.source_session,'confidence',f.confidence,
      'claim_metric',f.claim_metric,'claim_value',f.claim_value,'claim_unit',f.claim_unit,'claim_period',f.claim_period,
      'event_type',f.event_type,'dimension',f.dimension,'value',f.value,'dim_status',f.dim_status,'attributed_to',f.attributed_to
    ) AS value FROM facts f
    WHERE f.source_id=$1 AND f.id=ANY($2::integer[]) ORDER BY f.id${lock ? ' FOR UPDATE' : ''}`, [sourceId, ids]);
  return rows.map(row => ({ ...row, id: Number(row.id) }));
}

export async function submitMaintenanceConsolidation(engine: BrainEngine, authority: MaintenanceAuthority,
  slug: string, cluster: FactRow[], take: { claim: string; weight: number; source: string; since: string },
  derivation?: DerivationDeclaration): Promise<Record<string, unknown>> {
  const sourceId = authority.writer.sourceId;
  const facts = await readFacts(engine, sourceId, cluster.map(f => f.id));
  if (facts.length !== cluster.length || facts.some(f => f.value.visibility !== 'world' || f.value.expired_at || f.value.consolidated_at)) {
    throw opError('revision_conflict', 'The consolidation facts are no longer eligible.',
      `Facts on ${slug} in '${sourceId}' were expired, consolidated or made private after clustering; nothing was submitted. The next consolidate run re-clusters the current facts.`);
  }
  for (const fact of facts) {
    const observed = cluster.find(f => f.id === fact.id)!;
    if (fact.value.fact !== observed.fact || fact.value.entity_slug !== slug || fact.value.confidence !== observed.confidence ||
      fact.value.source !== observed.source || fact.value.source_session !== observed.source_session ||
      Date.parse(String(fact.value.valid_from)) !== observed.valid_from.getTime()) {
      throw opError('revision_conflict', 'The consolidation input changed after clustering.',
        `A fact on ${slug} in '${sourceId}' was edited after clustering; nothing was submitted. The next consolidate run re-clusters the current facts.`);
    }
  }
  const pages: EvidencePage[] = [];
  for (const pageSlug of [...new Set([slug, ...facts.map(f => f.value.source_markdown_slug).filter((s): s is string => typeof s === 'string' && !!s)])].sort()) {
    const snapshot = await engine.readPageSnapshot(pageSlug, { sourceId, excludePrivate: true });
    if (!snapshot) throw opError('page_not_found', 'The consolidation evidence page is unavailable.',
      `Evidence page ${pageSlug} in '${sourceId}' was deleted or made private after clustering; nothing was submitted. The next consolidate run re-clusters without it.`);
    pages.push({ slug: pageSlug, revision: snapshot.revision, id: snapshot.page.id });
  }
  const target = pages.find(p => p.slug === slug)!;
  const intent = { kind: 'managed_maintenance_consolidate', expected_revision: target.revision, facts, pages, ...take, ...(derivation ? { derivation } : {}) };
  const requestId = maintenanceRequestId({ source: authority.writer.sourceIncarnation, slug, intent });
  return submitMaintenance(engine, authority, slug, intent, requestId);
}

/** One legacy fact the v0.32.2 backfill adopts at a fence position; `hash` pins its whole row at admission. */
export interface FactFenceAssignment { id: number; row_num: number; hash: string }

/**
 * v0.32.2 on a managed brain: publish the page with its rendered facts fence
 * and adopt the legacy rows in place, so the canonical projection matches
 * them by (source, page, row_num) instead of inserting duplicates.
 */
export async function submitFactFenceAdoption(engine: BrainEngine, authority: MaintenanceAuthority, slug: string,
  options: { content: string; expectedRevision: string; assignments: Array<{ id: number; row_num: number }>; file: boolean }): Promise<Record<string, unknown>> {
  const current = await readFacts(engine, authority.writer.sourceId, options.assignments.map(a => a.id));
  const facts: FactFenceAssignment[] = options.assignments.map(a => ({ ...a, hash: digest(current.find(f => f.id === a.id)?.value ?? null) }));
  const intent = { kind: 'managed_maintenance_adopt_fact_fence', expected_revision: options.expectedRevision,
    source_incarnation: authority.writer.sourceIncarnation, content: options.content, facts };
  // A retry replays a pending or committed receipt; after a terminal refusal
  // (a drifted file, a conflict) the same inputs get a fresh attempt identity.
  for (let attempt = 0; ; attempt++) {
    const requestId = maintenanceRequestId({ authority: authority.writer, slug, intent, ...(attempt ? { attempt } : {}) });
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (!prior || prior.state === 'committed' || !isTerminal(prior)) return submitMaintenance(engine, authority, slug, intent, requestId, options.file);
  }
}

/**
 * `clock` (#6278): the claim's phase clock; the adoption's await boundaries (read facts, parse, occupied rows, the page) name
 * their step, and its preparation reads of `facts` run bounded by the remaining budget (`boundedReads`).
 */
async function prepareFactFenceAdoption(unbounded: BrainEngine, row: WriteRequest, config: GBrainConfig, clock?: ClaimPhaseClock): Promise<PreparedMutation> {
  const engine = boundedReads(unbounded, clock);
  const p = row.intent!;
  const facts = p.facts as FactFenceAssignment[];
  if (p.source_incarnation !== row.source_incarnation) throw opError('source_changed', 'The fact adoption source changed.',
    `Source ${row.source_id} was replaced after fact-fence adoption request ${row.request_id} for ${row.slug} was accepted, so nothing was published. Read the receipt with gbrain write-request -- ${row.request_id}; the next fact backfill run plans against the current source.`,
    { fix: receiptFix(row) });
  if (new Set(facts.map(f => f.id)).size !== facts.length || new Set(facts.map(f => f.row_num)).size !== facts.length) {
    throw opError('invalid_params', 'A fact adoption assigns one fact or fence position twice.',
      `Fact-fence adoption request ${row.request_id} for ${row.slug} in ${row.source_id} was refused before publication; nothing changed. The plan itself is malformed, so report the request ID to the user rather than running the same backfill again.`,
      { fix: receiptFix(row) });
  }
  enterClaimStep(clock, 'adoption_parse_fence');
  const fence = new Map(parseFactsFence(p.content as string).facts.map(f => [f.rowNum, f]));
  // `lock` is the publication transaction's re-check: the claim's clock stamps only the preparation's reads.
  const check = async (db: BrainEngine, lock: boolean) => {
    if (!lock) enterClaimStep(clock, 'adoption_read_facts', undefined, 'db');
    const current = await readFacts(db, row.source_id, facts.map(f => f.id), lock);
    for (const assignment of facts) {
      const fact = current.find(f => f.id === assignment.id);
      if (!fact || digest(fact.value) !== assignment.hash || fact.value.entity_slug !== row.slug
        || fact.value.row_num !== null || fact.value.expired_at !== null) {
        throw opError('revision_conflict', 'A legacy fact changed, was already adopted or moved to another owner before adoption.',
          `A legacy fact on ${row.slug} in ${row.source_id} changed before fact-fence adoption request ${row.request_id} published; nothing was written. The next fact backfill run re-reads the facts and plans a fresh request.`,
          { fix: receiptFix(row) });
      }
      // #6278: the fence codec trims and folds line endings, so the cell is
      // compared with the legacy text modulo that whitespace; the cell's text
      // is what the projection expects and is written back on apply.
      const cell = fence.get(assignment.row_num);
      if (!cell?.active || cell.claim === '' || normalizeClaimWhitespace(cell.claim) !== normalizeClaimWhitespace(String(fact.value.fact))
        || cell.visibility !== fact.value.visibility) {
        throw opError('fence_unrenderable', 'The adopted fence row does not render its legacy fact.',
          `Fact-fence adoption request ${row.request_id} for ${row.slug} in ${row.source_id} was refused before publication; nothing changed. Fence row ${assignment.row_num} does not read back as legacy fact ${assignment.id} (${!cell ? 'the row is missing from the rendered fence' : !cell.active ? 'it reads back struck' : cell.claim === '' ? 'it reads back empty' : cell.visibility !== fact.value.visibility ? 'its visibility differs' : 'its text differs by more than whitespace'}). This is a gbrain planning defect, not caller input: report the request ID with the gbrain version; the legacy fact stays active and searchable and nothing is lost.`,
          { fix: receiptFix(row) });
      }
    }
    if (!lock) enterClaimStep(clock, 'adoption_occupied_rows', undefined, 'db');
    const occupied = await db.executeRaw(`SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2
      AND row_num=ANY($3::integer[])${lock ? ' FOR UPDATE' : ''}`, [row.source_id, row.slug, facts.map(f => f.row_num)]);
    if (occupied.length) throw opError('revision_conflict', 'An adopted fence position is already owned by another fact.',
      `Another fact took a fence row on ${row.slug} in ${row.source_id} before adoption request ${row.request_id} published; nothing was written. The next fact backfill run plans from the current fence.`,
      { fix: receiptFix(row) });
  };
  await check(engine, false);
  const prepared = await preparePageMutation(unbounded, { ...row, intent: { kind: 'managed_maintenance_page', content: p.content,
    expected_revision: p.expected_revision } }, config, undefined, undefined, { clock });
  return { ...prepared, validate: async tx => { await prepared.validate?.(tx); await check(tx, true); }, apply: async tx => {
    // Runs ahead of the page import and its canonical projection, so the
    // projection's expiry pass and insertFacts see the adopted positions.
    // The fence cell's parsed text is written back with the row number: the
    // projection expires any row whose (row_num, fact, visibility) differs from
    // its fence row and inserts a new one, which would lose the legacy id.
    const adopted = await tx.executeRaw(`UPDATE facts f SET row_num=a.row_num,source_markdown_slug=$2,fact=a.fact
      FROM jsonb_to_recordset($3::text::jsonb) AS a(id integer,row_num integer,fact text)
      WHERE f.source_id=$1 AND f.id=a.id AND f.row_num IS NULL RETURNING f.id`,
    [row.source_id, row.slug, JSON.stringify(facts.map(({ id, row_num }) => ({ id, row_num, fact: fence.get(row_num)!.claim })))]);
    if (adopted.length !== facts.length) throw opError('revision_conflict', 'A legacy fact was adopted by another run.',
      `Another run adopted a legacy fact on ${row.slug} in ${row.source_id} while request ${row.request_id} was publishing, so its transaction rolled back. Read the receipt with gbrain write-request -- ${row.request_id} for the final state before planning any new adoption.`,
      { fix: receiptFix(row) });
    const outcome = await applyPreservingTakeResolutions(tx, row.page_id, prepared);
    return { ...outcome, facts_adopted: facts.length };
  } };
}

/**
 * Apply a page publication that republishes the page's takes fence unchanged.
 * Its projection would clear take resolutions recorded only in the database,
 * so they are restored afterwards in the same transaction.
 */
export async function applyPreservingTakeResolutions(tx: BrainEngine, pageId: number | null, prepared: PreparedMutation): Promise<Record<string, unknown>> {
  const resolved = await tx.executeRaw<Record<string, unknown>>(`SELECT row_num,resolved_at,resolved_quality,resolved_outcome,
    resolved_source,resolved_value,resolved_unit,resolved_by FROM takes WHERE page_id=$1 AND resolved_at IS NOT NULL`, [pageId]);
  const outcome = await prepared.apply(tx);
  for (const take of resolved) await tx.executeRaw(`UPDATE takes SET resolved_at=$3,resolved_quality=$4,resolved_outcome=$5,
    resolved_source=$6,resolved_value=$7,resolved_unit=$8,resolved_by=$9 WHERE page_id=$1 AND row_num=$2 AND resolved_at IS NULL`,
  [pageId, take.row_num, take.resolved_at, take.resolved_quality, take.resolved_outcome, take.resolved_source,
    take.resolved_value, take.resolved_unit, take.resolved_by]);
  return outcome;
}

/**
 * #5575 I2: a maintenance intent that carries a derivation declaration
 * publishes at the declared tier (never above agent_written), lowers its
 * derived row when the publication changed no content column, and records
 * the complete input edges (ENG-7). A consolidation's takes fence edit
 * keeps the entity page's tier (page-prepare's fence-edit rule).
 */
export async function prepareMaintenanceMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, clock?: ClaimPhaseClock): Promise<PreparedMutation> {
  const prepared = await prepareMaintenanceKind(engine, row, config, clock);
  const declaration = readDerivationDeclaration(row.intent?.derivation);
  if (!declaration) return prepared;
  const trust = declaredWriteTrust(declaration);
  const consolidation = row.intent?.kind === 'managed_maintenance_consolidate';
  return { ...prepared, trust, apply: async (tx, preimage) => {
    const outcome = await prepared.apply(tx, preimage);
    const [derived] = consolidation ? (outcome.take_id ? [{ table: 'takes' as const, id: Number(outcome.take_id) }] : [])
      : (await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [row.source_id, row.slug]))
        .map(page => ({ table: 'pages' as const, id: Number(page.id) }));
    if (derived) {
      await lowerToDerivedTier(tx, derived.table, [derived.id], trust);
      await recordTaintEdges(tx, { ...derived, sourceId: row.source_id }, declaration.inputs);
    }
    return outcome;
  } };
}

/** `clock` (#6278): the claim's phase clock, threaded to the page and adoption preparers' step boundaries. */
async function prepareMaintenanceKind(engine: BrainEngine, row: WriteRequest, config: GBrainConfig, clock?: ClaimPhaseClock): Promise<PreparedMutation> {
  if (row.authority.remote) throw trustedCliRequired('Remote maintenance publication is not supported.');
  enterClaimStep(clock, 'maintenance_dispatch');
  if (row.intent?.kind === 'managed_maintenance_restore_extractor_facts') return (await import('../repair/extractor-facts.ts')).prepareExtractorFactsRestore(engine, row);
  if (row.intent?.kind === 'managed_maintenance_expire_captured_facts') return (await import('../repair/captured-facts.ts')).prepareCapturedFactsExpiry(engine, row);
  if (row.intent?.kind === 'managed_maintenance_conversation_label_retire') return (await import('../repair/conversation-labels.ts')).prepareConversationLabelRetirement(engine, row);
  if (row.intent?.kind === 'managed_maintenance_conversation_facts') return (await import('../facts/conversation-publication.ts')).prepareConversationFactsPublication(engine, row, config);
  if (row.intent?.kind === 'managed_maintenance_fence_facts') return (await import('../cycle/extract-facts.ts')).prepareFenceFactsReconcile(engine, row, config);
  if (row.intent?.kind === 'managed_maintenance_deleted_page_facts_expire') return (await import('../cycle/extract-facts.ts')).prepareDeletedPageFactsExpiry(engine, row);
  if (row.intent?.kind === 'managed_maintenance_takes_reextract') return (await import('../cycle/extract-takes.ts')).prepareTakesReextract(engine, row);
  if (row.intent?.kind === 'managed_maintenance_take_reproject') return (await import('../repair/take-supersession.ts')).prepareTakeReprojection(engine, row);
  if (row.intent?.kind === 'managed_maintenance_timeline_extract') return (await import('../../commands/extract-timeline-db.ts')).prepareTimelineExtract(engine, row);
  if (row.intent?.kind === 'managed_maintenance_page') {
    const prepared = await preparePageMutation(engine, row.intent.expected_revision === null
      ? { ...row, intent: { ...row.intent, expected_revision: undefined } } : row, config, undefined, undefined, { clock });
    const projection = row.intent.event_projection as MaintenanceEventProjection | undefined;
    if (!projection) return prepared;
    // #5523: the event page and its depth-page timeline row commit together in
    // the coordinator's source-scoped transaction; a missing depth page
    // projects nothing, exactly like the legacy writer.
    return { ...prepared, additionalPageKeys: [...prepared.additionalPageKeys ?? [],
      { sourceId: row.source_id, slug: projection.depth_slug }], apply: async tx => {
      const outcome = await prepared.apply(tx);
      const { projected } = await tx.upsertEventProjection({ depthSlug: projection.depth_slug, eventSlug: row.slug,
        date: projection.date, summary: projection.summary, sourceId: row.source_id });
      return { ...outcome, event_projected: projected };
    } };
  }
  if (row.intent?.kind === 'managed_maintenance_adopt_fact_fence') return prepareFactFenceAdoption(engine, row, config, clock);
  if (row.intent?.kind === 'managed_maintenance_phantom_merge') return (await import('../cycle/phantom-redirect-managed.ts')).preparePhantomMerge(engine, row, config);
  if (row.intent?.kind === 'managed_maintenance_phantom_delete') return (await import('../cycle/phantom-redirect-managed.ts')).preparePhantomDelete(engine, row, config);
  if (row.intent?.kind === 'managed_maintenance_chronicle_event' || row.intent?.kind === 'managed_maintenance_chronicle_retire') {
    return (await import('../chronicle/publish.ts')).prepareChronicleMutation(engine, row, config);
  }
  if (row.intent?.kind === 'managed_maintenance_retire_stale_atoms') return (await import('../repair/stale-atoms.ts')).prepareStaleAtomRetirement(engine, row, config);
  if (row.intent?.kind !== 'managed_maintenance_consolidate') throw opError('invalid_params', 'Unsupported maintenance request.',
    `Request ${row.request_id} for ${row.slug} in ${row.source_id} carries a maintenance kind this gbrain version does not publish (likely queued by a newer release); nothing changed. Upgrade gbrain on the brain host, and read the receipt before submitting anything new.`,
    { fix: receiptFix(row) });
  const p = row.intent;
  const facts = p.facts as FactSnapshot[];
  const pages = p.pages as EvidencePage[];
  const [existing] = await engine.executeRaw<{ id: number; row_num: number; active: boolean; resolved_at: unknown }>(
    "SELECT id,row_num,active,resolved_at FROM takes WHERE page_id=$1 AND claim=$2 AND kind='fact' AND holder='self' ORDER BY id LIMIT 1", [row.page_id, p.claim]);
  if (existing && (!existing.active || existing.resolved_at)) {
    return { observedRevision: p.expected_revision as string, noop: true, validate: async tx => {
      const [current] = await tx.executeRaw<{ active: boolean; resolved_at: unknown }>(
        'SELECT active,resolved_at FROM takes WHERE id=$1 AND page_id=$2', [existing.id, row.page_id]);
      if (!current || current.active && !current.resolved_at) throw opError('revision_conflict', 'The retired take changed during preparation.',
        `The take for this consolidation on ${row.slug} in ${row.source_id} was reactivated while request ${row.request_id} was being prepared; nothing was written. The next consolidate run re-reads the take.`,
        { fix: receiptFix(row) });
    }, apply: async () => ({ status: 'skipped', reason: 'retired_take', noop: true,
      facts_consolidated: 0, takes_written: 0, take_id: Number(existing.id) }) };
  }
  const prepared = await prepareTakesMutation(engine, { ...row, operation: existing ? 'takes_update' : 'takes_add',
      intent: existing ? { source: p.source, row_num: Number(existing.row_num), expected_revision: p.expected_revision }
        : { ...p, kind: 'fact', holder: 'self' } }, config);
  return { ...prepared, additionalPageKeys: pages.map(page => ({ sourceId: row.source_id, slug: page.slug })),
    validate: async tx => {
      await prepared.validate?.(tx);
      for (const page of pages) {
        const current = await tx.readPageSnapshot(page.slug, { sourceId: row.source_id, excludePrivate: true });
        if (!current || current.page.id !== page.id || current.revision !== page.revision) {
          throw opError('revision_conflict', 'A consolidation evidence page changed.',
            `Evidence page ${page.slug} in ${row.source_id} changed while consolidation request ${row.request_id} was being prepared; nothing was written. The next consolidate run re-clusters from the current pages.`,
            { fix: receiptFix(row) });
        }
      }
      const current = await readFacts(tx, row.source_id, facts.map(f => f.id), true);
      if (digest(current) !== digest(facts) || current.some(f => f.value.visibility !== 'world' || f.value.expired_at || f.value.consolidated_at ||
        f.value.valid_until && Date.parse(String(f.value.valid_until)) <= Date.now())) {
        throw opError('revision_conflict', 'The consolidation evidence changed.',
          `Facts behind consolidation request ${row.request_id} on ${row.slug} in ${row.source_id} changed or expired before it published; nothing was written. The next consolidate run re-clusters the current facts.`,
          { fix: receiptFix(row) });
      }
    }, apply: async tx => {
      const outcome = await prepared.apply(tx);
      const [take] = await tx.executeRaw<{ id: number }>(
        "SELECT id FROM takes WHERE page_id=$1 AND claim=$2 AND kind='fact' AND holder='self' ORDER BY id LIMIT 1", [row.page_id, p.claim]);
      if (!take) throw opError('storage_error', 'The consolidated take did not commit.',
        `Consolidation request ${row.request_id} on ${row.slug} in ${row.source_id} did not find its take inside the publication transaction, so the transaction rolled back. Read the receipt with gbrain write-request -- ${row.request_id} and check the owner with gbrain sources writer status --source ${row.source_id} --json before any new consolidation.`,
        { fix: receiptFix(row) });
      for (const fact of facts) await tx.consolidateFact(fact.id, take.id);
      const chronological = [...facts].sort((a, b) => Date.parse(String(a.value.valid_from)) - Date.parse(String(b.value.valid_from)) || a.id - b.id);
      for (let i = 0; i < chronological.length - 1; i++) {
        await tx.executeRaw('UPDATE facts SET valid_until=$1::timestamptz WHERE source_id=$2 AND id=$3',
          [chronological[i + 1].value.valid_from, row.source_id, chronological[i].id]);
      }
      return { ...outcome, noop: false, facts_consolidated: facts.length, takes_written: existing ? 0 : 1, take_id: Number(take.id) };
    } };
}
