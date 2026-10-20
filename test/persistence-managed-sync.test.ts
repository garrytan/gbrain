import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { disposePersistenceConsumer, registerMutationPreparer } from '../src/core/persistence/service.ts';
import { UNFINISHED_PAGE_REQUEST_SQL } from '../src/core/persistence/sync-waivers.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';
import { stampByCheckpoint } from './helpers/pass-fold.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { loadSyncFailures, syncFailuresPath } from '../src/core/sync-failure-ledger.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';

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
    // #6926 (folded into 4b): the checkpoint commits inside the import's own publication, so the import is the one receipt.
    const requests = await engine.executeRaw<{state:string;stamp:string|null}>("SELECT state, outcome->>'pass_stamp' AS stamp FROM persistence_requests WHERE source_id=$1",[f.id]); expect(requests).toEqual([{state:'committed',stamp:'folded'}]);
    expect((await performManagedSync(engine,{sourceId:f.id,noPull:true})).status).toBe('up_to_date');
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1',[f.id])).toHaveLength(1);
  }
}),120_000);

test('a pinned import that trails the current page and its working-tree bytes is skipped, not a conflict', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const current = '---\ntitle: Example note\n---\nThe current observation, already in the database.\n';
    const pinned = '---\ntitle: Example note\n---\nAn older observation that Git still carries.\n';
    const f = await fixture(engine, { 'notes/example.md': current });
    expect((await performManagedSync(engine, { sourceId: f.id, noPull: true })).status).toBe('first_sync');
    const path = join(f.root, 'notes/example.md');
    // The state between a coordinated page write and its queued Git effect: the newest commit
    // holds other bytes than the page, and the working tree already carries the page's own bytes.
    writeFileSync(path, pinned); const head = commit(f.root, 'commit that trails the page'); writeFileSync(path, current);
    const result = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(result.status).not.toBe('blocked_by_failures'); expect(result.managedWrite).toBeUndefined(); expect(result.toCommit).toBe(head);
    expect((await engine.getPage('notes/example', { sourceId: f.id }))?.compiled_truth).toContain('current observation');
    expect(readFileSync(path, 'utf8')).toBe(current);
    expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(head);
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
    // Working-tree bytes that are neither the pinned commit nor the page are still protected: #6340 holds the file
    // (`worktree_dirty`) and the run finishes instead of blocking; nothing overwrites the local edit.
    const foreign = '---\ntitle: Example note\n---\nA local edit that nothing imported.\n';
    writeFileSync(path, pinned.replace('older', 'still older')); const trailing = commit(f.root, 'another trailing commit'); writeFileSync(path, foreign);
    const held = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(held).toMatchObject({ status: 'synced', toCommit: trailing, held_count: 1, held: [{ path: 'notes/example.md', code: 'worktree_dirty' }] });
    expect(held.managedWrite).toBeUndefined();
    expect(JSON.stringify(held)).not.toContain('local edit that nothing imported');
    expect(readFileSync(path, 'utf8')).toBe(foreign);
    expect((await engine.getPage('notes/example', { sourceId: f.id }))?.compiled_truth).toContain('current observation');
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
    rmSync(syncFailuresPath(), { force: true });
  }
}),120_000);

test('after a trailing-commit skip, the commit that carries the page bytes imports as a no-op', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const current = '---\ntitle: Trailing note\n---\nThe page body the coordinator already published.\n';
    const pinned = '---\ntitle: Trailing note\n---\nThe body an earlier commit still carries.\n';
    const f = await fixture(engine, { 'notes/trailing.md': current });
    expect((await performManagedSync(engine, { sourceId: f.id, noPull: true })).status).toBe('first_sync');
    const path = join(f.root, 'notes/trailing.md');
    writeFileSync(path, pinned); commit(f.root, 'commit that trails the page'); writeFileSync(path, current);
    const before = await engine.readPageSnapshot('notes/trailing', { sourceId: f.id });
    expect((await performManagedSync(engine, { sourceId: f.id, noPull: true })).status).not.toBe('blocked_by_failures');
    const carried = commit(f.root, 'the queued Git effect lands');
    const result = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(result.status).not.toBe('blocked_by_failures'); expect(result.managedWrite).toBeUndefined();
    expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(carried);
    const after = await engine.readPageSnapshot('notes/trailing', { sourceId: f.id });
    expect(after?.revision).toBe(before?.revision);
    expect(after?.page.compiled_truth).toContain('already published');
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
  }
}),120_000);

const OLD_SYNC_AT = '2000-01-01T00:00:00Z';
async function backdateLastSync(engine: BrainEngine, id: string): Promise<void> {
  await engine.transaction(tx => withCoordinatedWrite(tx, [id], () => tx.executeRaw('UPDATE sources SET last_sync_at=$2::timestamptz WHERE id=$1', [id, OLD_SYNC_AT]), TEST_WRITE_ATTRIBUTION));
}
async function lastSyncMs(engine: BrainEngine, id: string): Promise<number> {
  const [row] = await engine.executeRaw<{ last_sync_at: Date | string }>('SELECT last_sync_at FROM sources WHERE id=$1', [id]);
  return Date.parse(String(row.last_sync_at));
}

test('managed sync refreshes quiet-source freshness only after a complete up-to-date check', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'notes/example.md': 'A stable observation for heartbeat coverage.\n' });
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    await backdateLastSync(engine, f.id);
    const columns = 'SELECT last_commit,newest_content_at,incarnation FROM sources WHERE id=$1';
    const [before] = await engine.executeRaw(columns, [f.id]);
    const checkpoints = await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests');

    expect((await performManagedSync(engine, { sourceId: f.id, noPull: true, dryRun: true })).status).toBe('dry_run');
    expect(await lastSyncMs(engine, f.id)).toBe(Date.parse(OLD_SYNC_AT));

    expect((await performManagedSync(engine, { sourceId: f.id, noPull: true })).status).toBe('up_to_date');
    expect(await lastSyncMs(engine, f.id)).toBeGreaterThan(Date.parse(OLD_SYNC_AT));
    expect(await engine.executeRaw(columns, [f.id])).toEqual([before]);
    expect(await engine.executeRaw('SELECT count(*)::int AS n FROM persistence_requests')).toEqual(checkpoints);

    writeFileSync(join(f.root, 'notes/example.md'), 'A changed observation requiring a partial sync.\n');
    commit(f.root, 'changed content');
    await backdateLastSync(engine, f.id);
    const abort = new AbortController();
    // Stopped between the import and its checkpoint request: a folded stamp has no such window (#6926).
    const partial = await stampByCheckpoint(() => performManagedSync(engine, { sourceId: f.id, noPull: true, signal: abort.signal,
      onProgress: progress => { if (progress.bankedFiles === 1) abort.abort(); } }));
    expect(partial.status).toBe('partial');
    expect(await lastSyncMs(engine, f.id)).toBe(Date.parse(OLD_SYNC_AT));
  }
}),120_000);

test('a stale up-to-date run does not stamp a source re-added under a new incarnation', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'notes/example.md': 'A stable observation for incarnation coverage.\n' });
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    await backdateLastSync(engine, f.id);
    const reAdded = randomUUID();
    const transaction = engine.transaction;
    let rotated = false;
    engine.transaction = async function <T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
      return transaction.call(this, async tx => {
        const executeRaw = tx.executeRaw;
        tx.executeRaw = async function <R = Record<string, unknown>>(this: BrainEngine, sql: string, params?: unknown[], opts?: { signal?: AbortSignal }): Promise<R[]> {
          if (!rotated && /^UPDATE sources SET last_sync_at\b/.test(sql)) {
            rotated = true;
            // The source was removed and re-added after this run's discovery: same id, new incarnation.
            // The writer guard refuses an in-place incarnation change, so the fixture bypasses triggers for this one statement.
            await executeRaw.call(this, 'SET LOCAL session_replication_role = replica');
            await executeRaw.call(this, 'UPDATE sources SET incarnation=$2::uuid WHERE id=$1', [f.id, reAdded]);
            await executeRaw.call(this, 'SET LOCAL session_replication_role = origin');
          }
          return executeRaw.call(this, sql, params, opts) as Promise<R[]>;
        };
        return run(tx);
      }) as Promise<T>;
    } as BrainEngine['transaction'];
    try {
      expect((await performManagedSync(engine, { sourceId: f.id, noPull: true })).status).toBe('up_to_date');
    } finally { engine.transaction = transaction; }
    expect(rotated).toBe(true);
    const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [f.id]);
    expect(row.incarnation).toBe(reAdded);
    expect(await lastSyncMs(engine, f.id)).toBe(Date.parse(OLD_SYNC_AT));
  }
}),120_000);

test('an interrupted first pass resumes at the newer HEAD, never advances early and never re-imports what it imported', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {'a.md':'First stable observation about engineering.\n','b.md':'Original second observation about engineering.\n'});
    const abort = new AbortController();
    const first = await performManagedSync(engine,{sourceId:f.id,noPull:true,signal:abort.signal,onProgress:p=>{if(p.bankedFiles===1) abort.abort();}});
    expect(first).toMatchObject({status:'partial',filesImported:1});
    expect((await engine.executeRaw<{last_commit:string|null}>('SELECT last_commit FROM sources WHERE id=$1',[f.id]))[0].last_commit).toBeNull();
    writeFileSync(join(f.root,'b.md'),'Newer second observation about engineering.\n'); const secondHead=commit(f.root,'new content after interruption');
    // #6712 PR 4b: the live pass pins HEAD on every run, so the resumed pass syncs to the newer commit; a.md, which the
    // interrupted pass imported, is matched (not a candidate) and b.md imports the bytes HEAD commits.
    const second = await performManagedSync(engine,{sourceId:f.id,noPull:true});
    expect(second.toCommit).toBe(secondHead); expect(second).toMatchObject({ status: 'first_sync', added: 1, pass: { kind: 'full', candidates: 1 } });
    expect((await engine.getPage('b',{sourceId:f.id}))?.compiled_truth).toContain('Newer second');
    expect((await engine.executeRaw<{last_commit:string|null}>('SELECT last_commit FROM sources WHERE id=$1',[f.id]))[0].last_commit).toBe(secondHead);
    expect((await engine.executeRaw<{slug:string}>("SELECT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence",[f.id])).map(row=>row.slug)).toEqual(['a','b']);
    const third = await performManagedSync(engine,{sourceId:f.id,noPull:true});
    expect(third).toMatchObject({ status: 'up_to_date', toCommit: secondHead });
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
      if(p.bankedFiles===1){ abort.abort(); changed=engine.transaction(tx=>withCoordinatedWrite(tx, [f.id], async()=>{
        await tx.putPage('b',{type:'note',title:'b',compiled_truth:'A concurrently accepted newer observation.',timeline:'',frontmatter:{},content_hash:'newer'}, {sourceId:f.id});
      }, TEST_WRITE_ATTRIBUTION)); }
    }});
    expect(first.status).toBe('partial'); await changed;
    // #6340: the overtaken page is held, never overwritten, and the run finishes with the hold listed. #6712 PR 4b: the pass
    // sees a database-only page at b.md's slug with no import record, so it holds file_drift (#6887), naming the repair.
    const resumed = await performManagedSync(engine,{sourceId:f.id,noPull:true});
    expect(resumed).toMatchObject({ status: 'first_sync', held_count: 1, held: [{ path: 'b.md', code: 'file_drift' }] });
    expect((await engine.getPage('b',{sourceId:f.id}))?.compiled_truth).toBe('A concurrently accepted newer observation.');
    expect((await engine.executeRaw<{last_commit:string|null}>('SELECT last_commit FROM sources WHERE id=$1',[f.id]))[0].last_commit).toBe(f.head);
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
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


test.each([false, true])('raw bytes changing after preparation conflict without publishing and the same request replays', async newlineOnly => withEnv({GBRAIN_HOME:home},async()=>{
  for(const engine of engines){
    await disposePersistenceConsumer(engine);
    const original='Original source observation before admission.\n';
    const f=await fixture(engine,{'a.md':original}); const binding=(await getWorktreeBinding(engine,f.id))!;
    const authority=await managedSyncAuthority(engine,f.id,binding.source_incarnation,f.root);
    const intent:SyncIntent={kind:'managed_sync_import',processingOptions:{noEmbed:false,noExtract:false,noSchemaPack:false},expected_revision:null,sourcePath:'a.md',path:'a.md',rawHash:sha256(original),content:original,...(newlineOnly?{lineEndingOnly:true}:{}),
      ownerEpoch:String(binding.owner_epoch),syncAuthority:authority,cursorKey:'test-cursor',runId:randomUUID(),index:0,total:1,from:null,target:f.head,slugMode:'git-root'};
    const requestId=randomUUID();
    const admission={requestId,operation:'submit_job',sourceId:f.id,sourceIncarnation:binding.source_incarnation,slug:'a',pageId:null,
      worktreeId:binding.worktree_id,topologyGeneration:binding.topology_generation,principal:authority.writer.principal,authority:authority.writer,callerIntent:intent,intent};
    const accepted=await admitWrite(engine,admission); const claimed=(await claimNextWrite(engine,localHostId()))!; expect(claimed.id).toBe(accepted.id);
    const prepared=await prepareManagedSyncMutation(engine,claimed,{engine:engine.kind});
    const newer=newlineOnly?original.replace(/\n/g,'\r\n'):'New external source observation after preparation.\n'; writeFileSync(join(f.root,'a.md'),newer);
    const outcome=await publishMutation(engine,claimed,prepared);
    expect(outcome.state).toBe('conflict'); expect(outcome.error_code).toBe('source_changed');
    expect(await engine.getPage('a',{sourceId:f.id})).toBeNull(); expect(readFileSync(join(f.root,'a.md'),'utf8')).toBe(newer);
    const replay=await admitWrite(engine,admission); expect(replay.id).toBe(accepted.id); expect(replay.state).toBe('conflict');
    expect((await getWriteRequest(engine,authority.writer.principal,requestId))?.intent).toEqual(intent);
  }
}),120_000);

test('managed terminal receipts survive a missing ledger and corrected retry uses a new ID', async () =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      // #6340 holds a pinned-worktree conflict by default; `sync.holds=fail` keeps the blocking receipt this test is about.
      await engine.setConfig('sync.holds', 'fail');
      try {
      const f = await fixture(engine, { 'notes/example.md': 'An original observation about the example system.\n' });
      await performManagedSync(engine, { sourceId: f.id, noPull: true });
      const pinned = 'A newly committed observation about the example system.\n';
      const path = join(f.root, 'notes/example.md');
      writeFileSync(path, pinned);
      const target = commit(f.root);
      const working = 'A private uncommitted observation that must not appear in diagnostics.\n';
      writeFileSync(path, working);
      const opts = { sourceId: f.id, noPull: true };
      const blocked = await performManagedSync(engine, opts);
      expect(blocked).toMatchObject({ status: 'blocked_by_failures', failedFiles: 1, filesImported: 0,
        managedWrite: { source_id: f.id, slug: 'notes/example', path: 'notes/example.md', write_error: 'source_changed',
          reason: 'pinned_git_worktree_conflict', ledger_recorded: true, write_request: { state: 'conflict', retry_after_ms: null } } });
      expect(blocked.managedWrite?.line_endings).toBe(undefined);
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
      // #6712 PR 3 (L7): while the file keeps the bytes that refused, every sync replays the receipt; the fix below retries it.
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
      await expect(performManagedSync(engine, { ...opts, skipFailed: true })).rejects.toMatchObject({ code: 'managed_sync_flag_refused', detail: '--skip-failed' });
      writeFileSync(path, pinned);
      const corrected = await performManagedSync(engine, { ...opts, retryFailed: true });
      expect(corrected.status).toBe('synced');
      expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
      const requests = await engine.executeRaw<{ request_id: string; state: string }>('SELECT request_id,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
      expect(requests.filter(row => row.request_id === id)).toEqual([{ request_id: id, state: 'conflict' }]);
      expect(requests.at(-1)?.state).toBe('committed');
      expect(requests.at(-1)?.request_id).not.toBe(id);
      expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(target);
      } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
    }
  }), 120_000);

// The replay of a pinned-worktree refusal is decided by the file's bytes, not by its mtime against the stop's database
// timestamp: a filesystem timestamp lags the wall clock by up to a scheduler tick, so a correction written right after
// the stop was recorded read as unwritten and replayed the refusal (the flake of the test above, about 1 run in 7).
// The mtimes are forced to either side of the stop so the old comparison fails deterministically in both directions.
test('a pinned-worktree refusal replays on the file bytes, whatever the file mtime says', async () =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      await engine.setConfig('sync.holds', 'fail');
      try {
        const f = await fixture(engine, { 'notes/example.md': 'An original observation about the example system.\n' });
        await performManagedSync(engine, { sourceId: f.id, noPull: true });
        const pinned = 'A newly committed observation about the example system.\n';
        const working = 'A private uncommitted observation that must not appear in diagnostics.\n';
        const path = join(f.root, 'notes/example.md');
        writeFileSync(path, pinned);
        const target = commit(f.root);
        writeFileSync(path, working);
        const opts = { sourceId: f.id, noPull: true };
        const blocked = await performManagedSync(engine, opts);
        expect(blocked).toMatchObject({ status: 'blocked_by_failures', managedWrite: { reason: 'pinned_git_worktree_conflict', write_request: { state: 'conflict' } } });
        const minute = 60;
        const later = Date.now() / 1000 + minute, earlier = Date.now() / 1000 - minute;
        writeFileSync(path, working); utimesSync(path, later, later);
        const rewritten = await performManagedSync(engine, opts);
        expect(rewritten.status).toBe('blocked_by_failures');
        expect(rewritten.managedWrite?.write_request).toEqual(blocked.managedWrite!.write_request);
        writeFileSync(path, pinned); utimesSync(path, earlier, earlier);
        const corrected = await performManagedSync(engine, opts);
        expect(corrected.status).toBe('synced');
        expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(target);
      } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
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

// Page identity must survive repeated suffixes. Existing sync cases only used
// extension-free slugs; this exercises actual publication, without a new seam.
test('managed sync preserves extension-bearing slugs and their distinct extension-free siblings', async () =>
  withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const content = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
      const ordinary = content('Ordinary', 'The ordinary page remains separate.');
      const extended = content('Extended', 'The extension-bearing page keeps its identity.');
      // No explicit title: the overlay comparison must use the same filename fallback as import.
      const repeated = '---\ntype: note\n---\nThe repeated-extension page is separate too.\n';
      const f = await fixture(engine, {
        'notes/example.md': ordinary,
        'notes/example.md.md': extended,
        'notes/example.md.md.md': repeated,
      });
      const opts = { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true };
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'first_sync', added: 3 });
      const slugs = ['notes/example', 'notes/example.md', 'notes/example.md.md'];
      const before = await Promise.all(slugs.map(slug => engine.getPage(slug, { sourceId: f.id })));
      expect(new Set(before.map(page => page?.id)).size).toBe(3);
      expect(before.map(page => page?.title)).toEqual(['Ordinary', 'Extended', 'Example.Md.Md']);
      expect(before.map(page => page?.source_path)).toEqual(slugs.map(slug => `${slug}.md`));
      expect(readFileSync(join(f.root, 'notes/example.md.md.md'), 'utf8')).toBe(repeated);
      for (const slug of slugs) expect(readFileSync(join(f.root, `${slug}.md`), 'utf8')).not.toContain('slug:');
      writeFileSync(join(f.root, 'notes/example.md.md'), content('Extended', 'Updated extension-bearing content.'));
      const head = commit(f.root, 'update extension-bearing page');
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'synced', modified: 1, toCommit: head });
      const after = await Promise.all(slugs.map(slug => engine.getPage(slug, { sourceId: f.id })));
      expect(after.map(page => page?.id)).toEqual(before.map(page => page?.id));
      expect(after[0]?.compiled_truth).toBe(before[0]?.compiled_truth);
      expect(after[1]?.compiled_truth).toContain('Updated extension-bearing content.');
      expect(after[2]?.compiled_truth).toBe(before[2]?.compiled_truth);
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'up_to_date' });
    }
  }), 120_000);

test('managed sync still rejects conflicting explicit slugs on extension-bearing paths', async () =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const f = await fixture(engine, { 'notes/example.md.md':
        '---\ntype: note\ntitle: Example\nslug: notes/other\n---\nA conflicting identity must not be imported.\n' });
      // #5988: the conflicting file is held (never imported) instead of blocking the sync.
      const synced = await performManagedSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true });
      expect(synced).toMatchObject({ status: 'first_sync', held_count: 1 });
      expect(synced.held?.[0]).toMatchObject({ path: 'notes/example.md.md', code: 'frontmatter_slug_conflict' });
      expect(await engine.getPage('notes/example.md', { sourceId: f.id })).toBeNull();
      expect(await engine.getPage('notes/other', { sourceId: f.id })).toBeNull();
    }
  }), 120_000);

test('managed sync leaves reserved skillpack paths to the skill publisher instead of blocking (#5852)', async () =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      const page = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n${title} content.\n`;
      const f = await fixture(engine, {
        'topics/foo.md': page('Foo'),
        'skills/brain-router/SKILL.md': '---\nname: brain-router\ndescription: seeded pack skill\n---\n\n# Brain Router\n',
        'skillpack.json': '{"name":"example-pack","skills":["brain-router"]}\n',
        'docs/skills/nested.md': page('Nested'),
        'docs/skillset/tips.md': page('Tips'),
        'skills.md': page('Skills'),
      });
      const opts = { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true };
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'first_sync', added: 3 });
      const slugs = (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 ORDER BY slug', [f.id])).map(row => row.slug);
      expect(slugs).toEqual(['docs/skillset/tips', 'skills', 'topics/foo']);
      writeFileSync(join(f.root, 'skills/brain-router/SKILL.md'), '---\nname: brain-router\ndescription: edited\n---\n\n# Brain Router v2\n');
      const head = commit(f.root, 'edit the seeded skill');
      expect(await performManagedSync(engine, opts)).toMatchObject({ status: 'synced', added: 0, modified: 0, deleted: 0, toCommit: head });
      expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state<>'committed'", [f.id])).toEqual([]);
    }
  }), 120_000);

// #5984 / #6712 PR 4b: a synced source whose files are all removed in one commit, the named pages soft-deleted first.
const WAIVER_OPTS = { noPull: true, noEmbed: true, noExtract: true };
async function deletedFixture(engine: BrainEngine, files: Record<string, string>, softDeleted: string[]) {
  const f = await fixture(engine, files);
  expect((await performManagedSync(engine, { sourceId: f.id, ...WAIVER_OPTS })).status).toBe('first_sync');
  for (const slug of softDeleted) await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.softDeletePage(slug, { sourceId: f.id }), TEST_WRITE_ATTRIBUTION));
  for (const path of Object.keys(files)) rmSync(join(f.root, path));
  commit(f.root, 'remove every file');
  return f;
}
const deleteRequests = (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ slug: string; state: string }>(
  "SELECT slug,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_delete' ORDER BY sequence", [sourceId]);
/**
 * Runs `hook` on the `nth` snapshot read of `slug`. The default (2) is a delete's screen, which re-reads the page the pass classified.
 */
function onScreen(engine: BrainEngine, slug: string, hook: () => Promise<void>, nth = 2): BrainEngine {
  let reads = 0;
  return new Proxy(engine, { get(target, key) {
    if (key === 'readPageSnapshot') return async (read: string, opts: Parameters<BrainEngine['readPageSnapshot']>[1]) => {
      if (read === slug && ++reads === nth) await hook();
      return target.readPageSnapshot(read, opts);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;

// #6712 PR 4b: the live pass classifies a soft-deleted page whose file is gone at the pinned commit as `untracked` (settled), so it is never a
// candidate, waived or admitted; only a live page whose file is gone is deleted.
test('soft-deleted pages whose files are gone are not pass candidates; only the live page is deleted', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await deletedFixture(engine, { 'a.md': note('First'), 'b.md': note('Second'), 'c.md': note('Third'), 'd.md': note('Fourth') }, ['a', 'b', 'c']);
    const [{ sequence: seen }] = await engine.executeRaw<{ sequence: string }>('SELECT max(sequence)::text AS sequence FROM persistence_requests WHERE source_id=$1', [f.id]);
    const result = await performManagedSync(engine, { sourceId: f.id, ...WAIVER_OPTS });
    expect(result).toMatchObject({ status: 'synced', deleted: 1, waived: { imports: 0, deletes: 0 }, filesImported: 1, pass: { kind: 'full', candidates: 1 } });
    expect(result.legacySkips).toBeUndefined();
    const level = await readShadowLevel(engine, { sourceId: f.id });
    for (const path of ['a.md', 'b.md', 'c.md']) expect(level!.paths.find(entry => entry.path === path)?.result).toMatchObject({ cls: 'untracked', settled: true });
    for (const slug of ['a', 'b', 'c']) expect((await engine.readPageSnapshot(slug, { sourceId: f.id, includeDeleted: true }))?.page.deleted_at).toBeTruthy();
    expect((await engine.executeRaw<{ kind: string; slug: string; state: string }>("SELECT intent->>'kind' AS kind,slug,state FROM persistence_requests WHERE source_id=$1 AND sequence>$2::bigint ORDER BY sequence", [f.id, seen]))
      .map(row => [row.kind, row.slug, row.state]))
      .toEqual([['managed_sync_delete', 'd', 'committed'], ['managed_sync_checkpoint', '__managed_sync_checkpoint__', 'committed']]);
    expect(await engine.getPage('d', { sourceId: f.id })).toBeNull();
    expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(git(f.root, 'rev-parse', 'HEAD'));
  }
}), 120_000);

// #6712 PR 4b: a soft-deleted page whose file is gone is no pass candidate (nothing is read or waived), so the revocation
// lands on a live page's delete: its screen re-reads the page, and the revoked grant refuses before any admission.
test('revoked sync authority refuses before any delete is admitted', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await deletedFixture(engine, { 'a.md': note('Live until the grant is revoked') }, []);
    const clientId = `sync-client-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
      VALUES($1,'example-client','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, f.id]);
    const ctx = { engine, remote: true, sourceId: f.id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: f.id, allowedOperations: ['submit_job'] } } as OperationContext;
    const accepted = await prepareRemoteJob(ctx, 'sync', { noPull: true });
    const before = (await engine.readPageSnapshot('a', { sourceId: f.id }))!.revision;
    let revoked = false;
    const proxy = onScreen(engine, 'a', async () => { await engine.executeRaw("UPDATE oauth_clients SET scope='read' WHERE client_id=$1", [clientId]); revoked = true; });
    try {
      await expect(withSubmissionAuthority(accepted.authority, () => performManagedSync(proxy, accepted.data))).rejects.toMatchObject({ code: 'permission_denied' });
      expect(revoked).toBe(true);
      expect(await deleteRequests(engine, f.id)).toHaveLength(0);
      const after = await engine.readPageSnapshot('a', { sourceId: f.id });
      expect(after?.page.deleted_at ?? null).toBeNull();
      expect(after!.revision).toBe(before);
    } finally { await disposePersistenceConsumer(proxy); }
  }
}), 120_000);

// #6712 PR 4b: the waiver run (no-op deletes of soft-deleted pages, frozen and screened in one cursor run) is cursor-only; on the
// pass a soft-deleted page whose file is gone is no candidate (above). What survives is the delete of a live page whose file
// is gone, and these rows pin its two data guarantees: a database edit landing between the pass's read and its delete is
// never overwritten, and an unfinished foreground request on the page is never overtaken by the delete.
test('a database edit of a live page between the pass\'s screen and its delete is held concurrent_write; the page and the edit stay', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) {
    const f = await deletedFixture(engine, { 'a.md': note('Live until its file is removed') }, []);
    const edited = 'A concurrent database-only edit that the delete must not overwrite.';
    const proxy = onScreen(engine, 'a', () => engine.transaction(tx => withCoordinatedWrite(tx, [f.id], async () => { await tx.putPage('a', {
      type: 'note', title: 'Example', compiled_truth: edited, timeline: '', frontmatter: {}, content_hash: 'concurrent-edit' }, { sourceId: f.id }); }, TEST_WRITE_ATTRIBUTION)));
    try {
      const result = await performManagedSync(proxy, { sourceId: f.id, ...WAIVER_OPTS });
      expect(result).toMatchObject({ deleted: 0, held_count: 1, held: [{ path: 'a.md', code: 'concurrent_write' }] });
      expect((await engine.getPage('a', { sourceId: f.id }))?.compiled_truth).toBe(edited);
      expect((await deleteRequests(engine, f.id)).filter(row => row.state === 'committed')).toEqual([]);
    } finally { await disposePersistenceConsumer(proxy); rmSync(syncFailuresPath(), { force: true }); }
  }
}), 120_000);

test.each(['rename', 'database-only'] as const)('an unfinished %s request for a live page is never overtaken by the pass\'s delete', async kind => withEnv({ GBRAIN_HOME: home }, async () => {
  let hold = Promise.withResolvers<void>();
  registerMutationPreparer('test_pass_delete_hold', async () => { await hold.promise; return { observedRevision: null, noop: true, apply: async () => ({ status: 'complete' }) }; });
  try {
    for (const engine of engines) {
      hold = Promise.withResolvers<void>();
      const f = await deletedFixture(engine, { 'a.md': note('Pending foreground work') }, []);
      const binding = (await getWorktreeBinding(engine, f.id))!;
      const authority = await managedSyncAuthority(engine, f.id, binding.source_incarnation, f.root);
      const page = (await engine.readPageSnapshot('a', { sourceId: f.id }))!.page;
      const intent = kind === 'rename' ? { renameFrom: { slug: 'a', pageId: page.id } } : { restore: true };
      const foreground = await admitWrite(engine, { operation: 'test_pass_delete_hold', sourceId: f.id, sourceIncarnation: binding.source_incarnation,
        slug: kind === 'rename' ? 'a-renamed' : 'a', pageId: kind === 'rename' ? null : page.id,
        worktreeId: kind === 'database-only' ? null : binding.worktree_id, topologyGeneration: kind === 'database-only' ? null : binding.topology_generation,
        principal: authority.writer.principal, authority: authority.writer, callerIntent: intent, intent });
      const foregroundState = async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE id=$1::uuid', [foreground.id]))[0];
      const result = await performManagedSync(engine, { sourceId: f.id, ...WAIVER_OPTS });
      expect(result.deleted).toBe(0);
      // database-only: the page's open request makes its path in_flight, so no delete is admitted; rename: the delete is
      // admitted behind the rename's renameFrom (#6862 FIFO) and waits for it.
      const waiting = (await deleteRequests(engine, f.id)).map(row => ['committed', 'conflict', 'failed'].includes(row.state) ? `${row.slug}:done` : `${row.slug}:waiting`);
      expect(waiting).toEqual(kind === 'rename' ? ['a:waiting'] : []);
      expect(['committed', 'conflict', 'failed']).not.toContain((await foregroundState()).state);
      expect(await engine.getPage('a', { sourceId: f.id })).not.toBeNull();
      hold.resolve();
      await waitFor(async () => ['committed', 'conflict', 'failed'].includes((await foregroundState()).state), { timeoutMs: 30_000 });
      let finished = await performManagedSync(engine, { sourceId: f.id, ...WAIVER_OPTS });
      for (let i = 0; i < 5 && finished.status === 'partial'; i++) finished = await performManagedSync(engine, { sourceId: f.id, ...WAIVER_OPTS });
      expect(finished).toMatchObject({ status: 'synced' });
      const [order] = await engine.executeRaw<{ after: boolean }>("SELECT d.completed_at >= g.completed_at AS after FROM persistence_requests d, persistence_requests g WHERE d.source_id=$1 AND d.intent->>'kind'='managed_sync_delete' AND d.state='committed' AND g.id=$2::uuid", [f.id, foreground.id]);
      expect(order).toEqual({ after: true });
      expect(await engine.getPage('a', { sourceId: f.id })).toBeNull();
      await disposePersistenceConsumer(engine);
    }
  } finally { hold.resolve(); }
}), 120_000);

test('a CRLF-only working copy of a committed edit imports the committed bytes on the pass, with no refusal or receipt', async () =>
  withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    for (const engine of engines) {
      await engine.setConfig('sync.holds', 'fail');
      try {
        const f = await fixture(engine, { 'notes/example.md': 'An original observation about the example system.\n' });
        await performManagedSync(engine, { sourceId: f.id, noPull: true });
        const pinned = 'A newly committed observation about the example system.\n';
        const path = join(f.root, 'notes/example.md');
        writeFileSync(path, pinned);
        const target = commit(f.root);
        const working = pinned.replace(/\n/g, '\r\n');
        writeFileSync(path, working);
        const result = await performManagedSync(engine, { sourceId: f.id, noPull: true });
        expect(result).toMatchObject({ status: 'synced', modified: 1, toCommit: target });
        expect(result.managedWrite).toBeUndefined();
        expect((await engine.getPage('notes/example', { sourceId: f.id }))?.compiled_truth).toContain('newly committed');
        expect(readFileSync(path, 'utf8')).toBe(working);
        expect(loadSyncFailures().filter(row => row.source_id === f.id)).toHaveLength(0);
        expect((await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence", [f.id])).map(row => row.state))
          .toEqual(['committed', 'committed']);
        expect((await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(target);
      } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
    }
  }), 120_000);

test('the waiver lookup for unfinished page requests is served by the request indexes', async () => {
  for (const engine of engines) {
    const plan = await engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL enable_seqscan=off');
      return tx.executeRaw<Record<string, string>>(`EXPLAIN ${UNFINISHED_PAGE_REQUEST_SQL}`,
        [randomUUID(), randomUUID(), 'example-source', 'notes/example', 1, '1', 'notes/example.md', 'notes/example.md']);
    });
    const text = plan.map(row => Object.values(row)[0]).join('\n');
    // Every branch (worktree pending, worktree recovery, database-only pending) is an index scan; the planner may
    // serve the database-only branch from either partial pending index.
    expect(text.match(/(Index Scan|Index Only Scan|Bitmap Index Scan) (using|on) persistence_requests_(pending|recovery|database_pending)\b/g)?.length).toBeGreaterThanOrEqual(3);
    expect(text).toContain('persistence_requests_recovery');
    expect(text).not.toContain('Seq Scan');
  }
}, 60_000);

test('a fact withdrawn between sync preparation and canonical file writeback conflicts without publishing', async () => withEnv({GBRAIN_HOME:home},async()=>{
  for(const engine of engines){
    const f=await fixture(engine,{'a.md':'An original observation before the withdrawal race.\n'});
    await performManagedSync(engine,{sourceId:f.id,noPull:true,noEmbed:true,noExtract:true});
    await disposePersistenceConsumer(engine);
    await engine.transaction(tx=>withCoordinatedWrite(tx,[f.id],()=>tx.addTag('a','database-only-tag',{sourceId:f.id}),TEST_WRITE_ATTRIBUTION));
    const base=(await engine.readPageSnapshot('a',{sourceId:f.id}))!;
    const claim='withdrawn between managed sync preparation and publication';
    const content=`Facts: ${renderFactsTable([{rowNum:1,claim,kind:'fact',confidence:1,visibility:'world',notability:'medium',active:true,context:'test evidence'}])}\n`;
    writeFileSync(join(f.root,'a.md'),content); const target=commit(f.root);
    const binding=(await getWorktreeBinding(engine,f.id))!;
    const authority=await managedSyncAuthority(engine,f.id,binding.source_incarnation,f.root);
    const intent:SyncIntent={kind:'managed_sync_import',processingOptions:{noEmbed:true,noExtract:true,noSchemaPack:false},expected_revision:base.revision,sourcePath:'a.md',path:'a.md',rawHash:sha256(content),content,
      ownerEpoch:String(binding.owner_epoch),syncAuthority:authority,cursorKey:'test-cursor',runId:randomUUID(),index:0,total:1,from:f.head,target,slugMode:'git-root'};
    await admitWrite(engine,{requestId:randomUUID(),operation:'submit_job',sourceId:f.id,sourceIncarnation:binding.source_incarnation,slug:'a',pageId:base.page.id,
      worktreeId:binding.worktree_id,topologyGeneration:binding.topology_generation,principal:authority.writer.principal,authority:authority.writer,callerIntent:intent,intent});
    const claimed=(await claimNextWrite(engine,localHostId()))!;
    const prepared=await prepareManagedSyncMutation(engine,claimed,{engine:engine.kind});
    expect(prepared.file?.content).toContain(claim);
    const fact=await engine.transaction(tx=>withCoordinatedWrite(tx,[f.id],()=>
      tx.insertFact({fact:claim,source:'remember',visibility:'world'},{source_id:f.id}),TEST_WRITE_ATTRIBUTION));
    await engine.transaction(tx=>withCoordinatedWrite(tx,[f.id],()=>recordFactWithdrawal(tx,fact.id,f.id,true),TEST_WRITE_ATTRIBUTION));
    const boundaries:string[]=[];
    const outcome=await publishMutation(engine,claimed,prepared,localHostId(),{boundary:async name=>{boundaries.push(name);},fileBoundary:name=>{boundaries.push(name);}});
    expect(outcome).toMatchObject({state:'conflict',error_code:'revision_conflict'});
    expect(boundaries).not.toContain('before_publication');
    expect(boundaries).not.toContain('before_file');
    expect(readFileSync(join(f.root,'a.md'),'utf8')).toBe(content);
    expect((await engine.readPageSnapshot('a',{sourceId:f.id}))?.revision).toBe(base.revision);
  }
}),120_000);
