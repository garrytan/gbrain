import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { getWorktreeBinding, claimWorktree, acquireWorktree } from '../src/core/persistence/ownership.ts';
import { admitWrite, claimNextWrite, getWriteRequest } from '../src/core/persistence/journal.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { managedSyncAuthority } from '../src/core/persistence/sync-authority.ts';
import { prepareManagedSyncMutation, type SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { discoverManagedSync } from '../src/core/persistence/sync-discovery.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { loadSyncFailures, syncFailuresPath } from '../src/core/sync-failure-ledger.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-sync-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim(); }
function commit(root: string, message = 'test content'): string { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); }
async function fixture(engine: BrainEngine, files: Record<string,string>, subpath?: string) {
  const id = `sync-${randomUUID().replace(/-/g,'').slice(0,20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) { const full = join(root,path); mkdirSync(join(full,'..'), { recursive:true }); writeFileSync(full, body); }
  const head = commit(root);
  const sourceRoot = subpath ? join(root,subpath) : root;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id,sourceRoot]);
  await claimWorktree(engine,id,sourceRoot);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, sourceRoot, head };
}
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) { await engine.executeRaw('DELETE FROM oauth_clients WHERE source_id=$1', [id]); await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); } await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home,{recursive:true,force:true});
});

test('managed schema restart preserves source and brain identities without triggering a seed write', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const before = await engine.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const source = await engine.executeRaw("SELECT incarnation FROM sources WHERE id='default'");
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await engine.initSchema();
    expect(await engine.executeRaw('SELECT brain_id FROM persistence_brain WHERE singleton=1')).toEqual(before);
    expect(await engine.executeRaw("SELECT incarnation FROM sources WHERE id='default'")).toEqual(source);
    expect(await engine.executeRaw('SELECT enabled FROM persistence_brain WHERE singleton=1')).toEqual([{enabled:true}]);
  }
}),120_000);

test('imports files without rewriting bytes and checkpoints only committed page receipts', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const bytes = '---\ntitle: Example note\n---\nA stable useful observation about the project.\n';
    const f = await fixture(engine, { 'notes/example.md': bytes });
    const result = await performManagedSync(engine, {sourceId:f.id,noPull:true});
    expect(result).toMatchObject({status:'first_sync',added:1,filesImported:1});
    expect(readFileSync(join(f.root,'notes/example.md'),'utf8')).toBe(bytes);
    expect((await engine.getPage('notes/example',{sourceId:f.id}))?.source_path).toBe('notes/example.md');
    const [source] = await engine.executeRaw<{last_commit:string}>('SELECT last_commit FROM sources WHERE id=$1',[f.id]); expect(source.last_commit).toBe(f.head);
    const requests = await engine.executeRaw<{state:string}>('SELECT state FROM persistence_requests WHERE source_id=$1',[f.id]); expect(requests).toHaveLength(2); expect(requests.every(r=>r.state==='committed')).toBe(true);
    expect((await performManagedSync(engine,{sourceId:f.id,noPull:true})).status).toBe('up_to_date');
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1',[f.id])).toHaveLength(2);
  }
}),120_000);

test('interrupted cursor resumes its pinned target before a newer HEAD and never advances early', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {'a.md':'First stable observation about engineering.\n','b.md':'Original second observation about engineering.\n'});
    const abort = new AbortController();
    const first = await performManagedSync(engine,{sourceId:f.id,noPull:true,signal:abort.signal,onProgress:p=>{if(p.bankedFiles===1) abort.abort();}});
    expect(first).toMatchObject({status:'partial',filesImported:1});
    expect((await engine.executeRaw<{last_commit:string|null}>('SELECT last_commit FROM sources WHERE id=$1',[f.id]))[0].last_commit).toBeNull();
    writeFileSync(join(f.root,'b.md'),'Newer second observation about engineering.\n'); const secondHead=commit(f.root,'new content after interruption');
    const second = await performManagedSync(engine,{sourceId:f.id,noPull:true}); expect(second.toCommit).toBe(f.head); expect(second.status).toBe('first_sync');
    expect((await engine.getPage('b',{sourceId:f.id}))?.compiled_truth).toContain('Original second');
    expect((await performManagedSync(engine,{sourceId:f.id,noPull:true})).toCommit).toBe(secondHead);
    expect((await engine.getPage('b',{sourceId:f.id}))?.compiled_truth).toContain('Newer second');
  }
}),120_000);

test('attached working-tree changes require opt-in and delete retains exact physical identity', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f=await fixture(engine,{'notes/a.md':'Committed observation for the source.\n'});
    await performManagedSync(engine,{sourceId:f.id,noPull:true});
    writeFileSync(join(f.root,'notes/a.md'),'Uncommitted revised observation for the source.\n');
    expect((await performManagedSync(engine,{sourceId:f.id,noPull:true})).status).toBe('up_to_date');
    expect((await engine.getPage('notes/a',{sourceId:f.id}))?.compiled_truth).toContain('Committed');
    expect((await performManagedSync(engine,{sourceId:f.id,noPull:true,workingTree:true})).status).toBe('synced');
    expect((await engine.getPage('notes/a',{sourceId:f.id}))?.compiled_truth).toContain('Uncommitted');
    rmSync(join(f.root,'notes/a.md')); commit(f.root,'remove content');
    expect((await performManagedSync(engine,{sourceId:f.id,noPull:true})).deleted).toBe(1);
    expect(await engine.getPage('notes/a',{sourceId:f.id})).toBeNull();
  }
}),120_000);

test('repeated slices reuse one manifest and still reject an intervening page identity change', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {
      'a.md': 'First source observation for a durable sliced import.\n',
      'b.md': 'Second source observation for a durable sliced import.\n',
      'c.md': 'Third source observation for a durable sliced import.\n',
    });
    const executeRaw = engine.executeRaw;
    let manifestReads = 0;
    engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      if (params?.[0] === f.id && sql.includes('SELECT id,slug,source_path,knowledge_revision FROM pages')) manifestReads++;
      return executeRaw.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    try {
      const options = { sourceId: f.id, noPull: true };
      const slice = { maxPages: 1, maxMs: 1000 };
      expect(await performManagedSync(engine, options, slice)).toMatchObject({ status: 'partial', reason: 'writer_yield', filesImported: 1 });
      const [manifest] = await engine.executeRaw<{ fingerprint: string; completed_keys: unknown }>(
        `SELECT m.fingerprint,m.completed_keys FROM op_checkpoints c JOIN op_checkpoints m
          ON m.op='managed-sync-manifest' AND m.fingerprint=c.completed_keys->0->>'runId'
          WHERE c.op='managed-sync' AND c.completed_keys->0->>'sourceId'=$1`, [f.id]);
      expect(manifest).toBeDefined();
      expect(await performManagedSync(engine, options, slice)).toMatchObject({ status: 'partial', reason: 'writer_yield', filesImported: 2 });
      expect(manifestReads).toBe(1);
      await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.putPage('c', {
        type: 'note', title: 'c', compiled_truth: 'A newer accepted page between sync slices.', timeline: '', frontmatter: {}, content_hash: 'newer',
      }, { sourceId: f.id })));
      await expect(performManagedSync(engine, options, slice)).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(manifestReads).toBe(1);
      expect(await engine.executeRaw('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2',
        ['managed-sync-manifest', manifest.fingerprint])).toEqual([{ completed_keys: manifest.completed_keys }]);
      expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toBe('A newer accepted page between sync slices.');
      expect(await engine.executeRaw('SELECT slug,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]))
        .toEqual([{ slug: 'a', state: 'committed' }, { slug: 'b', state: 'committed' }]);
      expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
    } finally { await disposePersistenceConsumer(engine); engine.executeRaw = executeRaw; }
  }
}),120_000);

test('managed discovery unions persisted hidden-path waivers with explicit patterns', async () => withEnv({GBRAIN_HOME:home},async()=>{
  for(const engine of engines){
    const previous = await engine.getConfig('sync.include_hidden');
    try {
      await engine.setConfig('sync.include_hidden', '');
      const f = await fixture(engine, { 'visible.md': 'Visible ordinary source observation.\n',
        '.persisted/configured.md': 'Explicitly configured hidden source observation.\n',
        '.explicit/cli.md': 'Explicit per-call hidden source observation.\n',
        '.hidden/blocked.md': 'Hidden source observation with no waiver.\n' });
      expect((await discoverManagedSync(engine, { sourceId: f.id, noPull: true })).entries.map(e => e.sourcePath)).toEqual(['visible.md']);
      await engine.setConfig('sync.include_hidden', ' .persisted/ ,\n .persisted/** ');
      expect((await discoverManagedSync(engine, { sourceId: f.id, noPull: true })).entries.map(e => e.sourcePath))
        .toEqual(['.persisted/configured.md', 'visible.md']);
      const result = await performManagedSync(engine, { sourceId: f.id, noPull: true, includeHidden: ['.explicit/**'] });
      expect(result.added).toBe(3);
      const paths = await engine.executeRaw<{source_path:string}>('SELECT source_path FROM pages WHERE source_id=$1 ORDER BY source_path', [f.id]);
      expect(paths.map(p => p.source_path)).toEqual(['.explicit/cli.md', '.persisted/configured.md', 'visible.md']);
    } finally {
      if(previous == null) await engine.executeRaw("DELETE FROM config WHERE key='sync.include_hidden'");
      else await engine.setConfig('sync.include_hidden', previous);
    }
  }
}),120_000);

test('subpath exclusions and unsupported code/pull paths refuse before canonical writes', async () => withEnv({GBRAIN_HOME:home},async()=>{
  for(const engine of engines){
    const f=await fixture(engine,{'wiki/a.md':'Included source observation.\n','wiki/private/b.md':'Excluded source observation.\n','outside.md':'Another source observation.\n'},'wiki');
    const result=await performManagedSync(engine,{sourceId:f.id,noPull:true,exclude:['private/**']}); expect(result.added).toBe(1);
    expect(await engine.getPage('a',{sourceId:f.id})).not.toBeNull(); expect(await engine.getPage('private/b',{sourceId:f.id})).toBeNull();
    await expect(performManagedSync(engine,{sourceId:f.id})).rejects.toMatchObject({code:'writer_coordinator_required'});
    const c=await fixture(engine,{'a.md':'Normal page source observation.\n','code.ts':'export const example = 1;\n'});
    expect(await performManagedSync(engine,{sourceId:c.id,noPull:true,strategy:'auto',noEmbed:true})).toMatchObject({added:2});
    expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1',[c.id])).toHaveLength(2);
    expect(await engine.executeRaw("SELECT page_kind FROM pages WHERE source_id=$1 AND slug='code-ts'",[c.id])).toEqual([{page_kind:'code'}]);
    expect((await engine.getChunks('code-ts',{sourceId:c.id})).some(chunk=>chunk.symbol_name==='example')).toBe(true);
  }
}),120_000);

test('a write between batches cannot be overwritten by an older enumerated Git page', async () => withEnv({GBRAIN_HOME:home},async()=>{
  for(const engine of engines){
    const f=await fixture(engine,{'a.md':'First original observation about the system.\n','b.md':'Second original observation about the system.\n'});
    let changed: Promise<void>|undefined;
    const abort=new AbortController();
    const first=await performManagedSync(engine,{sourceId:f.id,noPull:true,signal:abort.signal,onProgress:p=>{
      if(p.bankedFiles===1){ abort.abort(); changed=engine.transaction(tx=>withCoordinatedWrite(tx,[f.id],async()=>{
        await tx.putPage('b',{type:'note',title:'b',compiled_truth:'A concurrently accepted newer observation.',timeline:'',frontmatter:{},content_hash:'newer'}, {sourceId:f.id});
      })); }
    }});
    expect(first.status).toBe('partial'); await changed;
    await expect(performManagedSync(engine,{sourceId:f.id,noPull:true})).rejects.toMatchObject({code:'revision_conflict'});
    expect((await engine.getPage('b',{sourceId:f.id}))?.compiled_truth).toBe('A concurrently accepted newer observation.');
    expect((await engine.executeRaw<{last_commit:string|null}>('SELECT last_commit FROM sources WHERE id=$1',[f.id]))[0].last_commit).toBeNull();
  }
}),120_000);

test('remote sync keeps submit_job authority and rejects option upgrades and current grant revocation', async () => withEnv({GBRAIN_HOME:home},async()=>{
  for(const engine of engines){
    const f=await fixture(engine,{'a.md':'First permitted remote source observation.\n','b.md':'Second permitted remote source observation.\n'});
    const clientId=`sync-client-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
      VALUES($1,'example-client','test-only','admin',$2,ARRAY['submit_job'])`,[clientId,f.id]);
    const ctx={engine,remote:true,sourceId:f.id,auth:{clientId,principal:{kind:'oauth_client',id:clientId},scopes:['admin'],sourceId:f.id,allowedOperations:['submit_job']}} as OperationContext;
    const accepted=await prepareRemoteJob(ctx,'sync',{noPull:true});
    await expect(withSubmissionAuthority(accepted.authority,()=>performManagedSync(engine,{...accepted.data,workingTree:true}))).rejects.toMatchObject({code:'permission_denied'});
    expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1',[f.id])).toHaveLength(0);
    const abort=new AbortController();
    const partial=await withSubmissionAuthority(accepted.authority,()=>performManagedSync(engine,{...accepted.data,signal:abort.signal,onProgress:p=>{if(p.bankedFiles===1)abort.abort();}}));
    expect(partial.status).toBe('partial');
    const requests=await engine.executeRaw<{principal_id:string;operation:string}>('SELECT principal_id,operation FROM persistence_requests WHERE source_id=$1',[f.id]);
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({principal_id:clientId,operation:'submit_job'});
    await engine.executeRaw("UPDATE oauth_clients SET scope='read' WHERE client_id=$1",[clientId]);
    await expect(withSubmissionAuthority(accepted.authority,()=>performManagedSync(engine,accepted.data))).rejects.toMatchObject({code:'permission_denied'});
    expect(await engine.getPage('b',{sourceId:f.id})).toBeNull();
    expect((await engine.executeRaw<{last_commit:string|null}>('SELECT last_commit FROM sources WHERE id=$1',[f.id]))[0].last_commit).toBeNull();
  }
}),120_000);


test('raw bytes changing after preparation conflict without publishing and the same request replays', async () => withEnv({GBRAIN_HOME:home},async()=>{
  for(const engine of engines){
    await disposePersistenceConsumer(engine);
    const original='Original source observation before admission.\n';
    const f=await fixture(engine,{'a.md':original}); const binding=(await getWorktreeBinding(engine,f.id))!;
    const authority=await managedSyncAuthority(engine,f.id,binding.source_incarnation,f.root);
    const intent:SyncIntent={kind:'managed_sync_import',expected_revision:null,sourcePath:'a.md',path:'a.md',rawHash:sha256(original),content:original,
      ownerEpoch:String(binding.owner_epoch),syncAuthority:authority,cursorKey:'test-cursor',runId:randomUUID(),index:0,total:1,from:null,target:f.head,slugMode:'git-root'};
    const requestId=randomUUID();
    const admission={requestId,operation:'submit_job',sourceId:f.id,sourceIncarnation:binding.source_incarnation,slug:'a',pageId:null,
      worktreeId:binding.worktree_id,topologyGeneration:binding.topology_generation,principal:authority.writer.principal,authority:authority.writer,callerIntent:intent,intent};
    const accepted=await admitWrite(engine,admission); const claimed=(await claimNextWrite(engine,localHostId()))!; expect(claimed.id).toBe(accepted.id);
    const prepared=await prepareManagedSyncMutation(engine,claimed,{engine:engine.kind});
    const newer='New external source observation after preparation.\n'; writeFileSync(join(f.root,'a.md'),newer);
    const outcome=await publishMutation(engine,claimed,prepared);
    expect(outcome.state).toBe('conflict'); expect(outcome.error_code).toBe('source_changed');
    expect(await engine.getPage('a',{sourceId:f.id})).toBeNull(); expect(readFileSync(join(f.root,'a.md'),'utf8')).toBe(newer);
    const replay=await admitWrite(engine,admission); expect(replay.id).toBe(accepted.id); expect(replay.state).toBe('conflict');
    expect((await getWriteRequest(engine,authority.writer.principal,requestId))?.intent).toEqual(intent);
  }
}),120_000);

test.each([false, true])('managed terminal receipts survive a missing ledger and corrected retry uses a new ID (CRLF=%s)', async crlf =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const f = await fixture(engine, { 'notes/example.md': 'An original observation about the example system.\n' });
      await performManagedSync(engine, { sourceId: f.id, noPull: true });
      const pinned = 'A newly committed observation about the example system.\n';
      const path = join(f.root, 'notes/example.md');
      writeFileSync(path, pinned);
      const target = commit(f.root);
      const working = crlf ? pinned.replace(/\n/g, '\r\n') : 'A private uncommitted observation that must not appear in diagnostics.\n';
      writeFileSync(path, working);
      const opts = { sourceId: f.id, noPull: true };
      const blocked = await performManagedSync(engine, opts);
      expect(blocked).toMatchObject({ status: 'blocked_by_failures', failedFiles: 1, filesImported: 0,
        managedWrite: { source_id: f.id, slug: 'notes/example', path: 'notes/example.md', write_error: 'source_changed',
          reason: 'pinned_git_worktree_conflict', ledger_recorded: true, write_request: { state: 'conflict', retry_after_ms: null } } });
      expect(blocked.managedWrite?.line_endings).toBe(crlf ? 'crlf_lf_only' : undefined);
      expect(JSON.stringify(blocked)).not.toContain(working.trim());
      expect(JSON.stringify(blocked)).not.toContain(f.root);
      expect(readFileSync(path, 'utf8')).toBe(working);
      const id = blocked.managedWrite!.write_request.request_id;
      const recorded = loadSyncFailures().filter(row => row.source_id === f.id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].path).toBe('notes/example.md');
      expect(recorded[0].error).toContain(id);
      expect(recorded[0].error).toContain('source_changed');
      expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(f.head);
      writeFileSync(path, pinned);
      rmSync(syncFailuresPath(), { force: true });
      const replay = await performManagedSync(engine, opts);
      expect(replay.managedWrite?.write_request).toEqual(blocked.managedWrite!.write_request);
      expect(replay.status).toBe('blocked_by_failures');
      expect(loadSyncFailures().find(row => row.source_id === f.id)?.error).toContain(id);
      await withEnv({ GBRAIN_SYNC_FAILURES_DIR: path }, async () => {
        const unavailable = await performManagedSync(engine, opts);
        expect(unavailable).toMatchObject({ status: 'blocked_by_failures', managedWrite: { ledger_recorded: false,
          write_request: { request_id: id, state: 'conflict' } } });
      });
      await expect(performManagedSync(engine, { ...opts, skipFailed: true })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
      const corrected = await performManagedSync(engine, { ...opts, retryFailed: true });
      expect(corrected.status).toBe('synced');
      expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
      const requests = await engine.executeRaw<{ request_id: string; state: string }>('SELECT request_id,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
      expect(requests.filter(row => row.request_id === id)).toEqual([{ request_id: id, state: 'conflict' }]);
      expect(requests.at(-1)?.state).toBe('committed');
      expect(requests.at(-1)?.request_id).not.toBe(id);
      expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(target);
    }
  }), 120_000);

test('pending durable sync retries keep the same request ID and do not claim committed imports', async () =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine);
      const f = await fixture(engine, { 'pending.md': 'An observation waiting for publication.\n' });
      const lock = await acquireWorktree((await getWorktreeBinding(engine, f.id))!);
      expect(lock).not.toBeNull();
      try {
        const opts = { sourceId: f.id, noPull: true };
        const pending = await performManagedSync(engine, opts);
        expect(pending).toMatchObject({ status: 'partial', reason: 'writer_pending', filesImported: 0, added: 0,
          managedWrite: { source_id: f.id, slug: 'pending', path: 'pending.md', write_error: 'write_pending' } });
        const id = pending.managedWrite!.write_request.request_id;
        expect(pending.managedWrite!.write_request.state).not.toBe('committed');
        expect(await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1', [f.id])).toHaveLength(0);
        expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBeNull();
        const retry = await performManagedSync(engine, { ...opts, retryFailed: true });
        expect(retry).toMatchObject({ status: 'partial', reason: 'writer_pending', filesImported: 0,
          managedWrite: { write_request: { request_id: id } } });
        expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(1);
        expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
        await lock!.release();
        const resumed = await performManagedSync(engine, opts);
        expect(resumed).toMatchObject({ status: 'first_sync', added: 1 });
        expect(await engine.executeRaw('SELECT state FROM persistence_requests WHERE source_id=$1 AND request_id=$2::uuid', [f.id, id]))
          .toEqual([{ state: 'committed' }]);
      } finally { await lock?.release(); await disposePersistenceConsumer(engine); }
    }
  }), 120_000);

test('continuous foreground arrivals cannot starve a bounded sync batch', async () => withEnv({GBRAIN_HOME:home},async()=>{
  const { registerMutationPreparer, startPersistenceConsumer, foregroundWriteCompletions } = await import('../src/core/persistence/service.ts');
  registerMutationPreparer('test_sync_foreground',async()=>{
    await new Promise(resolve=>setTimeout(resolve,40));
    return {observedRevision:null,noop:true,apply:async()=>({status:'complete'})};
  });
  for(const engine of engines){
    await disposePersistenceConsumer(engine);
    const f=await fixture(engine,{'a.md':'A sync observation amid continuous interactive traffic.\n'});
    const binding=(await getWorktreeBinding(engine,f.id))!;
    const authority=await managedSyncAuthority(engine,f.id,binding.source_incarnation,f.root);
    const consumer=startPersistenceConsumer(engine,{engine:engine.kind});
    let submitted=0,stopping=false,pumping=false;
    const admitted:Promise<unknown>[]=[];
    const enqueue=async()=>{
      const n=submitted++;
      await admitWrite(engine,{operation:'test_sync_foreground',sourceId:f.id,sourceIncarnation:binding.source_incarnation,
        slug:`foreground-${n}`,pageId:null,worktreeId:binding.worktree_id,topologyGeneration:binding.topology_generation,
        principal:authority.writer.principal,authority:authority.writer,callerIntent:{n},intent:{n}});
    };
    for(let i=0;i<8;i++)await enqueue();
    const timer=setInterval(()=>{
      if(stopping||pumping)return;
      pumping=true;
      const work=(async()=>{while(!stopping&&submitted-foregroundWriteCompletions(engine,binding.worktree_id)<8)await enqueue();})()
        .finally(()=>{pumping=false;});
      admitted.push(work);
    },10);
    let queuedWhenSyncCommitted=0;
    try{
      // A loaded test runner may exhaust the per-call acknowledgment budget;
      // resume the same durable cursor while the foreground producer keeps running.
      const deadline=performance.now()+30000;
      let result;
      do {
        result=await performManagedSync(engine,{sourceId:f.id,noPull:true,onProgress:p=>{
          if(p.phase==='managed_sync.page_committed')queuedWhenSyncCommitted=submitted-consumer.foregroundCompletions(binding.worktree_id);
        }});
      } while(result.status==='partial'&&result.reason==='writer_pending'&&performance.now()<deadline);
      expect(result).toMatchObject({status:'first_sync',added:1});
      expect(queuedWhenSyncCommitted).toBeGreaterThan(0);
      expect(consumer.foregroundCompletions(binding.worktree_id)).toBeGreaterThan(0);
    }finally{stopping=true;clearInterval(timer);await Promise.all(admitted);await disposePersistenceConsumer(engine);}
  }
}),120_000);
