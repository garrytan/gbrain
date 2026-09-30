/** NULL marks a legacy snapshot whose deletion state was not recorded. */
export const PAGE_VERSION_DELETION_SCHEMA_SQL = `ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN;`;

/** Shared by migration 150 and both schema blobs. Statements stay idempotent. */
export const PAGE_STATE_SCHEMA_STATEMENTS = [
  `ALTER TABLE sources ADD COLUMN IF NOT EXISTS incarnation UUID NOT NULL DEFAULT gen_random_uuid()`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sources_incarnation_key ON sources(incarnation)`,
  `ALTER TABLE pages ADD COLUMN IF NOT EXISTS knowledge_revision UUID NOT NULL DEFAULT gen_random_uuid()`,
  `ALTER TABLE pages ADD COLUMN IF NOT EXISTS text_projection_revision UUID`,
  `ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS knowledge_revision UUID`,
  `ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS timeline TEXT`,
  `ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS title TEXT`,
  `ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS type TEXT`,
  `ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS tags JSONB`,
  PAGE_VERSION_DELETION_SCHEMA_SQL,
  `CREATE TABLE IF NOT EXISTS page_write_guards (
    source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    PRIMARY KEY (source_incarnation, slug)
  )`,
  `CREATE OR REPLACE FUNCTION gbrain_advance_page_revision() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF (NEW.source_id, NEW.slug, NEW.type, NEW.page_kind, NEW.title, NEW.compiled_truth,
          NEW.timeline, NEW.frontmatter, NEW.deleted_at)
         IS DISTINCT FROM
         (OLD.source_id, OLD.slug, OLD.type, OLD.page_kind, OLD.title, OLD.compiled_truth,
          OLD.timeline, OLD.frontmatter, OLD.deleted_at) THEN
        IF NEW.knowledge_revision = OLD.knowledge_revision AND NOT (
          COALESCE(current_setting('gbrain.materializing_revision', true), '') = OLD.knowledge_revision::text
          AND (NEW.source_id, NEW.slug, NEW.type, NEW.page_kind, NEW.title, NEW.frontmatter, NEW.deleted_at)
            IS NOT DISTINCT FROM
            (OLD.source_id, OLD.slug, OLD.type, OLD.page_kind, OLD.title, OLD.frontmatter, OLD.deleted_at)
        ) THEN
          NEW.knowledge_revision := gen_random_uuid();
        END IF;
      END IF;
      IF NEW.knowledge_revision IS DISTINCT FROM OLD.knowledge_revision THEN
        NEW.text_projection_revision := NULL;
      END IF;
      RETURN NEW;
    END $fn$`,
  `DROP TRIGGER IF EXISTS pages_knowledge_revision ON pages`,
  `CREATE TRIGGER pages_knowledge_revision BEFORE UPDATE ON pages
    FOR EACH ROW EXECUTE FUNCTION gbrain_advance_page_revision()`,
  `CREATE OR REPLACE FUNCTION gbrain_advance_tag_revision() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'UPDATE' AND (NEW.page_id, NEW.tag) IS NOT DISTINCT FROM (OLD.page_id, OLD.tag) THEN
        RETURN NULL;
      END IF;
      IF TG_OP <> 'INSERT' THEN
        UPDATE pages SET knowledge_revision = gen_random_uuid() WHERE id = OLD.page_id;
      END IF;
      IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR (NEW.page_id, NEW.tag) IS DISTINCT FROM (OLD.page_id, OLD.tag)) THEN
        UPDATE pages SET knowledge_revision = gen_random_uuid() WHERE id = NEW.page_id;
      END IF;
      RETURN NULL;
    END $fn$`,
  `DROP TRIGGER IF EXISTS tags_knowledge_revision ON tags`,
  `CREATE TRIGGER tags_knowledge_revision AFTER INSERT OR DELETE OR UPDATE ON tags
    FOR EACH ROW EXECUTE FUNCTION gbrain_advance_tag_revision()`,
] as const;

export const PAGE_STATE_SCHEMA_SQL = PAGE_STATE_SCHEMA_STATEMENTS.join(';\n') + ';\n';
