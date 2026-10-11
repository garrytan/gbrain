import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import type { ToolDef } from '../minions/types.ts';
import { makeIndexedLinkResolver, loadLinkPageMetadata } from '../link-reconciliation.ts';
import { extractPageLinks, loadExtractionPack, inferLinkType } from '../link-extraction.ts';
import { inferLinkTypeFromPack } from '../schema-pack/link-inference.ts';
import { lineGrammarOptions } from '../line-grammar.ts';
import { UnrecoverableError } from '../minions/types.ts';
import type { SubagentHandlerData, SubagentResult } from '../minions/types.ts';
import {annotateIngestContent} from './ingest-provenance.ts';
import matter from 'gray-matter';
import {parseLlmJson} from '../llm-json.ts';
import {defaultMaxOutputTokens} from '../ai/model-compatibility.ts';

export interface EntityIngestContext {
  slug: string;
  sourceId: string;
  body: string;
  chunkBody: string;
  acknowledged?:string[];
}
interface EntityRef { slug: string; sourceId: string; title: string; type: string; evidence: string; names: string[] }
interface IngestRelation { from: string; to: string; link_type: string; evidence: string }
interface IngestReceipt { entities: string[]; relations: IngestRelation[]; no_entities?: boolean }

export function locateIngestSkillsDir(): string | null {
  for(const start of [process.cwd(),dirname(fileURLToPath(import.meta.url)),dirname(process.execPath)]){
    let dir=start;
    for(let i=0;i<8;i++){
      if(existsSync(join(dir,'skills/ingest/SKILL.md')))return join(dir,'skills');
      const parent=dirname(dir);if(parent===dir)break;dir=parent;
    }
  }
  return null;
}

export function readIngestContract(skillsDir=locateIngestSkillsDir()): string {
  if(!skillsDir)throw new Error('ingest Skill not found');
  return ['ingest/SKILL.md','_brain-filing-rules.md','conventions/quality.md']
    .map(path=>readFileSync(join(skillsDir,path),'utf8')).join('\n\n');
}

export function ingestOriginField(context:Pick<EntityIngestContext,'sourceId'|'body'>): string {
  return `ingest:${context.sourceId}:${createHash('sha256').update(context.body).digest('hex')}`;
}

function parseReceipt(text:string):IngestReceipt {
  const value=parseLlmJson<IngestReceipt>(text);
  if(!value)throw new UnrecoverableError('ingest receipt missing or invalid JSON');
  if(!Array.isArray(value.entities)||!value.entities.every(x=>typeof x==='string')||!Array.isArray(value.relations)
    ||value.relations.some(x=>!x||typeof x.from!=='string'||typeof x.to!=='string'||typeof x.link_type!=='string'||typeof x.evidence!=='string')
    ||(value.entities.length===0&&(value.no_entities!==true||value.relations.length>0))){
    throw new UnrecoverableError('ingest receipt requires entities, relations and explicit no_entities for an empty result');
  }
  return value;
}

function surfaceName(value:string):string{return value.replace(/[\s"'“”‘’]/gu,'');}
function evidenceFor(body:string,names:string[]):string|null {
  const positions:number[]=[];let normalized='';
  for(let i=0;i<body.length;i++){if(!/[\s"'“”‘’]/u.test(body[i]!)){normalized+=body[i];positions.push(i);}}
  for(const name of names){
    if(name.trim().length<2)continue;
    const start=normalized.indexOf(surfaceName(name));if(start<0)continue;
    const at=positions[start]!,end=positions[start+surfaceName(name).length-1]!+1;
    return body.slice(Math.max(0,at-70),Math.min(body.length,end+100));
  }
  return null;
}

async function resolveEntity(engine:BrainEngine,context:EntityIngestContext,reference:string):Promise<EntityRef>{
  const pages=await loadLinkPageMetadata(engine);
  const resolver=makeIndexedLinkResolver(pages,context.sourceId);
  const resolved=await resolver.resolveTarget!(reference);
  if(!resolved)throw new UnrecoverableError(`ingest unresolved target: ${reference} (source ${context.sourceId})`);
  if(![context.sourceId,'default'].includes(resolved.sourceId!))throw new UnrecoverableError(`ingest source boundary: ${reference}`);
  const page=await engine.getPage(resolved.slug,{sourceId:resolved.sourceId});
  if(!page||!['person','company','organization','entity','project','concept'].includes(page.type))throw new UnrecoverableError(`ingest target is not an entity: ${reference}`);
  const indexed=pages.find(candidate=>candidate.slug===page.slug&&candidate.source_id===resolved.sourceId);
  const aliases=[page.frontmatter.aliases,indexed?.aliases].flatMap(value=>Array.isArray(value)?value.filter((x):x is string=>typeof x==='string'):[]);
  const evidence=evidenceFor(context.chunkBody,[page.title,...aliases]);
  if(!evidence)throw new UnrecoverableError(`ingest entity evidence missing: ${reference}`);
  return {slug:page.slug,sourceId:resolved.sourceId!,title:page.title,type:page.type,evidence,names:[page.title,...aliases]};
}

async function relationEvidence(engine:BrainEngine,context:EntityIngestContext,relation:IngestRelation,from:EntityRef,to:EntityRef):Promise<void> {
  const evidence=relation.evidence.trim();
  if(evidence.length<4||!context.chunkBody.includes(evidence)||!from.names.some(name=>surfaceName(evidence).includes(surfaceName(name)))||!to.names.some(name=>surfaceName(evidence).includes(surfaceName(name)))){
    throw new UnrecoverableError(`ingest relation evidence missing: ${relation.from} -> ${relation.to}`);
  }
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(relation.link_type))throw new UnrecoverableError('ingest invalid relation type');
  if(relation.link_type!=='mentions'){
    const pack=await loadExtractionPack(engine,context.sourceId);
    const inferred=(pack&&inferLinkTypeFromPack(pack,from.type,evidence,undefined,to.type,{ner:true}))
      ||inferLinkType(from.type as import('../types.ts').PageType,evidence,evidence,to.slug);
    if(inferred!==relation.link_type)throw new UnrecoverableError(`ingest relation type unsupported by source evidence: ${relation.link_type}; inferred ${inferred}`);
  }
}

function managedLink(context:EntityIngestContext,from:{slug:string;sourceId:string},to:{slug:string;sourceId:string},type:string,evidence:string):LinkBatchInput{
  return {from_slug:from.slug,from_source_id:from.sourceId,to_slug:to.slug,to_source_id:to.sourceId,link_type:type,
    context:evidence,link_source:'manual',origin_slug:context.slug,origin_source_id:context.sourceId,origin_field:ingestOriginField(context)};
}

export async function validateIngestWrite(engine:BrainEngine,context:EntityIngestContext,name:string,input:Record<string,unknown>):Promise<void>{
  if(name==='put_page'){
    const reference=String(input.slug??'');const colon=reference.indexOf(':');
    const sourceId=colon<0?context.sourceId:reference.slice(0,colon);
    if(![context.sourceId,'default'].includes(sourceId))throw new UnrecoverableError(`ingest source boundary: ${reference}`);
    const slug=colon<0?reference:reference.slice(colon+1);const content=String(input.content??'');
    const {parseMarkdown}=await import('../markdown.ts');
    const parsed=parseMarkdown(content,slug);
    const metadata=matter(content).data;
    const existing=await engine.getPage(slug,{sourceId});
    if(existing&&!['person','company','organization','entity','project','concept'].includes(existing.type))throw new UnrecoverableError(`ingest cannot replace original document: ${reference}`);
    if(!existing&&(!metadata.title||!metadata.type))throw new UnrecoverableError(`ingest new entity requires YAML frontmatter title and type: ${reference}; a Markdown heading does not set the page identity`);
    const title=String(input.title??metadata.title??existing?.title??parsed.title);
    const aliases=parsed.frontmatter.aliases??existing?.frontmatter.aliases;
    const evidence=evidenceFor(context.chunkBody,[title,...(Array.isArray(aliases)?aliases.filter((x):x is string=>typeof x==='string'):[])]);
    if(!evidence)throw new UnrecoverableError(`ingest entity evidence missing: ${slug}; title '${title}' is not present in this source chunk. Keep the existing identity and add an aliases entry containing the exact name stated in the original source, or correct the title. Do not repeat this unchanged write.`);
    if(!content.includes('[Source:')||!content.includes(context.slug))throw new UnrecoverableError(`ingest provenance missing: ${slug}`);
    if(!['person','company','organization','entity','project','concept'].includes(String(input.type??metadata.type??existing?.type??parsed.type)))throw new UnrecoverableError(`ingest invalid entity type: ${slug}`);
    const pages=await loadLinkPageMetadata(engine);
    const matching=pages.filter(p=>['person','company','organization','entity','project','concept'].includes(p.type)&&(p.title===title||Array.isArray(p.aliases)&&p.aliases.includes(title))&&[context.sourceId,'default'].includes(p.source_id));
    const local=matching.filter(p=>p.source_id===context.sourceId);
    const preferred=local.length?local:matching;
    if(preferred.some(p=>p.slug!==slug||p.source_id!==sourceId))throw new UnrecoverableError(`ingest reuse existing entity: ${preferred.map(p=>`${p.source_id}:${p.slug}`).join(', ')}`);
    if(!existing){
      const name=surfaceName(title);
      const nearby=pages.filter(p=>[context.sourceId,'default'].includes(p.source_id)&&p.type===String(metadata.type)&&surfaceName(p.title)!==name&&(surfaceName(p.title).includes(name)||name.includes(surfaceName(p.title))));
      if(nearby.length)throw new UnrecoverableError(`ingest verify existing entity before creating a name variant: ${nearby.map(p=>`${p.source_id}:${p.slug} (${p.title})`).join(', ')}. Read these pages, reuse the confirmed identity and add the original-source name as an explicit alias. No automatic fuzzy merge is permitted.`);
    }
  }else if(name==='add_timeline_entry'){
    await resolveEntity(engine,context,String(input.slug??''));
    if(!String(input.source??'').includes(context.slug))throw new UnrecoverableError('ingest timeline provenance missing');
    const date=String(input.date??'');
    const parts=date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!parts)throw new UnrecoverableError('ingest timeline date requires YYYY-MM-DD; retain month-only facts in the entity body without inventing a day');
    if(!context.chunkBody.includes(date)&&!new RegExp(`${parts[1]}年0?${Number(parts[2])}月0?${Number(parts[3])}日`).test(context.chunkBody))throw new UnrecoverableError(`ingest timeline date has no exact source evidence: ${date}; do not invent a day from a month-only source`);
  }
}

export function entityIngestTools(tools:ToolDef[],context:EntityIngestContext):ToolDef[]{
  const canonicalInput=async(raw:unknown,engine:BrainEngine)=>{
    const input=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
    const slug=String(input.slug??'');
    if(!slug||slug.includes(':'))return input;
    for(const sourceId of [...new Set([context.sourceId,'default'])]){
      const page=await engine.getPage(slug,{sourceId});
      if(page)return {...input,slug:`${sourceId}:${slug}`};
    }
    return input;
  };
  return tools.map(tool=>{
    const name=tool.name.replace(/^brain_/,'');
    const unchanged=(raw:unknown)=>{
      const reference=String((raw as Record<string,unknown>)?.slug??'');
      return context.acknowledged?.includes(reference.includes(':')?reference:`${context.sourceId}:${reference}`);
    };
    if(name==='get_page')return {...tool,async execute(raw,ctx){
      const input=await canonicalInput(raw,ctx.engine);
      if(unchanged(input))return {slug:input.slug,status:'unchanged',instruction:'This entity has already been persisted for this exact unchanged source chunk. Include it in the receipt; no reread or rewrite is needed.'};
      const output=await tool.execute(input,ctx) as Record<string,unknown>;
      if(typeof output?.slug!=='string'||typeof output.source_id!=='string')return output;
      const [page]=await ctx.engine.executeRaw<{revision:string}>('SELECT knowledge_revision::text revision FROM pages WHERE slug=$1 AND source_id=$2',[output.slug,output.source_id]);
      return {...output,ingest_revision:page?.revision};
    }};
    if(name==='search')return {...tool,description:'Find existing entity pages by name or declared alias, current Source first then shared default. Returns identities; an empty result means no matching entity, not missing original material.',async execute(raw,ctx){
      const input=raw as Record<string,unknown>;const query=String(input.query??'').trim();
      if(query.length<2)return [];
      const terms=[...new Set(query.split(/[,，、\n]/).map(name=>surfaceName(name.toLowerCase())).filter(name=>name.length>=2))];
      const pages=await loadLinkPageMetadata(ctx.engine);
      return pages.filter(page=>['person','company','organization','entity','project','concept'].includes(page.type)
        &&[context.sourceId,'default'].includes(page.source_id)
        &&[page.title,...(Array.isArray(page.aliases)?page.aliases:[])].some(name=>typeof name==='string'&&terms.some(term=>surfaceName(name.toLowerCase()).includes(term)||term.includes(surfaceName(name.toLowerCase())))))
        .sort((a,b)=>Number(b.source_id===context.sourceId)-Number(a.source_id===context.sourceId)).slice(0,40)
        .map(page=>({slug:`${page.source_id}:${page.slug}`,title:page.title,type:page.type,source_id:page.source_id,aliases:page.aliases}));
    }};
    if(!['put_page','add_link','add_timeline_entry'].includes(name))return tool;
    return {...tool,async execute(raw,ctx){
      const input=name==='add_link'?(raw&&typeof raw==='object'?raw as Record<string,unknown>:{}):await canonicalInput(raw,ctx.engine);
      if(name==='put_page'&&unchanged(input))return {status:'unchanged',slug:input.slug,ingest_links_created:0,instruction:'Already persisted for this unchanged source chunk. Include in the final receipt and move to unfinished entities.'};
      if(name==='add_link'){
        try{
        const from=await resolveEntity(ctx.engine,context,String(input.from??''));
        const to=await resolveEntity(ctx.engine,context,String(input.to??''));
        const relation={from:String(input.from),to:String(input.to),link_type:String(input.link_type??'mentions'),evidence:String(input.context??'')};
        await relationEvidence(ctx.engine,context,relation,from,to);
        const created=await ctx.engine.transaction(async tx=>{
          await tx.executeRaw('SELECT id FROM pages WHERE (slug=$1 AND source_id=$2) OR(slug=$3 AND source_id=$4) OR(slug=$5 AND source_id=$6) ORDER BY id FOR SHARE',[context.slug,context.sourceId,from.slug,from.sourceId,to.slug,to.sourceId]);
          const original=await tx.getPage(context.slug,{sourceId:context.sourceId});
          if(!original||original.deleted_at||original.compiled_truth!==context.body)throw new UnrecoverableError('ingest source changed before relationship write');
          return tx.addLinksBatch([managedLink(context,from,to,relation.link_type,relation.evidence)]);
        });
        return {status:'ok',from:`${from.sourceId}:${from.slug}`,to:`${to.sourceId}:${to.slug}`,origin:context.slug,evidence:relation.evidence,ingest_links_created:created};
        }catch(error){
          const reason=error instanceof Error?error.message:String(error);
          if(reason.includes('source boundary')||!(error instanceof UnrecoverableError))throw error;
          return {status:'rejected',from:input.from,to:input.to,evidence:input.context,reason,ingest_links_created:0,instruction:'Do not repeat this candidate. Include only valid relations in the final receipt; this rejection is recorded separately.'};
        }
      }
      await validateIngestWrite(ctx.engine,context,name,input);
      return ctx.engine.transaction(async tx=>{
        await tx.executeRaw('SELECT id FROM pages WHERE slug=$1 AND source_id=$2 FOR SHARE',[context.slug,context.sourceId]);
        const original=await tx.getPage(context.slug,{sourceId:context.sourceId});
        if(!original||original.deleted_at||original.compiled_truth!==context.body)throw new UnrecoverableError('ingest source changed before entity write');
        const reference=String(input.slug),colon=reference.indexOf(':');
        const sourceId=colon<0?context.sourceId:reference.slice(0,colon),slug=colon<0?reference:reference.slice(colon+1);
        const [current]=await tx.executeRaw<{revision:string}>('SELECT knowledge_revision::text revision FROM pages WHERE slug=$1 AND source_id=$2 FOR UPDATE',[slug,sourceId]);
        if(name==='put_page'&&current){
          const [read]=await tx.executeRaw<{revision:string}>(`SELECT o->>'ingest_revision' revision FROM
            (SELECT id,CASE WHEN jsonb_typeof(input)='string' THEN (input #>> '{}')::jsonb ELSE input END i,CASE WHEN jsonb_typeof(output)='string' THEN (output #>> '{}')::jsonb ELSE output END o
             FROM subagent_tool_executions WHERE job_id=$1 AND tool_name IN ('brain_get_page','brain_put_page') AND status='complete') x
            WHERE i->>'slug'=ANY($2::text[]) AND COALESCE(o->>'source_id',CASE WHEN strpos(o->>'slug',':')>0 THEN split_part(o->>'slug',':',1) END,CASE WHEN strpos(i->>'slug',':')>0 THEN split_part(i->>'slug',':',1) END,$3)=$4 ORDER BY id DESC LIMIT 1`,[ctx.jobId,[slug,`${sourceId}:${slug}`],context.sourceId,sourceId]);
          if(!read){
            const reader=tools.find(candidate=>candidate.name.replace(/^brain_/,'')==='get_page');
            if(!reader)throw new UnrecoverableError('ingest existing page requires get_page before merge');
            const page=await reader.execute({slug:`${sourceId}:${slug}`},{...ctx,engine:tx});
            return {status:'merge_required',slug:`${sourceId}:${slug}`,page,ingest_revision:current.revision,ingest_links_created:0,instruction:'The existing page was read for you and has not been overwritten. Merge new facts into this page while retaining previous facts and timeline; rewrite State only. Call put_page again with the merged page. Do not repeat discovery.'};
          }
          if(read.revision!==current.revision)throw new UnrecoverableError('ingest revision conflict; read the changed entity before merging');
        }
        const [before]=await tx.executeRaw<{id:number}>('SELECT COALESCE(max(id),0)::int id FROM links');
        const writeInput=name==='put_page'?{...input,content:await annotateIngestContent(tx,context,String(input.slug),String(input.content))}:input;
        const output=await tool.execute(writeInput,{...ctx,engine:tx});
        const [after]=await tx.executeRaw<{n:number}>('SELECT count(*)::int n FROM links WHERE id>$1',[before?.id??0]);
        const [written]=await tx.executeRaw<{revision:string}>('SELECT knowledge_revision::text revision FROM pages WHERE slug=$1 AND source_id=$2',[slug,sourceId]);
        return {...output as object,slug:`${sourceId}:${slug}`,source_id:sourceId,ingest_links_created:after?.n??0,ingest_revision:written?.revision};
      });
    }};
  });
}

export async function finalizeEntityIngest(engine:BrainEngine,context:EntityIngestContext,text:string,requiredWrites:string[]=[]){
  const receipt=parseReceipt(text);
  const entities=await Promise.all([...new Set(receipt.entities)].map(ref=>resolveEntity(engine,context,ref)));
  const byRef=new Map([...new Set(receipt.entities)].map((ref,i)=>[ref,entities[i]]));
  const identities=new Set(entities.map(entity=>`${entity.sourceId}:${entity.slug}`));
  for(const reference of requiredWrites){
    const qualified=reference.includes(':')?reference:`${context.sourceId}:${reference}`;
    if(!identities.has(qualified))throw new UnrecoverableError(`ingest receipt omits written entity: ${reference}`);
  }
  const relations=[];
  const unresolved:Array<{sourcePage:string;sourceId:string;target:string;field:string;reason:string}>=[];
  for(const relation of receipt.relations){
    try{
    const from=byRef.get(relation.from)??await resolveEntity(engine,context,relation.from);
    const to=byRef.get(relation.to)??await resolveEntity(engine,context,relation.to);
    await relationEvidence(engine,context,relation,from,to);relations.push({relation,from,to});
    }catch(error){
      if(!(error instanceof UnrecoverableError)||error.message.includes('source boundary'))throw error;
      unresolved.push({sourcePage:relation.from,sourceId:context.sourceId,target:relation.to,field:'ingest_relation',reason:error.message});
    }
  }
  const origin={slug:context.slug,sourceId:context.sourceId};
  const rows=[...entities.flatMap(entity=>[managedLink(context,entity,origin,'mentions',entity.evidence),managedLink(context,origin,entity,'mentions',entity.evidence)]),
    ...relations.map(({relation,from,to})=>managedLink(context,from,to,relation.link_type,relation.evidence))];
  const linksCreated=await engine.transaction(async tx=>{
    await tx.executeRaw('SELECT id FROM pages WHERE slug=$1 AND source_id=$2 FOR SHARE',[context.slug,context.sourceId]);
    const source=await tx.getPage(context.slug,{sourceId:context.sourceId});
    if(!source||source.deleted_at||source.compiled_truth!==context.body)throw new UnrecoverableError('ingest source changed; retry current document');
    const created=rows.length?await tx.addLinksBatch(rows):0;
    for(const row of rows){
      const stored=await tx.executeRaw(`SELECT l.id FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE f.slug=$1 AND f.source_id=$2 AND t.slug=$3 AND t.source_id=$4 AND l.link_type=$5 AND l.origin_field=$6`,
        [row.from_slug,row.from_source_id,row.to_slug,row.to_source_id,row.link_type,row.origin_field]);
      if(stored.length!==1)throw new UnrecoverableError(`ingest relationship readback failed: ${row.from_slug} -> ${row.to_slug}`);
    }
    return created;
  });
  const metadata=await loadLinkPageMetadata(engine);
  for(const entity of entities){
    const page=await engine.getPage(entity.slug,{sourceId:entity.sourceId});
    if(!page)throw new UnrecoverableError(`ingest page readback failed: ${entity.slug}`);
    const extracted=await extractPageLinks(page.slug,`${page.compiled_truth}\n${page.timeline}`,page.frontmatter,page.type,makeIndexedLinkResolver(metadata,entity.sourceId),{
      pack:await loadExtractionPack(engine,entity.sourceId),lineGrammar:await lineGrammarOptions(engine)});
    for(const ref of extracted.unresolved)unresolved.push({sourcePage:page.slug,sourceId:entity.sourceId,target:ref.name,field:ref.field,reason:ref.reason??'missing_target'});
    for(const ref of extracted.candidates)if(!metadata.some(p=>p.slug===ref.targetSlug&&p.source_id===(ref.targetSourceId??entity.sourceId)))unresolved.push({sourcePage:page.slug,sourceId:entity.sourceId,target:ref.targetSlug,field:ref.linkSource??'markdown',reason:'missing_target'});
  }
  return {verified:true,entities,linksCreated,unresolved};
}

export async function pruneEntityIngestLinks(engine:BrainEngine,sourceId?:string,counts?:{created:number}):Promise<number>{
  const origins=await engine.executeRaw<{id:number|null;source_id:string|null;compiled_truth:string|null;deleted_at:string|null;origin_field:string}>(`SELECT DISTINCT o.id,o.source_id,o.compiled_truth,o.deleted_at,l.origin_field
    FROM links l LEFT JOIN pages o ON o.id=l.origin_page_id WHERE ((l.link_source='manual' AND l.origin_field LIKE 'ingest:%') OR(l.link_source='mentions' AND l.link_kind='typed_ner' AND l.origin_field LIKE 'ingest_ner:%'))
    AND ($1::text IS NULL OR split_part(l.origin_field,':',2)=$1)`,[sourceId??null]);
  let removed=0;
  for(const origin of origins){
    const current=ingestOriginField({sourceId:origin.source_id!,body:origin.compiled_truth??''});
    if(origin.id&&!origin.deleted_at&&origin.origin_field===(origin.origin_field.startsWith('ingest_ner:')?current.replace(/^ingest:/,'ingest_ner:'):current))continue;
    const affected=await engine.executeRaw<{id:number;slug:string;source_id:string}>(`SELECT DISTINCT p.id,p.slug,p.source_id FROM links l JOIN pages p ON p.id IN(l.from_page_id,l.to_page_id)
      WHERE l.origin_field=$1 AND l.origin_page_id IS NOT DISTINCT FROM $2 AND p.frontmatter ? 'pmbrain_ingest_provenance'`,[origin.origin_field,origin.id]);
    const rows=await engine.executeRaw("DELETE FROM links WHERE ((link_source='manual' AND origin_field LIKE 'ingest:%') OR(link_source='mentions' AND link_kind='typed_ner' AND origin_field LIKE 'ingest_ner:%')) AND origin_field=$1 AND origin_page_id IS NOT DISTINCT FROM $2 RETURNING id",[origin.origin_field,origin.id]);
    removed+=rows.length;
    if(affected.length){
      await engine.executeRaw('UPDATE page_mention_state SET mention_revision=NULL WHERE page_id=ANY($1::int[])',[affected.map(page=>page.id)]);
      const reconcile=await (await import('../link-reconciliation.ts')).prepareLinkReconciliation(engine);
      for(const page of affected)removed+=(await reconcile(page.slug,page.source_id)).removed;
      for(const source of [...new Set(affected.map(page=>page.source_id))]){
        const mentioned=await (await import('../mentions/pass.ts')).runMentionPass(engine,{sourceId:source,slugs:affected.filter(page=>page.source_id===source).map(page=>page.slug)});
        if(mentioned.state==='failed')throw new Error(mentioned.error);
        removed+=mentioned.removed;if(counts)counts.created+=mentioned.created;
      }
    }
  }
  return removed;
}

async function ingestRequiredWrites(engine:BrainEngine,data:SubagentHandlerData,jobId?:number):Promise<string[]>{
  const pending=jobId==null?[]:await engine.executeRaw<{slug:string}>(`SELECT i->>'slug' slug FROM
    (SELECT DISTINCT ON(COALESCE(output->>'slug',(output #>> '{}')::jsonb->>'slug',input->>'slug',(input #>> '{}')::jsonb->>'slug')) CASE WHEN jsonb_typeof(input)='string' THEN (input #>> '{}')::jsonb ELSE input END i,
      CASE WHEN jsonb_typeof(output)='string' THEN (output #>> '{}')::jsonb ELSE output END o FROM subagent_tool_executions
      WHERE job_id=$1 AND tool_name='brain_put_page' AND status='complete' ORDER BY COALESCE(output->>'slug',(output #>> '{}')::jsonb->>'slug',input->>'slug',(input #>> '{}')::jsonb->>'slug'),id DESC) x WHERE o->>'status'='merge_required'`,[jobId]);
  if(pending.length)throw new UnrecoverableError(`ingest pending entity merge: ${pending.map(row=>row.slug).join(', ')}`);
  const written=jobId==null?[]:await engine.executeRaw<{slug:string}>("SELECT DISTINCT COALESCE(output->>'slug',(output #>> '{}')::jsonb->>'slug',input->>'slug',(input #>> '{}')::jsonb->>'slug') AS slug FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_put_page' AND status='complete' AND COALESCE(output->>'status',(output #>> '{}')::jsonb->>'status','') NOT IN ('merge_required','unchanged')",[jobId]);
  return [...written.map(row=>row.slug),...(data.ingest_context?.acknowledged??[])];
}

export async function validateIngestCompletion(engine:BrainEngine,data:SubagentHandlerData,text:string,jobId:number,canContinue:boolean):Promise<string|null>{
  if(!data.ingest_context)return null;
  const context=data.ingest_context;
  try{
    const required=await ingestRequiredWrites(engine,data,jobId),receipt=parseReceipt(text);
    const entities=await Promise.all([...new Set(receipt.entities)].map(reference=>resolveEntity(engine,context,reference)));
    const identities=new Set(entities.map(entity=>`${entity.sourceId}:${entity.slug}`));
    for(const reference of required){
      const qualified=reference.includes(':')?reference:`${context.sourceId}:${reference}`;
      if(!identities.has(qualified))throw new UnrecoverableError(`ingest receipt omits written entity: ${reference}`);
    }
    return null;
  }catch(error){
    if(!(error instanceof UnrecoverableError)||error.message.includes('source boundary'))throw error;
    if(!canContinue)throw error;
    const writes=await engine.executeRaw<{slug:string;status:string}>(`SELECT COALESCE(o->>'slug',i->>'slug') slug,o->>'status' status FROM
      (SELECT id,CASE WHEN jsonb_typeof(input)='string' THEN (input #>> '{}')::jsonb ELSE input END i,CASE WHEN jsonb_typeof(output)='string' THEN (output #>> '{}')::jsonb ELSE output END o
       FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_put_page' AND status='complete') x ORDER BY id`,[jobId]);
    return `Ingest result verification failed: ${error.message}\nPersisted entity writes: ${JSON.stringify(writes)}\nThe document is unfinished. Use the remaining tool turns to save evidence-backed entities or finish required merges, then return the JSON receipt using actual persisted identities. Never claim an unwritten target. If the source has no notable entities, explicitly return no_entities:true with empty entities and relations. Do not repeat discovery or rewrite unchanged persisted pages.`;
  }
}

export async function verifyIngestResult(engine:BrainEngine,data:SubagentHandlerData,result:SubagentResult,jobId?:number):Promise<SubagentResult>{
  if(!data.ingest_context)return result;
  if(result.stop_reason!=='end_turn')throw new UnrecoverableError(result.stop_reason==='length'?'ingest_output_truncated: output truncated after bounded retry':['timeout','user_stop','service_shutdown','aborted'].includes(result.stop_reason)?`ingest_provider_${result.stop_reason}: ingest incomplete`:`ingest incomplete: ${result.stop_reason}`);
  const verified=await finalizeEntityIngest(engine,data.ingest_context,result.result,await ingestRequiredWrites(engine,data,jobId));
  const rejected=jobId==null?[]:await engine.executeRaw<{from:string;to:string;reason:string}>(`SELECT DISTINCT i->>'from' AS "from",i->>'to' AS "to",o->>'reason' AS reason
    FROM (SELECT CASE WHEN jsonb_typeof(input)='string' THEN (input #>> '{}')::jsonb ELSE input END i,CASE WHEN jsonb_typeof(output)='string' THEN (output #>> '{}')::jsonb ELSE output END o FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_add_link') x WHERE o->>'status'='rejected'`,[jobId]);
  for(const row of rejected)verified.unresolved.push({sourcePage:row.from,sourceId:data.ingest_context.sourceId,target:row.to,field:'ingest_relation',reason:row.reason});
  return {...result,ingest_verified:verified.verified,graph_reconciled:false,ingest_entities:verified.entities,ingest_unresolved:verified.unresolved,ingest_links_created:verified.linksCreated};
}

export async function ingestFinalPrompt(engine:BrainEngine,jobId:number,data:SubagentHandlerData):Promise<string>{
  const writes=await engine.executeRaw<{tool_name:string;input:Record<string,unknown>;output:unknown}>(`SELECT tool_name,CASE WHEN jsonb_typeof(input)='string' THEN (input #>> '{}')::jsonb ELSE input END input,CASE WHEN jsonb_typeof(output)='string' THEN (output #>> '{}')::jsonb ELSE output END output FROM subagent_tool_executions WHERE job_id=$1 AND status='complete' AND tool_name IN ('brain_put_page','brain_add_link','brain_add_timeline_entry') ORDER BY id`,[jobId]);
  const persisted=writes.map(row=>row.tool_name==='brain_add_link'?{tool:row.tool_name,...row.output as object}:{tool:row.tool_name,slug:row.input.slug,status:(row.output as any)?.status==='merge_required'?'merge_required':'persisted'});
  const [feedback]=await engine.executeRaw<{content_blocks:unknown}>("SELECT content_blocks FROM subagent_messages WHERE job_id=$1 AND role='user' AND content_blocks::text LIKE '%Ingest result verification failed:%' ORDER BY message_idx DESC LIMIT 1",[jobId]);
  return `${data.prompt}\n\nDurable write ledger (all successful writes must appear in entities; rejected relations must not be reported as valid):\n${JSON.stringify(persisted)}${feedback?`\nLast verification feedback: ${JSON.stringify(feedback.content_blocks)}`:''}\nReturn the requested JSON receipt now. No tools or further writes are available. Do not invent unwritten targets.`;
}

export function ingestAbortKind(signal:AbortSignal):'timeout'|'service_shutdown'|'user_stop'|'aborted'{
  const reason=signal.reason instanceof Error?`${signal.reason.name}: ${signal.reason.message}`:String(signal.reason??'');
  if(/timeout|timed out|超时/i.test(reason))return 'timeout';
  if(/shutdown|service.*stop|服务关闭/i.test(reason))return 'service_shutdown';
  if(/cancel|user.*stop|取消|用户停止/i.test(reason))return 'user_stop';
  return 'aborted';
}

export async function checkIngestCallBudget(engine:BrainEngine,jobId:number,data:SubagentHandlerData,system:string,messages:unknown,tools:unknown,compact=false,maxTokens=Math.min(defaultMaxOutputTokens(data.model),data.model_output_limit??Infinity,data.usage_limits?.output??Infinity),recovery=false):Promise<number>{
  if(!data.usage_limits)return maxTokens;
  const repeated=await engine.executeRaw(`SELECT tool_name FROM subagent_tool_executions WHERE job_id=$1 AND status='failed'
    AND tool_name IN ('brain_put_page','brain_add_link','brain_add_timeline_entry') GROUP BY tool_name,input HAVING count(*)>=2 LIMIT 1`,[jobId]);
  if(repeated.length)throw new UnrecoverableError(`ingest repeated failed write: ${repeated[0]!.tool_name}; stop and correct the recorded failure`);
  const limits=data.usage_limits;
  const [used]=await engine.executeRaw<{input:number;output:number}>(`SELECT COALESCE(sum(tokens_in),0)::int input,COALESCE(sum(tokens_out),0)::int output FROM subagent_messages WHERE job_id=$1`,[jobId]);
  const input=used?.input??0,output=used?.output??0;
  const [prior]=await engine.executeRaw<{tokens_in:number;added_bytes:number}>(`SELECT m.tokens_in,
    (SELECT COALESCE(sum(octet_length(n.content_blocks::text)),0)::int FROM subagent_messages n WHERE n.job_id=m.job_id AND n.message_idx>=m.message_idx) added_bytes
    FROM subagent_messages m WHERE m.job_id=$1 AND m.tokens_in IS NOT NULL ORDER BY m.message_idx DESC LIMIT 1`,[jobId]);
  const [first]=compact?await engine.executeRaw<{prefix:number}>('SELECT (tokens_in+COALESCE(tokens_cache_read,0)+COALESCE(tokens_cache_create,0))::int prefix FROM subagent_messages WHERE job_id=$1 AND tokens_in IS NOT NULL ORDER BY message_idx LIMIT 1',[jobId]):[];
  const reservation=compact&&first?first.prefix+Math.max(0,Buffer.byteLength(JSON.stringify(messages),'utf8')-Buffer.byteLength(data.prompt,'utf8'))+2048
    :prior&&!compact?prior.tokens_in+prior.added_bytes+2048:Buffer.byteLength(system+JSON.stringify(messages)+JSON.stringify(tools),'utf8')+2048;
  if(recovery){
    const finalCap=compact?0:Math.min(defaultMaxOutputTokens(data.model),data.model_output_limit??Infinity);
    const inputReserve=compact?reservation:reservation*2;
    if(input+inputReserve>limits.input)return 0;
    let cap=Math.min(maxTokens,limits.output-output-finalCap);
    if(limits.cost_cny!=null&&limits.input_price!=null&&limits.output_price!=null){
      const remaining=limits.cost_cny-(input+inputReserve)*limits.input_price/1_000_000-(output+finalCap)*limits.output_price/1_000_000;
      if(remaining<0)return 0;
      if(limits.output_price>0)cap=Math.min(cap,Math.floor(remaining*1_000_000/limits.output_price));
    }
    return Math.max(0,cap);
  }
  if(input+reservation>limits.input||output+maxTokens>limits.output)throw new UnrecoverableError('ingest_budget_tokens: document token limit; unfinished document is resumable');
  if(limits.cost_cny!=null&&limits.input_price!=null&&limits.output_price!=null){
    const reservedCost=((input+reservation)*limits.input_price+(output+maxTokens)*limits.output_price)/1_000_000;
    if(reservedCost>limits.cost_cny)throw new UnrecoverableError('ingest_budget_cost: configured cost limit; unfinished document is resumable');
  }
  return maxTokens;
}

export async function finalizeBeforeIngestBudget(engine:BrainEngine,jobId:number,data:SubagentHandlerData,system:string,messages:unknown,tools:unknown):Promise<boolean>{
  const cap=Math.min(defaultMaxOutputTokens(data.model),data.model_output_limit??Infinity,data.usage_limits?.output??Infinity);
  try{
    await checkIngestCallBudget(engine,jobId,data,system,messages,tools);
    const [first]=data.usage_limits?await engine.executeRaw<{prefix:number}>('SELECT (tokens_in+COALESCE(tokens_cache_read,0)+COALESCE(tokens_cache_create,0))::int prefix FROM subagent_messages WHERE job_id=$1 AND tokens_in IS NOT NULL ORDER BY message_idx LIMIT 1',[jobId]):[];
    if(first&&data.usage_limits){
      const finalMessages=[{role:'user',content:await ingestFinalPrompt(engine,jobId,data)}];
      const reserve=first.prefix+Math.max(0,Buffer.byteLength(JSON.stringify(finalMessages),'utf8')-Buffer.byteLength(data.prompt,'utf8'))+cap;
      const limits=data.usage_limits;
      const cost=limits.cost_cny!=null&&limits.input_price!=null&&limits.output_price!=null?Math.max(0,limits.cost_cny-(reserve*limits.input_price+cap*limits.output_price)/1_000_000):limits.cost_cny;
      await checkIngestCallBudget(engine,jobId,{...data,usage_limits:{...limits,input:Math.max(0,limits.input-reserve),output:Math.max(0,limits.output-cap),cost_cny:cost}},system,messages,tools,false,cap);
    }
    return false;
  }
  catch(error){if(error instanceof UnrecoverableError&&/^ingest_budget_(?:tokens|cost):/.test(error.message))return true;throw error;}
}
