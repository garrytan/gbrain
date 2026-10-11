import {afterAll,beforeAll,beforeEach,expect,test} from 'bun:test';
import type {BrainEngine} from '../src/core/engine.ts';
import {mentionBrain,resetMentionBrain,page} from './helpers/mention-brain.ts';
import {readRelationSnapshot,replaceDerivedLinks} from '../src/core/pmbrain-adapters/relation-writer.ts';
async function rejection(operation:Promise<unknown>):Promise<unknown>{
 try{await operation;}catch(error){return error;}
 throw new Error('Expected operation to reject');
}
let engine:BrainEngine;
beforeAll(async()=>{engine=await mentionBrain();},120_000);
afterAll(async()=>{await engine.disconnect();});
beforeEach(async()=>{await resetMentionBrain(engine);});
const read=()=>readRelationSnapshot(engine,'notes/revision','default');
test('only canonical content and tags advance the relationship revision',async()=>{
 await page(engine,'notes/revision','note','资料','原文');const first=(await read())!;
 await engine.executeRaw("UPDATE pages SET text_projection_revision=knowledge_revision,links_extracted_at=now(),updated_at=now(),content_hash='bookkeeping' WHERE slug='notes/revision'");
 expect((await read())!.revision).toBe(first.revision);
 await page(engine,'notes/revision','note','资料','原文');expect((await read())!.revision).toBe(first.revision);
 await engine.addTag('notes/revision','example');const tagged=(await read())!;
 expect(tagged.revision).not.toBe(first.revision);
 expect((await engine.executeRaw<{r:string|null}>("SELECT text_projection_revision::text AS r FROM pages WHERE slug='notes/revision'"))[0].r).toBeNull();
 await engine.addTag('notes/revision','example');expect((await read())!.revision).toBe(tagged.revision);
 await page(engine,'notes/revision','note','资料','修改原文');expect((await read())!.revision).not.toBe(tagged.revision);
});
test('nested SQL failures roll back only their savepoint and outer failure restores content and versions',async()=>{
 await page(engine,'notes/revision','note','资料','原文');const first=(await read())!;
 await engine.transaction(async tx=>{
  const sqlError=await tx.transaction(async child=>{await child.putPage('notes/revision',{type:'note',title:'资料',compiled_truth:'应回滚'});await child.executeRaw('SELECT 1/0');}).catch(error=>error);
  expect(sqlError.code).toBe('22012');
  expect((await readRelationSnapshot(tx,'notes/revision','default'))!.revision).toBe(first.revision);
  await tx.addTag('notes/revision','committed');
 });
 const committed=(await read())!;
 const rollback=await engine.transaction(async tx=>{await tx.createVersion('notes/revision');await tx.putPage('notes/revision',{type:'note',title:'资料',compiled_truth:'外层回滚'});throw new Error('rollback');}).catch(error=>error);
 expect(rollback.message).toBe('rollback');
 expect((await read())!.revision).toBe(committed.revision);expect(await engine.getVersions('notes/revision')).toHaveLength(0);
});
test('a stale origin or recreated Source cannot publish replacement relationships',async()=>{
 await engine.executeRaw("INSERT INTO sources(id,name) VALUES('state-test','state-test')");
 await page(engine,'notes/revision','note','资料','原文',{sourceId:'state-test'});
 const old=(await readRelationSnapshot(engine,'notes/revision','state-test'))!;
 const scope={slug:'notes/revision',sourceId:'state-test',expectedRevision:old.revision,sourceIncarnation:old.sourceIncarnation};
 await page(engine,'notes/revision','note','资料','修改',{sourceId:'state-test'});
 expect(await rejection(replaceDerivedLinks(engine,scope,[]))).toMatchObject({code:'revision_conflict'});
 await engine.executeRaw("DELETE FROM sources WHERE id='state-test'");
 await engine.executeRaw("INSERT INTO sources(id,name) VALUES('state-test','state-test')");
 await page(engine,'notes/revision','note','资料','新身份',{sourceId:'state-test'});
 expect((await readRelationSnapshot(engine,'notes/revision','state-test'))!.sourceIncarnation).not.toBe(old.sourceIncarnation);
 expect(await rejection(replaceDerivedLinks(engine,scope,[]))).toBeInstanceOf(Error);
});
