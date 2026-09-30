import type { BrainEngine, TakeBatchInput } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { parseTakesFence, upsertTakeRow, supersedeRow, type ParsedTake, type TakeQuality } from '../takes-fence.ts';
import { takesPreparation as edit, TakesWriteError } from '../takes-write.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { preparePageMutation } from './page-prepare.ts';
import { authorizeTakeHolder } from './authority.ts';
import type { WriteRequest } from './model.ts';
import type { PreparedMutation } from './coordinator.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';

/** Server-derived values are frozen after replay lookup, before admission. */
export async function normalizeTakesIntent(ctx: OperationContext, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const date = new Date().toISOString().slice(0,10);
  let resolvedBy = params.resolved_by;
  if (ctx.remote !== false) {
    const id = (ctx.auth?.clientId ?? ctx.transport ?? 'remote').replace(/[^\w.:-]/g,'_').slice(0,64);
    resolvedBy = `mcp:${id}`;
  } else if (typeof resolvedBy !== 'string' || !resolvedBy) {
    const { resolveOwnerHolder } = await import('../owner-holder.ts');
    resolvedBy = resolveOwnerHolder({ configValue: await ctx.engine.getConfig('emotional_weight.user_holder') });
  }
  let holder = params.holder;
  if (holder === 'me' && ctx.remote === false) {
    const { resolveOwnerHolder } = await import('../owner-holder.ts');
    holder = resolveOwnerHolder({ configValue: await ctx.engine.getConfig('emotional_weight.user_holder') });
  }
  return { ...params, holder, resolved_by: resolvedBy, resolved_at: date, since: params.since ?? date,
    since_supplied: params.since !== undefined };
}

function fail(error: unknown): never {
  if (!(error instanceof TakesWriteError)) throw error;
  const code = error.code === 'holder_denied' ? 'permission_denied' : error.code === 'row_not_found' ? 'not_found'
    : error.code === 'page_not_found' ? 'page_not_found' : 'invalid_params';
  throw new OperationError(code, error.message, error.hint);
}
export async function prepareTakesMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  try { return await prepare(engine,row,config); } catch (error) { return fail(error); }
}
async function prepare(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== row.page_id) throw new OperationError('page_identity_changed','The accepted page no longer exists.');
  const p = row.intent!;
  if (p.expected_revision !== undefined) assertPageRevision(snapshot,engineMutationPrecondition(parseMutationPrecondition(p)));
  const body = serializePageToMarkdown(snapshot.page,snapshot.tags);
  const parsed = parseTakesFence(body);
  edit.assertFenceRoundTrips(parsed);
  for (const key of ['claim','kind','holder','source','evidence','unit','resolved_by']) {
    if (p[key] !== undefined && typeof p[key] !== 'string') throw new OperationError('invalid_params',`${key} must be text.`);
    edit.assertSafeCellText(key,p[key] as string | undefined);
  }
  edit.assertValidWeight(p.weight as number | undefined);
  edit.assertValidSinceDate(p.since as string | undefined);
  const holders = row.authority.remote ? row.authority.takesHolders ?? ['world'] : null;
  const requiredHolders = new Set<string>();
  let next = body;
  let changed: ParsedTake[] = [];
  let result: Record<string, unknown>;
  let oldRow: number | undefined;
  if (row.operation === 'takes_add') {
    if (typeof p.claim !== 'string' || !p.claim.trim() || typeof p.kind !== 'string' || typeof p.holder !== 'string') throw new OperationError('invalid_params','claim, kind and holder are required.');
    edit.assertHolderAllowed(p.holder,holders); requiredHolders.add(p.holder);
    const added = upsertTakeRow(body,{claim:p.claim,kind:p.kind,holder:p.holder,weight:p.weight as number ?? 0.5,
      source:p.source as string | undefined,sinceDate:p.since as string,active:true});
    next=added.body; changed=parseTakesFence(next).takes.filter(t=>t.rowNum===added.rowNum);
    result={slug:row.slug,row_num:added.rowNum,holder:p.holder};
  } else {
    if (!Number.isSafeInteger(p.row_num) || Number(p.row_num)<1) throw new OperationError('invalid_params','row_num must be a positive integer.');
    const number=Number(p.row_num);
    const target=edit.findFenceRow(parsed.takes,number,holders,row.slug);
    requiredHolders.add(target.holder);
    if (target.resolvedAt) throw new TakesWriteError('already_resolved','Resolved takes are immutable.');
    if (!target.active) throw new TakesWriteError('row_inactive','The take was superseded.');
    if (row.operation==='takes_supersede') {
      if (typeof p.claim!=='string' || !p.claim.trim()) throw new OperationError('invalid_params','claim is required.');
      const holder=typeof p.holder==='string'?p.holder:target.holder;
      edit.assertHolderAllowed(holder,holders); requiredHolders.add(holder);
      const superseded=supersedeRow(body,number,{claim:p.claim,kind:p.kind as string ?? target.kind,holder,
        weight:p.weight as number ?? Math.max(0,target.weight-0.1),source:p.source as string | undefined,sinceDate:p.since as string});
      next=superseded.body; oldRow=number;
      changed=parseTakesFence(next).takes.filter(t=>t.rowNum===number || t.rowNum===superseded.newRowNum);
      result={slug:row.slug,old_row:number,new_row:superseded.newRowNum};
    } else {
      let updated: ParsedTake;
      if (row.operation==='takes_update') {
        if (p.weight===undefined && p.source===undefined && p.since_supplied!==true) throw new TakesWriteError('no_fields','No mutable fields supplied.');
        updated={...target,weight:p.weight as number ?? target.weight,source:p.source as string ?? target.source,
          sinceDate:p.since_supplied===true?p.since as string:target.sinceDate};
      } else if (row.operation==='takes_resolve') {
        if (!['correct','incorrect','partial','unresolvable'].includes(String(p.quality))) throw new OperationError('invalid_params','Unknown resolution quality.');
        if (p.value!==undefined && (typeof p.value!=='number' || !Number.isFinite(p.value))) throw new OperationError('invalid_params','value must be finite.');
        updated={...target,resolvedAt:String(p.resolved_at),resolvedQuality:p.quality as TakeQuality,
          resolvedOutcome:p.quality==='correct'?true:p.quality==='incorrect'?false:undefined,
          resolvedEvidence:p.evidence as string | undefined,resolvedValue:p.value as number | undefined,
          resolvedUnit:p.unit as string | undefined,resolvedBy:String(p.resolved_by)};
      } else throw new OperationError('invalid_params','Unsupported takes mutation.');
      changed=[updated]; next=edit.replaceFence(body,parsed.takes.map(t=>t.rowNum===number?updated:t));
      result={slug:row.slug,row_num:number,...(row.operation==='takes_resolve'?{quality:p.quality,resolved_by:p.resolved_by}:{})};
    }
  }
  for (const holder of requiredHolders) await authorizeTakeHolder(engine,row.authority,holder);
  const prepared=await preparePageMutation(engine,row,config,{content:next,expectedRevision:snapshot.revision});
  return {...prepared,validate:async tx=>{
    await prepared.validate?.(tx);
    for (const holder of requiredHolders) await authorizeTakeHolder(tx,row.authority,holder);
    await tx.executeRaw(`UPDATE persistence_requests
      SET authority=jsonb_set(authority,'{takeHoldersUsed}',$2::text::jsonb)
      WHERE id=$1::uuid`, [row.id, JSON.stringify([...requiredHolders].sort())]);
  },apply:async tx=>{
    const outcome=await prepared.apply(tx);
    if (!prepared.noop) {
      const batch:TakeBatchInput[]=changed.map(t=>edit.toBatchInput(snapshot.page.id,t,
        t.rowNum===oldRow?Number(result.new_row):null));
      await tx.addTakesBatch(batch);
      if (row.operation==='takes_resolve') {
        const t=changed[0];
        await tx.resolveTake(snapshot.page.id,t.rowNum,{quality:t.resolvedQuality!,outcome:t.resolvedOutcome,
          value:t.resolvedValue,unit:t.resolvedUnit,source:t.resolvedEvidence,resolvedBy:t.resolvedBy!});
        await tx.executeRaw('UPDATE takes SET resolved_at=$3::timestamptz WHERE page_id=$1 AND row_num=$2',[snapshot.page.id,t.rowNum,t.resolvedAt]);
      }
    }
    return {...outcome,...result,mirror_written:!!prepared.file};
  }};
}
