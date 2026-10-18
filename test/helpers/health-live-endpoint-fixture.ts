// Synthetic getHealth SQL regression for #6940. Run only in its own Bun process:
// mock.module replacements must not affect the rest of the test suite.
import {mock} from 'bun:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
const core=resolve(import.meta.dir,'../../src/core');
const stub=(n:string,v:object)=>mock.module(resolve(core,n),()=>v);
stub('types.ts',{MIN_ENTITY_PAGES_FOR_COVERAGE:5});
stub('utils.ts',{parseEmbedding:()=>{throw Error('unexpected vector decode')}});
stub('link-extraction-watermark.ts',{effectiveLinkExtractorWatermark:async()=> '2026-01-01T00:00:00Z'});
stub('timeline-grading.ts',{loadTimelineGradedPredicate:async()=>()=>true,gradeTimelinePages:()=>{throw Error('unexpected grade')}});
stub('search/embedding-column.ts',{quoteIdentifier:(s:string)=>{assert.match(s,/^[a-z_]+$/);return `"${s}"`}});
const {renderFragment}=await import(resolve(core,'engine-sql/fragment.ts'));
const {getHealth}=await import(resolve(core,'engine-sql/health.ts'));
const db=new PGlite();let statements=0;let rawCount:number|undefined;
const exec={run:async(f:any)=>{statements++;let q=renderFragment(f);const res=await db.query<{link_count:unknown}>(q.text,q.params);if(statements%3===1)rawCount=Number(res.rows[0].link_count);return res}};
// Actual schema-pack predicate, quarantine filter and orphan policy run natively.
const filter={types:['researcher'],per_source:[{source_id:'B',types:['company']}]};
const deps={embeddingColumn:async()=> 'active_embedding', getConfig:async()=>null,
 countStalePagesForExtraction:async()=>0,entityTypes:async()=>({filter,status:'resolved'})};
await db.exec(`CREATE TABLE pages(id int primary key,slug text,type text,source_id text,deleted_at timestamptz,frontmatter jsonb);
 CREATE TABLE links(from_page_id int,to_page_id int); CREATE TABLE content_chunks(page_id int,embedding text,active_embedding text);
 CREATE TABLE timeline_entries(page_id int);
 INSERT INTO pages VALUES
 (1,'hub','researcher','A',NULL,'{}'),(2,'deleted','note','A',now(),'{}'),
 (3,'live','note','A',NULL,'{}'),(4,'other','company','B',NULL,'{}'),
 (5,'quarantine','researcher','A',NULL,'{"quarantine":true}'),
 (6,'deleted-entity','researcher','A',now(),'{}'),(7,'zero','researcher','A',NULL,'{}'),
 (8,'nonentity','person','A',NULL,'{}'),(9,'tie','researcher','A',NULL,'{}');
 INSERT INTO links VALUES (1,2),(2,1),(1,3),(3,1),(1,1),(1,4),(4,1),(1,5),(1,6),(1,999);
 INSERT INTO content_chunks VALUES (1,'legacy',NULL),(1,'legacy','yes'),(2,'legacy',NULL);
 INSERT INTO timeline_entries VALUES(1);`);
const results:any[]=[];
try {
 const cases:[string,any,number,number][]=[['wide',undefined,6,10],['A',{sourceId:'A'},4,7],['both',{sourceIds:['A','B']},6,9],['dedup',{sourceIds:['A','A'],sourceId:'B'},4,7],['B',{sourceId:'B'},0,0],['empty',{sourceIds:[],sourceId:'A'},undefined as any,0]];
 const failures:string[]=[];
 for(const [name,scope,want,raw] of cases){
  const h=await getHealth(exec,scope,deps);results.push({name,connected:h.most_connected,raw:rawCount});
  try {
   assert.equal(rawCount,raw,'raw link storage boundary');
   if(name==='empty'){assert.deepEqual(h.most_connected,[]);assert.equal(h.page_count,0);continue}
   const hub=h.most_connected.find((v:any)=>v.slug==='hub');
   if(want!==0)assert.equal(hub?.link_count,want,'LIVE_ENDPOINT_DEGREE '+name);
   assert.ok(!h.most_connected.some((v:any)=>['quarantine','deleted-entity','nonentity','deleted'].includes(v.slug)));
   if(name==='wide'||name==='both')assert.equal(h.most_connected.find((v:any)=>v.slug==='other')?.link_count,2);
   if(name==='B')assert.deepEqual(h.most_connected,[{slug:'other',link_count:0}]);
   if(name==='A'||name==='dedup'){
    assert.deepEqual(h.most_connected,[{slug:'hub',link_count:4},{slug:'tie',link_count:0},{slug:'zero',link_count:0}]);
    assert.equal(h.page_count,6);assert.equal(h.entity_page_count,3);assert.equal(h.linkable_page_count,5);
    assert.equal(h.missing_embeddings,1);assert.equal(h.embed_coverage,1/3);assert.equal(h.dead_links,1);
   }
  }catch(e){failures.push(String(e))}
 }
 // Isolate each direction so one arm cannot compensate for the other;
 // duplicate link rows remain multiplicative and selflinks count once.
 for(const [name,edges,want] of [
  ['deleted inbound','(2,1)',0],['deleted outbound','(1,2)',0],
  ['live inbound','(3,1)',1],['live outbound','(1,3)',1],
  ['self','(1,1)',1],['duplicate rows','(1,3),(1,3)',2],
  ['missing inbound','(999,1)',0],['missing outbound','(1,999)',0],
  ['quarantined far unchanged','(1,5)',1]
 ] as const){
  await db.exec(`DELETE FROM links; INSERT INTO links VALUES ${edges}`);
  const h=await getHealth(exec,{sourceId:'A'},deps);
  const actual=h.most_connected.find((v:any)=>v.slug==='hub')?.link_count;
  results.push({name,actual,want});
  try{assert.equal(actual,want,'ISOLATED_DIRECTION '+name)}catch(e){failures.push(String(e))}
 }
 assert.equal(statements,45);console.log(JSON.stringify({results,statements,failures}));assert.deepEqual(failures,[]);
} finally {await db.close()}
