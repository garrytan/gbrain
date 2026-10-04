import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { assertPhysicalRoot } from './physical-root.ts';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { localHostId, persistenceHome, currentVerifiedLocalWriter, readLocalWriter, verifyLocalWriter } from './identity.ts';
import { acquireNativeLock, tryAcquireNativeLock, type NativeLockHandle } from './native-lock.ts';
import { containsPath, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { completeWrite, lockCounters } from './journal.ts';
import { principalKey, requestPrincipal, type WriteRequest } from './model.ts';
import { catalogueError } from '../error-catalogue.ts';
import { ACTIVE_REFRESH_STATES_SQL } from './worktree-refresh-schema.ts';

export type TopologyBinding=WorktreeBinding & { unbound?:boolean };

const ownerStatusFix=(sourceId:string):Action=>readFix(
  `Shows source ${sourceId}'s owner host, worktree state, pending or recovering requests and blocking effects, read-only.`,
  {argv:['gbrain','sources','writer','status','--source',sourceId,'--json']});

export async function topologyPrincipal(engine: BrainEngine): Promise<string> {
  const writer = currentVerifiedLocalWriter() ?? await verifyLocalWriter(engine, await readLocalWriter(engine, 'cli'));
  if (writer.remote || writer.principal.kind !== 'local_cli') throw trustedCliRequired('Source lifecycle requires a verified local CLI registration.');
  return writer.principal.id;
}
export async function lockTopologyPrincipal(engine: BrainEngine, id: string): Promise<void> {
  const [writer] = await engine.executeRaw<{ lane: string; revoked_at: unknown }>('SELECT lane,revoked_at FROM persistence_local_writers WHERE id=$1::uuid FOR SHARE', [id]);
  if (!writer || writer.lane !== 'cli' || writer.revoked_at != null) throw opError('permission_denied', 'The administering CLI registration was revoked.',
    `CLI writer registration ${id}, which started this source lifecycle change, was revoked, so nothing changed. Replacing it is the user's decision: review the registrations with the command in fix; the user stops any running owner and runs gbrain auth local-writer register cli --replace with the complete intended grant, then starts the lifecycle command again.`,
    {reason:'trusted_cli_required',fix:readFix('Lists the local writer registrations with their lane, grant and revocation state, read-only.',{argv:['gbrain','auth','local-writer','list','--json']})});
}

/** Native locks precede every topology/source/grant/receipt transaction. */
export async function withTopologyLocks<T>(engine: BrainEngine, sourceId: string,
  run: (bindings: TopologyBinding[]) => Promise<T>, additionalRoot?: string, waitMs=5000): Promise<T> {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const handles: NativeLockHandle[] = [];
  const take = async (path: string) => {
    const handle = waitMs===0?await tryAcquireNativeLock(path):await acquireNativeLock(path, { timeoutMs: waitMs });
    if (!handle) throw opError('write_pending', 'A source worktree is busy; retry this lifecycle request with the same request_id.',
      `Another lifecycle change, refresh or publication holds a worktree lock of source ${sourceId}, so this change did not start and nothing changed. Check the source with the command in fix, then run the same lifecycle command again with the same request_id once it is idle.`,
      {fix:ownerStatusFix(sourceId)});
    handles.push(handle);
  };
  try {
    // Serializes discovery of new/unbound paths on this host. Worktree locks
    // remain the actual publication authority and never live in the checkout.
    await take(join(persistenceHome(), 'locks', `topology-${brain.brain_id}.lock`));
    const binding = await getWorktreeBinding(engine, sourceId);
    const bindings:TopologyBinding[] = binding ? [binding] : [];
    if (additionalRoot) {
      const local = await engine.executeRaw<TopologyBinding>(`SELECT w.id AS worktree_id,w.owner_host_id,w.owner_epoch,w.state,w.topology_generation,
        h.local_path,h.coordination_path FROM persistence_host_bindings h JOIN persistence_worktrees w ON w.id=h.worktree_id WHERE h.host_id=$1::uuid`,[localHostId()]);
      for (const row of local) if (row.local_path&&(containsPath(row.local_path,additionalRoot) || containsPath(additionalRoot,row.local_path))) {
        const [member]=await engine.executeRaw<{source_id:string}>('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid ORDER BY source_id LIMIT 1',[row.worktree_id]);
        const other = member?await getWorktreeBinding(engine,member.source_id):{...row,source_id:'',source_incarnation:'00000000-0000-0000-0000-000000000000',relative_path:'',unbound:true};
        if (other && !bindings.some(item=>item.worktree_id===other.worktree_id)) bindings.push(other);
      }
    }
    for (const item of bindings.sort((a,b) => a.worktree_id.localeCompare(b.worktree_id))) {
      if (item.owner_host_id !== localHostId() || !item.coordination_path) throw opError('owner_unavailable', 'Run source lifecycle on the current registered owner.',
        `The worktree holding source ${item.source_id || sourceId} is owned by host ${item.owner_host_id}, not this host (${localHostId()}), or has no coordination path here, so nothing changed. Run the lifecycle command on the owning host; moving ownership is a separate, deliberate writer transfer.`,
        {fix:ownerStatusFix(sourceId)});
      await take(item.coordination_path);
      if(item.local_path&&existsSync(item.local_path))assertPhysicalRoot(item.local_path,{worktreeId:item.worktree_id,coordinationPath:item.coordination_path});
    }
    return await run(bindings);
  } finally { for (const handle of handles.reverse()) await handle.release(); }
}

/**
 * Keep the complete affected membership locked, including absent target keys.
 * An active `gbrain sources refresh` on an affected worktree refuses with
 * `refresh_in_progress`, except for the refresh named by `refreshId` itself.
 */
export async function lockTopologyRows(tx: BrainEngine, sourceId: string, bindings: TopologyBinding[], refreshId?: string): Promise<string[]> {
  await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
  const ids = bindings.map(b => b.worktree_id).sort();
  const owners = await tx.executeRaw<{ id: string; owner_host_id: string; state: string; owner_epoch:string;topology_generation:string }>(
    'SELECT id,owner_host_id,state,owner_epoch,topology_generation FROM persistence_worktrees WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
  if (owners.length !== ids.length || owners.some(row => row.owner_host_id !== localHostId() || row.state !== 'active')) {
    throw opError('recovery_required', 'The affected worktree is draining, recovering, or changed ownership.',
      `A worktree holding source ${sourceId} is draining, recovering, or now owned by another host, so the lifecycle change rolled back and nothing changed. Check its state with the command in fix; once it is active on this host, run the same lifecycle command again with the same request_id.`,
      {fix:ownerStatusFix(sourceId)});
  }
  const [refresh] = await tx.executeRaw<{ id: string; state: string; source_ids: string[] }>(`SELECT id,state,source_ids FROM persistence_worktree_refreshes
    WHERE worktree_id=ANY($1::uuid[]) AND state IN ${ACTIVE_REFRESH_STATES_SQL} AND ($2::uuid IS NULL OR id<>$2::uuid) LIMIT 1`, [ids, refreshId ?? null]);
  if (refresh) throw catalogueError('refresh_in_progress',
    `Refresh ${refresh.id} of the worktree holding source ${refresh.source_ids[0]} is ${refresh.state}; source topology cannot change until it finishes.`,
    `gbrain sources refresh ${refresh.source_ids[0]} --resume, then retry this source command with the same request_id.`);
  const members = await tx.executeRaw<{ source_id: string }>('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=ANY($1::uuid[]) ORDER BY source_id', [ids]);
  const sources = [...new Set([sourceId,...members.map(row => row.source_id)])].sort();
  await tx.executeRaw('SELECT id FROM sources WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [sources]);
  for (const before of bindings) {
    if(before.unbound){
      const [member]=await tx.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid LIMIT 1',[before.worktree_id]);
      const [host]=await tx.executeRaw<{local_path:string;coordination_path:string}>(
        'SELECT local_path,coordination_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid',[before.worktree_id,localHostId()]);
      const owner=owners.find(owner=>owner.id===before.worktree_id)!;
      if(member||host?.local_path!==before.local_path||host.coordination_path!==before.coordination_path
        ||String(owner.owner_epoch)!==String(before.owner_epoch)||String(owner.topology_generation)!==String(before.topology_generation))
        throw opError('source_changed','The retained worktree binding changed during lifecycle preparation.',
          `The unbound worktree at ${before.local_path} gained a source, moved or changed owner while the lifecycle change of ${sourceId} was prepared, so it rolled back and nothing changed. Check the current bindings with the command in fix, then run the lifecycle command again.`,
          {fix:ownerStatusFix(sourceId)});
      continue;
    }
    const current = await getWorktreeBinding(tx, before.source_id);
    if (!current || current.worktree_id !== before.worktree_id || current.source_incarnation !== before.source_incarnation
      || String(current.owner_epoch) !== String(before.owner_epoch) || String(current.topology_generation) !== String(before.topology_generation)
      || current.local_path !== before.local_path || current.coordination_path !== before.coordination_path) {
      throw opError('source_changed', 'Source membership changed during lifecycle lock acquisition.',
        `The worktree binding of source ${before.source_id} (owner epoch, topology generation or path) changed while the lifecycle change of ${sourceId} waited for its locks, so it rolled back and nothing changed. Check the current bindings with the command in fix, then run the lifecycle command again.`,
        {fix:ownerStatusFix(sourceId)});
    }
  }
  return sources;
}

export async function topologyCanonicalStamp(tx:BrainEngine,worktreeId:string):Promise<string>{
  const [row]=await tx.executeRaw<{stamp:string}>(`SELECT md5(COALESCE(string_agg(p.id::text||':'||p.knowledge_revision::text||':'||b.source_incarnation::text,',' ORDER BY p.id),'')) AS stamp
    FROM persistence_source_bindings b LEFT JOIN pages p ON p.source_id=b.source_id WHERE b.worktree_id=$1::uuid`,[worktreeId]);
  return row.stamp;
}

/** No provider or filesystem wait occurs while these database guards are held. */
export async function settleTopologyRequests(tx: BrainEngine, sources: string[], worktrees: string[], principal: string): Promise<number> {
  const requests = await tx.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests
    WHERE (source_id=ANY($1::text[]) OR worktree_id=ANY($2::uuid[]))
      AND (state IN ('queued','running','recovering') OR recovery IS NOT NULL) ORDER BY sequence`, [sources,worktrees]);
  const busy = requests.find(row => row.state === 'running' || row.state === 'recovering' || row.recovery != null);
  if (busy) {
    throw opError('write_pending', 'Publication must finish or recover before source lifecycle can proceed.',
      `Write request ${busy.request_id} in source ${busy.source_id} is still publishing or recovering, so the lifecycle change rolled back and nothing changed. The owner finishes or recovers that write on its own; once the command in fix shows no running or recovering request, run the same lifecycle command again with the same request_id.`,
      {fix:ownerStatusFix(busy.source_id)});
  }
  const [blocked] = await tx.executeRaw<{ id: string; source_id: string | null }>(`SELECT id,source_id FROM persistence_effects WHERE
    (source_id=ANY($1::text[]) OR worktree_id=ANY($2::uuid[])) AND
    (recovery IS NOT NULL OR state='running' OR (kind='withdrawal-mirror' AND state<>'committed')) LIMIT 1`, [sources,worktrees]);
  if (blocked) {
    const source = blocked.source_id ?? sources[0];
    throw opError('recovery_required', 'Finish the pending withdrawal mirror and publication effects before changing source topology.',
      `Effect ${blocked.id} on source ${source} (a withdrawal mirror or publication effect) has not finished, so the lifecycle change rolled back and nothing changed. The owner's effect worker settles it; check it with the command in fix, which lists it with its page and request; gbrain sources writer retry-effects re-authorizes a failed or parked one. Then run the same lifecycle command again with the same request_id.`,
      {fix:ownerStatusFix(source)});
  }
  const pending = requests.filter(row => row.state === 'queued');
  // Revocation and publication use the same principal rows. Administrative
  // invalidation may terminate revoked work but still respects guard ordering.
  const principals = new Map(pending.map(row => [`${row.principal_kind}:${row.principal_id}`,requestPrincipal(row)]));
  principals.set(`local_cli:${principal}`, { kind:'local_cli', id:principal });
  for (const [_, identity] of [...principals].sort(([a],[b]) => a.localeCompare(b))) {
    if (identity.kind === 'oauth_client') await tx.executeRaw('SELECT client_id FROM oauth_clients WHERE client_id=$1 FOR SHARE',[identity.id]);
    else if (identity.kind === 'legacy_token') await tx.executeRaw('SELECT id FROM access_tokens WHERE id=$1 FOR SHARE',[identity.id]);
    else await tx.executeRaw('SELECT id FROM persistence_local_writers WHERE id=$1::uuid FOR SHARE',[identity.id]);
  }
  await lockTopologyPrincipal(tx,principal);
  await lockCounters(tx,['brain',...pending.map(row=>principalKey(requestPrincipal(row))),...worktrees.map(id=>`worktree:${id}`),principalKey({kind:'local_cli',id:principal})]);
  for (const row of pending) await completeWrite(tx,row,'conflict',{}, { code:'source_changed', message:'The accepted source topology was changed by its administrator.' });
  return pending.length;
}

export async function advanceTopology(tx: BrainEngine, worktrees: string[]): Promise<void> {
  await tx.executeRaw('UPDATE persistence_worktrees SET topology_generation=topology_generation+1 WHERE id=ANY($1::uuid[])',[worktrees]);
  await tx.executeRaw(`UPDATE persistence_source_bindings b SET topology_generation=w.topology_generation
    FROM persistence_worktrees w WHERE b.worktree_id=w.id AND w.id=ANY($1::uuid[])`,[worktrees]);
}
