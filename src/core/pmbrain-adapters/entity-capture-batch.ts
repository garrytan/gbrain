import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { ToolDef } from '../minions/types.ts';
import { UnrecoverableError } from '../minions/types.ts';
import type { EntityIngestContext } from './entity-ingest-workflow.ts';
import type { CaptureReceipt } from './entity-capture-receipts.ts';
import { withCaptureWrite } from './entity-capture-window.ts';

type Step = { output: Record<string, unknown>; proof: NonNullable<CaptureReceipt['capture_proof']> };
type State = { version: 1; payload_hash: string; completed: Record<string, Step> };
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,stable(child)])) : value;

export function captureBatchTool(put: ToolDef, context: EntityIngestContext, checks: {
  required: (engine: BrainEngine, jobId: number) => Promise<string[]>;
  validate: (engine: BrainEngine, text: string, required: string[]) => Promise<void>;
}): ToolDef {
  return {
    name: 'brain_capture_entities',
    description: '一次提交本段值得记录实体的事实增量及证据关系，每次最多32个实体。entities 每项提供准确 slug 和含 YAML title/type、逐条 Source 引用的 Markdown content；程序保留旧事实并逐项原子保存。reused_entities 列出只复用而无新增事实的实体。尚有其他实体时设置 has_more:true 并继续提交；达到32项时程序也会要求继续或用 complete_ingest 确认全部完成。全部完成后程序验证关系并直接结束；有日期的时间线可在本工具后调用原有时间线工具，最后 complete_ingest。',
    input_schema: { type:'object',additionalProperties:false,properties:{
      entities:{type:'array',maxItems:32,items:{type:'object',additionalProperties:false,properties:{slug:{type:'string'},content:{type:'string',maxLength:65536}},required:['slug','content']}},
      reused_entities:{type:'array',maxItems:64,items:{type:'string'}},
      relations:{type:'array',maxItems:128,items:{type:'object',properties:{from:{type:'string'},to:{type:'string'},link_type:{type:'string'},evidence:{type:'string'}},required:['from','to','link_type','evidence']}},
      no_entities:{type:'boolean'},
      has_more:{type:'boolean'},
    },required:['entities','relations']},
    idempotent:true,
    async execute(raw,ctx){
      ctx.signal?.throwIfAborted();
      if(!ctx.toolUseId)throw new UnrecoverableError('ingest batch requires a durable tool execution identity');
      const input=raw as {entities?:Array<{slug:string;content:string}>;reused_entities?:string[];relations?:unknown[];no_entities?:boolean;has_more?:boolean};
      if(!input||!Array.isArray(input.entities)||input.entities.length>32||!Array.isArray(input.relations)||input.relations.length>128
        ||input.entities.some(entity=>!entity||typeof entity.slug!=='string'||typeof entity.content!=='string'||entity.content.length>65536)
        ||Buffer.byteLength(JSON.stringify(input),'utf8')>1024*1024)throw new UnrecoverableError('ingest batch input exceeds its bounded schema');
      const identity=(reference:string)=>reference.includes(':')?reference:`${context.sourceId}:${reference}`;
      if(new Set(input.entities.map(entity=>identity(entity.slug))).size!==input.entities.length)throw new UnrecoverableError('ingest batch requires one fact delta per entity');
      if(input.reused_entities!==undefined&&(!Array.isArray(input.reused_entities)||input.reused_entities.length>64||input.reused_entities.some(reference=>typeof reference!=='string')))throw new UnrecoverableError('ingest batch reused identities are invalid');
      if(input.has_more!==undefined&&typeof input.has_more!=='boolean'||input.has_more&&input.no_entities)throw new UnrecoverableError('ingest batch completion flag is invalid');
      const hash=createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
      const [row]=await ctx.engine.executeRaw<{output:unknown}>(`SELECT output FROM subagent_tool_executions
        WHERE job_id=$1 AND gbrain_tool_use_id::text=$2 AND status='pending'`,[ctx.jobId,ctx.toolUseId]);
      if(!row)throw new UnrecoverableError('ingest batch execution is no longer pending');
      const previous=(typeof row.output==='string'?JSON.parse(row.output):row.output) as State|null;
      if(previous&&(previous.version!==1||previous.payload_hash!==hash))throw new UnrecoverableError('ingest batch replay input changed');
      const state:State=previous??{version:1,payload_hash:hash,completed:{}};
      const {captureReceiptProof,reuseCaptureReceipt}=await import('./entity-capture-receipts.ts');
      for(const [index,entity] of input.entities.entries()){
        ctx.signal?.throwIfAborted();
        const stored=state.completed[String(index)];
        if(stored){
          const reference=String(stored.output.slug),colon=reference.indexOf(':');
          const sourceId=colon<0?context.sourceId:reference.slice(0,colon),slug=colon<0?reference:reference.slice(colon+1);
          const reused=await withCaptureWrite(ctx.engine,ctx.signal,()=>reuseCaptureReceipt(ctx.engine,context,{capture_proof:stored.proof,ingest_entities:[{sourceId,slug}]}));
          if(!reused)throw new UnrecoverableError('ingest revision conflict; an already committed batch entity changed');
          continue;
        }
        const record=async(tx:BrainEngine,value:unknown)=>{
          const output=value as Record<string,unknown>;
          if(output.status==='merge_required')throw new UnrecoverableError('ingest pending entity merge');
          const reference=String(output.slug??entity.slug),colon=reference.indexOf(':');
          const sourceId=colon<0?context.sourceId:reference.slice(0,colon),slug=colon<0?reference:reference.slice(colon+1);
          const step:Step={output:{...output,slug:`${sourceId}:${slug}`},proof:await captureReceiptProof(tx,context,[{sourceId,slug}])};
          const updated=await tx.executeRaw(`UPDATE subagent_tool_executions SET output=jsonb_build_object('version',1,'payload_hash',$3::text,
            'completed',COALESCE(output->'completed','{}'::jsonb)||$4::text::jsonb) WHERE job_id=$1 AND gbrain_tool_use_id::text=$2
            AND status='pending' AND (output IS NULL OR output->>'payload_hash'=$3) RETURNING id`,[ctx.jobId,ctx.toolUseId,hash,JSON.stringify({[index]:step})]);
          if(updated.length!==1)throw new UnrecoverableError('ingest batch commit receipt lost its execution identity');
          state.completed[String(index)]=step;
        };
        const output=await put.execute(entity,{...ctx,persistCommit:record});
        if(!state.completed[String(index)])await ctx.engine.transaction(tx=>record(tx,output));
      }
      const required=await checks.required(ctx.engine,ctx.jobId);
      const entities=[...new Set([...required,...Object.values(state.completed).map(step=>String(step.output.slug)),...(input.reused_entities??[])])];
      if(input.no_entities&&entities.length)throw new UnrecoverableError('ingest no_entities conflicts with committed entities');
      const prior=await ctx.engine.executeRaw<{output:unknown}>("SELECT output FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_capture_entities' AND status='complete' AND output IS NOT NULL",[ctx.jobId]);
      const relations=[...new Map([...prior.flatMap(row=>{const output=typeof row.output==='string'?JSON.parse(row.output):row.output as {receipt?:string};return output?.receipt?JSON.parse(output.receipt).relations??[]:[];}),...input.relations].map(relation=>[JSON.stringify(stable(relation)),relation])).values()];
      const receipt=JSON.stringify({entities,relations,...(input.no_entities?{no_entities:true}:{})});
      await checks.validate(ctx.engine,receipt,required);
      if(input.has_more||input.entities.length===32)return {...state,status:'partial',receipt,instruction:'本批已保存。继续提交本段剩余实体；全部处理完后使用 complete_ingest 验收完整清单。'};
      return {...state,status:'ready',receipt};
    },
  };
}
