/**
 * The extract_atoms backlog count (`countExtractAtomsBacklog`, cycle/extract-atoms.ts): doctor's extract_atoms_backlog check,
 * the drain's remaining count, `gbrain dream` and the autopilot dispatch count the pages awaiting atom extraction through it.
 * The statement is the one that function composed (its predicate pieces: the raw-holder exclusion, the minimum compiled-truth
 * length, `managedAtomDiscoverySql`, `pageScanStateExclusionSql`, and the atom-exists test), written out as constants (four, and a twin of each for the source opt-out's `excluded` count) so
 * no clause is spliced and this file imports nothing heavy (doctor-search.ts's member list is imported early). The connector
 * exclusion's page types and source kinds are bound arrays instead of the literal lists `connectorAtomExclusionSql` spliced;
 * the caller (cycle/connector-atoms.ts) owns both lists and passes them only when connector pages are opted out.
 * test/doctor-search-sql.test.ts pins each constant against the composed original.
 * The Rust engine answers it from page records (rust/crates/gbrain-store/src/link_queries/atom_backlog.rs,
 * rust/docs/store/cli-reads-doctor-search.md).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** The count's inputs: all resolved by the caller (the extractable types, the length floor, the input cap, the connector opt-out). */
export interface AtomBacklogQuery {
  /** The one source counted, or null for the whole brain (an atom must live in its page's source either way). */
  sourceId: string | null;
  /** Page types that may be extracted. */
  types: string[];
  /** Minimum compiled-truth length in characters. */
  minChars: number;
  /** The current input cap: a partial disposition recorded below it counts. */
  maxInputChars: number;
  /** When connector pages are opted out: the page types left out of sources of these kinds; null when they are counted. */
  connectorExclusion: { pageTypes: string[]; sourceKinds: string[] } | null;
  /**
   * The hold ids `currentHoldIds(engine, 'atom')` returns (#10270): a page whose held atom generation carries one of them,
   * for the page's current input pin and not a partial hold, is skipped by the phase and so is left out of the count.
   */
  holdIds?: readonly string[];
  /**
   * #9888: `apply` (the default) leaves out the pages of a source whose config turns `extract_atoms` off; `excluded` counts
   * only those pages instead, for doctor's `policy_excluded` note.
   */
  sourcePolicy?: 'apply' | 'excluded';
}

export const ATOM_BACKLOG_SCOPED_SQL = `SELECT COUNT(*) AS cnt FROM pages p
         WHERE p.source_id = $1
           AND p.type = ANY($2::text[])
           AND p.deleted_at IS NULL
           AND p.content_hash IS NOT NULL
           AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
           AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
           AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))
           AND (octet_length(p.compiled_truth) >= 4 * $3 OR (octet_length(p.compiled_truth) >= $3 AND length(p.compiled_truth) >= $3))
           AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac
  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id
    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)
    AND ac.completed_keys->0->>'kind'='page'
    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true')
    AND (ac.completed_keys->0->>'partial' IS NULL OR (ac.completed_keys->0->>'partial')::integer >= $4::integer))
           AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars >= $4::integer)
    AND NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=scan.source_incarnation AND newer.page_id=scan.page_id AND newer.updated_at > scan.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > scan.updated_at)
)
           AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false'
           AND NOT EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')
           AND NOT EXISTS (SELECT 1 FROM derived_generations dg
        WHERE dg.source_id = p.source_id AND dg.kind = 'atom' AND dg.state = 'held' AND dg.owner_key = 'source_slug:' || p.slug
          AND dg.hold_id = ANY($5::text[]) AND COALESCE(dg.held_context->>'partial', 'false') <> 'true'
          AND dg.input_pin IN (p.content_hash, p.content_hash || ':' || p.id::text || ':' || p.knowledge_revision::text))
           AND (NOT EXISTS (
    SELECT 1 FROM pages atom
    WHERE atom.type = 'atom' AND atom.source_id = p.source_id
      AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
      AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
      AND atom.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND newer.page_id=p.id AND newer.content_hash<>p.content_hash
      AND newer.updated_at > COALESCE((SELECT max(cur.updated_at) FROM extract_atoms_page_state cur
        WHERE cur.source_incarnation=newer.source_incarnation AND cur.page_id=p.id AND cur.content_hash=p.content_hash), '-infinity'::timestamptz)
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state done
    JOIN fact_withdrawals w ON w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > done.updated_at
    WHERE done.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND done.page_id=p.id AND done.content_hash=p.content_hash
  ))`;

/** ATOM_BACKLOG_SCOPED_SQL, counting only the pages a source's extract_atoms opt-out keeps out (doctor's policy_excluded note). */
export const ATOM_BACKLOG_SCOPED_POLICY_OFF_SQL = `SELECT COUNT(*) AS cnt FROM pages p
         WHERE p.source_id = $1
           AND p.type = ANY($2::text[])
           AND p.deleted_at IS NULL
           AND p.content_hash IS NOT NULL
           AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
           AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
           AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))
           AND (octet_length(p.compiled_truth) >= 4 * $3 OR (octet_length(p.compiled_truth) >= $3 AND length(p.compiled_truth) >= $3))
           AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac
  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id
    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)
    AND ac.completed_keys->0->>'kind'='page'
    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true')
    AND (ac.completed_keys->0->>'partial' IS NULL OR (ac.completed_keys->0->>'partial')::integer >= $4::integer))
           AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars >= $4::integer)
    AND NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=scan.source_incarnation AND newer.page_id=scan.page_id AND newer.updated_at > scan.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > scan.updated_at)
)
           AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false'
           AND EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')
           AND NOT EXISTS (SELECT 1 FROM derived_generations dg
        WHERE dg.source_id = p.source_id AND dg.kind = 'atom' AND dg.state = 'held' AND dg.owner_key = 'source_slug:' || p.slug
          AND dg.hold_id = ANY($5::text[]) AND COALESCE(dg.held_context->>'partial', 'false') <> 'true'
          AND dg.input_pin IN (p.content_hash, p.content_hash || ':' || p.id::text || ':' || p.knowledge_revision::text))
           AND (NOT EXISTS (
    SELECT 1 FROM pages atom
    WHERE atom.type = 'atom' AND atom.source_id = p.source_id
      AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
      AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
      AND atom.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND newer.page_id=p.id AND newer.content_hash<>p.content_hash
      AND newer.updated_at > COALESCE((SELECT max(cur.updated_at) FROM extract_atoms_page_state cur
        WHERE cur.source_incarnation=newer.source_incarnation AND cur.page_id=p.id AND cur.content_hash=p.content_hash), '-infinity'::timestamptz)
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state done
    JOIN fact_withdrawals w ON w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > done.updated_at
    WHERE done.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND done.page_id=p.id AND done.content_hash=p.content_hash
  ))`;

export const ATOM_BACKLOG_SCOPED_CONNECTORS_OUT_SQL = `SELECT COUNT(*) AS cnt FROM pages p
         WHERE p.source_id = $1
           AND p.type = ANY($2::text[])
           AND p.deleted_at IS NULL
           AND p.content_hash IS NOT NULL
           AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
           AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
           AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))
           AND (octet_length(p.compiled_truth) >= 4 * $3 OR (octet_length(p.compiled_truth) >= $3 AND length(p.compiled_truth) >= $3))
           AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac
  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id
    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)
    AND ac.completed_keys->0->>'kind'='page'
    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true')
    AND (ac.completed_keys->0->>'partial' IS NULL OR (ac.completed_keys->0->>'partial')::integer >= $4::integer))
           AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars >= $4::integer)
    AND NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=scan.source_incarnation AND newer.page_id=scan.page_id AND newer.updated_at > scan.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > scan.updated_at)
)
           AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false' AND NOT (p.type = ANY($5::text[]) AND EXISTS (SELECT 1 FROM sources cs
        WHERE cs.id = p.source_id AND cs.config->>'kind' = ANY($6::text[])))
           AND NOT EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')
           AND NOT EXISTS (SELECT 1 FROM derived_generations dg
        WHERE dg.source_id = p.source_id AND dg.kind = 'atom' AND dg.state = 'held' AND dg.owner_key = 'source_slug:' || p.slug
          AND dg.hold_id = ANY($7::text[]) AND COALESCE(dg.held_context->>'partial', 'false') <> 'true'
          AND dg.input_pin IN (p.content_hash, p.content_hash || ':' || p.id::text || ':' || p.knowledge_revision::text))
           AND (NOT EXISTS (
    SELECT 1 FROM pages atom
    WHERE atom.type = 'atom' AND atom.source_id = p.source_id
      AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
      AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
      AND atom.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND newer.page_id=p.id AND newer.content_hash<>p.content_hash
      AND newer.updated_at > COALESCE((SELECT max(cur.updated_at) FROM extract_atoms_page_state cur
        WHERE cur.source_incarnation=newer.source_incarnation AND cur.page_id=p.id AND cur.content_hash=p.content_hash), '-infinity'::timestamptz)
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state done
    JOIN fact_withdrawals w ON w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > done.updated_at
    WHERE done.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND done.page_id=p.id AND done.content_hash=p.content_hash
  ))`;

/** ATOM_BACKLOG_SCOPED_CONNECTORS_OUT_SQL, counting only the pages a source's extract_atoms opt-out keeps out (doctor's policy_excluded note). */
export const ATOM_BACKLOG_SCOPED_CONNECTORS_OUT_POLICY_OFF_SQL = `SELECT COUNT(*) AS cnt FROM pages p
         WHERE p.source_id = $1
           AND p.type = ANY($2::text[])
           AND p.deleted_at IS NULL
           AND p.content_hash IS NOT NULL
           AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
           AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
           AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))
           AND (octet_length(p.compiled_truth) >= 4 * $3 OR (octet_length(p.compiled_truth) >= $3 AND length(p.compiled_truth) >= $3))
           AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac
  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id
    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)
    AND ac.completed_keys->0->>'kind'='page'
    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true')
    AND (ac.completed_keys->0->>'partial' IS NULL OR (ac.completed_keys->0->>'partial')::integer >= $4::integer))
           AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars >= $4::integer)
    AND NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=scan.source_incarnation AND newer.page_id=scan.page_id AND newer.updated_at > scan.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > scan.updated_at)
)
           AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false' AND NOT (p.type = ANY($5::text[]) AND EXISTS (SELECT 1 FROM sources cs
        WHERE cs.id = p.source_id AND cs.config->>'kind' = ANY($6::text[])))
           AND EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')
           AND NOT EXISTS (SELECT 1 FROM derived_generations dg
        WHERE dg.source_id = p.source_id AND dg.kind = 'atom' AND dg.state = 'held' AND dg.owner_key = 'source_slug:' || p.slug
          AND dg.hold_id = ANY($7::text[]) AND COALESCE(dg.held_context->>'partial', 'false') <> 'true'
          AND dg.input_pin IN (p.content_hash, p.content_hash || ':' || p.id::text || ':' || p.knowledge_revision::text))
           AND (NOT EXISTS (
    SELECT 1 FROM pages atom
    WHERE atom.type = 'atom' AND atom.source_id = p.source_id
      AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
      AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
      AND atom.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND newer.page_id=p.id AND newer.content_hash<>p.content_hash
      AND newer.updated_at > COALESCE((SELECT max(cur.updated_at) FROM extract_atoms_page_state cur
        WHERE cur.source_incarnation=newer.source_incarnation AND cur.page_id=p.id AND cur.content_hash=p.content_hash), '-infinity'::timestamptz)
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state done
    JOIN fact_withdrawals w ON w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > done.updated_at
    WHERE done.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND done.page_id=p.id AND done.content_hash=p.content_hash
  ))`;

export const ATOM_BACKLOG_ALL_SQL = `SELECT COUNT(*) AS cnt FROM pages p
         WHERE p.type = ANY($1::text[])
           AND p.deleted_at IS NULL
           AND p.content_hash IS NOT NULL
           AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
           AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
           AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))
           AND (octet_length(p.compiled_truth) >= 4 * $2 OR (octet_length(p.compiled_truth) >= $2 AND length(p.compiled_truth) >= $2))
           AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac
  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id
    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)
    AND ac.completed_keys->0->>'kind'='page'
    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true')
    AND (ac.completed_keys->0->>'partial' IS NULL OR (ac.completed_keys->0->>'partial')::integer >= $3::integer))
           AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars >= $3::integer)
    AND NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=scan.source_incarnation AND newer.page_id=scan.page_id AND newer.updated_at > scan.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > scan.updated_at)
)
           AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false'
           AND NOT EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')
           AND NOT EXISTS (SELECT 1 FROM derived_generations dg
        WHERE dg.source_id = p.source_id AND dg.kind = 'atom' AND dg.state = 'held' AND dg.owner_key = 'source_slug:' || p.slug
          AND dg.hold_id = ANY($4::text[]) AND COALESCE(dg.held_context->>'partial', 'false') <> 'true'
          AND dg.input_pin IN (p.content_hash, p.content_hash || ':' || p.id::text || ':' || p.knowledge_revision::text))
           AND (NOT EXISTS (
    SELECT 1 FROM pages atom
    WHERE atom.type = 'atom' AND atom.source_id = p.source_id
      AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
      AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
      AND atom.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND newer.page_id=p.id AND newer.content_hash<>p.content_hash
      AND newer.updated_at > COALESCE((SELECT max(cur.updated_at) FROM extract_atoms_page_state cur
        WHERE cur.source_incarnation=newer.source_incarnation AND cur.page_id=p.id AND cur.content_hash=p.content_hash), '-infinity'::timestamptz)
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state done
    JOIN fact_withdrawals w ON w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > done.updated_at
    WHERE done.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND done.page_id=p.id AND done.content_hash=p.content_hash
  ))`;

/** ATOM_BACKLOG_ALL_SQL, counting only the pages a source's extract_atoms opt-out keeps out (doctor's policy_excluded note). */
export const ATOM_BACKLOG_ALL_POLICY_OFF_SQL = `SELECT COUNT(*) AS cnt FROM pages p
         WHERE p.type = ANY($1::text[])
           AND p.deleted_at IS NULL
           AND p.content_hash IS NOT NULL
           AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
           AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
           AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))
           AND (octet_length(p.compiled_truth) >= 4 * $2 OR (octet_length(p.compiled_truth) >= $2 AND length(p.compiled_truth) >= $2))
           AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac
  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id
    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)
    AND ac.completed_keys->0->>'kind'='page'
    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true')
    AND (ac.completed_keys->0->>'partial' IS NULL OR (ac.completed_keys->0->>'partial')::integer >= $3::integer))
           AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars >= $3::integer)
    AND NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=scan.source_incarnation AND newer.page_id=scan.page_id AND newer.updated_at > scan.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > scan.updated_at)
)
           AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false'
           AND EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')
           AND NOT EXISTS (SELECT 1 FROM derived_generations dg
        WHERE dg.source_id = p.source_id AND dg.kind = 'atom' AND dg.state = 'held' AND dg.owner_key = 'source_slug:' || p.slug
          AND dg.hold_id = ANY($4::text[]) AND COALESCE(dg.held_context->>'partial', 'false') <> 'true'
          AND dg.input_pin IN (p.content_hash, p.content_hash || ':' || p.id::text || ':' || p.knowledge_revision::text))
           AND (NOT EXISTS (
    SELECT 1 FROM pages atom
    WHERE atom.type = 'atom' AND atom.source_id = p.source_id
      AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
      AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
      AND atom.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND newer.page_id=p.id AND newer.content_hash<>p.content_hash
      AND newer.updated_at > COALESCE((SELECT max(cur.updated_at) FROM extract_atoms_page_state cur
        WHERE cur.source_incarnation=newer.source_incarnation AND cur.page_id=p.id AND cur.content_hash=p.content_hash), '-infinity'::timestamptz)
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state done
    JOIN fact_withdrawals w ON w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > done.updated_at
    WHERE done.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND done.page_id=p.id AND done.content_hash=p.content_hash
  ))`;

export const ATOM_BACKLOG_ALL_CONNECTORS_OUT_SQL = `SELECT COUNT(*) AS cnt FROM pages p
         WHERE p.type = ANY($1::text[])
           AND p.deleted_at IS NULL
           AND p.content_hash IS NOT NULL
           AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
           AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
           AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))
           AND (octet_length(p.compiled_truth) >= 4 * $2 OR (octet_length(p.compiled_truth) >= $2 AND length(p.compiled_truth) >= $2))
           AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac
  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id
    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)
    AND ac.completed_keys->0->>'kind'='page'
    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true')
    AND (ac.completed_keys->0->>'partial' IS NULL OR (ac.completed_keys->0->>'partial')::integer >= $3::integer))
           AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars >= $3::integer)
    AND NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=scan.source_incarnation AND newer.page_id=scan.page_id AND newer.updated_at > scan.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > scan.updated_at)
)
           AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false' AND NOT (p.type = ANY($4::text[]) AND EXISTS (SELECT 1 FROM sources cs
        WHERE cs.id = p.source_id AND cs.config->>'kind' = ANY($5::text[])))
           AND NOT EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')
           AND NOT EXISTS (SELECT 1 FROM derived_generations dg
        WHERE dg.source_id = p.source_id AND dg.kind = 'atom' AND dg.state = 'held' AND dg.owner_key = 'source_slug:' || p.slug
          AND dg.hold_id = ANY($6::text[]) AND COALESCE(dg.held_context->>'partial', 'false') <> 'true'
          AND dg.input_pin IN (p.content_hash, p.content_hash || ':' || p.id::text || ':' || p.knowledge_revision::text))
           AND (NOT EXISTS (
    SELECT 1 FROM pages atom
    WHERE atom.type = 'atom' AND atom.source_id = p.source_id
      AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
      AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
      AND atom.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND newer.page_id=p.id AND newer.content_hash<>p.content_hash
      AND newer.updated_at > COALESCE((SELECT max(cur.updated_at) FROM extract_atoms_page_state cur
        WHERE cur.source_incarnation=newer.source_incarnation AND cur.page_id=p.id AND cur.content_hash=p.content_hash), '-infinity'::timestamptz)
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state done
    JOIN fact_withdrawals w ON w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > done.updated_at
    WHERE done.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND done.page_id=p.id AND done.content_hash=p.content_hash
  ))`;

/** ATOM_BACKLOG_ALL_CONNECTORS_OUT_SQL, counting only the pages a source's extract_atoms opt-out keeps out (doctor's policy_excluded note). */
export const ATOM_BACKLOG_ALL_CONNECTORS_OUT_POLICY_OFF_SQL = `SELECT COUNT(*) AS cnt FROM pages p
         WHERE p.type = ANY($1::text[])
           AND p.deleted_at IS NULL
           AND p.content_hash IS NOT NULL
           AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
           AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
           AND NOT (p.type = 'source' AND COALESCE(p.frontmatter ? 'raw', false))
           AND (octet_length(p.compiled_truth) >= 4 * $2 OR (octet_length(p.compiled_truth) >= $2 AND length(p.compiled_truth) >= $2))
           AND NOT EXISTS (SELECT 1 FROM op_checkpoints ac
  WHERE ac.op='managed-atoms' AND ac.completed_keys->0->>'sourceId'=p.source_id
    AND ac.completed_keys->0->>'incarnation'=(SELECT incarnation::text FROM sources WHERE id=p.source_id)
    AND ac.completed_keys->0->>'kind'='page'
    AND ac.completed_keys->0->>'pageId'=p.id::text AND ac.completed_keys->0->>'contentHash'=p.content_hash
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true')
    AND (ac.completed_keys->0->>'partial' IS NULL OR (ac.completed_keys->0->>'partial')::integer >= $3::integer))
           AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars >= $3::integer)
    AND NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=scan.source_incarnation AND newer.page_id=scan.page_id AND newer.updated_at > scan.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > scan.updated_at)
)
           AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false' AND NOT (p.type = ANY($4::text[]) AND EXISTS (SELECT 1 FROM sources cs
        WHERE cs.id = p.source_id AND cs.config->>'kind' = ANY($5::text[])))
           AND EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')
           AND NOT EXISTS (SELECT 1 FROM derived_generations dg
        WHERE dg.source_id = p.source_id AND dg.kind = 'atom' AND dg.state = 'held' AND dg.owner_key = 'source_slug:' || p.slug
          AND dg.hold_id = ANY($6::text[]) AND COALESCE(dg.held_context->>'partial', 'false') <> 'true'
          AND dg.input_pin IN (p.content_hash, p.content_hash || ':' || p.id::text || ':' || p.knowledge_revision::text))
           AND (NOT EXISTS (
    SELECT 1 FROM pages atom
    WHERE atom.type = 'atom' AND atom.source_id = p.source_id
      AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
      AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
      AND atom.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND newer.page_id=p.id AND newer.content_hash<>p.content_hash
      AND newer.updated_at > COALESCE((SELECT max(cur.updated_at) FROM extract_atoms_page_state cur
        WHERE cur.source_incarnation=newer.source_incarnation AND cur.page_id=p.id AND cur.content_hash=p.content_hash), '-infinity'::timestamptz)
  ) OR EXISTS (
    SELECT 1 FROM extract_atoms_page_state done
    JOIN fact_withdrawals w ON w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > done.updated_at
    WHERE done.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
      AND done.page_id=p.id AND done.content_hash=p.content_hash
  ))`;

/** Pages awaiting atom extraction (no atom of their current content yet, no held or tombstoned disposition) in `query`'s scope. */
export async function countAtomExtractionBacklog(raw: EngineRawRead, query: AtomBacklogQuery): Promise<number> {
  const { sourceId, types, minChars, maxInputChars, connectorExclusion: connectors } = query;
  const off = query.sourcePolicy === 'excluded';
  const tail = [...(connectors ? [connectors.pageTypes, connectors.sourceKinds] : []), [...(query.holdIds ?? [])]];
  const all = connectors
    ? (off ? ATOM_BACKLOG_ALL_CONNECTORS_OUT_POLICY_OFF_SQL : ATOM_BACKLOG_ALL_CONNECTORS_OUT_SQL)
    : (off ? ATOM_BACKLOG_ALL_POLICY_OFF_SQL : ATOM_BACKLOG_ALL_SQL);
  const scoped = connectors
    ? (off ? ATOM_BACKLOG_SCOPED_CONNECTORS_OUT_POLICY_OFF_SQL : ATOM_BACKLOG_SCOPED_CONNECTORS_OUT_SQL)
    : (off ? ATOM_BACKLOG_SCOPED_POLICY_OFF_SQL : ATOM_BACKLOG_SCOPED_SQL);
  const [row] = sourceId === null
    ? await raw<{ cnt: string | number }>(all, [types, minChars, maxInputChars, ...tail])
    : await raw<{ cnt: string | number }>(scoped, [sourceId, types, minChars, maxInputChars, ...tail]);
  return Number(row?.cnt ?? 0);
}
