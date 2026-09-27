import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine, FactRow } from '../engine.ts';
import { loadConfig, type GBrainConfig } from '../config.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { submissionAuthority, authorizeStoredRequest, authorizeWrite } from './authority.ts';
import { currentVerifiedLocalWriter, localHostId, registerLocalWriter } from './identity.ts';
import { getWorktreeBinding, managedPersistenceEnabled, type WorktreeBinding } from './ownership.ts';
import { admitWrite, assertReplayIntent, getWriteRequest, intentDigest } from './journal.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';
import { preparePageMutation, prepareFileTarget } from './page-prepare.ts';
import { prepareTakesMutation } from './takes-prepare.ts';
import { digest } from './digest.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteAuthority, WriteRequest } from './model.ts';
import { authorizePageVisibility } from './page-visibility.ts';
import { nativeLockCapability } from './native-lock.ts';
import { assertPhysicalRoot } from './physical-root.ts';

export interface MaintenanceAuthority {
  writer: WriteAuthority;
  binding: WorktreeBinding | null;
}

function maintenanceRequestId(value: unknown): string {
  const key = digest(value);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
}

export async function maintenancePreflight(engine: BrainEngine, sourceId: string, root?: string): Promise<MaintenanceAuthority | null> {
  if (!await managedPersistenceEnabled(engine)) return null;
  assertPersistenceAccepting(engine);
  const job = currentSubmissionAuthority();
  const verified = currentVerifiedLocalWriter();
  if (job && job.kind !== 'application' || verified?.remote) {
    throw new OperationError('permission_denied', 'Managed maintenance requires a registered local CLI writer; remote maintenance jobs are not supported.');
  }
  if (!verified) await registerLocalWriter(engine, 'cli');
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null }>(
    'SELECT incarnation,archived,local_path FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The maintenance source is not active.');
  const writer = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext,
    'submit_job', sourceId, source.incarnation, 'maintenance');
  if (writer.slugPrefixes !== null) throw new OperationError('permission_denied', 'Managed maintenance requires a source-wide grant.');
  const binding = await getWorktreeBinding(engine, sourceId);
  const writeThrough = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
  const configuredRoot = source.local_path || (sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  if (writeThrough && (root || configuredRoot || binding)) {
    if (!binding || binding.source_incarnation !== source.incarnation || binding.owner_host_id !== localHostId() ||
      binding.state !== 'active' || !binding.local_path || !binding.coordination_path) {
      throw new OperationError('owner_unavailable', 'The maintenance source needs an active canonical owner before model work.');
    }
    if (root && realpathSync(root) !== realpathSync(join(binding.local_path, binding.relative_path))) {
      throw new OperationError('source_changed', 'The maintenance directory is not the canonical source root.');
    }
    await nativeLockCapability();
    assertPhysicalRoot(binding.local_path, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path });
  }
  if (!writeThrough) writer.databaseOnlyReason = 'disabled_by_config';
  else if (!binding) writer.databaseOnlyReason = 'no_repo_configured';
  return { writer, binding: writeThrough ? binding : null };
}

async function validateMaintenance(engine: BrainEngine, authority: MaintenanceAuthority, slug: string): Promise<void> {
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>(
    'SELECT incarnation,archived FROM sources WHERE id=$1', [authority.writer.sourceId]);
  if (!source || source.archived || source.incarnation !== authority.writer.sourceIncarnation) {
    throw new OperationError('source_changed', 'The accepted maintenance source changed.');
  }
  await authorizeWrite(engine, authority.writer, 'submit_job', slug);
  await authorizePageVisibility(engine, authority.writer, slug);
}

async function submitMaintenance(engine: BrainEngine, authority: MaintenanceAuthority, slug: string,
  intent: Record<string, unknown>, requestId: string, file = true): Promise<Record<string, unknown>> {
  await validateMaintenance(engine, authority, slug);
  const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
  if (prior) {
    await authorizeStoredRequest(engine, prior);
    assertReplayIntent(prior, intentDigest({ operation: 'submit_job', sourceId: authority.writer.sourceId, slug, callerIntent: intent }));
    return writeResponse(await waitForWrite(engine, prior, loadConfig() ?? { engine: engine.kind }));
  }
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: authority.writer.sourceId, includeDeleted: true });
  if (snapshot?.page.deleted_at) throw new OperationError('page_not_found', 'Maintenance cannot restore a deleted page.');
  if ((snapshot?.revision ?? null) !== intent.expected_revision) throw new OperationError('revision_conflict', 'The maintenance target changed before admission.');
  const row = await admitWrite(engine, { principal: authority.writer.principal, requestId, operation: 'submit_job',
    sourceId: authority.writer.sourceId, sourceIncarnation: authority.writer.sourceIncarnation, slug,
    pageId: snapshot?.page.id ?? null, authority: authority.writer, callerIntent: intent, intent,
    worktreeId: file ? authority.binding?.worktree_id : null, topologyGeneration: file ? authority.binding?.topology_generation : null });
  return writeResponse(await waitForWrite(engine, row, loadConfig() ?? { engine: engine.kind }));
}

export async function publishMaintenancePage(engine: BrainEngine, authority: MaintenanceAuthority, slug: string,
  content: string, options: { requestId?: string; expectedRevision: string | null; file?: boolean }): Promise<Record<string, unknown>> {
  return submitMaintenance(engine, authority, slug, { kind: 'managed_maintenance_page', content,
    expected_revision: options.expectedRevision }, options.requestId ?? maintenanceRequestId({ authority: authority.writer,
    slug, content, revision: options.expectedRevision, file: options.file ?? true }), options.file);
}

export async function stampMaintenancePage(engine: BrainEngine, authority: MaintenanceAuthority, slug: string,
  cycleDate: string, rawSource?: string): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: authority.writer.sourceId });
  if (!snapshot) throw new OperationError('page_not_found', 'A maintenance output page disappeared.');
  const firstDate = snapshot.page.frontmatter.dream_created_cycle_date || snapshot.page.frontmatter.dream_cycle_date || cycleDate;
  const page = { ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, dream_generated: true,
    dream_cycle_date: firstDate, dream_created_cycle_date: firstDate, ...(rawSource ? { raw_source: rawSource } : {}) } };
  await publishMaintenancePage(engine, authority, slug, serializePageToMarkdown(page, snapshot.tags), { expectedRevision: snapshot.revision });
}

export async function verifyMaintenanceOutputs(engine: BrainEngine, authority: MaintenanceAuthority,
  refs: Array<{ slug: string; source_id: string }>): Promise<number> {
  for (const ref of refs) {
    if (ref.source_id !== authority.writer.sourceId) throw new OperationError('permission_denied', 'A maintenance output belongs to another source.');
    await validateMaintenance(engine, authority, ref.slug);
    const snapshot = await engine.readPageSnapshot(ref.slug, { sourceId: ref.source_id });
    if (!snapshot) throw new OperationError('page_not_found', 'A maintenance output page disappeared.');
    if (authority.binding) await prepareFileTarget(engine, { source_id: ref.source_id, slug: ref.slug,
      worktree_id: authority.binding.worktree_id }, snapshot, serializePageToMarkdown(snapshot.page, snapshot.tags));
  }
  return authority.binding ? refs.length : 0;
}

interface FactSnapshot { id: number; value: Record<string, unknown>; }
interface EvidencePage { slug: string; revision: string; id: number; }

async function readFacts(engine: BrainEngine, sourceId: string, ids: number[], lock = false): Promise<FactSnapshot[]> {
  const rows = await engine.executeRaw<FactSnapshot>(`SELECT f.id,jsonb_build_object(
      'source_id',f.source_id,'entity_slug',f.entity_slug,'source_markdown_slug',f.source_markdown_slug,'row_num',f.row_num,
      'fact',f.fact,'kind',f.kind,'visibility',f.visibility,'notability',f.notability,'context',f.context,
      'valid_from',f.valid_from,'valid_until',f.valid_until,'expired_at',f.expired_at,'superseded_by',f.superseded_by,
      'consolidated_at',f.consolidated_at,'consolidated_into',f.consolidated_into,
      'source',f.source,'source_session',f.source_session,'confidence',f.confidence,
      'claim_metric',f.claim_metric,'claim_value',f.claim_value,'claim_unit',f.claim_unit,'claim_period',f.claim_period,
      'event_type',f.event_type,'dimension',f.dimension,'value',f.value,'dim_status',f.dim_status
    ) AS value FROM facts f
    WHERE f.source_id=$1 AND f.id=ANY($2::integer[]) ORDER BY f.id${lock ? ' FOR UPDATE' : ''}`, [sourceId, ids]);
  return rows.map(row => ({ ...row, id: Number(row.id) }));
}

export async function submitMaintenanceConsolidation(engine: BrainEngine, authority: MaintenanceAuthority,
  slug: string, cluster: FactRow[], take: { claim: string; weight: number; source: string; since: string }): Promise<Record<string, unknown>> {
  const sourceId = authority.writer.sourceId;
  const facts = await readFacts(engine, sourceId, cluster.map(f => f.id));
  if (facts.length !== cluster.length || facts.some(f => f.value.visibility !== 'world' || f.value.expired_at || f.value.consolidated_at)) {
    throw new OperationError('revision_conflict', 'The consolidation facts are no longer eligible.');
  }
  for (const fact of facts) {
    const observed = cluster.find(f => f.id === fact.id)!;
    if (fact.value.fact !== observed.fact || fact.value.entity_slug !== slug || fact.value.confidence !== observed.confidence ||
      fact.value.source !== observed.source || fact.value.source_session !== observed.source_session ||
      Date.parse(String(fact.value.valid_from)) !== observed.valid_from.getTime()) {
      throw new OperationError('revision_conflict', 'The consolidation input changed after clustering.');
    }
  }
  const pages: EvidencePage[] = [];
  for (const pageSlug of [...new Set([slug, ...facts.map(f => f.value.source_markdown_slug).filter((s): s is string => typeof s === 'string' && !!s)])].sort()) {
    const snapshot = await engine.readPageSnapshot(pageSlug, { sourceId, excludePrivate: true });
    if (!snapshot) throw new OperationError('page_not_found', 'The consolidation evidence page is unavailable.');
    pages.push({ slug: pageSlug, revision: snapshot.revision, id: snapshot.page.id });
  }
  const target = pages.find(p => p.slug === slug)!;
  const intent = { kind: 'managed_maintenance_consolidate', expected_revision: target.revision, facts, pages, ...take };
  const requestId = maintenanceRequestId({ source: authority.writer.sourceIncarnation, slug, intent });
  return submitMaintenance(engine, authority, slug, intent, requestId);
}

export async function prepareMaintenanceMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  if (row.authority.remote) throw new OperationError('permission_denied', 'Remote maintenance publication is not supported.');
  if (row.intent?.kind === 'managed_maintenance_page') return preparePageMutation(engine, row.intent.expected_revision === null
    ? { ...row, intent: { ...row.intent, expected_revision: undefined } } : row, config);
  if (row.intent?.kind !== 'managed_maintenance_consolidate') throw new OperationError('invalid_params', 'Unsupported maintenance request.');
  const p = row.intent;
  const facts = p.facts as FactSnapshot[];
  const pages = p.pages as EvidencePage[];
  const [existing] = await engine.executeRaw<{ id: number; row_num: number; active: boolean; resolved_at: unknown }>(
    "SELECT id,row_num,active,resolved_at FROM takes WHERE page_id=$1 AND claim=$2 AND kind='fact' AND holder='self' ORDER BY id LIMIT 1", [row.page_id, p.claim]);
  if (existing && (!existing.active || existing.resolved_at)) {
    return { observedRevision: p.expected_revision as string, noop: true, validate: async tx => {
      const [current] = await tx.executeRaw<{ active: boolean; resolved_at: unknown }>(
        'SELECT active,resolved_at FROM takes WHERE id=$1 AND page_id=$2', [existing.id, row.page_id]);
      if (!current || current.active && !current.resolved_at) throw new OperationError('revision_conflict', 'The retired take changed during preparation.');
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
          throw new OperationError('revision_conflict', 'A consolidation evidence page changed.');
        }
      }
      const current = await readFacts(tx, row.source_id, facts.map(f => f.id), true);
      if (digest(current) !== digest(facts) || current.some(f => f.value.visibility !== 'world' || f.value.expired_at || f.value.consolidated_at ||
        f.value.valid_until && Date.parse(String(f.value.valid_until)) <= Date.now())) {
        throw new OperationError('revision_conflict', 'The consolidation evidence changed.');
      }
    }, apply: async tx => {
      const outcome = await prepared.apply(tx);
      const [take] = await tx.executeRaw<{ id: number }>(
        "SELECT id FROM takes WHERE page_id=$1 AND claim=$2 AND kind='fact' AND holder='self' ORDER BY id LIMIT 1", [row.page_id, p.claim]);
      if (!take) throw new OperationError('storage_error', 'The consolidated take did not commit.');
      for (const fact of facts) await tx.consolidateFact(fact.id, take.id);
      const chronological = [...facts].sort((a, b) => Date.parse(String(a.value.valid_from)) - Date.parse(String(b.value.valid_from)) || a.id - b.id);
      for (let i = 0; i < chronological.length - 1; i++) {
        await tx.executeRaw('UPDATE facts SET valid_until=$1::timestamptz WHERE source_id=$2 AND id=$3',
          [chronological[i + 1].value.valid_from, row.source_id, chronological[i].id]);
      }
      return { ...outcome, noop: false, facts_consolidated: facts.length, takes_written: existing ? 0 : 1, take_id: Number(take.id) };
    } };
}
