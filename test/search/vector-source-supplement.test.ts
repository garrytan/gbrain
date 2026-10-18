import {test,expect} from 'bun:test';
import {buildVectorSearchStatement} from '../../src/core/search/vector-statement.ts';
import {buildSourceFactorCase,buildVisibilityClause,buildHardExcludeClause} from '../../src/core/search/sql-ranking.ts';
import {searchVectorPool,searchIndexWalk} from '../../src/core/search/vector-pool.ts';
const base={dialect:'postgres' as const,embedding:new Float32Array([1,0]),limit:10,offset:0,opts:{source_boosts:{'synthetic-calendar/':0.1,'synthetic-curated/':1},excludePrivate:true,minTrust:'operator_curated' as const,suppressFlagged:true}};
const supplement=(sql:string)=>sql.split('source_candidates AS (')[1]?.split('hnsw_candidates AS (')[0]??'';
test('builder adds bounded higher-factor candidates before shared page ranking on every ANN path',()=>{
 const stmt=buildVectorSearchStatement(base);
 for(const sql of [stmt.sql,stmt.indexWalkSql!,buildVectorSearchStatement({...base,scope:{share:.1,chunks:1000}}).scopeScanSql!]){
  const s=supplement(sql);expect(s).not.toBe('');
  expect(s).toContain('> 0.1');expect(s).toContain('LIMIT LEAST(');expect(s).toContain('100)');
  expect(s).toMatch(/ORDER BY cc\."embedding" <=> [^\n]+\n\s+LIMIT/);
  expect(s).toContain(buildVisibilityClause('p','s',{...base.opts,chunkAlias:'cc'}));
  expect(s).toContain(buildHardExcludeClause('p.slug',['test/','attachments/','.raw/']));
  expect(s).toContain('cc.embedded_text_hash=md5(cc.chunk_text)');
  expect(s).toContain(buildSourceFactorCase('p.slug',base.opts.source_boosts,undefined));
  expect(sql).toContain('SELECT * FROM primary_candidates');
  expect(sql).toContain('base_chunk.chunk_id = extra.chunk_id');
  expect(sql).toMatch(/FROM primary_candidates\) pool/);
  expect(sql.indexOf('source_candidates AS')).toBeLessThan(sql.indexOf('scored AS'));
 }
 expect(stmt.exactSql).not.toContain('source_candidates');
});
test('all narrowing predicates are reused by the supplement; bound placeholders are shared',()=>{
 const stmt=buildVectorSearchStatement({...base,opts:{...base.opts,type:'note',types:['note'],sourceIds:['synthetic-source'],exclude_slugs:['hidden'],exclude_slug_prefixes:['extra/'],language:'en',symbolKind:'function',afterDate:'2026-01-01',beforeDate:'2026-12-31',detail:'low'}});
 const s=supplement(stmt.sql);
 for(const fragment of ['p.type = $','p.type = ANY(','p.source_id = ANY(','p.slug != ALL(','p.slug LIKE \'extra/%\'','cc.language = $','cc.symbol_type = $',"cc.chunk_source = 'compiled_truth'",'p.effective_date >','p.effective_date <','cc.modality','cc.model='])expect(s).toContain(fragment);
 expect(stmt.params[stmt.innerLimitIdx]).toBe(100);
});
test('uniform maps, normalized high detail, invalid entries and complete exact fallback do not add work',()=>{
 for(const source_boosts of [{}, {'all/':1}, {'bad/':NaN,'negative/':-1,'':.1}] as Record<string, number>[])expect(buildVectorSearchStatement({...base,opts:{source_boosts}}).sql).not.toContain('source_candidates');
 for(const detail of ['high',' HIGH '])expect(buildVectorSearchStatement({...base,opts:{...base.opts,detail:detail as any}}).sql).not.toContain('source_candidates');
 const zero=buildVectorSearchStatement({...base,opts:{source_boosts:{'zero/':0,'normal/':1}}});expect(supplement(zero.sql)).toContain('> 0');
 const pg=buildVectorSearchStatement({...base,dialect:'pglite',offset:20});expect(pg.params[pg.innerLimitIdx]).toBe(120);expect(supplement(pg.sql)).toContain('100)');
});
// Synthetic candidate contract, NOT an SQL executor. Builder tests above independently
// bind the shape/filter/budget contract to the native SQL. No real records used.
const stubs=Array.from({length:100},(_,i)=>({page_id:i+1,chunk_id:i+1,slug:`synthetic-calendar/${i}`,score:.09,raw_score:.9,factor:.1}));
const useful={page_id:101,chunk_id:101,slug:'synthetic-curated/target',score:.89,raw_score:.89,factor:1};
function syntheticBatch(sql:string,corpus:any[],window:number){
 const primary=corpus.slice(0,window);
 const extra=supplement(sql)?corpus.filter(r=>r.factor>.1).slice(0,Math.min(window,100)):[];
 const merged=[...new Map([...primary,...extra].map(r=>[r.chunk_id,r])).values()];
 return {rows:merged.sort((a,b)=>b.score-a.score).slice(0,10),candidatePool:primary.length,eligiblePool:primary.length};
}
test('101st source-weighted witness survives a full native walk AND full pool without escalation',async()=>{
 const stmt=buildVectorSearchStatement(base);let calls=0;
 const run=async(a:any)=>{calls++;return syntheticBatch(a.indexWalk?stmt.indexWalkSql!:stmt.sql,[...stubs,useful],a.innerLimit)};
 const walked=await searchIndexWalk(stmt,10,run);expect(walked?.[0].page_id).toBe(101);
 const pooled=await searchVectorPool(10,100,true,true,'postgres',run,async()=>{throw Error('unexpected witness query')},undefined);
 expect(pooled[0].page_id).toBe(101);expect(calls).toBe(2);
});
test('synthetic empty/heterogeneous/overlap and cap preserve primary counts and bounded additions',()=>{
 const sql=buildVectorSearchStatement(base).sql;
 expect(syntheticBatch(sql,[],100)).toEqual({rows:[],candidatePool:0,eligiblePool:0});
 const mixed=[useful,...stubs];const batch=syntheticBatch(sql,mixed,100);
 expect(new Set(batch.rows.map(r=>r.chunk_id)).size).toBe(batch.rows.length);expect(batch.candidatePool).toBe(100);
 const higher=Array.from({length:1000},(_,i)=>({...useful,page_id:i+101,chunk_id:i+101}));
 const b=syntheticBatch(sql,[...stubs,...higher],100);expect(b.candidatePool).toBe(100);expect(b.rows[0].page_id).toBe(101);
});

const input={dialect:'postgres' as const,embedding:new Float32Array([1,0]),limit:10,offset:0,opts:{source_boosts:{'synthetic-calendar/':0.1,'synthetic-curated/':1},excludePrivate:true,minTrust:'operator_curated' as const,suppressFlagged:true}};
test('actual native builder retains distance-first cut then weighting in joined/exact/walk paths',()=>{
 const s=buildVectorSearchStatement(input);expect(s.innerLimit).toBe(100);
 expect(s.indexWalkSql).toBeDefined();
 for(const sql of [s.sql,s.exactSql,s.indexWalkSql!]){
  expect(sql.indexOf('LIMIT ')).toBeLessThan(sql.indexOf('raw_score *'));
  expect(sql).toContain("LIKE 'synthetic-calendar/%' THEN 0.1");
  expect(sql).toContain('quarantine');expect(sql).toContain('trust_tier');
  expect(sql).toContain('write_gate_receipts');expect(sql).toContain('unverified_stub');
  expect(sql).toContain('deleted_at IS NULL');expect(sql).toContain('NOT s.archived');
 }
 expect(s.sql).toMatch(/ORDER BY cc\.[^\n]+<=>[^\n]+\n\s+LIMIT/);
});
test('native scope-scan builder still cuts raw distance before source weighting',()=>{
 const s=buildVectorSearchStatement({...input,scope:{share:0.1,chunks:1000}});
 expect(s.scopeScanSql).toBeDefined();expect(s.scopeScanSql!.indexOf('LIMIT ')).toBeLessThan(s.scopeScanSql!.indexOf('raw_score *'));
});
test('native weighting high-detail bypass and hard exclusion remain distinct contracts',()=>{
 expect(buildSourceFactorCase('slug',input.opts.source_boosts,'high','unverified_stub')).toBe('1.0');
 const s=buildVectorSearchStatement({...input,opts:{...input.opts,exclude_slug_prefixes:['synthetic-calendar/']}});
 expect(s.sql.indexOf("p.slug LIKE 'synthetic-calendar/%'")).toBeLessThan(s.sql.indexOf('LIMIT '));
});

test('supplement inherits current chunk visibility in both manifest forms without changing exact fallback',()=>{
 for(const chunkManifest of [true,false]) {
  const stmt=buildVectorSearchStatement({...base,chunkManifest});
  const scoped=buildVectorSearchStatement({...base,chunkManifest,scope:{share:.1,chunks:1000}});
  const visible=buildVisibilityClause('p','s',{...base.opts,chunkAlias:'cc'});
  for(const sql of [stmt.sql,stmt.indexWalkSql!,scoped.scopeScanSql!]) {
   expect(supplement(sql)).toContain(visible);
   expect(supplement(sql)).toContain('text_projection_revision');
   expect(supplement(sql)).toContain('body_generation');
  }
  expect(stmt.exactSql).not.toContain('source_candidates');
 }
});
