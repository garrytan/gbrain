import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { EntityCaptureCandidate } from '../cycle/capture-entities.ts';
import { captureScopeKey } from './entity-capture-plan.ts';

type Proof = { id: number; revision: string; lines: string[]; title: string; type: string; aliases: string };
type Options = { model: string; contract: string; proofs?: Proof[]; unresolved?:unknown[]; onCached?:(page:EntityCaptureCandidate,manifest:Manifest)=>void };
type Metadata = { id: number; source_id: string; slug: string; revision: string; incarnation: string };
type Target = Metadata & { proofs?:Proof[] };
type Manifest = { version: 1; scope: string; revision: string; graph: string; chunks: number; targets: Target[];unresolved?:unknown[] };
const key = (page: EntityCaptureCandidate) => `dream.entity_capture.manifest.${createHash('sha256').update(JSON.stringify([page.sourceId, page.pageId, page.sourceIncarnation])).digest('hex')}`;
const scope = (page: EntityCaptureCandidate, options: Options) => captureScopeKey({ ...page, ...options,contract:JSON.stringify([options.contract,page.policySignature??null]) });

async function metadata(engine: BrainEngine, ids: number[]): Promise<Map<number, Metadata>> {
  if (!ids.length) return new Map();
  const rows = await engine.executeRaw<Metadata>(`SELECT p.id,p.source_id,p.slug,p.knowledge_revision::text revision,s.incarnation::text incarnation
    FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.id=ANY($1::int[]) AND p.deleted_at IS NULL AND NOT s.archived`, [ids]);
  return new Map(rows.map(row => [row.id, row]));
}

async function graphs(engine: BrainEngine, ids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += 200) {
    const rows = await engine.executeRaw<{ page_id: number; signature: string }>(`SELECT page_id,md5(string_agg(signature,',' ORDER BY edge_id,direction)) signature FROM (
      SELECT from_page_id page_id,id edge_id,'from' direction,'from:'||id::text||':'||to_page_id::text||':'||md5(jsonb_build_array(link_type,context,link_source,link_kind,origin_field,origin_page_id,resolution_type)::text) signature FROM links WHERE from_page_id=ANY($1::int[])
      UNION ALL
      SELECT to_page_id page_id,id edge_id,'to' direction,'to:'||id::text||':'||from_page_id::text||':'||md5(jsonb_build_array(link_type,context,link_source,link_kind,origin_field,origin_page_id,resolution_type)::text) signature FROM links WHERE to_page_id=ANY($1::int[])
      UNION ALL
      SELECT origin_page_id page_id,id edge_id,'origin' direction,'origin:'||id::text||':'||from_page_id::text||':'||to_page_id::text||':'||md5(jsonb_build_array(link_type,context,link_source,link_kind,origin_field,origin_page_id,resolution_type)::text) signature FROM links WHERE origin_page_id=ANY($1::int[])
    ) selected GROUP BY page_id`, [unique.slice(offset, offset + 200)]);
    for (const row of rows) result.set(row.page_id, row.signature);
  }
  return result;
}

export async function pendingCaptureCandidates(engine: BrainEngine, pages: EntityCaptureCandidate[], options: Options): Promise<EntityCaptureCandidate[]> {
  const pending: EntityCaptureCandidate[] = [];
  const facts=new Map<number,{revision:string;title:string;type:string;aliases:string;lines:Set<string>;known:Set<string>}>();
  for (let offset = 0; offset < pages.length; offset += 100) {
    const batch = pages.slice(offset, offset + 100);
    const rows = await engine.executeRaw<{ key: string; value: string }>('SELECT key,value FROM config WHERE key=ANY($1::text[])', [batch.map(key)]);
    const manifests = new Map(rows.map(row => [row.key, JSON.parse(row.value) as Manifest]));
    const eligible = batch.filter(page => {
      const manifest = manifests.get(key(page));
      if (!page.revision || manifest?.version !== 1 || manifest.revision !== page.revision || manifest.scope !== scope(page, options) || !Array.isArray(manifest.targets)) {
        pending.push(page); return false;
      }
      return true;
    });
    const targets = await metadata(engine, [...new Set(eligible.flatMap(page => manifests.get(key(page))!.targets.map(target => target.id)))]);
    const needed=new Map<number,Set<string>>();
    for(const page of eligible)for(const target of manifests.get(key(page))!.targets){
      const current=targets.get(target.id),saved=facts.get(target.id);
      if(current&&current.revision!==target.revision)for(const proof of target.proofs??[])for(const line of proof.lines){
        if(saved?.revision===current.revision&&saved.known.has(line))continue;
        const lines=needed.get(target.id)??new Set<string>();lines.add(line);needed.set(target.id,lines);
      }
    }
    const changed=[...needed.keys()];
    for(let start=0;start<changed.length;start+=100){
      const ids=changed.slice(start,start+100),wanted=[...new Set(ids.flatMap(id=>[...needed.get(id)!]))];
      const rows=await engine.executeRaw<{id:number;revision:string;title:string;type:string;aliases:string;lines:string[]}>(`SELECT id,knowledge_revision::text revision,title,type,COALESCE(frontmatter->'aliases','[]'::jsonb)::text aliases,
        ARRAY(SELECT encode(sha256(convert_to(line,'UTF8')),'hex') FROM regexp_split_to_table(COALESCE(compiled_truth,'')||chr(10)||COALESCE(timeline,''),chr(10)) line WHERE encode(sha256(convert_to(line,'UTF8')),'hex')=ANY($2::text[])) lines
        FROM pages WHERE id=ANY($1::int[]) AND deleted_at IS NULL`,[ids,wanted]);
      for(const row of rows){
        const aliases=JSON.parse(row.aliases),saved=facts.get(row.id),prior=saved?.revision===row.revision?saved:undefined,wanted=needed.get(row.id)!;
        facts.set(row.id,{...row,aliases:JSON.stringify(Array.isArray(aliases)?aliases.sort():[]),lines:new Set([...(prior?.lines??[]),...row.lines.filter(line=>wanted.has(line))]),known:new Set([...(prior?.known??[]),...wanted])});
      }
    }
    const unchanged = eligible.filter(page => {
      const valid = manifests.get(key(page))!.targets.every(target => {
        const current = targets.get(target.id);
        if(!current||![page.sourceId,'default'].includes(current.source_id)||current.slug!==target.slug||current.source_id!==target.source_id||current.incarnation!==target.incarnation)return false;
        if(current.revision===target.revision)return true;
        const snapshot=facts.get(target.id);
        return snapshot?.revision===current.revision&&!!target.proofs?.length&&target.proofs.every(proof=>proof.lines.length>0&&proof.title===snapshot.title&&proof.type===snapshot.type&&proof.aliases===snapshot.aliases&&proof.lines.every(line=>snapshot.lines.has(line)));
      });
      if (!valid) pending.push(page);
      return valid;
    });
    const signatures = await graphs(engine, unchanged.map(page => Number(page.pageId)));
    for (const page of unchanged) {
      const manifest = manifests.get(key(page))!;
      if ((signatures.get(Number(page.pageId)) ?? '') !== manifest.graph) pending.push(page);
      else options.onCached?.(page,manifest);
    }
  }
  const selected = new Set(pending);
  return pages.filter(page => selected.has(page));
}

export async function publishCaptureManifest(engine: BrainEngine, page: EntityCaptureCandidate, entities: Array<{ slug: string; sourceId: string }>, chunks: number, options: Options): Promise<void> {
  if (!page.revision || !page.pageId || !page.sourceIncarnation) return;
  await engine.transaction(async tx => {
    const [source] = await tx.executeRaw<{ revision: string; incarnation: string }>(`SELECT p.knowledge_revision::text revision,s.incarnation::text incarnation
      FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.id=$1 AND p.slug=$2 AND p.source_id=$3 AND p.deleted_at IS NULL AND NOT s.archived FOR SHARE OF p,s`, [page.pageId, page.slug, page.sourceId]);
    if (source?.revision !== page.revision || source.incarnation !== page.sourceIncarnation) return;
    const references = [...new Set(entities.map(entity => `${entity.sourceId}:${entity.slug}`))];
    const targets = references.length ? await tx.executeRaw<Metadata>(`SELECT p.id,p.source_id,p.slug,p.knowledge_revision::text revision,s.incarnation::text incarnation
      FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id||':'||p.slug=ANY($1::text[]) AND p.deleted_at IS NULL AND NOT s.archived FOR SHARE OF p,s`, [references]) : [];
    if (targets.length !== references.length || targets.some(target => ![page.sourceId, 'default'].includes(target.source_id))) return;
    if (options.proofs && targets.length) {
      const rows = await tx.executeRaw<{ id: number; title: string; type: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> }>(
        'SELECT id,title,type,compiled_truth,timeline,frontmatter FROM pages WHERE id=ANY($1::int[])', [targets.map(target => target.id)]);
      for (const target of targets) {
        const proofs = options.proofs.filter(proof => proof.id === target.id);
        const current = rows.find(row => row.id === target.id)!;
        if (!proofs.length) return;
        const aliases = JSON.stringify(Array.isArray(current.frontmatter.aliases) ? [...current.frontmatter.aliases].sort() : []);
        const lines = new Set(`${current.compiled_truth}\n${current.timeline}`.split('\n').map(line => createHash('sha256').update(line).digest('hex')));
        if (proofs.some(proof => proof.title !== current.title || proof.type !== current.type || proof.aliases !== aliases
          || proof.lines.some(line => !lines.has(line)) || (!proof.lines.length && proof.revision !== target.revision))) return;
      }
    }
    const signatures = await graphs(tx, [Number(page.pageId)]);
    const manifest: Manifest = { version: 1, scope: scope(page, options), revision: page.revision, graph: signatures.get(Number(page.pageId)) ?? '', chunks,
      targets: targets.map(target => ({ ...target, proofs:options.proofs?.filter(proof=>proof.id===target.id) })),unresolved:options.unresolved??[] };
    await tx.setConfig(key(page), JSON.stringify(manifest));
  });
}
