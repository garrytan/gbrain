import type { BrainEngine } from '../engine.ts';

export const SEARCH_WRITE_SCHEMA_SQL = `
DROP INDEX IF EXISTS idx_pages_compiled_truth_trgm;
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_source_check;
ALTER TABLE links ADD CONSTRAINT links_link_source_check CHECK(link_source IS NULL OR link_source IN ('markdown','wikilink-resolved','frontmatter','manual','mentions','concept-provenance'));
CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS $fn$
DECLARE timeline_text TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.title IS NOT DISTINCT FROM OLD.title
    AND NEW.compiled_truth IS NOT DISTINCT FROM OLD.compiled_truth
    AND NEW.timeline IS NOT DISTINCT FROM OLD.timeline THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '') INTO timeline_text
    FROM timeline_entries WHERE page_id = NEW.id;
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.compiled_truth, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.timeline, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(timeline_text, '')), 'C');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages;
CREATE TRIGGER trg_pages_search_vector
  BEFORE INSERT OR UPDATE OF title,compiled_truth,timeline ON pages
  FOR EACH ROW EXECUTE FUNCTION update_page_search_vector();
DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='pages'::regclass AND tgname='pages_knowledge_revision') THEN
    DROP TRIGGER pages_knowledge_revision ON pages;
    CREATE TRIGGER pages_knowledge_revision
      BEFORE UPDATE OF source_id,slug,type,page_kind,title,compiled_truth,timeline,frontmatter,deleted_at,knowledge_revision ON pages
      FOR EACH ROW EXECUTE FUNCTION gbrain_advance_page_revision();
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='pages'::regclass AND tgname='bump_page_generation_trg') THEN
    DROP TRIGGER bump_page_generation_trg ON pages;
    CREATE TRIGGER bump_page_generation_trg BEFORE INSERT OR UPDATE OF title,type,page_kind,compiled_truth,timeline,frontmatter,deleted_at,contextual_retrieval_mode,corpus_generation,content_hash ON pages
      FOR EACH ROW EXECUTE FUNCTION bump_page_generation_fn();
  END IF;
END $do$;
`;

export async function repairSearchWriteAmplification(engine: BrainEngine): Promise<void> {
  const [row]=await engine.executeRaw<{present:boolean}>("SELECT to_regclass('pages') IS NOT NULL AS present");
  if(!row?.present)return;
  await engine.transaction(async tx=>{await tx.runMigration(134,SEARCH_WRITE_SCHEMA_SQL);});
}
