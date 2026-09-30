/** Durable DB-only text rebuild work; source deletion cancels its old incarnation. */
export const PAGE_PROJECTION_SCHEMA_STATEMENTS = [
  // Metadata/embedding updates must preserve the explicitly sanitized vector.
  // Canonical body updates remain unsearchable until projection completion.
  `DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages`,
  `CREATE TRIGGER trg_pages_search_vector BEFORE INSERT OR UPDATE OF title,timeline ON pages
    FOR EACH ROW EXECUTE FUNCTION update_page_search_vector()`,
  `CREATE TABLE IF NOT EXISTS page_projection_jobs (
    source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    revision UUID NOT NULL,
    reason TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(source_incarnation,slug)
  )`,
  `CREATE OR REPLACE FUNCTION gbrain_queue_page_projection() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE incarnation UUID;
    BEGIN
      IF TG_OP='DELETE' THEN
        DELETE FROM page_projection_jobs j USING sources s
          WHERE s.id=OLD.source_id AND j.source_incarnation=s.incarnation AND j.slug=OLD.slug;
        RETURN NULL;
      END IF;
      IF TG_OP='UPDATE' AND (OLD.source_id,OLD.slug) IS DISTINCT FROM (NEW.source_id,NEW.slug) THEN
        DELETE FROM page_projection_jobs j USING sources s
          WHERE s.id=OLD.source_id AND j.source_incarnation=s.incarnation AND j.slug=OLD.slug;
      END IF;
      SELECT s.incarnation INTO incarnation FROM sources s WHERE s.id=NEW.source_id;
      IF NEW.deleted_at IS NOT NULL OR NEW.text_projection_revision=NEW.knowledge_revision THEN
        DELETE FROM page_projection_jobs j WHERE j.source_incarnation=incarnation AND j.slug=NEW.slug;
      ELSIF TG_OP='INSERT' OR NEW.knowledge_revision IS DISTINCT FROM OLD.knowledge_revision THEN
        INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
          VALUES (incarnation,NEW.slug,NEW.knowledge_revision,'canonical_change')
          ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now();
      END IF;
      RETURN NULL;
    END $fn$`,
  `DROP TRIGGER IF EXISTS pages_projection_queue ON pages`,
  `CREATE TRIGGER pages_projection_queue AFTER INSERT OR UPDATE OR DELETE ON pages
    FOR EACH ROW EXECUTE FUNCTION gbrain_queue_page_projection()`,
] as const;
export const PAGE_PROJECTION_SCHEMA_SQL = PAGE_PROJECTION_SCHEMA_STATEMENTS.join(';\n') + ';\n';

/** Run once at protocol activation, never on schema replay: old indexes are unverified. */
export const PAGE_PROJECTION_ACTIVATION_SQL = `
  UPDATE pages SET text_projection_revision=NULL,embedding_signature=NULL;
  INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,'protocol_activation'
    FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.deleted_at IS NULL
    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,
      reason=EXCLUDED.reason,updated_at=now();
`;
