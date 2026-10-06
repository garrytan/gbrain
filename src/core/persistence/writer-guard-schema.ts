import { ROW_ATTRIBUTION_COLUMNS } from './attribution-schema.ts';
const ROW_ATTRIBUTION_KEYS = `ARRAY[${ROW_ATTRIBUTION_COLUMNS.map(column => `'${column}'`).join(',')}]`;
/** Guarded tables with no canonical source_id: their source is always their page's (#5983). */
export const PAGE_CHILD_TABLES = ['tags', 'timeline_entries', 'takes'];
export const GUARDED_TABLES = ['pages', 'tags', 'slug_aliases', 'page_aliases', 'facts', 'takes', 'timeline_entries', 'sources'];
const sqlList = (names: string[]) => names.map(name => `'${name}'`).join(',');
/** The guard function alone: replacing it takes no table lock (v197). */
export const MANAGED_WRITER_GUARD_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION gbrain_require_managed_writer() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE target_source text; old_source text; row_data jsonb; old_data jsonb; allowed jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM persistence_brain WHERE singleton=1 AND enabled) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_OP='UPDATE' THEN old_data := to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='pages' AND TG_OP='UPDATE' THEN
    IF (NEW.source_id,NEW.slug,NEW.type,NEW.page_kind,NEW.title,NEW.compiled_truth,NEW.timeline,NEW.frontmatter,NEW.deleted_at,NEW.knowledge_revision)
      IS NOT DISTINCT FROM
       (OLD.source_id,OLD.slug,OLD.type,OLD.page_kind,OLD.title,OLD.compiled_truth,OLD.timeline,OLD.frontmatter,OLD.deleted_at,OLD.knowledge_revision) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='sources' THEN
    IF TG_OP='UPDATE' AND (NEW.id,NEW.incarnation,NEW.local_path,NEW.archived)
      IS NOT DISTINCT FROM (OLD.id,OLD.incarnation,OLD.local_path,OLD.archived) THEN
      IF (NEW.last_commit,NEW.last_sync_at,NEW.newest_content_at)
        IS NOT DISTINCT FROM (OLD.last_commit,OLD.last_sync_at,OLD.newest_content_at) THEN RETURN NEW; END IF;
      allowed := COALESCE(NULLIF(current_setting('gbrain.write_sources',true),''),'[]')::jsonb;
      IF NOT (allowed ? NEW.id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: source checkpoints require canonical owner publication',
          TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='managed_writer_guard:checkpoint',
          DETAIL=jsonb_build_object('op',TG_OP,'relationship','checkpoint_outside_owner','target_source',NEW.id,'old_source',OLD.id,'allowed',allowed)::text;
      END IF;
      RETURN NEW;
    END IF;
    IF COALESCE(current_setting('gbrain.topology_change',true),'') <> 'on' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: source topology must be drained and changed through writer administration',
        TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='managed_writer_guard:topology',
        DETAIL=jsonb_build_object('op',TG_OP,'relationship','topology_outside_administration','target_source',row_data->>'id','old_source',old_data->>'id')::text;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME IN ('facts','takes') AND TG_OP='UPDATE' THEN
    row_data := row_data - ARRAY['embedding_model','embedded_text_hash'] - ${ROW_ATTRIBUTION_KEYS};
    old_data := old_data - ARRAY['embedding_model','embedded_text_hash'] - ${ROW_ATTRIBUTION_KEYS};
    -- Embedding completion, retrieval telemetry and write attribution
    -- (attribution-schema.ts; a journal backfill fills it) are physical projections.
    IF (row_data - ARRAY['embedding','embedded_at','last_retrieved_at','retrieval_count','updated_at'])
      = (old_data - ARRAY['embedding','embedded_at','last_retrieved_at','retrieval_count','updated_at']) THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME NOT IN (${sqlList(PAGE_CHILD_TABLES)}) THEN
    target_source := row_data->>'source_id'; old_source := old_data->>'source_id';
  END IF;
  IF target_source IS NULL THEN SELECT source_id INTO target_source FROM pages WHERE id=(row_data->>'page_id')::integer; END IF;
  IF TG_OP='UPDATE' AND old_source IS NULL THEN
    SELECT source_id INTO old_source FROM pages WHERE id=(old_data->>'page_id')::integer;
  END IF;
  -- Cascaded projection removal after the already-guarded parent deletion.
  IF target_source IS NULL AND TG_OP='DELETE' THEN RETURN OLD; END IF;
  allowed := COALESCE(NULLIF(current_setting('gbrain.write_sources',true),''),'[]')::jsonb;
  IF target_source IS NULL OR NOT (allowed ? target_source) OR (old_source IS NOT NULL AND NOT (allowed ? old_source)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: canonical writer must use the persistence coordinator',
      TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='managed_writer_guard:allowlist',
      DETAIL=jsonb_build_object('op',TG_OP,'relationship',CASE WHEN target_source IS NULL THEN 'missing_source'
        WHEN NOT (allowed ? target_source) THEN 'different_source' ELSE 'old_source_outside' END,
        'target_source',target_source,'old_source',old_source,'allowed',allowed)::text;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $fn$;
`;
/** Defense in depth for inventoried legacy writers. Manual SQL is outside the protocol. */
export const MANAGED_WRITER_GUARD_SQL = `${MANAGED_WRITER_GUARD_FUNCTION_SQL}
DO $body$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[${sqlList(GUARDED_TABLES)}] LOOP
    IF to_regclass(target) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS managed_writer_guard ON %I',target);
      EXECUTE format('CREATE TRIGGER managed_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION gbrain_require_managed_writer()',target);
    END IF;
  END LOOP;
END $body$;
`;
