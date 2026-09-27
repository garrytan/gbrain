import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { inspectLockHolder } from '../src/core/pglite-lock.ts';
import { persistenceSocketPathForConfig, requestPersistenceCapabilities, requestPersistenceAdministration } from '../src/core/persistence/ipc.ts';
import { readPersistenceCliRegistration } from '../src/core/persistence/local-client.ts';
import { parsePersistenceSyncArgs } from '../src/commands/sync-persistence-delegate.ts';
import { withEnv } from './helpers/with-env.ts';

const home=mkdtempSync(join(tmpdir(),'gbrain-stdio-sync-'));
const root=join(home,'repo'), databasePath=join(home,'db');
const config={engine:'pglite' as const,database_path:databasePath};
const env={...process.env,GBRAIN_HOME:home,DATABASE_URL:undefined,GBRAIN_DATABASE_URL:undefined,GBRAIN_BRAIN_ID:'host',
  GBRAIN_SOURCE:'workspace',GBRAIN_NO_BANNER:'1',GBRAIN_BACKUP_CHECK:'0',GBRAIN_SWEEP:'0',GBRAIN_SKIP_STARTUP_HOOKS:'1'};
let setup:PGLiteEngine;
let owner:ReturnType<typeof Bun.spawn>|undefined;
let stdout='',stderr='';
const readers:Promise<void>[]=[];
async function read(stream:ReadableStream<Uint8Array>,append:(text:string)=>void) {
  const decoder=new TextDecoder(),reader=stream.getReader();
  try{for(;;){const next=await reader.read();if(next.done)return;append(decoder.decode(next.value));}}finally{reader.releaseLock();}
}
async function until(check:()=>boolean|Promise<boolean>,ms=60000) {
  const deadline=performance.now()+ms;
  while(performance.now()<deadline){if(await check())return;if(owner?.exitCode!==null&&owner?.exitCode!==undefined)throw new Error(`Owner exited: ${stderr}`);await new Promise(r=>setTimeout(r,50));}
  throw new Error(`Owner did not become ready: ${stderr}`);
}
async function cli(args:string[],childHome=home) {
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),...args],{cwd:childHome,env:{...env,GBRAIN_HOME:childHome},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
  try {const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return{out,err,code};}
  finally{clearTimeout(timer);}
}
beforeAll(async()=>{
  mkdirSync(join(home,'.gbrain'),{recursive:true});mkdirSync(root);
  writeFileSync(join(home,'.gbrain','config.json'),JSON.stringify(config));
  writeFileSync(join(root,'a.md'),'A durable source observation imported through the resident owner.\n');
  writeFileSync(join(root,'excluded.md'),'An intentionally excluded observation.\n');
  execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'add','.']);
  execFileSync('git',['-C',root,'-c','user.name=Example','-c','user.email=example@example.invalid','commit','-qm','source content']);
  setup=new PGLiteEngine();
  await withEnv(env,async()=>{
    await setup.connect(config);await setup.initSchema();
    await setup.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('workspace','workspace',$1,'{}')",[root]);
    await claimWorktree(setup,'workspace',root);await registerLocalWriter(setup,'cli');await registerLocalWriter(setup,'stdio');
    await setup.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');await setup.disconnect();
  });
  owner=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/persistence-stdio-owner.ts')],{cwd:home,env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  readers.push(read(owner.stdout as ReadableStream<Uint8Array>,s=>{stdout+=s;}),read(owner.stderr as ReadableStream<Uint8Array>,s=>{stderr+=s;}));
  await until(async()=>{try{await requestPersistenceCapabilities(persistenceSocketPathForConfig(config)!,250);return true;}catch{return false;}});
  (owner.stdin as {write:(value:string)=>unknown}).write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'example-test',version:'1'}}})+'\n');
  await until(()=>stdout.split('\n').some(line=>{try{return JSON.parse(line).id===1;}catch{return false;}}));
},120000);
afterAll(async()=>{
  if(owner){owner.kill('SIGTERM');const timer=setTimeout(()=>owner?.kill('SIGKILL'),10000);await owner.exited;clearTimeout(timer);}
  await Promise.allSettled(readers);await setup?.disconnect();rmSync(home,{recursive:true,force:true});
},30000);

test('actual CLI sync and page reads delegate to a real non-serve stdio owner before opening PGLite',async()=>{
  expect(inspectLockHolder(databasePath)).toMatchObject({held:true,serve:false});
  const synced=await cli(['sync','--source','workspace','--no-pull','--exclude','excluded.md','--json','--no-hard-deadline']);
  expect({code:synced.code,err:synced.err}).toMatchObject({code:0});
  expect(JSON.parse(synced.out)).toMatchObject({schema_version:1,source_id:'workspace',sync_status:'first_sync',added:1});
  expect(synced.err).toContain('registered PGLite owner');
  const page=await cli(['call','get_page',JSON.stringify({slug:'a',source_id:'workspace'})]);
  expect({code:page.code,err:page.err}).toMatchObject({code:0});
  expect(JSON.parse(page.out).compiled_truth).toContain('resident owner');
  const status=await cli(['sources','writer','status','--json']);
  expect({code:status.code,err:status.err}).toMatchObject({code:0});
  expect(inspectLockHolder(databasePath).pid).toBe(owner!.pid);
},90000);

test('strict sync parsing retains filtering options and rejects runtime authority fields',async()=>{
  await withEnv(env,async()=>{
    expect((await parsePersistenceSyncArgs(['--source','workspace','--no-pull','--working-tree','--exclude','draft/**','--include-hidden','.notes/**','--no-hard-deadline'],home)).options)
      .toMatchObject({sourceId:'workspace',noPull:true,workingTree:true,exclude:['draft/**'],includeHidden:['.notes/**']});
    await expect(parsePersistenceSyncArgs(['--skipLock','--no-hard-deadline'],home)).rejects.toMatchObject({code:'invalid_params'});
  });
});

test('the remote stdio credential cannot enter the trusted CLI sync lane',async()=>{
  const socket=persistenceSocketPathForConfig(config)!,cap=await requestPersistenceCapabilities(socket);
  const registration=JSON.parse(readFileSync(join(home,'.gbrain','persistence',`${cap.brain_id}.stdio.json`),'utf8'));
  await expect(requestPersistenceAdministration(socket,{version:1,kind:'administration',brain_id:cap.brain_id,
    operation:'writer_sync',params:{options:{sourceId:'workspace',noPull:true},cwd:home,timeoutSeconds:30},registration:{...registration,lane:'cli'}}))
    .rejects.toMatchObject({code:'permission_denied'});
});

test('a separate user home cannot borrow the resident owner registration',async()=>{
  const otherHome=join(home,'other-user');mkdirSync(join(otherHome,'.gbrain'),{recursive:true});
  writeFileSync(join(otherHome,'.gbrain','config.json'),JSON.stringify(config));
  const denied=await cli(['sync','--source','workspace','--no-pull','--json','--no-hard-deadline'],otherHome);
  expect(denied.code).toBe(1);expect(denied.err).toContain('permission_denied');
  expect(denied.err).toContain('registration');expect(denied.err).not.toContain('LockTimeout');
  expect(inspectLockHolder(databasePath).pid).toBe(owner!.pid);
},60000);

test('a revoked CLI cannot fall through to a competing database open',async()=>{
  await withEnv(env,async()=>{
    const socket=persistenceSocketPathForConfig(config)!,cap=await requestPersistenceCapabilities(socket),registration=readPersistenceCliRegistration(cap.brain_id);
    await requestPersistenceAdministration(socket,{version:1,kind:'administration',brain_id:cap.brain_id,operation:'local_writer_revoke',params:{id:registration.id},registration});
  });
  const denied=await cli(['sync','--source','workspace','--no-pull','--json','--no-hard-deadline']);
  expect(denied.code).toBe(1);expect(denied.err).toContain('permission_denied');expect(denied.err).not.toContain('LockTimeout');
  expect(inspectLockHolder(databasePath).pid).toBe(owner!.pid);
},60000);
