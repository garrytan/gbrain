import { requireMaintainerPoliciesSql } from '../derived-state-maintainers.ts';
import { ACTIVATION_SERVED_REVISION, protectedTextFilter, SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { currentProjectionReasonSql, PROJECTION_OVERRIDE_SETTING } from './projection-policy-sql.ts';

/**
 * The page search-vector trigger fires on the columns its function reads:
 * title, timeline and, once migration v248 added it, the segmented page's
 * timeline_lead (a purge or flip that rewrites only the lead re-indexes it).
 */
export const PAGE_SEARCH_VECTOR_TRIGGER_SQL = `DO $trg$ BEGIN
    EXECUTE format('CREATE TRIGGER trg_pages_search_vector BEFORE INSERT OR UPDATE OF %s ON pages FOR EACH ROW EXECUTE FUNCTION update_page_search_vector()',
      CASE WHEN EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'pages'::regclass AND attname = 'timeline_lead' AND NOT attisdropped)
        THEN 'title,timeline,timeline_lead' ELSE 'title,timeline' END);
  END $trg$`;

const dropsJobs = requireMaintainerPoliciesSql('page_projection_jobs', ['SELECT', 'DELETE'], '        ');
/** Queues a page's text rebuild by source incarnation; under RLS the writer needs sources and the queue (#7637). */
export const PAGE_PROJECTION_QUEUE_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION gbrain_queue_page_projection() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
    DECLARE incarnation UUID; prior_reason TEXT; old_reason TEXT; held BOOLEAN := false; current_only BOOLEAN := false;
    BEGIN
      ${requireMaintainerPoliciesSql('sources', ['SELECT'], '      ')}
      IF TG_OP='DELETE' THEN
        ${dropsJobs}
        DELETE FROM page_projection_jobs j USING sources s
          WHERE s.id=OLD.source_id AND j.source_incarnation=s.incarnation AND j.slug=OLD.slug;
        RETURN NULL;
      END IF;
      IF to_regclass('public.config') IS NOT NULL THEN
        SELECT COALESCE((SELECT value='true' FROM config WHERE key='embed.current_projections_only'),false)
          AND COALESCE(current_setting('${PROJECTION_OVERRIDE_SETTING}',true),'')<>'false' INTO current_only;
      END IF;
      IF TG_OP='UPDATE' AND current_only THEN
        ${requireMaintainerPoliciesSql('page_projection_jobs', ['SELECT'], '        ')}
        SELECT j.reason INTO old_reason FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation
          WHERE s.id=OLD.source_id AND j.slug=OLD.slug;
        IF old_reason IS NULL AND (COALESCE((to_jsonb(OLD)->>'chunker_version')::int,0)<${SAFE_FENCE_CHUNKER_VERSION}
          OR OLD.text_projection_revision IS DISTINCT FROM OLD.knowledge_revision) THEN
          old_reason := 'legacy_projection';
        END IF;
      END IF;
      IF TG_OP='UPDATE' AND (OLD.source_id,OLD.slug) IS DISTINCT FROM (NEW.source_id,NEW.slug) THEN
        ${dropsJobs}
        DELETE FROM page_projection_jobs j USING sources s
          WHERE s.id=OLD.source_id AND j.source_incarnation=s.incarnation AND j.slug=OLD.slug;
      END IF;
      SELECT s.incarnation INTO incarnation FROM sources s WHERE s.id=NEW.source_id;
      IF current_only THEN
        ${requireMaintainerPoliciesSql('page_projection_jobs', ['SELECT'], '        ')}
        SELECT j.reason INTO prior_reason FROM page_projection_jobs j WHERE j.source_incarnation=incarnation AND j.slug=NEW.slug;
        prior_reason := COALESCE(prior_reason,old_reason);
        held := prior_reason IS NOT NULL AND NOT ${currentProjectionReasonSql('prior_reason')};
      END IF;
      IF NEW.deleted_at IS NOT NULL THEN
        ${dropsJobs}
        DELETE FROM page_projection_jobs j WHERE j.source_incarnation=incarnation AND j.slug=NEW.slug;
      ELSIF NEW.text_projection_revision=NEW.knowledge_revision THEN
        IF held THEN
          IF TG_OP='INSERT' OR OLD.text_projection_revision IS DISTINCT FROM OLD.knowledge_revision
            OR OLD.knowledge_revision IS DISTINCT FROM NEW.knowledge_revision
            OR (COALESCE((to_jsonb(OLD)->>'chunker_version')::int,0)<${SAFE_FENCE_CHUNKER_VERSION}
              AND COALESCE((to_jsonb(NEW)->>'chunker_version')::int,0)>=${SAFE_FENCE_CHUNKER_VERSION}) THEN
            RAISE EXCEPTION 'historical_projection_held: historical text requires an authorized rebuild' USING ERRCODE='55000';
          END IF;
        ELSE
          ${dropsJobs}
          DELETE FROM page_projection_jobs j WHERE j.source_incarnation=incarnation AND j.slug=NEW.slug;
        END IF;
      ELSIF TG_OP='INSERT' OR NEW.knowledge_revision IS DISTINCT FROM OLD.knowledge_revision THEN
        ${requireMaintainerPoliciesSql('page_projection_jobs', ['SELECT', 'INSERT', 'UPDATE'], '        ')}
        INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
          VALUES (incarnation,NEW.slug,NEW.knowledge_revision,CASE WHEN held THEN prior_reason ELSE 'canonical_change' END)
          ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now();
      END IF;
      RETURN NULL;
    END $fn$`;

/** Durable DB-only text rebuild work; source deletion cancels its old incarnation. */
export const PAGE_PROJECTION_SCHEMA_STATEMENTS = [
  // Metadata/embedding updates must preserve the explicitly sanitized vector.
  // Canonical body updates remain unsearchable until projection completion.
  `DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages`,
  PAGE_SEARCH_VECTOR_TRIGGER_SQL,
  `CREATE TABLE IF NOT EXISTS page_projection_jobs (
    source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    revision UUID NOT NULL,
    reason TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(source_incarnation,slug)
  )`,
  PAGE_PROJECTION_QUEUE_FUNCTION_SQL,
  `DROP TRIGGER IF EXISTS pages_projection_queue ON pages`,
  `CREATE TRIGGER pages_projection_queue AFTER INSERT OR UPDATE OR DELETE ON pages
    FOR EACH ROW EXECUTE FUNCTION gbrain_queue_page_projection()`,
] as const;
export const PAGE_PROJECTION_SCHEMA_SQL = PAGE_PROJECTION_SCHEMA_STATEMENTS.join(';\n') + ';\n';

/**
 * Run once at protocol activation, never on schema replay: old indexes are unverified, so every page is queued for a
 * rebuild. #9192: a Markdown or code page indexed at or after the safe-chunk fence keeps serving that index until its
 * rebuild (ACTIVATION_SERVED_REVISION) when nothing the rebuild's projection removes can be in it: no facts or takes
 * fence (withdrawn, held, purged and lower-tier rows), no private-key text (credential-safe projection) and no
 * quarantine marker. Every other page waits for the drain. A page written before v150 gets its first revision in its
 * own statement, whose trigger clears text_projection_revision.
 */
export const PAGE_PROJECTION_ACTIVATION_SQL = `
  UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE knowledge_revision IS NULL;
  UPDATE pages SET text_projection_revision=CASE WHEN deleted_at IS NULL AND page_kind IN ('markdown','code')
      AND chunker_version >= ${SAFE_FENCE_CHUNKER_VERSION}
      AND NOT (${protectedTextFilter('compiled_truth')} OR ${protectedTextFilter('timeline')})
      AND strpos(compiled_truth || COALESCE(timeline,''),'PRIVATE KEY-----') = 0
      AND NOT (COALESCE(frontmatter,'{}'::jsonb) ? 'quarantine')
    THEN '${ACTIVATION_SERVED_REVISION}'::uuid END,embedding_signature=NULL;
  INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,'protocol_activation'
    FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.deleted_at IS NULL
    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,
      reason=EXCLUDED.reason,updated_at=now();
`;
