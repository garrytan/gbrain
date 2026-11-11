import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-2462 (D2): page rules. A folder rule (v283) can't name a page at the root
// of a source, and put_page can't tighten a page whose file left git outside
// the write door, so such a page could not be restricted at all. A page rule
// names one exact slug (slug: in .gbrain/access.yml, --slug on gbrain access
// rule add) and is stored in access_rules.prefix without the trailing '/'.
// This widens both prefix checks to accept that form and makes the rule and
// pending-coverage matchers cover a slash-less prefix only when it equals the
// slug (the SQL twin of folder-rules.ts ruleCovers). Folder prefixes match as
// before, so no stamp changes on upgrade; nothing is rewritten. Reads are
// decided here, so an older binary sharing the database keeps the page
// restricted; its rule commands and its sync of a git-backed source refuse the
// stored rulebook until it is upgraded (fail closed). No schema.sql mirror: like v283, these exist only through
// migrations. Provisional number: renumbered at the merge slot.
const FOLDER_OR_PAGE = "(length(prefix) <= 512 AND prefix ~ '^(([a-z0-9][a-z0-9._-]*/)+|([a-z0-9][a-z0-9._-]*/)*[a-z0-9][a-z0-9._-]*)$' AND position('..' in prefix) = 0)";

export const v303: Migration = {
  version: 303,
  name: 'access_page_rules',
  idempotent: true,
  sql: `
ALTER TABLE access_rules DROP CONSTRAINT IF EXISTS access_rules_prefix_check;
ALTER TABLE access_rules ADD CONSTRAINT access_rules_prefix_check CHECK ${FOLDER_OR_PAGE};
ALTER TABLE access_pending_coverage DROP CONSTRAINT IF EXISTS access_pending_coverage_prefix_check;
ALTER TABLE access_pending_coverage ADD CONSTRAINT access_pending_coverage_prefix_check CHECK (prefix = '' OR ${FOLDER_OR_PAGE});
CREATE OR REPLACE FUNCTION gbrain_access_folder_rules(p_source TEXT, p_slug TEXT) RETURNS TEXT[]
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT array_agg(p_source || ':' || r.rule_id ORDER BY r.rule_id COLLATE "C")
    FROM access_rules r WHERE r.source_id = p_source AND starts_with(p_slug, r.prefix) AND (right(r.prefix, 1) = '/' OR p_slug = r.prefix)
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_pending_covers(p_source TEXT, p_slug TEXT) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM access_pending_coverage c WHERE c.source_id = p_source AND starts_with(p_slug, c.prefix)
    AND (c.prefix = '' OR right(c.prefix, 1) = '/' OR p_slug = c.prefix))
$fn$;
`,
};
