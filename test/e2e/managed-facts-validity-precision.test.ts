/** Frozen extraction payloads must not lose fractional validity when rendered into an entity fence. */
import { expect,test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { prepareManagedFactsSession,publishManagedFacts } from '../../src/core/persistence/facts-maintenance.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway,resetGateway } from '../../src/core/ai/gateway.ts';
import { parseFactsFenceFor } from '../../src/core/facts-fence.ts';

for(const backend of ['pglite','postgres'] as const)test(`managed extracted facts retain fractional validity in both the fence and its projection (${backend})`,async()=>{
 if(backend==='postgres'&&!process.env.DATABASE_URL)throw new Error('PostgreSQL precision regression requires DATABASE_URL');
 configureGateway({env:{},embedding_model:'openai:text-embedding-3-large',embedding_dimensions:1536});
 const pg=backend==='postgres'?await isolatedPersistencePostgres(process.env.DATABASE_URL!):null;
 const engine=pg?.engine??new PGLiteEngine();const fetchOriginal=globalThis.fetch;
 try{
  globalThis.fetch=(()=>{throw new Error('No provider or network calls are permitted');}) as unknown as typeof fetch;
  configureGateway({env:{},embedding_model:'openai:text-embedding-3-large',embedding_dimensions:1536});
  if(!pg){await engine.connect({});await engine.initSchema();}
  await engine.setConfig('embedding_disabled','true');await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const operation={engine,remote:false,sourceId:'default',config:{engine:engine.kind,embedding_disabled:true},dryRun:false,logger:console};
  for(const [slug,type,title] of [['people/precision-owner','person','Precision Owner'],['notes/precision-evidence','note','Precision evidence']] as const)await operationsByName.put_page.handler(operation,{slug,source_id:'default',content:`---\ntype: ${type}\ntitle: ${title}\ncreated: 2026-11-15\nfacts_backstop: false\n---\n\nSynthetic precision fixture.`});
  const source=await engine.readPageSnapshot('notes/precision-evidence',{sourceId:'default'});
  const validFrom=new Date('2026-11-15T01:02:03.885Z'),validUntil=new Date('2036-11-15T01:02:03.987Z');
  const ctx={engine,operationContext:operation,remote:false,sourceId:'default',source:'mcp:extract_facts' as const,sessionId:'synthetic-precision',validFrom};
  const session=await prepareManagedFactsSession(ctx,{turnText:source!.page.compiled_truth,pageSlug:'notes/precision-evidence'});expect(session).not.toBeNull();
  const result=await publishManagedFacts(engine,session!,ctx,[{fact:'Precision Owner retains the stated validity interval.',kind:'fact',entity_slug:'people/precision-owner',embedding:null,source:'mcp:extract_facts',valid_from:validFrom,valid_until:validUntil,confidence:1,notability:'high'}],'private','notes/precision-evidence');
  expect(result.inserted).toBe(1);
  const [row]=await engine.executeRaw<{valid_from:string;valid_until:string}>('SELECT valid_from::text,valid_until::text FROM facts WHERE id=$1',[result.fact_ids[0]]);
  expect(new Date(row!.valid_from).toISOString()).toBe(validFrom.toISOString());expect(new Date(row!.valid_until).toISOString()).toBe(validUntil.toISOString());
  const target=await engine.readPageSnapshot('people/precision-owner',{sourceId:'default'});const [fact]=parseFactsFenceFor(target!.page.compiled_truth,{slug:'people/precision-owner'}).facts;
  expect(new Date(fact!.validFrom!).toISOString()).toBe(validFrom.toISOString());expect(new Date(fact!.validUntil!).toISOString()).toBe(validUntil.toISOString());
 }finally{await disposePersistenceConsumer(engine);if(pg)await pg.close();else await engine.disconnect();resetGateway();globalThis.fetch=fetchOriginal;}
},120000);

for(const backend of ['pglite','postgres'] as const)test(`managed supersession writes the same fractional old-validity boundary to its fence and row (${backend})`,async()=>{
 if(backend==='postgres'&&!process.env.DATABASE_URL)throw new Error('isolated PostgreSQL required');
 configureGateway({env:{},embedding_model:'voyage:voyage-4',embedding_dimensions:1024});
 const pg=backend==='postgres'?await isolatedPersistencePostgres(process.env.DATABASE_URL!):null;const engine=pg?.engine??new PGLiteEngine();const fetchOriginal=globalThis.fetch;
 try{
  globalThis.fetch=(()=>{throw new Error('No network or provider calls');}) as unknown as typeof fetch;
  if(!pg){await engine.connect({});await engine.initSchema();}await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const operation={engine,remote:false,sourceId:'default',config:{engine:engine.kind,embedding_disabled:false},dryRun:false,logger:console};
  for(const [slug,type] of [['people/precision-owner','person'],['notes/precision-evidence','note']] as const)await operationsByName.put_page.handler(operation,{slug,source_id:'default',content:`---\ntype: ${type}\ntitle: Synthetic precision\ncreated: 2026-11-15\nfacts_backstop: false\n---\n\nSynthetic evidence.`});
  for(const [key,value] of Object.entries({embedding_model:'voyage:voyage-4',embedding_dimensions:'1024',embedding_disabled:'false'}))await engine.setConfig(key,value);
  const source=await engine.readPageSnapshot('notes/precision-evidence',{sourceId:'default'});
  const save=async(fact:string,when:Date,supersede:boolean)=>{
   const ctx={engine,operationContext:operation,remote:false,sourceId:'default',source:'mcp:extract_facts' as const,sessionId:'synthetic-precision',validFrom:when};
   const session=await prepareManagedFactsSession(ctx,{turnText:source!.page.compiled_truth,pageSlug:'notes/precision-evidence'});session!.embedding={model:'voyage:voyage-4',dimensions:1024};
   return publishManagedFacts(engine,session!,ctx,[{fact,kind:'fact',entity_slug:'people/precision-owner',embedding:new Float32Array(Array.from({length:1024},(_,i)=>i===0?1:0)),source:'mcp:extract_facts',valid_from:when,confidence:1,notability:'high'}],'private','notes/precision-evidence',{supersede});
  };
  const first=await save('Precision Owner requires a review.',new Date('2026-01-01T01:02:03.111Z'),false);const boundary=new Date('2030-11-15T01:02:03.885Z');
  const second=await save('Precision Owner requires one review.',boundary,true);expect(second.superseded).toBe(1);
  const [old]=await engine.executeRaw<{valid_until:string;superseded_by:number}>('SELECT valid_until::text,superseded_by FROM facts WHERE id=$1',[first.fact_ids[0]]);expect(Number(old!.superseded_by)).toBe(second.fact_ids[0]!);expect(new Date(old!.valid_until).getTime()).toBe(boundary.getTime());
  const page=await engine.readPageSnapshot('people/precision-owner',{sourceId:'default'});const retired=parseFactsFenceFor(page!.page.compiled_truth,{slug:'people/precision-owner'}).facts.find(f=>!f.active)!;expect(new Date(retired.validUntil!).getTime()).toBe(boundary.getTime());
 }finally{await disposePersistenceConsumer(engine);if(pg)await pg.close();else await engine.disconnect();resetGateway();globalThis.fetch=fetchOriginal;}
},120000);
