import {createHash} from 'node:crypto';
import type {BrainEngine,LinkBatchInput} from '../engine.ts';
import {parseMarkdown,serializeMarkdown} from '../markdown.ts';
import type {EntityIngestContext} from './entity-ingest-workflow.ts';
import matter from 'gray-matter';

interface Provenance {line:string;sourceId:string;slug:string;pageId:string;bodyHash:string;chunkHash?:string}
const key='pmbrain_ingest_provenance';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function records(frontmatter:Record<string,unknown>):Provenance[]{
  const value=frontmatter[key];
  return Array.isArray(value)?value.filter((x):x is Provenance=>!!x&&['line','sourceId','slug','pageId','bodyHash'].every(field=>typeof x[field]==='string')):[];
}

export function ingestMentionOrigin(frontmatter:Record<string,unknown>,body:string,offset:number):Partial<LinkBatchInput>{
  const start=body.lastIndexOf('\n',Math.max(0,offset-1))+1,end=body.indexOf('\n',offset);
  const line=body.slice(start,end<0?body.length:end),record=records(frontmatter).find(value=>value.line===hash(line));
  return record?{origin_slug:record.slug,origin_source_id:record.sourceId,origin_field:`ingest_ner:${record.sourceId}:${record.bodyHash}`} : {};
}

function splitState(body:string):{facts:string;states:string[]}{
  const facts:string[]=[],states:string[]=[];let current:string[]|null=null;
  for(const line of body.split('\n')){
    if(/^##\s+(?:State|当前状态)(?:\s*[（(][^）)]*[）)])?\s*$/i.test(line)){
      if(current)states.push(current.join('\n'));current=[line];continue;
    }
    if(current&&/^#{1,2}\s/.test(line)){states.push(current.join('\n'));current=null;}
    if(current)current.push(line);else facts.push(line);
  }
  if(current)states.push(current.join('\n'));
  return {facts:facts.join('\n'),states};
}

function preserveExisting(existing:{compiled_truth:string;timeline:string}|null,body:string,timeline:string):{body:string;timeline:string}{
  if(!existing)return {body,timeline};
  const old=splitState(existing.compiled_truth),current=splitState(body);
  const missing=old.facts.split(/\n\s*\n/).map(block=>block.trim()).filter(block=>block&&!/^#{1,6}[^\n]*$/.test(block)&&!body.includes(block));
  const historical=missing.length?`\n\n## 历史事实\n\n${missing.join('\n\n')}`:'';
  const state=!current.states.length&&old.states.length?`\n\n${old.states.at(-1)}`:'';
  const priorTimeline=existing.timeline.trim();
  return {body:body+historical+state,timeline:priorTimeline&&!timeline.includes(priorTimeline)?[priorTimeline,timeline].filter(Boolean).join('\n\n'):timeline};
}

export async function annotateIngestContent(engine:BrainEngine,context:EntityIngestContext,reference:string,content:string):Promise<string>{
  const at=reference.indexOf(':'),sourceId=at<0?context.sourceId:reference.slice(0,at),slug=at<0?reference:reference.slice(at+1);
  const existing=await engine.getPage(slug,{sourceId});
  const [origin]=await engine.executeRaw<{id:string}>('SELECT id::text id FROM pages WHERE slug=$1 AND source_id=$2 AND deleted_at IS NULL',[context.slug,context.sourceId]);
  if(!origin)throw new Error('ingest source missing before write');
  const parsed=parseMarkdown(content,slug);
  const metadata=matter(content).data;
  const preserved=preserveExisting(existing,parsed.compiled_truth,parsed.timeline);
  const previous=records(existing?.frontmatter??{});
  const lines=`${preserved.body}\n${preserved.timeline}`.split('\n');
  const next=previous.filter(record=>lines.some(line=>hash(line)===record.line));
  const incoming=new Set(`${parsed.compiled_truth}\n${parsed.timeline}`.split('\n').map(hash));
  for(const line of lines){
    if(!line.includes(context.slug))continue;
    const lineHash=hash(line);
    const owned=next.find(record=>record.line===lineHash&&record.sourceId===context.sourceId&&record.slug===context.slug&&record.pageId===origin.id);
    if(owned){if(incoming.has(lineHash)){owned.bodyHash=hash(context.body);owned.chunkHash=hash(context.chunkBody);}continue;}
    next.push({line:lineHash,sourceId:context.sourceId,slug:context.slug,pageId:origin.id,bodyHash:hash(context.body),chunkHash:hash(context.chunkBody)});
  }
  const frontmatter:Record<string,unknown>={...existing?.frontmatter,...parsed.frontmatter,[key]:next};
  const aliases=[existing?.frontmatter.aliases,parsed.frontmatter.aliases].flatMap(value=>Array.isArray(value)?value.filter((name):name is string=>typeof name==='string'):[]);
  if(aliases.length)frontmatter.aliases=[...new Set(aliases)];
  if(existing?.frontmatter.private===true)frontmatter.private=true;
  if(existing?.frontmatter.visibility==='private')frontmatter.visibility='private';
  const tags=[...new Set([...(existing?await engine.getTags(slug,{sourceId}):[]),...parsed.tags])];
  const title=String(metadata.title??existing?.title??parsed.title);
  if(existing&&title!==existing.title)frontmatter.aliases=[...new Set([existing.title,...aliases])];
  return serializeMarkdown(frontmatter,preserved.body,preserved.timeline,{type:(metadata.type??existing?.type??parsed.type) as typeof parsed.type,title,tags});
}

export async function activeIngestContent(engine:Pick<BrainEngine,'executeRaw'>,page:{compiled_truth:string|null;timeline?:string|null;frontmatter?:Record<string,unknown>}):Promise<{compiled_truth:string;timeline:string;origins:Array<{slug:string;sourceId:string;revision:string}>}>{
  const provenance=records(page.frontmatter??{});
  if(!provenance.length)return {compiled_truth:page.compiled_truth??'',timeline:page.timeline??'',origins:[]};
  const cache=new Map<string,boolean>();const invalid=new Set<string>(),valid=new Set<string>();
  const origins=new Map<string,{slug:string;sourceId:string;revision:string}>();
  for(const record of provenance){
    const identity=JSON.stringify([record.pageId,record.sourceId,record.bodyHash]);
    let active=cache.get(identity);
    if(active===undefined){
      const [origin]=await engine.executeRaw<{compiled_truth:string;deleted_at:string|null;source_id:string;slug:string;revision:string}>('SELECT compiled_truth,deleted_at,source_id,slug,knowledge_revision::text revision FROM pages WHERE id=$1',[record.pageId]);
      active=!!origin&&!origin.deleted_at&&origin.source_id===record.sourceId&&origin.slug===record.slug&&hash(origin.compiled_truth??'')===record.bodyHash;cache.set(identity,active);
      if(active)origins.set(identity,{slug:origin!.slug,sourceId:origin!.source_id,revision:origin!.revision});
    }
    if(!active)invalid.add(record.line);else valid.add(record.line);
  }
  const filter=(body:string)=>body.split('\n').map(line=>invalid.has(hash(line))&&!valid.has(hash(line))?'':line).join('\n');
  return {compiled_truth:filter(page.compiled_truth??''),timeline:filter(page.timeline??''),origins:[...origins.values()]};
}
