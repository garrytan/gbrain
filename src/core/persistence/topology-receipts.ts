import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { digest, jsonBytes } from './digest.ts';
import { lockCounters, quotaExhausted } from './journal.ts';
import { journalLimitKey, oneYearCapacity, readJournalLimits } from './limits.ts';
import { principalKey } from './model.ts';
import { receiptReservation, retainedReceiptBytes } from './receipt-bytes.ts';

export interface TopologyChange {
  id:string; principal_id:string; request_id:string; digest:string; operation:string; source_id:string;
  source_incarnation:string|null; worktree_ids:string[]; state:'recovering'|'committed'|'failed';
  recovery:Record<string,unknown>|null; recovery_bytes:number; intent_bytes:number; terminal_bytes:number; outcome:Record<string,unknown>|null;
}
export async function priorTopologyChange(engine:BrainEngine,principal:string,requestId:string,intent:unknown):Promise<TopologyChange|null> {
  const page=await engine.executeRaw("SELECT id FROM persistence_requests WHERE principal_kind='local_cli' AND principal_id=$1 AND request_id=$2::uuid",[principal,requestId]);
  if(page.length) throw opError('idempotency_conflict','This request_id belongs to a page mutation.',
    `Request ${requestId} already names a page write, so this lifecycle change was not accepted. Submit it with a new request id, or omit the id so gbrain generates one.`);
  const [prior]=await engine.executeRaw<TopologyChange>('SELECT * FROM persistence_topology_changes WHERE principal_id=$1::uuid AND request_id=$2::uuid',[principal,requestId]);
  if(prior && prior.digest!==digest(intent)) throw opError('idempotency_conflict','This lifecycle request_id was accepted with different arguments.',
    `Request ${requestId} was accepted for a ${prior.operation} of source ${prior.source_id} with other arguments. Reuse it only to resubmit that identical command; give a different change a new request id.`);
  return prior??null;
}
export async function recordTopologyChange(tx:BrainEngine, input:{principal:string;requestId:string;intent:unknown;operation:string;sourceId:string;incarnation:string|null;worktrees:string[]},
  outcome:Record<string,unknown>, recovery:Record<string,unknown>|null=null,recoveryBytes=0):Promise<TopologyChange> {
  const reservation=receiptReservation({});
  const intentBytes=recovery?jsonBytes(input.intent):0;
  if(Buffer.byteLength(JSON.stringify(outcome))+1024>reservation) throw opError('request_too_large','Lifecycle outcome exceeds its retained receipt capacity.',
    `The ${input.operation} of source ${input.sourceId} would record an outcome over ${reservation - 1024} bytes, so nothing was recorded. Report this to the user with the request id ${input.requestId}; it is not a caller mistake.`);
  // #6696 (A1): a change recorded committed keeps only its outcome, so it is trued up at insert; a recovering one keeps the reservation.
  const terminalBytes=recovery?reservation:Math.min(reservation,retainedReceiptBytes({outcome},{stage:'terminal'}));
  const limits=await readJournalLimits(tx);
  const key=principalKey({kind:'local_cli',id:input.principal});
  const counters=await lockCounters(tx,['brain',key,...input.worktrees.map(id=>`worktree:${id}`)]);
  const admitted=await priorTopologyChange(tx,input.principal,input.requestId,input.intent);
  if(admitted&&!recovery&&isRetireAdmission(admitted)){
    const settled=await settleTopologyRetire(tx,admitted,'committed',outcome);
    if(settled)return settled;
  }
  for(const counter of counters){
    const brain=counter.key==='brain';
    if(!counter.key.startsWith('worktree:')){
      await assertQuota(tx,counter,limits,terminalBytes,input);
      if(recovery && (Number(counter.outstanding_count)+1>(brain?limits.brainOutstanding:limits.principalOutstanding)
        ||Number(counter.intent_bytes)+intentBytes>(brain?limits.brainIntentBytes:limits.principalIntentBytes)))
        throw opError('queue_capacity','Pending lifecycle work exceeds available brain/principal request or intent capacity.',
          `Too much lifecycle work is still pending, so the ${input.operation} of source ${input.sourceId} was not accepted. Let the pending work settle, then submit it again; raising ${journalLimitKey(brain?'brainOutstanding':'principalOutstanding')} is the user's call.`, { fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', input.sourceId, '--json'], consent: [], actor: 'agent', why: 'Shows the pending lifecycle and recovery work that holds this capacity.', requires_exclusive: false } });
    }
    if(recoveryBytes && counter.key!==key && Number(counter.recovery_bytes)+recoveryBytes>(brain?limits.brainRecoveryBytes:limits.worktreeRecoveryBytes))
      throw opError('queue_capacity','The lifecycle recovery exceeds available brain/worktree capacity.',
        `Recovery records already use the ${journalLimitKey(brain?'brainRecoveryBytes':'worktreeRecoveryBytes')} budget, so the ${input.operation} of source ${input.sourceId} was not accepted. Let recovery settle first; raising the cap is the user's call and recovery records are never removed.`, { fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', input.sourceId, '--json'], consent: [], actor: 'agent', why: 'Shows the pending lifecycle and recovery work that holds this capacity.', requires_exclusive: false } });
  }
  const [row]=await tx.executeRaw<TopologyChange>(`INSERT INTO persistence_topology_changes
    (principal_id,request_id,digest,operation,source_id,source_incarnation,worktree_ids,state,recovery,recovery_bytes,terminal_bytes,outcome,intent_bytes)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid[],$8,$9::text::jsonb,$10,$11,$12::text::jsonb,$13) RETURNING *`,
  [input.principal,input.requestId,digest(input.intent),input.operation,input.sourceId,input.incarnation,input.worktrees,recovery?'recovering':'committed',
    recovery?JSON.stringify(recovery):null,recoveryBytes,terminalBytes,JSON.stringify(outcome),intentBytes]);
  for(const counter of counters){
    if(!counter.key.startsWith('worktree:')) await tx.executeRaw('UPDATE persistence_counters SET lifetime_ids=lifetime_ids+1,terminal_bytes=terminal_bytes+$2 WHERE key=$1',[counter.key,terminalBytes]);
    if(recovery && !counter.key.startsWith('worktree:')) await tx.executeRaw('UPDATE persistence_counters SET outstanding_count=outstanding_count+1,intent_bytes=intent_bytes+$2 WHERE key=$1',[counter.key,intentBytes]);
    if(recoveryBytes && counter.key!==key) await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$2 WHERE key=$1',[counter.key,recoveryBytes]);
  }
  return row;
}
type JournalLimits=Awaited<ReturnType<typeof readJournalLimits>>;
type Counter=Awaited<ReturnType<typeof lockCounters>>[number];
async function assertQuota(tx:BrainEngine,counter:Counter,limits:JournalLimits,terminalBytes:number,input:{operation:string;sourceId:string}):Promise<void>{
  const brain=counter.key==='brain';
  const ids=Number(counter.lifetime_ids)+1>(brain?limits.brainLifetimeIds:limits.principalLifetimeIds);
  if(!ids&&Number(counter.terminal_bytes)+terminalBytes<=(brain?limits.brainTerminalBytes:limits.principalTerminalBytes)) return;
  const setting=`${brain?'brain':'principal'}${ids?'LifetimeIds':'TerminalBytes'}` as const;
  const used=Number(ids?counter.lifetime_ids:counter.terminal_bytes);
  throw quotaExhausted(`${brain?'brain':'principal'} ${ids?'permanent request IDs':'reserved receipt bytes'} (lifecycle ${input.operation} of source ${input.sourceId})`,
    journalLimitKey(setting),await oneYearCapacity(tx,counter.key,ids?'LifetimeIds':'TerminalBytes',used,limits[setting]),used,limits[setting],ids?'lifetime_ids':'terminal_bytes');
}
/**
 * #8984: a remove or purge that deletes pages in batches (#7702/#8905) first records, in the transaction of its first
 * batch, which incarnation of the source its request_id was admitted against: a recovering row with no recovery
 * record, holding one lifetime ID and a full receipt reservation (so it refuses on a spent quota before deleting
 * anything). recordTopologyChange settles it committed; a retry against another incarnation settles it failed.
 */
export function isRetireAdmission(row:TopologyChange):boolean{
  return row.state==='recovering'&&row.recovery===null&&['remove','purge'].includes(row.operation);
}
export const RETIRE_SUPERSEDED='source_retire_superseded';
export function isSupersededRetire(row:TopologyChange):boolean{
  return row.state==='failed'&&row.outcome?.error===RETIRE_SUPERSEDED;
}
export async function admitTopologyRetire(tx:BrainEngine,input:{principal:string;requestId:string;intent:unknown;operation:string;sourceId:string;incarnation:string;worktrees:string[];expiredOnly?:boolean}):Promise<void>{
  const limits=await readJournalLimits(tx);
  const reservation=receiptReservation({});
  const counters=await lockCounters(tx,['brain',principalKey({kind:'local_cli',id:input.principal})]);
  for(const counter of counters) await assertQuota(tx,counter,limits,reservation,input);
  await tx.executeRaw(`INSERT INTO persistence_topology_changes
    (principal_id,request_id,digest,operation,source_id,source_incarnation,worktree_ids,state,terminal_bytes,outcome)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid[],'recovering',$8,$9::text::jsonb)`,
  [input.principal,input.requestId,digest(input.intent),input.operation,input.sourceId,input.incarnation,input.worktrees,reservation,
    JSON.stringify({operation:input.operation,source_id:input.sourceId,source_incarnation:input.incarnation,...(input.expiredOnly?{expired_only:true}:{})})]);
  for(const counter of counters) await tx.executeRaw('UPDATE persistence_counters SET lifetime_ids=lifetime_ids+1,terminal_bytes=terminal_bytes+$2 WHERE key=$1',[counter.key,reservation]);
}
/** Settles a retire admission and trues its reserved receipt bytes up to the outcome it keeps; null when already settled. */
export async function settleTopologyRetire(tx:BrainEngine,row:TopologyChange,state:'committed'|'failed',outcome:Record<string,unknown>):Promise<TopologyChange|null>{
  const counters=await lockCounters(tx,['brain',principalKey({kind:'local_cli',id:row.principal_id})]);
  const terminalBytes=Math.min(receiptReservation({}),retainedReceiptBytes({outcome},{stage:'terminal'}));
  const [settled]=await tx.executeRaw<TopologyChange>(`UPDATE persistence_topology_changes SET state=$2,outcome=$3::text::jsonb,terminal_bytes=$4,updated_at=now()
    WHERE id=$1::uuid AND state='recovering' AND recovery IS NULL RETURNING *`,[row.id,state,JSON.stringify(outcome),terminalBytes]);
  if(!settled)return null;
  for(const counter of counters) await tx.executeRaw('UPDATE persistence_counters SET terminal_bytes=terminal_bytes+$2 WHERE key=$1',[counter.key,terminalBytes-Number(row.terminal_bytes)]);
  return settled;
}
/** A lifecycle change that deleted or changed incarnation X fails every other request still admitted against X: none can resume. Requests are keyed by (principal, request_id), so the same request_id under another CLI registration is another request. */
export async function supersedeTopologyRetires(tx:BrainEngine,sourceId:string,incarnation:string,principal:string,requestId:string):Promise<void>{
  const rows=await tx.executeRaw<TopologyChange>(`SELECT * FROM persistence_topology_changes WHERE source_id=$1 AND source_incarnation=$2::uuid
    AND state='recovering' AND recovery IS NULL AND operation IN ('remove','purge') AND NOT (principal_id=$3::uuid AND request_id=$4::uuid) ORDER BY id`,[sourceId,incarnation,principal,requestId]);
  for(const row of rows) await settleTopologyRetire(tx,row,'failed',{...row.outcome,error:RETIRE_SUPERSEDED});
}
/** Caller retains owner/source guards and completes final state in this same transaction. */
export async function releaseTopologyReservation(tx:BrainEngine,row:TopologyChange):Promise<boolean>{
  // Revocation or removal prevents publication, never cleanup of its prior
  // durable reservation. Lock an extant principal without checking its grant.
  await tx.executeRaw('SELECT id FROM persistence_local_writers WHERE id=$1::uuid FOR SHARE',[row.principal_id]);
  const principal=principalKey({kind:'local_cli',id:row.principal_id});
  const counters=await lockCounters(tx,['brain',principal,...row.worktree_ids.map(id=>`worktree:${id}`)]);
  const [current]=await tx.executeRaw<TopologyChange>('SELECT * FROM persistence_topology_changes WHERE id=$1::uuid FOR UPDATE',[row.id]);
  if(!current?.recovery)return false;
  const intentBytes=Number(current.intent_bytes);
  for(const counter of counters){
    // Pre-accounting recovery rows have zero intent_bytes and did not reserve
    // an outstanding slot. New normalized JSON always occupies at least one byte.
    if(intentBytes>0 && !counter.key.startsWith('worktree:')) await tx.executeRaw('UPDATE persistence_counters SET outstanding_count=outstanding_count-1,intent_bytes=intent_bytes-$2 WHERE key=$1',[counter.key,intentBytes]);
    if(counter.key!==principal) await tx.executeRaw('UPDATE persistence_counters SET recovery_bytes=recovery_bytes-$2 WHERE key=$1',[counter.key,Number(current.recovery_bytes)]);
  }
  await tx.executeRaw('UPDATE persistence_topology_changes SET recovery=NULL,recovery_bytes=0,intent_bytes=0,updated_at=now() WHERE id=$1::uuid',[row.id]);
  return true;
}
export function topologyReceipt(row:TopologyChange):Record<string,unknown>{
  return {...row.outcome,request_id:row.request_id,state:row.state,retry_after_ms:row.state==='recovering'?1000:null};
}
