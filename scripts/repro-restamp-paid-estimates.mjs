import {stripTypeScriptTypes} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
// Run: node --experimental-vm-modules scripts/repro-restamp-paid-estimates.mjs
// Synthetic SQL-contract regression: no real DB, filesystem writes or provider calls.
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const variant='source';
const core=path.join(root,'src/core');
const MODEL='openai:text-embedding-3-large', DIMS=1536;
const stats={sql:[],writes:0,providerDispatches:0,tests:[]};
const denied=(name)=>(...args)=>{throw new Error('DENIED seam '+name);};
const recipe={id:'openai',touchpoints:{embedding:{max_batch_tokens:100000,max_batch_items:100,chars_per_token:4,safety_factor:0.8}}};
const mocks={
 'ai/model-resolver.ts':{resolveRecipe:()=>({recipe,parsed:{modelId:'text-embedding-3-large'}}),embeddingDimsForModel:()=>DIMS},
 'embedding-dim-check.ts':{readContentChunksEmbeddingDim:async e=>({exists:e.columnExists??true,dims:e.columnDims??DIMS})},
 'search/embedding-column.ts':{resolveActiveEmbeddingColumnFromEngine:async()=>({name:'embedding'}),quoteIdentifier:n=>{assert.match(n,/^[a-z_][a-z0-9_]*$/);return '"'+n+'"';}},
 'stored-embedding-identity.ts':{readStoredEmbeddingIdentity:async()=>null},
 'search/mode.ts':{loadSearchModeConfig:async()=>({}),resolveSearchMode:()=>({reranker_enabled:false})},
 'facts/audit-sources.ts':{AUDIT_ROW_SOURCES:[]},
 'facts/embedding-identity.ts':{countStaleFactEmbeddings:async e=>e.facts,eligibleFactEmbedding:'TRUE',staleFactEmbedding:'TRUE'},
 'embedding-readiness.ts':{prepareEmbeddingProjections:async()=>({blocked:0})},
 'embedding-context.ts':{wrapChunkTextsForStoredMode:(p,rows)=>rows.map(r=>r.chunk_text)},
 'embed-stale.ts':{EMBED_PROBE_TEXT:'synthetic probe'},
 'embed-oversize-heal.ts':{healOversizedChunks:rows=>({changed:false,chunks:rows})},
 'embedding-input-limit.ts':{resolveMaxChunkTokens:()=>512},
 'page-state/projections.ts':{readProjectionSnapshot:denied('unexpected projection'),preparePageProjection:denied('unexpected projection')},
 'quarantine.ts':{QUARANTINE_FILTER_FRAGMENT:'TRUE'},
 'budget/budget-tracker.ts':{loadPricingOverrides:async()=>({})},
 'budget/reservation-cost.ts':{usageCostUsd:(model,t)=>model.startsWith('unknown:')?null:t/1e6,reservationCostUsd:(model,kind,t)=>model.startsWith('unknown:')?null:t/1e6},
 'budget/no-pricing.ts':{noPricingGuidance:()=>({}),noPricingSteps:()=> 'synthetic unknown-price refusal'},
 'ai/embedding-guard.ts':{sendableEmbeddingInputs:arr=>arr.map((v,i)=>v.trim()?i:null).filter(i=>i!==null)},
 'node:crypto':{randomUUID:()=> 'synthetic-attempt'},
};
const context=vm.createContext({process:Object.freeze({env:Object.freeze({HOME:path.join(root,'empty-home')})}),Buffer,TextEncoder,TextDecoder},{codeGeneration:{strings:false,wasm:false}});
const real=new Map();
for(const f of ['embedding-migration.ts','embedding-invalidation.ts','embedding-migration-worst-case.ts','embedding-migration-budget.ts','embedding-pricing.ts','ai/embed-batch-plan.ts','text-safe.ts','ai/defaults.ts','page-size-policy.ts']){
 const text=stripTypeScriptTypes(fs.readFileSync(path.join(core,f),'utf8'),{mode:'transform'});
 real.set(f,new vm.SourceTextModule(text,{context,identifier:f,importModuleDynamically:denied('dynamic import')}));
}
// Enumerate import names only, to make all non-allowed imports explicit throwing seams.
const names=new Map();
for(const [f,mod] of real){
 const s=stripTypeScriptTypes(fs.readFileSync(path.join(core,f),'utf8'),{mode:'transform'});
 for(const m of s.matchAll(/(?:import|export)\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)){
  const key=m[2].startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(f),m[2])):m[2];
  if(!names.has(key))names.set(key,new Set());
  for(const n of m[1].split(',').map(t=>t.trim().split(/\s+as\s+/)[0]).filter(Boolean))names.get(key).add(n);
 }
}
const fake=new Map();
for(const [key,ns] of names){
 if(real.has(key))continue;
 const vals=Object.fromEntries([...ns].map(n=>[n,mocks[key]?.[n]??denied(key+':'+n)]));
 fake.set(key,new vm.SyntheticModule(Object.keys(vals),function(){for(const [n,v]of Object.entries(vals))this.setExport(n,v);},{context,identifier:'fake:'+key}));
}
const linker=(spec,ref)=>{
 const key=spec.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(ref.identifier),spec)):spec;
 const m=real.get(key)??fake.get(key);if(!m)throw new Error('DENIED unresolved '+key);return m;
};
for(const m of real.values())if(m.status==='unlinked')await m.link(linker);
for(const m of real.values())if(m.status==='linked')await m.evaluate({timeout:3000});
const migration=real.get('embedding-migration.ts').namespace;
const worst=real.get('embedding-migration-worst-case.ts').namespace;
const budget=real.get('embedding-migration-budget.ts').namespace;
const inv=real.get('embedding-invalidation.ts').namespace;
const row=(kind,id=1)=>({page_id:id,chunk_index:0,chunk_text:kind+' '.repeat(100),chunk_source:'compiled_truth',title:'fixture',contextual_retrieval_mode:null,kind});
const isCurrent=r=>r.kind==='restamp';
function engine(rows=[],opts={}){
 let config=null;
 const e={rows,facts:opts.facts??{count:0,chars:0},columnDims:opts.columnDims??DIMS,
  async countStaleChunks(){return rows.length;},async sumStaleChunkChars(){return rows.reduce((n,r)=>n+r.chunk_text.length,0);},async countStaleTakes(){return opts.takes?.length??0;},async listStaleTakes(){return opts.takes??[];},
  async getConfig(){return config;},async setConfig(k,v){stats.writes++;config=v;},async transaction(fn){return fn(e);},
  async executeRaw(sql,args=[]){
   stats.sql.push({sql,args});
   if(sql.includes('WITH fs AS'))return [{pages:0,chunks:0,chars:0}];
   if(sql.includes('AS count') && sql.includes('FROM content_chunks cc JOIN pages p')){
    for(const s of ['deleted_at IS NULL',"? 'embed_skip'",'source_id = $4','embedded_text_hash = md5','vector_dims'])assert.ok(sql.includes(s),s);
    assert.equal(args[1],MODEL);assert.equal(args[2],DIMS);
    const kept=rows.filter(isCurrent);return [{count:kept.length,chars:kept.reduce((n,r)=>n+r.chunk_text.length,0)}];
   }
   if(sql.includes('AS stale')&&sql.includes('ORDER BY cc.page_id')){
    // Contract fake, NOT SQL/pgvector conformance. It recognizes the emitted
    // current-space exclusion only after checking its full required guard shape.
    const keptGuard=sql.includes('AND NOT COALESCE(');
    if(keptGuard){for(const s of ['model = $2','embedded_text_hash = md5','vector_dims','IS NOT NULL'])assert.ok(sql.includes(s));assert.equal(args[4],DIMS);}
    const rebuild=sql.includes('AND NOT false');
    const selected=rows.map(r=>({...r,stale:rebuild||!keptGuard||!isCurrent(r)}));
    return selected.filter(r=>selected.some(s=>s.page_id===r.page_id&&s.stale));
   }
   if(sql.includes('FROM pages p JOIN sources'))return [];
   if(sql.includes('FROM facts f'))return [];
   if(sql.includes('GROUP BY embedding_signature'))return [];
   if(sql.includes("contextual_retrieval_mode = 'per_chunk_synopsis'"))return [{n:0}];
   if(sql.includes('SELECT key FROM config'))return [];
   throw new Error('DENIED unrecognized SQL '+sql);
  }
 };return e;
}
const plan=e=>migration.planEmbeddingMigration(e,{to:MODEL,dim:DIMS,fromModel:'legacy:model',fromDims:DIMS});
async function test(name,fn){try{await fn();stats.tests.push({name,result:'PASS'});}catch(e){stats.tests.push({name,result:'FAIL',error:String(e)});}}
await test('RESTAMP-only excludes chars/cost but retains paid probes',async()=>{
 const empty=await worst.planMigrationWorstCase(engine(),await plan(engine()));
 const e=engine([row('restamp')]);const p=await plan(e);assert.equal(p.chunks_to_embed,0);assert.equal(p.chunks_to_restamp,1);assert.equal(p.total_chars,0);assert.equal(p.est_cost_usd,0);
 const w=await worst.planMigrationWorstCase(e,p);assert.equal(w.input_tokens,empty.input_tokens);assert.equal(w.requests,empty.requests);assert.ok(w.usd>0);assert.ok(w.requests>=6);
});
await test('worst-case independently excludes RESTAMP-only and preserves genuine paid requests',async()=>{
 const emptyEngine=engine(),emptyPlan=await plan(emptyEngine);
 const empty=await worst.planMigrationWorstCase(emptyEngine,emptyPlan);
 const restamp=engine([row('restamp')]);const w=await worst.planMigrationWorstCase(restamp,await plan(restamp));
 assert.equal(w.requests,empty.requests);assert.equal(w.input_tokens,empty.input_tokens);assert.equal(w.usd,empty.usd);
 const paid=engine([row('no-vector',10)]),mixed=engine([row('restamp'),row('no-vector',10)]);
 const pw=await worst.planMigrationWorstCase(paid,await plan(paid)),mw=await worst.planMigrationWorstCase(mixed,await plan(mixed));
 assert.ok(pw.input_tokens>empty.input_tokens);assert.equal(mw.input_tokens,pw.input_tokens);assert.equal(mw.requests,pw.requests);
});
await test('MIXED == PAID-only in plan and request ceiling',async()=>{
 const paid=['no-vector','other-model','changed-text','null-hash'].map((k,i)=>row(k,i+10));
 const e=engine(paid),m=engine([row('restamp'),...paid]);const p=await plan(e),mp=await plan(m);
 assert.equal(mp.chunks_to_restamp,1);assert.equal(mp.chunks_to_embed,4);assert.equal(mp.total_chars,p.total_chars);assert.equal(mp.est_cost_usd,p.est_cost_usd);assert.ok(p.total_chars>0);
 const w=await worst.planMigrationWorstCase(e,p),mw=await worst.planMigrationWorstCase(m,mp);assert.equal(mw.input_tokens,w.input_tokens);assert.equal(mw.requests,w.requests);
});
await test('rebuild keeps current vectors paid',async()=>{
 const e=engine([row('restamp')],{columnDims:768}),p=await plan(e);assert.equal(p.dim_change,true);assert.equal(p.chunks_to_restamp,0);assert.ok(p.total_chars>0);
 const w=await worst.planMigrationWorstCase(e,p),empty=await worst.planMigrationWorstCase(engine(),{...p});assert.ok(w.input_tokens>empty.input_tokens);
});
await test('compatibility count API and source-scoped eligibility SQL',async()=>{
 const e=engine([row('restamp'),row('changed-text')]);assert.equal(await inv.countRestampOnlyChunks(e,{signature:MODEL+':'+DIMS,sourceId:'fixture-source',includeNullSignature:true}),1);
 const q=stats.sql.at(-1);assert.equal(q.args[3],'fixture-source');assert.ok(q.sql.includes('p.embedding_signature IS NULL'));
});
await test('facts and takes cost remains additive',async()=>{
 const e=engine([row('restamp')],{facts:{count:2,chars:80},takes:[{claim:'synthetic claim'}]});const p=await plan(e);assert.equal(p.total_chars,95);assert.equal(p.facts_to_embed,2);assert.equal(p.takes_to_embed,1);
});
await test('overcap refuses before writes or provider dispatch',async()=>{
 const e=engine(),p=await plan(e);const w=await worst.planMigrationWorstCase(e,p),before=stats.writes;
 await assert.rejects(()=>budget.authorizeMigrationBudget(e,p,0,[],undefined,w),/worst-case authorization/);assert.equal(stats.writes,before);assert.equal(stats.providerDispatches,0);
});
await test('prior debit preserved; reservation+settlement retain cap enforcement',async()=>{
 const e=engine(),p=await plan(e);let permit=await budget.authorizeMigrationBudget(e,p,1,[],undefined,{usd:0.1});
 const call={kind:'embedding',model:MODEL,maxInputTokens:100000};const attempt=await permit(call);await attempt.settle({inputTokens:50000,outputTokens:0});
 let state=JSON.parse(await e.getConfig());assert.equal(state.budget.requests,1);assert.ok(Math.abs(state.budget.debited_usd-.05)<1e-9);
 const before=stats.writes;await assert.rejects(()=>budget.authorizeMigrationBudget(e,p,0.1,[],undefined,{usd:0.1}),/already debited/);assert.equal(stats.writes,before);
 permit=await budget.authorizeMigrationBudget(e,p,0.06,[],undefined,{usd:0});await assert.rejects(()=>permit(call),/already debited/);
 assert.ok(Math.abs(JSON.parse(await e.getConfig()).budget.debited_usd-.05)<1e-9);
});
await test('unknown-price permit refuses before dispatch/reservation',async()=>{
 const e=engine(),p={...await plan(e),to_model:'unknown:fixture'};const permit=await budget.authorizeMigrationBudget(e,p,1,[],undefined,{usd:null});const before=stats.writes;
 await assert.rejects(()=>permit({kind:'embedding',model:p.to_model,maxInputTokens:1000}),/cannot price/);assert.equal(stats.writes,before);assert.equal(stats.providerDispatches,0);
});
console.log(JSON.stringify({variant,tests:stats.tests,sql_count:stats.sql.length,writes:stats.writes,provider_dispatches:stats.providerDispatches,real_modules:[...real.keys()],module_boundaries:[...fake.keys()],limitations:'Synthetic engine/contracts, not PostgreSQL/drain/application/live proof.'},null,2));
process.exitCode=stats.tests.some(t=>t.result==='FAIL')?1:0;
