import {createHash} from 'node:crypto';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {mkdirSync,existsSync} from 'node:fs';

const root=resolve(process.argv[2]??'');
const mode=process.argv[3]??'before';
const allowed=resolve('D:/pmbrain-acceptance');
const rel=relative(allowed,root);
if(!process.argv[2]||!rel||rel.startsWith('..')||isAbsolute(rel)||!existsSync(join(root,'brain.pglite','PG_VERSION')))throw new Error('Use an isolated database copy below D:/pmbrain-acceptance');
const home=join(root,'harness-home');mkdirSync(home,{recursive:true});
mkdirSync(join(home,'.pmbrain'),{recursive:true});
process.env.PMBRAIN_HOME=home;process.env.GBRAIN_HOME=home;
delete process.env.DATABASE_URL;delete process.env.PMBRAIN_DATABASE_URL;delete process.env.GBRAIN_DATABASE_URL;
await Bun.write(join(home,'.pmbrain','config.json'),JSON.stringify({engine:'pglite',database_path:join(root,'brain.pglite')}));
const {PGLiteEngine}=await import('../src/core/pglite-engine.ts');
const {runMigrations}=await import('../src/core/migrate.ts');
const engine=new PGLiteEngine();
await engine.connect({database_path:join(root,'brain.pglite')});
const file=(name:string)=>join(root,name+'.json');
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const protectedTables=['pages','page_versions','sources','tags','links','content_chunks','timeline_entries','raw_data','files','takes','facts','access_tokens','oauth_clients'];
async function inventory(previous?:Record<string,{columns:string[];count:number;sha256:string}>){
  const result:Record<string,{columns:string[];count:number;sha256:string}>={};
  for(const table of protectedTables){
    const columns=previous?.[table]?.columns??(await engine.executeRaw<{column_name:string}>('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',['public',table])).map(r=>r.column_name);
    if(!columns.length)continue;
    const projection=columns.map(column=>table==='pages'&&column==='knowledge_revision'?'NULL::uuid AS knowledge_revision':quote(column));
    const rows=await engine.executeRaw<{hash:string}>(`SELECT md5(to_jsonb(x)::text) AS hash FROM (SELECT ${projection.join(',')} FROM ${quote(table)}) x ORDER BY hash`);
    result[table]={columns,count:rows.length,sha256:createHash('sha256').update(rows.map(r=>r.hash).join('\n')).digest('hex')};
  }
  return result;
}
async function revisionInventory(){
  const columns=await engine.executeRaw<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pages' AND column_name='knowledge_revision'");
  return columns.length?engine.executeRaw<{id:number;revision:string|null}>('SELECT id,knowledge_revision::text AS revision FROM pages ORDER BY id'):[];
}
async function footprint(){return engine.executeRaw('SELECT pg_database_size(current_database())::text AS database_bytes,pg_total_relation_size($1::regclass)::text AS pages_bytes,pg_indexes_size($1::regclass)::text AS page_indexes_bytes',['pages']);}
async function search(){
  const result=[];
  for(const query of ['知识图谱','水务','人工智能','项目管理','刘慈欣','三体']){
    const samples=[];let hits:string[]=[];
    for(let i=0;i<3;i++){const start=performance.now();const rows=await engine.searchKeyword(query,{limit:20});samples.push(performance.now()-start);hits=rows.map(r=>(r.source_id??'default')+':'+r.slug);}
    const ranked=await engine.searchKeyword(query,{limit:100});
    result.push({query,hits,ranked:ranked.map(r=>({key:(r.source_id??'default')+':'+r.slug,score:r.score})),ms:samples.sort((a,b)=>a-b)[1]});
  }
  return result;
}
async function writes(){
  const ids=(await engine.executeRaw<{id:number}>('SELECT id FROM pages WHERE deleted_at IS NULL ORDER BY length(compiled_truth) DESC LIMIT 20')).map(r=>r.id);
  const samples=[],sqlSamples:number[]=[];
  for(let i=0;i<3;i++){
    const start=performance.now();
    try{await engine.transaction(async tx=>{const sqlStart=performance.now();await tx.executeRaw('UPDATE pages SET links_extracted_at=now() WHERE id=ANY($1::int[])',[ids]);sqlSamples.push(performance.now()-sqlStart);throw new Error('measurement-rollback');});}
    catch(error){if(!(error instanceof Error)||error.message!=='measurement-rollback')return {samples,error:error instanceof Error?error.message:String(error),code:(error as {code?:string}).code};}
    samples.push(performance.now()-start);
  }
  return {samples,sqlSamples};
}
try{
  if(mode==='before'){
    console.log('Capturing protected table hashes');
    const data=await inventory();
    console.log('Measuring Chinese retrieval');
    const searches=await search();
    console.log('Measuring metadata writes with rollback');
    const result={schema:await engine.getConfig('version'),inventory:data,revisions:await revisionInventory(),footprint:await footprint(),search:searches,writes:await writes()};
    await Bun.write(file('before'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({phase:mode,schema:result.schema,counts:Object.fromEntries(Object.entries(result.inventory).map(([t,r])=>[t,r.count])),footprint:result.footprint,writes_ms:result.writes,search_ms:result.search.map(r=>({query:r.query,hits:r.hits.length,ms:r.ms}))}));
  }else if(mode==='interrupt'){
    await runMigrations(engine,{onProgress:async progress=>{
      const assigned=await engine.executeRaw('SELECT id,knowledge_revision::text AS revision FROM pages WHERE knowledge_revision IS NOT NULL ORDER BY id');
      await Bun.write(file('cancel'),JSON.stringify({progress,assigned},null,2));
      console.log(JSON.stringify({phase:mode,progress,assigned:assigned.length,exit_without_disconnect:true}));
      process.exit(75);
    }});
  }else if(mode==='cancel'){
    const controller=new AbortController();let progress;
    const started=performance.now();
    try{await runMigrations(engine,{signal:controller.signal,onProgress:p=>{progress=p;controller.abort();}});throw new Error('Expected a cancellable legacy backfill');}
    catch(error){if(!(error instanceof Error)||error.name!=='AbortError')throw error;}
    const result={phase:mode,ms:performance.now()-started,progress,state:await engine.getConfig('page_state.revision_backfill'),assigned:await engine.executeRaw('SELECT id,knowledge_revision::text AS revision FROM pages WHERE knowledge_revision IS NOT NULL ORDER BY id')};
    await Bun.write(file('cancel'),JSON.stringify(result,null,2));console.log(JSON.stringify({phase:mode,ms:result.ms,progress,assigned:result.assigned.length}));
  }else if(mode==='finish'){
    const start=performance.now(),cpu=process.cpuUsage();let progress;
    const result=await runMigrations(engine,{onProgress:p=>{progress=p;console.log(JSON.stringify({phase:'progress',...p}));}});
    const usage=process.cpuUsage(cpu);const ms=performance.now()-start;
    const metrics={phase:mode,...result,ms,cpu_ms:(usage.user+usage.system)/1000,peak_rss_kib:process.resourceUsage().maxRSS,progress};
    await Bun.write(file(result.applied>0?'finish':'recheck-migrations'),JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics));
  }else if(mode==='verify'){
    const before=await Bun.file(file('before')).json();
    const after={inventory:await inventory(before.inventory),footprint:await footprint(),search:await search(),writes:await writes()};
    const changed=protectedTables.filter(t=>JSON.stringify(before.inventory[t])!==JSON.stringify(after.inventory[t]));
    const searchChanged=after.search.filter((r,i)=>JSON.stringify([...r.hits].sort())!==JSON.stringify([...before.search[i].hits].sort())).map(r=>r.query);
    const lostTop20=after.search.map((r,i)=>({query:r.query,lost:before.search[i].hits.filter((h:string)=>!r.hits.includes(h))})).filter(r=>r.lost.length);
    const lostHits=lostTop20.flatMap(r=>{const current=after.search.find(s=>s.query===r.query)!;const floor=current.ranked[19]?.score??-Infinity;return r.lost.filter(h=>{const row=current.ranked.find(x=>x.key===h);return !row||row.score>floor;}).map(h=>({query:r.query,key:h}));});
    const cancelled=await Bun.file(file('cancel')).json();
    const preserved=await engine.executeRaw('SELECT id,knowledge_revision::text AS revision FROM pages WHERE id=ANY($1::int[]) ORDER BY id',[cancelled.assigned.map((r:{id:number})=>r.id)]);
    const pending=await engine.executeRaw('SELECT id FROM pages WHERE knowledge_revision IS NULL');
    if(!Array.isArray(before.revisions))throw new Error('The baseline must include revision inventory; rerun before on an unupgraded isolated copy');
    const currentRevisions=new Map((await revisionInventory()).map(row=>[row.id,row.revision]));
    const originalRevisionsPreserved=before.revisions.every((row:{id:number;revision:string|null})=>currentRevisions.has(row.id)&&(row.revision===null||currentRevisions.get(row.id)===row.revision));
    const result={phase:mode,data_unchanged:changed.length===0,changed_tables:changed,search_identical:searchChanged.length===0,search_changed:searchChanged,baseline_hits_retained:lostTop20.length===0,top20_reordered:lostTop20.map(r=>({query:r.query,count:r.lost.length})),unexplained_lost_hits:lostHits,original_revisions_preserved:originalRevisionsPreserved,resumed_revisions_unchanged:JSON.stringify(preserved)===JSON.stringify(cancelled.assigned),pending:pending.length,schema:await engine.getConfig('pmbrain.schema.version'),...after};
    await Bun.write(file('verify'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({...result,inventory:undefined,search:result.search.map(r=>({query:r.query,hits:r.hits.length,ms:r.ms}))}));
    if(changed.length||lostHits.length||pending.length||!originalRevisionsPreserved||!result.resumed_revisions_unchanged)throw new Error('Real database acceptance failed');
  }else if(mode==='maintenance'){
    const {extractStaleFromDB}=await import('../src/commands/extract-stale.ts');
    const {runMentionPass}=await import('../src/core/mentions/pass.ts');
    const {importFromContent}=await import('../src/core/import-file.ts');
    const {setCliOptions}=await import('../src/core/cli-options.ts');
    setCliOptions({quiet:true,progressJson:false,progressInterval:1000,explain:false,timeoutMs:null});
    const stable=async()=>({
      pages:await engine.executeRaw("SELECT id,md5(concat_ws('~',source_id,slug,type,title,compiled_truth,timeline,frontmatter::text,deleted_at::text)) AS hash FROM pages ORDER BY id"),
      chunks:(await inventory())['content_chunks'],versions:(await inventory())['page_versions'],
      manual:await engine.executeRaw("SELECT * FROM links WHERE link_source='manual' OR link_kind='typed_ner' ORDER BY id")});
    const original=await stable();const begin=performance.now();
    const first=await extractStaleFromDB(engine,{dryRun:false,jsonMode:false,includeFrontmatter:true,quiet:true,catchUp:true,maxPages:100});
    const rest=await extractStaleFromDB(engine,{dryRun:false,jsonMode:false,includeFrontmatter:true,quiet:true,catchUp:true});
    const unchanged=JSON.stringify(await stable())===JSON.stringify(original);
    if(!unchanged)throw new Error('Quick maintenance changed original content, vectors, versions or protected edges');
    const source='pmbrain-acceptance-142';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
    const put=async(slug:string,title:string)=>engine.putPage(slug,{type:'person',title,compiled_truth:'用于隔离验收的虚构人物。'},{sourceId:source});
    const edges=async()=>engine.executeRaw<{target:string}>(`SELECT t.slug AS target FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id=$1 AND f.slug='notes/lifecycle' ORDER BY target`,[source]);
    const sweep=()=>extractStaleFromDB(engine,{dryRun:false,jsonMode:false,includeFrontmatter:true,quiet:true,catchUp:true,sourceIdFilter:source});
    await put('people/alpha','验收人物甲');
    await importFromContent(engine,'notes/lifecycle','---\ntype: note\ntitle: 文档生命周期验收\n---\n验收人物甲参与了本次文档生命周期验收。',{noEmbed:true,sourceId:source});
    await sweep();if(!(await edges()).some(r=>r.target==='people/alpha'))throw new Error('new document did not link');
    await importFromContent(engine,'notes/lifecycle','---\ntype: note\ntitle: 文档生命周期验收\n---\n验收人物乙参与了修改后的文档生命周期验收。',{noEmbed:true,sourceId:source});
    await sweep();if((await edges()).length)throw new Error('edited document retained an obsolete link');
    await put('people/beta','验收人物乙');await sweep();
    if(!(await edges()).some(r=>r.target==='people/beta'))throw new Error('later entity did not link old document');
    await engine.deletePage('people/beta',{sourceId:source});await sweep();
    if((await edges()).length)throw new Error('deleted entity retained a link');
    await put('people/beta','验收人物乙');await sweep();
    if(!(await edges()).some(r=>r.target==='people/beta'))throw new Error('recreated entity did not heal');
    await engine.deletePage('notes/lifecycle',{sourceId:source});await sweep();
    if((await edges()).length)throw new Error('deleted document retained a link');
    const unchangedPass=await runMentionPass(engine,{sourceId:source});
    if(unchangedPass.pages)throw new Error('unchanged entity index rescanned pages');
    const result={phase:mode,ms:performance.now()-begin,first:{pages:first.pagesProcessed,mentions:first.mentions},rest:{pages:rest.pagesProcessed,mentions:rest.mentions,max_batch_ms:Math.max(...rest.batchTimings.map(t=>t.totalMs))},original_content_vectors_versions_protected_edges_unchanged:unchanged,lifecycle:'add-edit-later-entity-delete-entity-recreate-delete-document passed'};
    await Bun.write(file('maintenance'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,first:{pages:first.pagesProcessed,mention_pages:first.mentions?.pages},rest:{pages:rest.pagesProcessed,mention_pages:rest.mentions?.pages,max_batch_ms:result.rest.max_batch_ms}}));
  }else if(mode==='inspect'){
    console.log(JSON.stringify(await engine.executeRaw("SELECT t.tgname,pg_get_triggerdef(t.oid) AS trigger,pg_get_functiondef(t.tgfoid) AS function FROM pg_trigger t WHERE t.tgrelid='pages'::regclass AND NOT t.tgisinternal"),null,2));
    const before=await Bun.file(file('before')).json(),after=await Bun.file(file('verify')).json();
    const b=before.search.find((r:{query:string})=>r.query==='三体'),a=after.search.find((r:{query:string})=>r.query==='三体');
    console.log(JSON.stringify({lost:b.hits.filter((h:string)=>!a.hits.includes(h)),gained:a.hits.filter((h:string)=>!b.hits.includes(h))}));
  }else throw new Error('Unknown acceptance phase');
}finally{await engine.disconnect();}
