/** Defense in depth for inventoried legacy writers. Manual SQL is outside the protocol. */
export const MANAGED_WRITER_GUARD_SQL = `
CREATE OR REPLACE FUNCTION gbrain_require_managed_writer() RETURNS trigger LANGUAGE plpgsql AS $fn$
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
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: source checkpoints require canonical owner publication';
      END IF;
      RETURN NEW;
    END IF;
    IF COALESCE(current_setting('gbrain.topology_change',true),'') <> 'on' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: source topology must be drained and changed through writer administration';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME IN ('facts','takes') AND TG_OP='UPDATE' THEN
    -- Embedding completion and retrieval telemetry are physical projections.
    IF (row_data - ARRAY['embedding','embedded_at','last_retrieved_at','retrieval_count','updated_at'])
      = (old_data - ARRAY['embedding','embedded_at','last_retrieved_at','retrieval_count','updated_at']) THEN RETURN NEW; END IF;
  END IF;
  IF row_data ? 'source_id' THEN target_source := row_data->>'source_id';
  ELSE SELECT source_id INTO target_source FROM pages WHERE id=(row_data->>'page_id')::integer; END IF;
  IF TG_OP='UPDATE' THEN
    IF old_data ? 'source_id' THEN old_source := old_data->>'source_id';
    ELSE SELECT source_id INTO old_source FROM pages WHERE id=(old_data->>'page_id')::integer; END IF;
  END IF;
  -- Cascaded projection removal after the already-guarded parent deletion.
  IF target_source IS NULL AND TG_OP='DELETE' THEN RETURN OLD; END IF;
  allowed := COALESCE(NULLIF(current_setting('gbrain.write_sources',true),''),'[]')::jsonb;
  IF target_source IS NULL OR NOT (allowed ? target_source) OR (old_source IS NOT NULL AND NOT (allowed ? old_source)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: canonical writer must use the persistence coordinator';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $fn$;
DO $body$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['pages','tags','slug_aliases','page_aliases','facts','takes','timeline_entries','sources'] LOOP
    IF to_regclass(target) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS managed_writer_guard ON %I',target);
      EXECUTE format('CREATE TRIGGER managed_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION gbrain_require_managed_writer()',target);
    END IF;
  END LOOP;
END $body$;
`;
