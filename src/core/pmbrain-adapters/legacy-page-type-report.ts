import type { BrainEngine } from '../engine.ts';
export async function reportLegacyPageTypes(engine: Pick<BrainEngine,'executeRaw'>, sourceId?: string) {
  const rows=await engine.executeRaw<{source_id:string;slug:string;title:string;type:string;authored_type:string|null;generated:string|null;content_hash:string|null}>(
    `SELECT source_id,slug,title,type,frontmatter->>'type' AS authored_type,frontmatter->>'dream_generated' AS generated,content_hash
       FROM pages WHERE deleted_at IS NULL AND type='concept' AND ($1::text IS NULL OR source_id=$1) ORDER BY source_id,slug`,[sourceId ?? null]);
  const candidates=rows.filter(row=>!row.authored_type && row.generated!=='true' && !/^(?:concepts|projects)\//.test(row.slug));
  return {mode:'read_only',concept_pages:rows.length,candidates:candidates.map(row=>({...row,reason:'未记录原始类型，且不在概念/项目目录；需要核对原文，不能据此自动改成 note'}))};
}
