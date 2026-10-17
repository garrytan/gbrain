import {beforeAll,afterAll,describe,test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import type {BrainEngine} from '../src/core/engine.ts';
import {freshBrainFactory} from './helpers/persistence-request-fixture.ts';
import {testBackends} from './helpers/test-backends.ts';
import {ATOM_CONTROL_EQUIVALENCE as KEY,parseAtomControlProof,validateControlImages,readControlBindings,validControlRowsSql,type AtomControlProof} from '../src/core/atom-control-equivalence.ts';
import {computeAtomProvenanceDriftCheck} from '../src/commands/doctor/checks/extraction-sync.ts';
import {discoverExtractablePages,countExtractAtomsBacklog} from '../src/core/cycle/extract-atoms.ts';
import {contentHash} from '../src/core/utils.ts';
const initialUrl=process.env.DATABASE_URL;
for(const backend of testBackends())describe('atom control equivalence '+backend,()=>{
 let factory:Awaited<ReturnType<typeof freshBrainFactory>>;
 beforeAll(async()=>{factory=await freshBrainFactory(backend,initialUrl);},120000);
 afterAll(async()=>{await factory?.dispose();});
 const run=(fn:(e:BrainEngine)=>Promise<void>)=>async()=>fn(await factory.fresh());
 async function fixture(e:BrainEngine,count=1,quote=true,withFence=false){
  const source='control-'+randomUUID().slice(0,8),slug='notes/lesson';await e.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
  const [{incarnation}]=await e.executeRaw<{incarnation:string}>('SELECT incarnation FROM sources WHERE id=$1',[source]);
  const body='An exact historical quote.\n'+'Keep the stable evidence and all historical content.\n'.repeat(60)+(withFence?'\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|-------------|------------|-------------|--------|---------|\n| 1 | Withdrawal test claim. | fact | 1.0 | world | medium | 2026-01-01 | | test | test |\n<!--- gbrain:facts:end -->\n':'');
  const fm={date:'2026-10-15',visibility:'private'};
  const input={type:'note',title:'Lesson',compiled_truth:body,timeline:'Historical decision\n',frontmatter:fm};
  const old=await e.putPage(slug,input,{sourceId:source});const version=await e.createVersion(slug,{sourceId:source});
  const current=await e.putPage(slug,{...input,frontmatter:{...fm,facts_backstop:false}},{sourceId:source});
  const fp='control-proof-'+randomUUID();const checkpoint=[{sourceId:source,incarnation,kind:'page',locator:slug,pageId:old.id,contentHash:old.content_hash}];
  await e.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-atoms',$1,$2::text::jsonb)",[fp,JSON.stringify(checkpoint)]);
  await e.executeRaw('INSERT INTO extract_atoms_page_state(source_incarnation,page_id,content_hash,tombstoned) VALUES($1::uuid,$2,$3,true)',[incarnation,old.id,old.content_hash]);
  const currentSnap=(await e.readPageSnapshot(slug,{sourceId:source}))!;
  const proof:AtomControlProof={schema_version:1,source_id:source,source_incarnation:incarnation,source_page_id:old.id,source_slug:slug,source_version_id:version.id,source_version_revision:(version as any).knowledge_revision,old_full_hash:old.content_hash!,current_full_hash:current.content_hash!,current_revision:currentSnap.revision,frontmatter_order:Object.keys(fm),checkpoint_fingerprint:fp};
  const atoms=[];for(let i=0;i<count;i++){const af={source_slug:slug,source_hash:old.content_hash!.slice(0,16),extracted_at:'2026-10-15T00:00:00.000Z',extracted_by:'original-model',managed_extraction:true,...(quote?{source_quote:'An exact historical quote.',source_quote_offset:[0,26],source_quote_verified:true}:{}),[KEY]:proof};
   const a=await e.putPage('atoms/2026-10-15/atom-'+i,{type:'atom',title:'Original '+i,compiled_truth:'Original distilled claim.',frontmatter:af},{sourceId:source});atoms.push(a);
  }

  return{source,slug,old,current,version,proof,atoms,fp,input,checkpoint};
 }
 const live=(e:BrainEngine,b:unknown)=>e.executeRaw(validControlRowsSql('$1'),[JSON.stringify(b)]);
 test('complete exact control change is recognized consistently without altering original provenance',run(async e=>{
  const f=await fixture(e,30);const originals=await e.executeRaw('SELECT id,md5(to_jsonb(p)::text) AS hash FROM pages p ORDER BY id');
  const bindings=await readControlBindings(e,[f.source]);expect(bindings).toHaveLength(30);expect(await live(e,bindings)).toHaveLength(30);
  const doctor=await computeAtomProvenanceDriftCheck(e);expect(doctor.status).toBe('ok');expect(doctor.details).toMatchObject({total_atoms:30,drifted:0,equivalent_control_changes:30});
  expect(await discoverExtractablePages(e,f.source,[f.slug])).toHaveLength(0);expect(await countExtractAtomsBacklog(e,f.source)).toBe(0);expect(await countExtractAtomsBacklog(e)).toBe(0);
  expect(await e.executeRaw('SELECT id,md5(to_jsonb(p)::text) AS hash FROM pages p ORDER BY id')).toEqual(originals);
  expect(await e.executeRaw('SELECT id FROM persistence_effects')).toEqual([]);
 }),120000);
 test('original absence of quote remains absence rather than fabricated verification',run(async e=>{const f=await fixture(e,1,false);expect(await readControlBindings(e,[f.source])).toHaveLength(1);expect((await e.getPage(f.atoms[0].slug,{sourceId:f.source}))!.frontmatter.source_quote_verified).toBeUndefined();}),120000);
 for(const change of ['body','visibility','timeline','title','tags','source_path'] as const)test('rejects additional source '+change+' change',run(async e=>{
  const f=await fixture(e);await e.putPage(f.slug,{...f.input,...(change==='body'?{compiled_truth:f.input.compiled_truth+'new content'}:change==='visibility'?{frontmatter:{...f.input.frontmatter,visibility:'world',facts_backstop:false}}:change==='timeline'?{timeline:'new timeline'}:change==='title'?{title:'new title'}:change==='tags'?{tags:['new-tag']}:{source_path:'new.md'}),...(change!=='visibility'?{frontmatter:{...f.input.frontmatter,facts_backstop:false}}:{})},{sourceId:f.source});
  expect(await readControlBindings(e,[f.source])).toHaveLength(0);expect((await computeAtomProvenanceDriftCheck(e)).details).toMatchObject({drifted:1,equivalent_control_changes:0});
 }),120000);
 test('bad shape, missing key, duplicate key, wrong identity and hash fail closed',run(async e=>{
  const f=await fixture(e);for(const value of [null,[],{...f.proof,extra:true},{...f.proof,frontmatter_order:['date','date']},{...f.proof,current_revision:'invalid'}])expect(parseAtomControlProof(value)).toBeNull();
  for(const patch of [{frontmatter_order:['date']},{source_incarnation:randomUUID()},{source_version_revision:randomUUID()},{old_full_hash:'a'.repeat(64)},{source_page_id:f.old.id+1000}]){
   const p={...f.proof,...patch};await e.executeRaw('UPDATE pages SET frontmatter=jsonb_set(frontmatter,$2::text[],$3::text::jsonb),knowledge_revision=$4::uuid WHERE id=$1',[f.atoms[0].id,[KEY],JSON.stringify(p),randomUUID()]);expect(await readControlBindings(e,[f.source])).toHaveLength(0);
  }
 }),120000);
 for(const invalid of ['failed','held','partial','fail_count','checkpoint_missing','version_missing'] as const)test('incomplete or missing '+invalid+' evidence cannot suppress extraction',run(async e=>{
  const f=await fixture(e);if(invalid==='failed'||invalid==='held'){const cp=[{...f.checkpoint[0],...(invalid==='failed'?{failure:'error'}:{held:true})}];await e.executeRaw("UPDATE op_checkpoints SET completed_keys=$2::text::jsonb WHERE fingerprint=$1",[f.fp,JSON.stringify(cp)]);}
  else if(invalid==='partial')await e.executeRaw('UPDATE extract_atoms_page_state SET partial_input_chars=100 WHERE page_id=$1',[f.old.id]);
  else if(invalid==='fail_count')await e.executeRaw('UPDATE extract_atoms_page_state SET fail_count=1 WHERE page_id=$1',[f.old.id]);
  else if(invalid==='checkpoint_missing')await e.executeRaw('DELETE FROM op_checkpoints WHERE fingerprint=$1',[f.fp]);
  else await e.executeRaw('DELETE FROM page_versions WHERE id=$1',[f.version.id]);
  expect(await readControlBindings(e,[f.source])).toHaveLength(0);expect(await discoverExtractablePages(e,f.source,[f.slug])).toHaveLength(1);expect(await countExtractAtomsBacklog(e,f.source)).toBe(1);
 }),120000);
 for(const race of ['source','atom','version_redaction','version_move','checkpoint','scan'] as const)test('consuming SQL rejects stale validated binding after '+race+' changes',run(async e=>{
  const f=await fixture(e),bindings=await readControlBindings(e,[f.source]);expect(bindings).toHaveLength(1);
  if(race==='source')await e.putPage(f.slug,{...f.input,compiled_truth:f.input.compiled_truth+' changed',frontmatter:{...f.input.frontmatter,facts_backstop:false}},{sourceId:f.source});
  else if(race==='atom')await e.executeRaw('UPDATE pages SET knowledge_revision=$2::uuid WHERE id=$1',[f.atoms[0].id,randomUUID()]);
  else if(race==='version_redaction')await e.executeRaw("UPDATE page_versions SET compiled_truth='redacted' WHERE id=$1",[f.version.id]);
  else if(race==='version_move')await e.executeRaw('UPDATE page_versions SET page_id=$2 WHERE id=$1',[f.version.id,f.atoms[0].id]);
  else if(race==='checkpoint')await e.executeRaw("UPDATE op_checkpoints SET completed_keys='[]'::jsonb WHERE fingerprint=$1",[f.fp]);
  else await e.executeRaw('UPDATE extract_atoms_page_state SET fail_count=1 WHERE page_id=$1',[f.old.id]);
  expect(await live(e,bindings)).toHaveLength(0);
 }),120000);
 test('one int4-overflow proof cannot poison a valid neighbor',run(async e=>{const f=await fixture(e,2);await e.executeRaw('UPDATE pages SET frontmatter=jsonb_set(frontmatter,$2::text[],$3::text::jsonb),knowledge_revision=$4::uuid WHERE id=$1',[f.atoms[0].id,[KEY],JSON.stringify({...f.proof,source_version_id:2147483648}),randomUUID()]);expect(parseAtomControlProof({...f.proof,source_page_id:2147483648})).toBeNull();expect(await readControlBindings(e,[f.source])).toHaveLength(1);expect((await computeAtomProvenanceDriftCheck(e)).details).toMatchObject({drifted:1,equivalent_control_changes:1});}),120000);
 test('out-of-bounds quote offset is rejected rather than clamped',run(async e=>{const f=await fixture(e);const source=(await e.getPage(f.slug,{sourceId:f.source}))!;await e.executeRaw('UPDATE pages SET frontmatter=frontmatter||$2::text::jsonb,knowledge_revision=$3::uuid WHERE id=$1',[f.atoms[0].id,JSON.stringify({source_quote:source.compiled_truth.slice(-10),source_quote_offset:[source.compiled_truth.length-10,source.compiled_truth.length+1]}),randomUUID()]);expect(await readControlBindings(e,[f.source])).toHaveLength(0);}),120000);
 test('already-aborted proof read sends no query; abort between reads stops the sequence',run(async e=>{await fixture(e);const a=new AbortController();a.abort();let calls=0;const wrap=new Proxy(e,{get(t,k){if(k==='executeRaw')return async(...args:any[])=>{calls++;return (t.executeRaw as any)(...args);};const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;}});await expect(readControlBindings(wrap,undefined,{signal:a.signal})).rejects.toThrow();expect(calls).toBe(0);const b=new AbortController();const wrap2=new Proxy(e,{get(t,k){if(k==='executeRaw')return async(sql:string,params:any,opts:any)=>{calls++;expect(opts.signal).toBe(b.signal);const result=await t.executeRaw(sql,params,opts);b.abort();return result;};const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;}});await expect(readControlBindings(wrap2,undefined,{signal:b.signal})).rejects.toThrow();expect(calls).toBe(1);}),120000);
 for(const consumer of ['doctor','discovery','count'] as const)test('actual '+consumer+' does not consume proof across a source race',run(async e=>{const f=await fixture(e);let changed=false;const wrap=new Proxy(e,{get(t,k){if(k==='executeRaw')return async(sql:string,params:any,opts:any)=>{const rows=await t.executeRaw(sql,params,opts);if(!changed&&sql.startsWith('SELECT page_id FROM extract_atoms_page_state')){changed=true;await e.putPage(f.slug,{...f.input,compiled_truth:f.input.compiled_truth+'changed',frontmatter:{...f.input.frontmatter,facts_backstop:false}},{sourceId:f.source});}return rows;};const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;}});if(consumer==='doctor')expect((await computeAtomProvenanceDriftCheck(wrap)).details).toMatchObject({drifted:1,equivalent_control_changes:0});else if(consumer==='discovery')expect(await discoverExtractablePages(wrap,f.source,[f.slug])).toHaveLength(1);else expect(await countExtractAtomsBacklog(wrap,f.source)).toBe(1);expect(changed).toBe(true);}),120000);
 test('stale-atom repair keeps a valid bridge but resumes retirement after real source change',run(async e=>{const f=await fixture(e);const {staleAtomsRepair}=await import('../src/core/repair/stale-atoms.ts');const [{brain_id}]=await e.executeRaw<{brain_id:string}>('SELECT brain_id FROM persistence_brain');const scope={brain_id,source_ids:[f.source]};const complete=async(hash:string)=>e.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-atoms',$1,$2::text::jsonb)",['fresh-'+randomUUID(),JSON.stringify([{...f.checkpoint[0],contentHash:hash}])]);await complete(f.current.content_hash!);expect((await staleAtomsRepair.plan(e,scope,null as any,{apply:false})).items).toHaveLength(0);const changed=await e.putPage(f.slug,{...f.input,compiled_truth:f.input.compiled_truth+'real body change',frontmatter:{...f.input.frontmatter,facts_backstop:false}},{sourceId:f.source});await complete(changed.content_hash!);expect((await staleAtomsRepair.plan(e,scope,null as any,{apply:false})).items).toHaveLength(1);}),120000);
 test('native withdrawal overlay prevents proof even when rebinding current revision and raw hash stays equal',run(async e=>{const f=await fixture(e,1,true,true);await e.insertFacts([{fact:'Withdrawal test claim.',kind:'fact',confidence:1,visibility:'world',notability:'medium',entity_slug:f.slug,source:'test',source_markdown_slug:f.slug,row_num:1}],{source_id:f.source});const [{id}]=await e.executeRaw<{id:number}>('SELECT id FROM facts WHERE source_id=$1',[f.source]);const {recordFactWithdrawal}=await import('../src/core/facts/withdrawal.ts');const result=await recordFactWithdrawal(e,Number(id),f.source,false,{semanticReview:false});expect(result.withdrawn).toBe(true);const [raw]=await e.executeRaw<any>('SELECT compiled_truth,content_hash,knowledge_revision FROM pages WHERE id=$1',[f.old.id]);expect(raw.compiled_truth).toBe(f.input.compiled_truth);expect(raw.content_hash).toBe(f.proof.current_full_hash);const snap=(await e.readPageSnapshot(f.slug,{sourceId:f.source}))!;expect(snap.page.compiled_truth).not.toBe(raw.compiled_truth);await e.executeRaw('UPDATE pages SET frontmatter=jsonb_set(frontmatter,$2::text[],$3::text::jsonb),knowledge_revision=$4::uuid WHERE id=$1',[f.atoms[0].id,[KEY],JSON.stringify({...f.proof,current_revision:snap.revision}),randomUUID()]);expect(await readControlBindings(e,[f.source])).toHaveLength(0);expect((await computeAtomProvenanceDriftCheck(e)).details).toMatchObject({drifted:1,equivalent_control_changes:0});}),120000);
 test('consumption rechecks withdrawal ledger even if raw page revision does not change',run(async e=>{const f=await fixture(e),bindings=await readControlBindings(e,[f.source]);expect(bindings).toHaveLength(1);await e.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES($1,'world','*',gbrain_fact_fingerprint('concurrent marker'))",[f.source]);expect(await live(e,bindings)).toHaveLength(0);}),120000);
 for(const table of ['fact_withdrawals','fact_purges'] as const)test('consumption rechecks '+table+' timestamp changes',run(async e=>{const f=await fixture(e);const dateColumn=table==='fact_withdrawals'?'withdrawn_at':'purged_at';await e.executeRaw(`INSERT INTO ${table}(source_id,visibility,subject,fact_hash,${dateColumn}) VALUES($1,'world','*',gbrain_fact_fingerprint('existing ledger marker'),'2026-01-01T00:00:00Z')`,[f.source]);const bindings=await readControlBindings(e,[f.source]);expect(bindings).toHaveLength(1);await e.executeRaw(`UPDATE ${table} SET ${dateColumn}='2026-01-02T00:00:00Z' WHERE source_id=$1`,[f.source]);expect(await live(e,bindings)).toHaveLength(0);}),120000);
 test('withdrawal timestamp changes canonical fence expiry text',run(async e=>{const f=await fixture(e,1,true,true);const [{hash}]=await e.executeRaw<{hash:string}>("SELECT gbrain_fact_fingerprint('Withdrawal test claim.') AS hash");const {overlayCanonicalBodies}=await import('../src/core/page-state/snapshot.ts');const view=async(date:string)=>overlayCanonicalBodies(e.executeRaw.bind(e) as any,f.input.compiled_truth,f.input.timeline,[{visibility:'world',fact_hash:hash,withdrawn_at:date}]);const a=await view('2026-01-03T00:00:00Z'),b=await view('2026-01-04T00:00:00Z');expect(a.compiled_truth).not.toBe(b.compiled_truth);expect(a.compiled_truth).toContain('2026-01-03');expect(b.compiled_truth).toContain('2026-01-04');}),120000);
 test('oversized carrier metadata is rejected before it reaches the proof parser',run(async e=>{
  const f=await fixture(e);await e.putPage(f.atoms[0].slug,{type:'atom',title:f.atoms[0].title,compiled_truth:f.atoms[0].compiled_truth,frontmatter:{...f.atoms[0].frontmatter,padding:'x'.repeat(17000)}},{sourceId:f.source});let oversizedReturned=false;
  const wrap=new Proxy(e,{get(t,k){if(k==='executeRaw')return async(sql:string,params:any,opts:any)=>{const rows=await t.executeRaw<any>(sql,params,opts);if(sql.startsWith('SELECT id,source_id,knowledge_revision,frontmatter'))for(const row of rows)if(Buffer.byteLength(JSON.stringify(row.frontmatter))>16384)oversizedReturned=true;return rows;};const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;}});
  const bindings=await readControlBindings(wrap,[f.source]);expect(oversizedReturned).toBe(false);expect(bindings).toHaveLength(0);
 }),120000);
 for(const field of ['body','timeline','frontmatter'] as const)test('snapshot refuses concurrent oversized '+field+' before returning content',run(async e=>{
  const f=await fixture(e);let changed=false,oversizedReturned=false;
  const wrap=new Proxy(e,{get(t,k){if(k==='executeRaw')return async(sql:string,params:any,opts:any)=>{
   const rows=await t.executeRaw<any>(sql,params,opts);
   if(/^WITH chosen(?:_input)? AS \(/.test(sql))for(const row of rows)if(Buffer.byteLength(row.compiled_truth??'')+Buffer.byteLength(row.timeline??'')>65536||Buffer.byteLength(JSON.stringify(row.frontmatter??{}))>16384)oversizedReturned=true;
   if(!changed&&sql.startsWith('SELECT id FROM pages p WHERE p.id=')){changed=true;
    await e.putPage(f.slug,{...f.input,frontmatter:{...f.input.frontmatter,facts_backstop:false,...(field==='frontmatter'?{extra:'x'.repeat(17000)}:{})},...(field==='body'?{compiled_truth:'x'.repeat(66000)}:field==='timeline'?{timeline:'x'.repeat(66000)}:{})},{sourceId:f.source});
   }return rows;};const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;}});
  expect(await readControlBindings(wrap,[f.source])).toHaveLength(0);expect(changed).toBe(true);expect(oversizedReturned).toBe(false);
 }),120000);
 test('consuming SQL rejects a source-path update that preserves revision and content hash',run(async e=>{
  const f=await fixture(e),bindings=await readControlBindings(e,[f.source]);expect(bindings).toHaveLength(1);
  await e.executeRaw('UPDATE pages SET source_path=$2 WHERE id=$1',[f.old.id,'moved/source.md']);
  const [current]=await e.executeRaw<any>('SELECT knowledge_revision,content_hash FROM pages WHERE id=$1',[f.old.id]);
  expect(current.knowledge_revision).toBe(f.proof.current_revision);expect(current.content_hash).toBe(f.proof.current_full_hash);
  expect(await live(e,bindings)).toHaveLength(0);
 }),120000);
 test('overflow withdrawal evidence grants no equivalence',run(async e=>{
  const f=await fixture(e);
  await e.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) SELECT $1,'world','*',gbrain_fact_fingerprint('ledger marker '||n) FROM generate_series(1,33) n",[f.source]);
  expect(await readControlBindings(e,[f.source])).toHaveLength(0);
 }),120000);
 test('canonical snapshot refuses ledger growth after the bounded pre-read',run(async e=>{
  const f=await fixture(e);let changed=false,oversizedReturned=false;
  const wrap=new Proxy(e,{get(t,k){if(k==='executeRaw')return async(sql:string,params:any,opts:any)=>{
   const rows=await t.executeRaw<any>(sql,params,opts);
   if(/^WITH chosen(?:_input)? AS \(/.test(sql))for(const row of rows)if((row.snapshot_withdrawals?.length??0)>32)oversizedReturned=true;
   if(!changed&&sql.startsWith('SELECT ')&&sql.includes('bounded_ledger')&&sql.endsWith(' AS image')){changed=true;
    await e.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) SELECT $1,'world','*',gbrain_fact_fingerprint('racing ledger marker '||n) FROM generate_series(1,33) n",[f.source]);
   }return rows;};const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;}});
  const bindings=await readControlBindings(wrap,[f.source]);expect(changed).toBe(true);expect(oversizedReturned).toBe(false);expect(bindings).toHaveLength(0);
 }),120000);
 test('old key order must exactly reproduce original full checkpoint hash',run(async e=>{const f=await fixture(e);expect(contentHash(f.input as any)).toBe(f.proof.old_full_hash);const wrong={...f.proof,frontmatter_order:[...f.proof.frontmatter_order].reverse()};const [old]=await e.executeRaw<any>('SELECT * FROM page_versions WHERE id=$1',[f.version.id]);const snap=(await e.readPageSnapshot(f.slug,{sourceId:f.source}))!;expect(validateControlImages(wrong,f.atoms[0],old,{...snap.page,tags:snap.tags})).toBe(false);}),120000);
});
