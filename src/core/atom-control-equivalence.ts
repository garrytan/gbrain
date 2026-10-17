/** A machine-checked bridge for one operational opt-out; never rewrites extraction provenance. */
import type {BrainEngine} from './engine.ts';
import {contentHash} from './utils.ts';
import {stableJson} from './persistence/digest.ts';
import {readPageSnapshot} from './page-state/snapshot.ts';
export const ATOM_CONTROL_EQUIVALENCE='source_control_equivalence_v1';
export interface AtomControlProof {
 schema_version:1; source_id:string; source_incarnation:string; source_page_id:number; source_slug:string;
 source_version_id:number; source_version_revision:string; old_full_hash:string; current_full_hash:string;
 current_revision:string; frontmatter_order:string[]; checkpoint_fingerprint:string;
}
const keys='checkpoint_fingerprint,current_full_hash,current_revision,frontmatter_order,old_full_hash,schema_version,source_id,source_incarnation,source_page_id,source_slug,source_version_id,source_version_revision';
const uuid=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const hash=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
export function parseAtomControlProof(value:unknown):AtomControlProof|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;const p=value as AtomControlProof;
 if(Object.keys(p).sort().join(',')!==keys||JSON.stringify(p).length>4096||p.schema_version!==1
  ||typeof p.source_id!=='string'||!p.source_id||p.source_id.length>128||typeof p.source_slug!=='string'||!p.source_slug||p.source_slug.length>512
  ||!uuid(p.source_incarnation)||!uuid(p.source_version_revision)||!uuid(p.current_revision)||!hash(p.old_full_hash)||!hash(p.current_full_hash)||p.old_full_hash===p.current_full_hash
  ||![p.source_page_id,p.source_version_id].every(n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647)
  ||!Array.isArray(p.frontmatter_order)||p.frontmatter_order.length>64||p.frontmatter_order.some(k=>typeof k!=='string'||!k||k.length>128)||new Set(p.frontmatter_order).size!==p.frontmatter_order.length
  ||typeof p.checkpoint_fingerprint!=='string'||!p.checkpoint_fingerprint||p.checkpoint_fingerprint.length>512)return null;
 return p;
}
/** No timestamps: stable across connection timezone, and includes fields that redaction/rename may change. */
export const oldVersionImageSql=(v:string)=>`jsonb_build_object('page_id',${v}.page_id,'knowledge_revision',${v}.knowledge_revision,'compiled_truth',${v}.compiled_truth,'timeline',${v}.timeline,'title',${v}.title,'type',${v}.type,'tags',${v}.tags,'frontmatter',${v}.frontmatter,'body_storage',${v}.body_storage,'body_generation',${v}.body_generation,'is_deleted',${v}.is_deleted,'source_path',${v}.source_path)`;
export interface ControlBinding {
 atom_id:number;atom_revision:string;source_id:string;incarnation:string;page_id:number;page_slug:string;
 page_revision:string;page_path:string|null;new_hash:string;old_hash:string;version_id:number;version_image:unknown;
 checkpoint_fingerprint:string;checkpoint_image:unknown;ledger_image:unknown;
}
/** Pin ledger identity and exact instants: withdrawal dates alter canonical fence expiry. */
/** At most 32 relevant ledger rows, with bounded scalar fields; overflow grants no exemption. */
export const controlLedgerImageSql=(source:string,slug:string)=>`(
 SELECT CASE WHEN count(*)<=32 AND COALESCE(bool_and(octet_length(visibility)<=16 AND octet_length(fact_hash)<=128),true)
  THEN COALESCE(jsonb_agg(CASE WHEN octet_length(visibility)<=16 AND octet_length(fact_hash)<=128
   THEN jsonb_build_array(kind,visibility,global_subject,fact_hash,instant) END ORDER BY kind,visibility,global_subject,fact_hash),'[]'::jsonb) ELSE NULL END
 FROM (SELECT * FROM (
  SELECT 'withdrawal' AS kind,w.visibility,(w.subject='*') AS global_subject,w.fact_hash,extract(epoch from w.withdrawn_at)::text AS instant
   FROM fact_withdrawals w WHERE w.source_id=${source} AND w.subject IN ('*',${slug})
  UNION ALL
  SELECT 'purge',w.visibility,(w.subject='*'),w.fact_hash,extract(epoch from w.purged_at)::text
   FROM fact_purges w WHERE w.source_id=${source} AND w.subject IN ('*',${slug})
 ) ledger LIMIT 33) bounded_ledger)`;
/** Every consuming statement rechecks these pins, so a validation/consumption race cannot suppress work. */
export function validControlRowsSql(parameter:string):string{
 return `SELECT q.* FROM jsonb_to_recordset(${parameter}::text::jsonb) AS q(atom_id int,atom_revision uuid,source_id text,incarnation uuid,page_id int,page_slug text,page_revision uuid,page_path text,new_hash text,old_hash text,version_id int,version_image jsonb,checkpoint_fingerprint text,checkpoint_image jsonb,ledger_image jsonb)
 JOIN sources cs ON cs.id=q.source_id AND cs.incarnation=q.incarnation AND NOT cs.archived
 JOIN pages ca ON ca.id=q.atom_id AND ca.source_id=q.source_id AND ca.type='atom' AND ca.deleted_at IS NULL AND ca.knowledge_revision=q.atom_revision
 JOIN pages cp ON cp.id=q.page_id AND cp.source_id=q.source_id AND cp.slug=q.page_slug AND cp.knowledge_revision=q.page_revision AND cp.content_hash=q.new_hash AND cp.deleted_at IS NULL AND cp.body_storage='inline' AND cp.source_path IS NOT DISTINCT FROM q.page_path
 JOIN page_versions cv ON cv.id=q.version_id AND cv.page_id=q.page_id AND ${oldVersionImageSql('cv')}=q.version_image
 JOIN op_checkpoints cc ON cc.op='managed-atoms' AND cc.fingerprint=q.checkpoint_fingerprint AND cc.completed_keys=q.checkpoint_image
 JOIN extract_atoms_page_state scan ON scan.source_incarnation=q.incarnation AND scan.page_id=q.page_id AND scan.content_hash=q.old_hash AND scan.tombstoned AND scan.fail_count=0 AND scan.partial_input_chars IS NULL
 WHERE ${controlLedgerImageSql('q.source_id','q.page_slug')}=q.ledger_image`;
}
export const controlPageExclusionSql=(parameter:string,alias='p')=>`AND NOT EXISTS (SELECT 1 FROM (${validControlRowsSql(parameter)}) cb WHERE cb.page_id=${alias}.id AND cb.source_id=${alias}.source_id AND cb.new_hash=${alias}.content_hash AND cb.page_revision=${alias}.knowledge_revision)`;
/** Pure equivalence: exactly one control field, flat bounded metadata, original quote offset untouched. */
export function validateControlImages(p:AtomControlProof,atom:any,old:any,current:any):boolean{
 if(old.page_id!==p.source_page_id||old.knowledge_revision!==p.source_version_revision||old.is_deleted!==false||old.body_storage!=='inline'||current.deleted_at!==null||(current.body_storage??'inline')!=='inline')return false;
 if(current.id!==p.source_page_id||current.slug!==p.source_slug||current.knowledge_revision!==p.current_revision||current.content_hash!==p.current_full_hash)return false;
 const of=old.frontmatter,cf=current.frontmatter;if(!of||!cf||Object.hasOwn(of,'facts_backstop')||cf.facts_backstop!==false)return false;
 if(p.frontmatter_order.slice().sort().join('\0')!==Object.keys(of).sort().join('\0')||Object.values(of).some(v=>v!==null&&typeof v==='object'))return false;
 const stripped={...cf};delete stripped.facts_backstop;
 if(stableJson(stripped)!==stableJson(of))return false;
 for(const field of ['compiled_truth','timeline','title','type'])if(old[field]!==current[field])return false;
 if(stableJson(old.tags??[])!==stableJson(current.tags??[])||(old.source_path??null)!==(current.source_path??null))return false;
 const ordered=Object.fromEntries(p.frontmatter_order.map(k=>[k,of[k]]));
 if(contentHash({title:old.title,type:old.type,compiled_truth:old.compiled_truth,timeline:old.timeline,frontmatter:ordered,tags:old.tags} as never)!==p.old_full_hash)return false;
 const fm=atom.frontmatter;if(fm?.managed_extraction!==true&&fm?.managed_extraction!=='true')return false;
 if(fm.source_slug!==p.source_slug||String(fm.source_hash??'').replace(/^pending:/,'')!==p.old_full_hash.slice(0,16))return false;
 if(fm.source_quote===undefined)return fm.source_quote_offset===undefined&&fm.source_quote_verified===undefined;
 const offset=fm.source_quote_offset;
 return typeof fm.source_quote==='string'&&fm.source_quote.length>0&&fm.source_quote.length<=1000&&fm.source_quote_verified===true&&Array.isArray(offset)&&offset.length===2&&offset.every(Number.isSafeInteger)&&offset[0]>=0&&offset[1]>offset[0]&&offset[1]<=old.compiled_truth.length&&old.compiled_truth.slice(offset[0],offset[1])===fm.source_quote;
}
/** Bounded and read-only. Missing proof is ordinary; database failures propagate rather than granting an exemption. */
export async function readControlBindings(db:BrainEngine,sourceIds?:readonly string[],opts:{signal?:AbortSignal}={}):Promise<ControlBinding[]>{
 const check=()=>opts.signal?.throwIfAborted();check();
 const query=async<T=any>(sql:string,params:unknown[]=[])=>{check();const rows=await db.executeRaw<T>(sql,params,{signal:opts.signal});check();return rows;};
 const atoms=await query<any>(`SELECT id,source_id,knowledge_revision,frontmatter FROM pages WHERE type='atom' AND deleted_at IS NULL AND octet_length(frontmatter::text)<=16384 AND frontmatter ? $1 AND ($2::text[] IS NULL OR source_id=ANY($2::text[])) ORDER BY id LIMIT 129`,[ATOM_CONTROL_EQUIVALENCE,sourceIds?.length?[...sourceIds]:null]);
 if(atoms.length>128)return [];const out:ControlBinding[]=[];
 for(const atom of atoms){check();const p=parseAtomControlProof(atom.frontmatter?.[ATOM_CONTROL_EQUIVALENCE]);if(!p||p.source_id!==atom.source_id)continue;
  const [source]=await query<any>('SELECT incarnation,archived FROM sources WHERE id=$1',[p.source_id]);if(!source||source.archived||source.incarnation!==p.source_incarnation)continue;
  const [old]=await query<any>(`SELECT v.*,${oldVersionImageSql('v')} AS image FROM page_versions v WHERE id=$1 AND page_id=$2 AND body_storage='inline' AND octet_length(compiled_truth)+octet_length(COALESCE(timeline,''))<=65536 AND octet_length(frontmatter::text)<=16384`,[p.source_version_id,p.source_page_id]);
  if(!old)continue;
  const [physical]=await query<any>("SELECT id FROM pages p WHERE p.id=$1 AND p.source_id=$2 AND p.knowledge_revision=$3::uuid AND p.content_hash=$4 AND p.body_storage='inline' AND octet_length(p.compiled_truth)+octet_length(COALESCE(p.timeline,''))<=65536 AND octet_length(p.frontmatter::text)<=16384",[p.source_page_id,p.source_id,p.current_revision,p.current_full_hash]);if(!physical)continue;
  const [ledger]=await query<any>(`SELECT ${controlLedgerImageSql('$1','$2')} AS image`,[p.source_id,p.source_slug]);if(ledger?.image==null)continue;
  // Bind the physical pins and caps to the same MVCC statement that returns
  // canonical content; a concurrent large edit must never cross the reader.
  const current=await readPageSnapshot(async<T>(sql:string,params:unknown[]=[]):Promise<T[]>=>{
   if(sql.startsWith('WITH chosen AS (')&&sql.includes(') SELECT p.*,')&&sql.includes('FROM chosen p\n')){const n=params.length;
    const bounded=`SELECT * FROM chosen_input WHERE id=$${n+1} AND source_id=$${n+2} AND knowledge_revision=$${n+3}::uuid AND content_hash=$${n+4}
     AND body_storage='inline' AND octet_length(compiled_truth)+octet_length(COALESCE(timeline,''))<=65536 AND octet_length(frontmatter::text)<=16384
     AND ${controlLedgerImageSql('source_id','slug')}=$${n+5}::text::jsonb`;
    // MATERIALIZED makes bounded eligibility precede the native lateral ledger
    // aggregate; the same MVCC snapshot rejects a ledger that grew meanwhile.
    sql=sql.replace('WITH chosen AS (','WITH chosen_input AS (').replace(') SELECT p.*,',`), chosen AS MATERIALIZED (${bounded}) SELECT p.*,`);
    return query<T>(sql,[...params,p.source_page_id,p.source_id,p.current_revision,p.current_full_hash,JSON.stringify(ledger.image)]);
   }
   if(/\bpages\b/i.test(sql))throw Error('Unsupported control snapshot query shape; bounded read refused.');
   return query<T>(sql,params);
  },p.source_slug,{sourceId:p.source_id});check();
  if(!current||!validateControlImages(p,atom,old,{...current.page,tags:current.tags}))continue;
  const [cp]=await query<any>("SELECT completed_keys FROM op_checkpoints WHERE op='managed-atoms' AND fingerprint=$1",[p.checkpoint_fingerprint]);const origin=cp?.completed_keys?.[0];
  if(!origin||origin.sourceId!==p.source_id||origin.incarnation!==p.source_incarnation||origin.kind!=='page'||origin.locator!==p.source_slug||Number(origin.pageId)!==p.source_page_id||origin.contentHash!==p.old_full_hash||origin.failure!=null||origin.held===true||origin.held==='true')continue;
  const scan=await query("SELECT page_id FROM extract_atoms_page_state WHERE source_incarnation=$1::uuid AND page_id=$2 AND content_hash=$3 AND tombstoned AND fail_count=0 AND partial_input_chars IS NULL",[p.source_incarnation,p.source_page_id,p.old_full_hash]);if(!scan.length)continue;
  out.push({atom_id:Number(atom.id),atom_revision:atom.knowledge_revision,source_id:p.source_id,incarnation:p.source_incarnation,page_id:p.source_page_id,page_slug:p.source_slug,page_revision:p.current_revision,page_path:current.page.source_path??null,new_hash:p.current_full_hash,old_hash:p.old_full_hash,version_id:p.source_version_id,version_image:old.image,checkpoint_fingerprint:p.checkpoint_fingerprint,checkpoint_image:cp.completed_keys,ledger_image:ledger.image});
 }
 return out;
}
