/**
 * GBRA-161 PR 4: the managed activation of a kind whose producer writes its items itself (`publishesInPlace`: synthesis).
 * One admission transaction records the activation and admits the `managed_generation_activate` request and one
 * `managed_generation_retire` member per retired item (version first through the page delete, stamped with the
 * generation's `retired_by`, refusing unless its item is pending on the live generation the activation made). A crash
 * after the activation leaves the items retire_pending (still live): `resumeRetireMembers` finishes them on the next run,
 * and an item edited since keeps its content.
 */
import type { BrainEngine } from '../engine.ts';
import { loadConfig, type GBrainConfig } from '../config.ts';
import { opError } from '../ops/contract.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import { admitWriteInTransaction, getWriteRequest } from '../persistence/journal.ts';
import { MaintenanceWriteWait } from '../persistence/maintenance-wait.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import type { MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { waitForWrite, writeResponse } from '../persistence/service.ts';
import { acceptedPendingReceipt } from '../persistence/accepted-pending.ts';
import type { DerivedRetiredBy } from '../persistence/derived-retirement-hold.ts';
import { generationAdapter } from './adapters/index.ts';
import type { GenerationKey } from './contract.ts';
import { assertMemberPending, GENERATION_ACTIVATE_SLUG, listPendingMembers, memberRequestId, recordActivation, settleMember,
  type ActivationIntent, type ManagedPlan } from './managed.ts';

export const GENERATION_RETIRE_INTENT = 'managed_generation_retire';

interface RetireIntent extends Record<string, unknown> {
  kind: typeof GENERATION_RETIRE_INTENT; activationId: string; generationKey: GenerationKey; expected_revision: string; retiredBy: DerivedRetiredBy;
}

async function waitAll(engine: BrainEngine, maintenance: MaintenanceAuthority, rows: WriteRequest[]): Promise<void> {
  const wait = maintenance.wait ??= new MaintenanceWriteWait();
  const config = loadConfig() ?? { engine: engine.kind };
  for (const row of rows) {
    try { writeResponse(wait.observe(await waitForWrite(engine, row, config as GBrainConfig, wait.ms()))); }
    catch (error) { if (!acceptedPendingReceipt(error)) throw error; }
  }
}

/** Admits a planned publication of an in-place kind: its activation, then one retire member per retired item. Returns the activation id. */
export async function admitInPlaceGeneration(engine: BrainEngine, maintenance: MaintenanceAuthority, plan: Extract<ManagedPlan, { kind: 'publish' }>): Promise<string> {
  const { writer, binding } = maintenance;
  const { activationId, key, retiredBy } = plan.intent;
  const retires: Array<{ slug: string; pageId: number; intent: RetireIntent }> = [];
  for (const member of plan.members) {
    const snapshot = await engine.readPageSnapshot(member.slug, { sourceId: key.sourceId });
    if (member.action !== 'retire' || !snapshot) throw opError('page_identity_changed', 'A page the generation retires changed before admission.',
      `${member.slug} in source ${key.sourceId} was removed or is not a retirement of activation ${activationId}; nothing was admitted. The next run plans again from the pages as they are.`);
    await authorizeWrite(engine, writer, 'delete_page', member.slug);
    retires.push({ slug: member.slug, pageId: Number(snapshot.page.id), intent: { kind: GENERATION_RETIRE_INTENT, activationId, generationKey: key,
      expected_revision: snapshot.revision, retiredBy } });
  }
  const activation: ActivationIntent = { ...plan.intent, runKey: activationId };
  const rows = await engine.transaction(async tx => {
    await recordActivation(tx, plan.intent);
    const admit = (slug: string, pageId: number | null, requestId: string, intent: Record<string, unknown>) => admitWriteInTransaction(tx, {
      principal: writer.principal, authority: writer, operation: 'submit_job', sourceId: key.sourceId, sourceIncarnation: writer.sourceIncarnation,
      worktreeId: binding?.worktree_id, topologyGeneration: binding?.topology_generation, slug, pageId, requestId, callerIntent: intent, intent });
    const accepted = [await admit(GENERATION_ACTIVATE_SLUG, null, activationId, activation)];
    for (const retire of retires) accepted.push(await admit(retire.slug, retire.pageId, memberRequestId(activationId, retire.slug, 'retire'), retire.intent));
    return accepted;
  });
  await waitAll(engine, maintenance, rows);
  return activationId;
}

/** Preparer of `managed_generation_retire` (trusted local only): the versioned page delete of one pending retirement. */
export async function prepareGenerationRetireMember(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent as RetireIntent | null;
  if (!p || p.kind !== GENERATION_RETIRE_INTENT || row.authority.remote || !p.generationKey || p.generationKey.sourceId !== row.source_id
    || !generationAdapter(p.generationKey.kind)?.publishesInPlace) {
    throw opError('permission_denied', 'Unsupported generation retirement request.',
      `Request ${row.request_id} in source ${row.source_id} is not a generation retirement the trusted local writer admitted, so the coordinator refused it before any change. Retirements run only from the gbrain CLI on the brain host.`);
  }
  await assertMemberPending(engine, row, p.activationId, p.generationKey.kind);
  await authorizeWrite(engine, row.authority, 'delete_page', row.slug);
  const prepared = await preparePageMutation(engine, { ...row, operation: 'delete_page' }, config, undefined, undefined, { allowMissingFile: true });
  return { ...prepared, validate: async tx => {
    await assertMemberPending(tx, row, p.activationId, p.generationKey.kind);
    await authorizeWrite(tx, row.authority, 'delete_page', row.slug);
    await prepared.validate?.(tx);
  }, apply: async tx => {
    const result = await prepared.apply(tx);
    if (!prepared.noop) {
      await tx.executeRaw(`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
        WHERE id=$3 AND source_id=$4 AND deleted_at IS NOT NULL`, [p.retiredBy, new Date().toISOString(), row.page_id, row.source_id]);
      await settleMember(tx, p.activationId, row.slug);
    }
    return { ...result, retired_by: p.retiredBy, activation_id: p.activationId };
  } };
}

/**
 * Finishes the retire_pending items an earlier run of `kind` left in this source: a member still queued is waited on; one
 * that ended without committing is submitted again under a fresh id bound to the failed one, unless its page changed
 * since the activation planned it (then the page keeps its content and the mark clears). Returns how many it touched.
 */
export async function resumeRetireMembers(engine: BrainEngine, maintenance: MaintenanceAuthority, kind: string): Promise<number> {
  const { writer, binding } = maintenance;
  const pending = (await listPendingMembers(engine, [writer.sourceId], kind)).filter(member => member.action === 'retire');
  const adapter = generationAdapter(kind)!;
  for (const member of pending) {
    let row = await getWriteRequest(engine, writer.principal, memberRequestId(member.activation_id, member.slug, 'retire'));
    if (row && ['queued', 'running', 'recovering'].includes(row.state)) { await waitAll(engine, maintenance, [row]); row = await getWriteRequest(engine, writer.principal, row.request_id); }
    if (row?.state === 'committed') continue;
    const key: GenerationKey = { kind, sourceId: member.source_id, ownerKey: member.owner_key };
    const snapshot = await engine.readPageSnapshot(member.slug, { sourceId: member.source_id });
    const current = snapshot ? (await adapter.readItems(engine, key, [member.slug])).get(member.slug) : undefined;
    if (!snapshot || !current?.live || current.identityHash !== member.identity) { await engine.transaction(tx => settleMember(tx, member.activation_id, member.slug)); continue; }
    const prior = row?.intent as RetireIntent | undefined;
    const intent: RetireIntent = { kind: GENERATION_RETIRE_INTENT, activationId: member.activation_id, generationKey: key, expected_revision: snapshot.revision,
      retiredBy: prior?.retiredBy ?? adapter.retiredBy };
    const resubmitted = await engine.transaction(tx => admitWriteInTransaction(tx, { principal: writer.principal, authority: writer, operation: 'submit_job',
      sourceId: member.source_id, sourceIncarnation: writer.sourceIncarnation, worktreeId: binding?.worktree_id, topologyGeneration: binding?.topology_generation,
      slug: member.slug, pageId: Number(snapshot.page.id), requestId: memberRequestId(member.activation_id, member.slug, `retire:after:${row?.id ?? 'missing'}`),
      callerIntent: intent, intent }));
    await waitAll(engine, maintenance, [resubmitted]);
  }
  return pending.length;
}
