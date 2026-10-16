import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { finalizeEntityIngest,type EntityIngestContext } from './entity-ingest-workflow.ts';
import { UnrecoverableError } from '../minions/types.ts';

type EntityReference={slug:string;sourceId:string};
interface EntityProof extends EntityReference {id:number;title:string;type:string;aliases:string;revision:string;lines:string[]}
export interface CaptureReceipt {result?:string;ingest_entities?:EntityReference[];capture_proof?:EntityProof[];graph_reconciled?:boolean}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const aliases=(value:unknown)=>JSON.stringify(Array.isArray(value)?[...value].sort():[]);

export async function captureReceiptProof(engine:BrainEngine,context:EntityIngestContext,entities:EntityReference[]):Promise<EntityProof[]>{
  const proofs:EntityProof[]=[];
  for(const entity of entities){
    const page=await engine.getPage(entity.slug,{sourceId:entity.sourceId});
    if(!page||page.deleted_at)throw new Error('实体识别回执目标已改变');
    const rows=Array.isArray(page.frontmatter.pmbrain_ingest_provenance)?page.frontmatter.pmbrain_ingest_provenance as Array<Record<string,unknown>>:[];
    const [revision]=await engine.executeRaw<{revision:string}>('SELECT knowledge_revision::text revision FROM pages WHERE id=$1',[page.id]);
    proofs.push({...entity,id:page.id,title:page.title,type:page.type,aliases:aliases(page.frontmatter.aliases),revision:revision!.revision,
      lines:rows.filter(record=>record.sourceId===context.sourceId&&record.slug===context.slug&&record.pageId===String(context.pageId)
        &&record.chunkHash===hash(context.chunkBody)).map(record=>String(record.line))});
  }
  return proofs;
}

export async function reuseCaptureReceipt(engine:BrainEngine,context:EntityIngestContext,receipt:CaptureReceipt):Promise<{entities:EntityReference[];links:number;rebound:boolean;unresolved?:unknown[]}|null>{
  if(!Array.isArray(receipt.capture_proof))return null;
  try{
    return await engine.transaction(async tx=>{
      let rebound=false;
      const [source]=await tx.executeRaw<{id:number;body:string;incarnation:string}>(`SELECT p.id,p.compiled_truth AS body,s.incarnation::text incarnation
        FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.slug=$1 AND p.source_id=$2 AND p.deleted_at IS NULL AND NOT s.archived FOR SHARE OF p,s`,[context.slug,context.sourceId]);
      if(!source||source.id!==context.pageId||source.body!==context.body||source.incarnation!==context.sourceIncarnation)throw new Error('实体识别原文身份或内容已改变');
      for(const proof of receipt.capture_proof!){
        if(![context.sourceId,'default'].includes(proof.sourceId))throw new Error('实体识别回执越过 Source 边界');
        await tx.executeRaw('SELECT id FROM pages WHERE id=$1 FOR UPDATE',[proof.id]);
        const page=await tx.getPage(proof.slug,{sourceId:proof.sourceId});
        if(!page||page.deleted_at||page.id!==proof.id||page.title!==proof.title||page.type!==proof.type||aliases(page.frontmatter.aliases)!==proof.aliases)throw new UnrecoverableError('cached entity identity changed');
        const lines=new Set(`${page.compiled_truth}\n${page.timeline}`.split('\n').map(hash));
        if(proof.lines.some(line=>!lines.has(line)))throw new UnrecoverableError('cached entity facts changed');
        if(proof.lines.length===0){
          const [revision]=await tx.executeRaw<{revision:string}>('SELECT knowledge_revision::text revision FROM pages WHERE id=$1',[proof.id]);
          if(revision?.revision!==proof.revision)throw new UnrecoverableError('cached entity revision changed');
        }
        const records=Array.isArray(page.frontmatter.pmbrain_ingest_provenance)?page.frontmatter.pmbrain_ingest_provenance as Array<Record<string,unknown>>:[];
        const next=records.map(record=>proof.lines.includes(String(record.line))&&record.sourceId===context.sourceId&&record.slug===context.slug&&record.pageId===String(context.pageId)&&record.chunkHash===hash(context.chunkBody)
          ? {...record,bodyHash:hash(context.body)}:record);
        if(JSON.stringify(next)!==JSON.stringify(records)){
          await tx.putPage(page.slug,{type:page.type,title:page.title,compiled_truth:page.compiled_truth,timeline:page.timeline,frontmatter:{...page.frontmatter,pmbrain_ingest_provenance:next}},{sourceId:proof.sourceId});
          rebound=true;
        }
      }
      if(typeof receipt.result!=='string')return {entities:receipt.ingest_entities??[],links:0,rebound};
      const result=await finalizeEntityIngest(tx,context,receipt.result);
      return {entities:result.entities,links:result.linksCreated,rebound,unresolved:result.unresolved};
    });
  }catch(error){if(error instanceof UnrecoverableError)return null;throw error;}
}
