/**
 * The statement texts the conversation publication and relink callers sent through `executeRaw` at base commit 5e22f0c134,
 * copied verbatim (helpers such as outcomeMarkerSql, unbackedEntitySql and retiredPageSql already resolved to their text).
 * test/facts-conversation-sites-sql-pin.test.ts holds the typed members (src/core/engine-sql/facts-conversation.ts) to them.
 * Generated once from the base commit; never regenerate from the current helpers, or the pin only compares them with themselves.
 * One intended change since: listPurgeTombstoneMatches also matches gbrain_fact_fingerprint_v2 (migration v353, fact fingerprint v3).
 */
export const BASE_SQL: Record<string, string> = {
  readNewestConversationFactId: "SELECT max(id) AS id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND source LIKE 'cli:extract-conversation-facts%'",
  findSpentConversationRequest: "SELECT request_id::text AS request_id FROM persistence_requests\n      WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid AND (digest<>$4 OR (compacted AND state<>'committed'))",
  listConversationBatchRequests: "SELECT r.id::text AS id, r.request_id::text AS request_id, r.state, r.error_code,\n            (SELECT jsonb_agg(jsonb_build_object('generation', p->>'generation', 'attempt', (p->>'attempt')::int)) FROM jsonb_array_elements(r.intent->'pages') p) AS members\n       FROM persistence_requests r\n      WHERE r.principal_kind=$1 AND r.principal_id=$2 AND r.source_id=$3 AND r.slug=$4 AND r.operation='submit_job'\n        AND r.state<>'committed' AND NOT r.compacted\n      ORDER BY r.sequence",
  readStoredConversationEntry: "SELECT p AS entry FROM persistence_requests r, jsonb_array_elements(r.intent->'pages') p\n    WHERE r.id=$1::uuid AND NOT r.compacted AND p->>'generation'=$2 LIMIT 1",
  readPrincipalCounters: "SELECT outstanding_count, terminal_bytes, lifetime_ids FROM persistence_counters WHERE key=$1",
  countConversationPagesToExtract: "SELECT count(*)::int AS n FROM pages p\n    WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.type=ANY($2::text[])\n      AND ($3::boolean OR NOT EXISTS (SELECT 1 FROM facts f WHERE f.source_id=p.source_id AND f.source_markdown_slug=p.slug\n        AND f.source LIKE 'cli:extract-conversation-facts%' AND f.source IN ($4,$5) AND f.expired_at IS NULL))",
  listMergedEntityAliases: "SELECT a.alias_slug, a.canonical_slug FROM slug_aliases a\n    WHERE a.source_id=$1 AND a.alias_slug=ANY($2::text[])\n      AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=a.alias_slug AND p.deleted_at IS NULL)\n      AND EXISTS (SELECT 1 FROM pages c WHERE c.source_id=a.source_id AND c.slug=a.canonical_slug AND c.deleted_at IS NULL)",
  moveConversationSourceWindows: "UPDATE facts f SET source_window = r.w FROM jsonb_to_recordset($3::text::jsonb) AS r(k text, w jsonb)\n    WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.source LIKE 'cli:extract-conversation-facts%' AND (f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha') = r.k",
  stampConversationSourceWindows: "UPDATE facts f SET source_window = r.w FROM jsonb_to_recordset($1::text::jsonb) AS r(id bigint, w jsonb) WHERE f.id = r.id",
  countActiveConversationFacts: "SELECT count(*)::int AS n FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2\n    AND f.source LIKE 'cli:extract-conversation-facts%' AND f.expired_at IS NULL AND NOT (f.source = ANY($3::text[]))",
  readConversationSlotValueHash: "SELECT value_hash FROM facts\n      WHERE source_id=$1 AND entity_slug=$2 AND dimension=$3 AND value_hash IS NOT NULL AND expired_at IS NULL AND superseded_by IS NULL AND COALESCE(source, '') LIKE 'cli:extract-conversation-facts%'\n        AND valid_from <= $4::timestamptz ORDER BY valid_from DESC, id DESC LIMIT 1",
  deleteConversationOutcomeRows: "DELETE FROM facts\n      WHERE source_id=$1 AND source_markdown_slug=$2 AND source = ANY($3::text[]) RETURNING id",
  listPurgeTombstoneMatches: "SELECT n.ord FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS n(fact, visibility, entity_slug, source, ord)\n    WHERE NOT (n.source IN ('cli:extract-conversation-facts:terminal:v2','cli:extract-conversation-facts:non-extractable:v2','cli:extract-conversation-facts:terminal') AND n.fact IN ('EXTRACTION_COMPLETE','EXTRACTION_NOT_APPLICABLE')) AND EXISTS (SELECT 1 FROM fact_purges p WHERE p.source_id=$1 AND p.visibility=n.visibility\n      AND (p.subject IN ('*', n.entity_slug) OR COALESCE(strpos(n.entity_slug, '/') = 0 AND NOT EXISTS (SELECT 1 FROM pages unbacked_page\n    WHERE unbacked_page.source_id = $1 AND unbacked_page.slug = n.entity_slug AND unbacked_page.deleted_at IS NULL), false)) AND p.fact_hash IN (gbrain_fact_fingerprint(n.fact), gbrain_fact_fingerprint_v2(n.fact)))",
  maxConversationRowNum: "SELECT max(row_num) AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2",
  listHeldFactSlots: "SELECT entity_slug, dimension, value_hash, valid_from FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND dimension IS NOT NULL",
  countPageConversationFacts: "SELECT count(*)::text AS count FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2\n    AND f.source LIKE 'cli:extract-conversation-facts%' AND NOT (f.source = ANY($3::text[]))",
  countConversationWindowFacts: "SELECT count(*)::text AS count FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2\n    AND f.source LIKE 'cli:extract-conversation-facts%' AND f.expired_at IS NULL AND f.source_window IS NOT NULL AND (f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha') = $3",
  countConversationFactsOutsideWindows: "SELECT count(*)::text AS count FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2\n    AND f.source LIKE 'cli:extract-conversation-facts%' AND NOT (f.source = ANY($3::text[])) AND f.expired_at IS NULL\n    AND (f.source_window IS NULL OR NOT ((f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha') = ANY($4::text[])))",
  findSameClaimFenceRow: "SELECT id, visibility FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL\n         AND expired_at IS NULL AND fact=$3 AND source IS NOT DISTINCT FROM $4 ORDER BY id LIMIT 1",
  findOntologyTwin: "SELECT t.id FROM facts m JOIN facts t ON t.source_id = m.source_id AND t.dimension = m.dimension AND t.value_hash = m.value_hash\n             AND t.valid_from = m.valid_from AND t.id <> m.id\n           WHERE m.source_id=$1 AND m.id=$3 AND t.entity_slug=$2 AND t.source_markdown_slug=$2\n           ORDER BY (t.expired_at IS NULL) DESC, t.id LIMIT 1",
  maxFenceRowNum: "SELECT COALESCE(MAX(row_num),0)::int AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2",
  readRelinkSource: "SELECT incarnation, archived, local_path, config->>'kind' AS kind FROM sources WHERE id = $1",
  factRelinkAttemptsTableExists: "SELECT to_regclass('fact_relink_attempts')::text AS t",
  readReextractOutcomeRow: "SELECT f.id, COALESCE(p.content_hash, '') AS hash FROM facts f JOIN pages p ON p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.deleted_at IS NULL\n      WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.source = $3 AND f.expired_at IS NULL ORDER BY f.id DESC LIMIT 1",
  // Main join (da99c637a7): the next two keep the base text except the ORDER BY. The cli-members line's callers
  // (conversation-relink.ts:99 and :120 at de72811022) sorted `f.source_markdown_slug COLLATE "C", f.id`; the join
  // re-applied that byte order to main's members, so these texts carry it too.
  listUnbackedConversationRows: "SELECT f.id, f.fact, f.context, f.visibility, f.source_markdown_slug AS slug, f.attributed_to, f.entity_slug FROM facts f\n      WHERE f.source_id = $1 AND f.source_markdown_slug = ANY($2::text[]) AND COALESCE(strpos(f.entity_slug, '/') = 0 AND NOT EXISTS (SELECT 1 FROM pages unbacked_page\n    WHERE unbacked_page.source_id = f.source_id AND unbacked_page.slug = f.entity_slug AND unbacked_page.deleted_at IS NULL), false) AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source LIKE 'cli:extract-conversation-facts%' AND f.source <> ALL($3::text[])\n      ORDER BY f.source_markdown_slug COLLATE \"C\", f.id",
  listUnlinkedConversationRows: "SELECT f.id, f.fact, f.context, f.visibility, f.source_markdown_slug AS slug, f.attributed_to FROM facts f\n      WHERE f.source_id = $1 AND f.source_markdown_slug = ANY($2::text[]) AND f.entity_slug IS NULL AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source LIKE 'cli:extract-conversation-facts%' AND f.source <> ALL($3::text[])\n      ORDER BY f.source_markdown_slug COLLATE \"C\", f.id",
  listEntityHintPages: "SELECT p.slug, p.type, p.frontmatter, (lower(COALESCE(p.frontmatter->>'canonical', '')) IN ('false', 'no')\n    OR btrim(COALESCE(p.frontmatter->>'superseded_by', '')) <> ''\n    OR btrim(COALESCE(p.frontmatter->>'merged_into', '')) <> ''\n    OR lower(COALESCE(p.frontmatter->>'status', '')) ~ '(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)') AS retired, (p.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(p.source_id, p.slug) OR (SELECT gbrain_access_state_unreadable())) AS folder_restricted FROM pages p\n      WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND p.deleted_at IS NULL",
  lockPageById: "SELECT id FROM pages WHERE id = $1 FOR UPDATE",
  listClearedRelinkedFacts: "SELECT f.fact, f.entity_slug, f.context FROM facts f\n      WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.source LIKE 'cli:extract-conversation-facts%' AND f.expired_at IS NOT NULL\n        AND f.entity_slug IS NOT NULL AND COALESCE(f.context, '') LIKE '%entity relinked from %'\n        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)\n      ORDER BY f.id DESC",
  countEmbeddedFactsAmong: "SELECT COUNT(*) AS n FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[]) AND embedding IS NOT NULL",
};

/** The five statements of the base `clearConversationFacts`, in order, for a whole-page clear and a window clear. */
export const BASE_CLEAR: Record<'plain' | 'windows', Array<{ text: string; params: unknown[] }>> = {
  plain: [
   {
    "text": "DELETE FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE 'cli:extract-conversation-facts%' AND f.expired_at IS NOT NULL AND f.entity_slug IS NOT NULL AND COALESCE(f.context, '') LIKE '%entity relinked from %' AND NOT (EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) OR EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id))",
    "params": [
     "src-a",
     "conversations/c1"
    ]
   },
   {
    "text": "UPDATE facts f SET dimension=NULL, value=NULL, value_hash=NULL, dim_status=NULL WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE 'cli:extract-conversation-facts%' AND f.expired_at IS NOT NULL AND f.dimension IS NOT NULL",
    "params": [
     "src-a",
     "conversations/c1"
    ]
   },
   {
    "text": "WITH up AS (UPDATE facts f SET expired_at=now(), dimension=NULL, value=NULL, value_hash=NULL, dim_status=NULL\n    WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE 'cli:extract-conversation-facts%' AND f.expired_at IS NULL AND f.entity_slug IS NOT NULL AND COALESCE(f.context, '') LIKE '%entity relinked from %' RETURNING 1) SELECT COUNT(*)::text AS count FROM up",
    "params": [
     "src-a",
     "conversations/c1"
    ]
   },
   {
    "text": "WITH up AS (UPDATE facts f SET expired_at=now(), dimension=NULL, value=NULL, value_hash=NULL, dim_status=NULL\n    WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE 'cli:extract-conversation-facts%' AND f.expired_at IS NULL AND (EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) OR EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id)) RETURNING 1) SELECT COUNT(*)::text AS count FROM up",
    "params": [
     "src-a",
     "conversations/c1"
    ]
   },
   {
    "text": "WITH del AS (DELETE FROM facts f\n    WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE 'cli:extract-conversation-facts%' AND NOT (EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) OR EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id)) AND COALESCE(f.context,'') NOT LIKE '%retired: conversation-labels%' AND NOT (f.entity_slug IS NOT NULL AND COALESCE(f.context, '') LIKE '%entity relinked from %') RETURNING 1)\n    SELECT COUNT(*)::text AS count FROM del",
    "params": [
     "src-a",
     "conversations/c1"
    ]
   }
  ],
  windows: [
   {
    "text": "DELETE FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE 'cli:extract-conversation-facts%' AND NOT (f.source = ANY($3::text[])) AND (CASE WHEN f.source_window IS NULL THEN $4::boolean ELSE ((f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha') = ANY($5::text[])) <> $6::boolean END) AND f.expired_at IS NOT NULL AND f.entity_slug IS NOT NULL AND COALESCE(f.context, '') LIKE '%entity relinked from %' AND NOT (EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) OR EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id))",
    "params": [
     "src-a",
     "conversations/c1",
     [
      "cli:extract-conversation-facts:terminal:v2",
      "cli:extract-conversation-facts:non-extractable:v2",
      "cli:extract-conversation-facts:terminal"
     ],
     false,
     [
      "a:1:x",
      "b:2:y"
     ],
     true
    ]
   },
   {
    "text": "UPDATE facts f SET dimension=NULL, value=NULL, value_hash=NULL, dim_status=NULL WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE 'cli:extract-conversation-facts%' AND NOT (f.source = ANY($3::text[])) AND (CASE WHEN f.source_window IS NULL THEN $4::boolean ELSE ((f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha') = ANY($5::text[])) <> $6::boolean END) AND f.expired_at IS NOT NULL AND f.dimension IS NOT NULL",
    "params": [
     "src-a",
     "conversations/c1",
     [
      "cli:extract-conversation-facts:terminal:v2",
      "cli:extract-conversation-facts:non-extractable:v2",
      "cli:extract-conversation-facts:terminal"
     ],
     false,
     [
      "a:1:x",
      "b:2:y"
     ],
     true
    ]
   },
   {
    "text": "WITH up AS (UPDATE facts f SET expired_at=now(), dimension=NULL, value=NULL, value_hash=NULL, dim_status=NULL\n    WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE 'cli:extract-conversation-facts%' AND NOT (f.source = ANY($3::text[])) AND (CASE WHEN f.source_window IS NULL THEN $4::boolean ELSE ((f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha') = ANY($5::text[])) <> $6::boolean END) AND f.expired_at IS NULL AND f.entity_slug IS NOT NULL AND COALESCE(f.context, '') LIKE '%entity relinked from %' RETURNING 1) SELECT COUNT(*)::text AS count FROM up",
    "params": [
     "src-a",
     "conversations/c1",
     [
      "cli:extract-conversation-facts:terminal:v2",
      "cli:extract-conversation-facts:non-extractable:v2",
      "cli:extract-conversation-facts:terminal"
     ],
     false,
     [
      "a:1:x",
      "b:2:y"
     ],
     true
    ]
   },
   {
    "text": "WITH up AS (UPDATE facts f SET expired_at=now(), dimension=NULL, value=NULL, value_hash=NULL, dim_status=NULL\n    WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE 'cli:extract-conversation-facts%' AND NOT (f.source = ANY($3::text[])) AND (CASE WHEN f.source_window IS NULL THEN $4::boolean ELSE ((f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha') = ANY($5::text[])) <> $6::boolean END) AND f.expired_at IS NULL AND (EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) OR EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id)) RETURNING 1) SELECT COUNT(*)::text AS count FROM up",
    "params": [
     "src-a",
     "conversations/c1",
     [
      "cli:extract-conversation-facts:terminal:v2",
      "cli:extract-conversation-facts:non-extractable:v2",
      "cli:extract-conversation-facts:terminal"
     ],
     false,
     [
      "a:1:x",
      "b:2:y"
     ],
     true
    ]
   },
   {
    "text": "WITH del AS (DELETE FROM facts f\n    WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.source LIKE 'cli:extract-conversation-facts%' AND NOT (f.source = ANY($3::text[])) AND (CASE WHEN f.source_window IS NULL THEN $4::boolean ELSE ((f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha') = ANY($5::text[])) <> $6::boolean END) AND NOT (EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) OR EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id)) AND COALESCE(f.context,'') NOT LIKE '%retired: conversation-labels%' AND NOT (f.entity_slug IS NOT NULL AND COALESCE(f.context, '') LIKE '%entity relinked from %') RETURNING 1)\n    SELECT COUNT(*)::text AS count FROM del",
    "params": [
     "src-a",
     "conversations/c1",
     [
      "cli:extract-conversation-facts:terminal:v2",
      "cli:extract-conversation-facts:non-extractable:v2",
      "cli:extract-conversation-facts:terminal"
     ],
     false,
     [
      "a:1:x",
      "b:2:y"
     ],
     true
    ]
   }
  ],
};
