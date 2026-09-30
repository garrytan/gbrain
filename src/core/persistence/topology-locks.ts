import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { assertPhysicalRoot } from './physical-root.ts';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { localHostId, persistenceHome, currentVerifiedLocalWriter, readLocalWriter, verifyLocalWriter } from './identity.ts';
import { acquireNativeLock, tryAcquireNativeLock, type NativeLockHandle } from './native-lock.ts';
import { containsPath, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { completeWrite, lockCounters } from './journal.ts';
import { principalKey, requestPrincipal, type WriteRequest } from './model.ts';

export type TopologyBinding=WorktreeBinding & { unbound?:boolean };

export async function topologyPrincipal(engine: BrainEngine): Promise<string> {
  const writer = currentVerifiedLocalWriter() ?? await verifyLocalWriter(engine, await readLocalWriter(engine, 'cli'));
  if (writer.remote || writer.principal.kind !== 'local_cli') throw new OperationError('permission_denied', 'Source lifecycle requires a verified local CLI registration.');
  return writer.principal.id;
}
export async function lockTopologyPrincipal(engine: BrainEngine, id: string): Promise<void> {
  const [writer] = await engine.executeRaw<{ lane: string; revoked_at: unknown }>('SELECT lane,revoked_at FROM persistence_local_writers WHERE id=$1::uuid FOR SHARE', [id]);
  if (!writer || writer.lane !== 'cli' || writer.revoked_at != null) throw new OperationError('permission_denied', 'The administering CLI registration was revoked.');
}

/** Native locks precede every topology/source/grant/receipt transaction. */
export async function withTopologyLocks<T>(engine: BrainEngine, sourceId: string,
  run: (bindings: TopologyBinding[]) => Promise<T>, additionalRoot?: string, waitMs=5000): Promise<T> {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const handles: NativeLockHandle[] = [];
  const take = async (path: string) => {
    const handle = waitMs===0?await tryAcquireNativeLock(path):await acquireNativeLock(path, { timeoutMs: waitMs });
    if (!handle) throw new OperationError('write_pending', 'A source worktree is busy; retry this lifecycle request with the same request_id.');
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
      if (item.owner_host_id !== localHostId() || !item.coordination_path) throw new OperationError('owner_unavailable', 'Run source lifecycle on the current registered owner.');
      await take(item.coordination_path);
      if(item.local_path&&existsSync(item.local_path))assertPhysicalRoot(item.local_path,{worktreeId:item.worktree_id,coordinationPath:item.coordination_path});
    }
    return await run(bindings);
  } finally { for (const handle of handles.reverse()) await handle.release(); }
}

/** Keep the complete affected membership locked, including absent target keys. */
export async function lockTopologyRows(tx: BrainEngine, sourceId: string, bindings: TopologyBinding[]): Promise<string[]> {
  await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
  const ids = bindings.map(b => b.worktree_id).sort();
  const owners = await tx.executeRaw<{ id: string; owner_host_id: string; state: string; owner_epoch:string;topology_generation:string }>(
    'SELECT id,owner_host_id,state,owner_epoch,topology_generation FROM persistence_worktrees WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
  if (owners.length !== ids.length || owners.some(row => row.owner_host_id !== localHostId() || row.state !== 'active')) {
    throw new OperationError('recovery_required', 'The affected worktree is draining, recovering, or changed ownership.');
  }
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
        throw new OperationError('source_changed','The retained worktree binding changed during lifecycle preparation.');
      continue;
    }
    const current = await getWorktreeBinding(tx, before.source_id);
    if (!current || current.worktree_id !== before.worktree_id || current.source_incarnation !== before.source_incarnation
      || String(current.owner_epoch) !== String(before.owner_epoch) || String(current.topology_generation) !== String(before.topology_generation)
      || current.local_path !== before.local_path || current.coordination_path !== before.coordination_path) {
      throw new OperationError('source_changed', 'Source membership changed during lifecycle lock acquisition.');
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
  if (requests.some(row => row.state === 'running' || row.state === 'recovering' || row.recovery != null)) {
    throw new OperationError('write_pending', 'Publication must finish or recover before source lifecycle can proceed.');
  }
  const [blocked] = await tx.executeRaw(`SELECT id FROM persistence_effects WHERE
    (source_id=ANY($1::text[]) OR worktree_id=ANY($2::uuid[])) AND
    (recovery IS NOT NULL OR state='running' OR (kind='withdrawal-mirror' AND state<>'committed')) LIMIT 1`, [sources,worktrees]);
  if (blocked) throw new OperationError('recovery_required', 'Finish the pending withdrawal mirror and publication effects before changing source topology.');
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
