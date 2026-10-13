import type { BrainEngine } from '../engine';
import type { SearchResult, Page } from '../types';

export function managedMemoryPageSql(alias: string): string {
  return `(${alias}.frontmatter->>'pmbrain_memory'='true'
    AND ${alias}.slug LIKE 'conversations/pmbrain/%'
    AND split_part(${alias}.slug,'/',3)=split_part(${alias}.frontmatter->>'source_ref','/',4)
    AND split_part(${alias}.frontmatter->>'source_ref','/',5)~'^[a-zA-Z0-9_-]+$'
    AND ${alias}.frontmatter->>'id'~('^'||split_part(${alias}.frontmatter->>'source_ref','/',5)||'-[a-f0-9]{64}$')
    AND ${alias}.frontmatter->>'source_ref'='pmbrain://conversations/'||split_part(${alias}.slug,'/',3)||'/'||split_part(${alias}.frontmatter->>'source_ref','/',5)) IS TRUE`;
}

export function currentMemoryPageSql(alias: string): string {
  const ids = `CASE WHEN jsonb_typeof(${alias}.frontmatter->'pmbrain_memory_fact_ids')='array' THEN ${alias}.frontmatter->'pmbrain_memory_fact_ids'
    ELSE COALESCE((SELECT jsonb_agg(legacy_memory_fact.id) FROM facts legacy_memory_fact
      WHERE legacy_memory_fact.source_id=${alias}.source_id AND legacy_memory_fact.source LIKE 'PMBrain 知识助手 / %'
        AND legacy_memory_fact.context LIKE '%"sourceSlug":"'||${alias}.slug||'"%'),'[]'::jsonb) END`;
  return `(CASE WHEN ${managedMemoryPageSql(alias)} THEN (jsonb_array_length(${ids})>0 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${ids}) memory_id(value)
    WHERE NOT EXISTS (SELECT 1 FROM facts memory_fact
      WHERE memory_fact.id=CASE WHEN memory_id.value~'^[0-9]{1,18}$' THEN memory_id.value::bigint END
        AND memory_fact.source_id=${alias}.source_id AND memory_fact.expired_at IS NULL
        AND (memory_fact.valid_until IS NULL OR memory_fact.valid_until>now())
        AND (memory_fact.visibility='world' OR ${alias}.frontmatter->>'visibility'='private')))) ELSE TRUE END)`;
}

export async function memoryPageIsCurrent(engine: BrainEngine, page: Page): Promise<boolean> {
  if (!page.slug.startsWith('conversations/pmbrain/') || page.frontmatter.pmbrain_memory !== true) return true;
  return (await engine.executeRaw(`SELECT id FROM pages p WHERE p.id=$1 AND ${currentMemoryPageSql('p')}`, [page.id])).length>0;
}

export async function memoryPageFilterForSchema(engine: BrainEngine, alias: string): Promise<string> {
  const [schema] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('facts') IS NOT NULL AS present");
  return schema.present ? currentMemoryPageSql(alias) : 'TRUE';
}

export async function filterCurrentMemoryHits(engine: BrainEngine, results: SearchResult[]): Promise<SearchResult[]> {
  const native = results.filter(row => row.slug.startsWith('conversations/pmbrain/'));
  if (!native.length) return results;
  const rows = await engine.executeRaw<{ slug: string; source_id: string }>(`SELECT p.slug,p.source_id FROM pages p
    WHERE p.slug=ANY($1::text[]) AND p.deleted_at IS NULL AND ${currentMemoryPageSql('p')}`, [native.map(row => row.slug)]);
  const current = new Set(rows.map(row => JSON.stringify([row.source_id,row.slug])));
  return results.filter(row => !row.slug.startsWith('conversations/pmbrain/') || current.has(JSON.stringify([row.source_id,row.slug])));
}

export const MEMORY_TAKE_PREFIX = 'pmbrain:memory-fact:';
export function legacyMemoryTakeSql(take: string, page: string): string {
  return `(${take}.kind='fact' AND ${take}.holder='self'
    AND ${take}.source~'^[a-f0-9-]{36}(,[a-f0-9-]{36})*$'
    AND 2<=(SELECT count(*) FROM facts legacy_take_fact WHERE legacy_take_fact.consolidated_into=${take}.id
      AND legacy_take_fact.source_id=${page}.source_id AND legacy_take_fact.entity_slug=${page}.slug)
    AND NOT EXISTS (SELECT 1 FROM facts legacy_take_fact WHERE legacy_take_fact.consolidated_into=${take}.id
      AND legacy_take_fact.source_id=${page}.source_id AND legacy_take_fact.entity_slug=${page}.slug
      AND (legacy_take_fact.source NOT LIKE 'PMBrain 知识助手 / %' OR legacy_take_fact.source_session IS NULL
        OR NOT (legacy_take_fact.source_session=ANY(string_to_array(${take}.source,','))) OR legacy_take_fact.created_at>${take}.created_at))
    AND NOT EXISTS (SELECT 1 FROM unnest(string_to_array(${take}.source,',')) legacy_session(value)
      WHERE NOT EXISTS (SELECT 1 FROM facts legacy_take_fact WHERE legacy_take_fact.consolidated_into=${take}.id
        AND legacy_take_fact.source_id=${page}.source_id AND legacy_take_fact.entity_slug=${page}.slug AND legacy_take_fact.source_session=legacy_session.value)))`;
}
export function currentMemoryTakeSql(take: string, page: string): string {
  return `((COALESCE(${take}.source,'') NOT LIKE '${MEMORY_TAKE_PREFIX}%' AND NOT (${legacyMemoryTakeSql(take,page)})) OR EXISTS (
    SELECT 1 FROM facts memory_take_fact WHERE memory_take_fact.id=CASE
      WHEN substring(${take}.source FROM ${MEMORY_TAKE_PREFIX.length + 1})~'^[0-9]{1,18}$' THEN substring(${take}.source FROM ${MEMORY_TAKE_PREFIX.length + 1})::bigint END
      AND memory_take_fact.source_id=${page}.source_id AND memory_take_fact.fact=${take}.claim
      AND memory_take_fact.visibility='world' AND memory_take_fact.expired_at IS NULL
      AND (memory_take_fact.valid_until IS NULL OR memory_take_fact.valid_until>now()))
    OR (${legacyMemoryTakeSql(take,page)} AND EXISTS (SELECT 1 FROM facts legacy_live_fact
      WHERE legacy_live_fact.consolidated_into=${take}.id AND legacy_live_fact.source_id=${page}.source_id
        AND legacy_live_fact.entity_slug=${page}.slug AND legacy_live_fact.fact=${take}.claim AND legacy_live_fact.visibility='world'
        AND legacy_live_fact.expired_at IS NULL AND (legacy_live_fact.valid_until IS NULL OR legacy_live_fact.valid_until>now()))))`;
}

export async function retireInvalidMemoryTakes(engine: BrainEngine, sourceId?: string): Promise<void> {
  await engine.executeRaw(`UPDATE takes t SET active=false, updated_at=now() FROM pages p
    WHERE p.id=t.page_id AND t.active AND t.resolved_at IS NULL
      AND (t.source LIKE '${MEMORY_TAKE_PREFIX}%' OR ${legacyMemoryTakeSql('t','p')}) AND NOT (${currentMemoryTakeSql('t','p')})
      ${sourceId ? 'AND p.source_id=$1' : ''}`, sourceId ? [sourceId] : []);
}
