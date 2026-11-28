/**
 * The extract_atoms phase's reads and its partial-disposition release (cycle/extract-atoms.ts, cycle/extract-atoms-input.ts):
 * page discovery, the transcript idempotency read, the transcript tombstone read, the atom-title read of a source page and
 * the release of the partial dispositions a raised input cap supersedes. Each statement is the text those functions sent
 * through `executeRaw`, written out as a constant so no clause is spliced (test/extract-atoms-sql-pin.test.ts pins each one
 * against master's text). Discovery keeps master's four shapes: with or without the connector opt-out (its page types and
 * source kinds are the literal lists connector-atoms.ts spliced) and with or without the affected-slug filter. Discovery is
 * sync-21's text (GST-4020 #10542, #9888 #10483): the per-source opt-out, the still-current scan and atoms tests, and no
 * body column (cycle/extract-atoms-page-state.ts canonicalPageInputs reads each page's canonical snapshot).
 * The Rust engine refuses `listExtractablePages` by name (rust/docs/store/extract-atoms.md): its store keeps none of the
 * sync-21 discovery state, so a Rust brain refuses the phase before discovery and before any model call.
 */
type Raw = { executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> };

/** Discovery's inputs, all resolved by the caller. */
export interface ExtractablePageQuery {
  sourceId: string;
  /** Page types that may be extracted. */
  types: string[];
  /** Minimum compiled-truth length in characters. */
  minChars: number;
  /** At most this many pages, newest first. */
  limit: number;
  /** Only these slugs, when the run names the pages it touched; null for every page. */
  affectedSlugs: string[] | null;
  /** When connector email and meeting pages are opted out: the lists the statement names. Null when they are extracted. */
  connectorExclusion: { pageTypes: string[]; sourceKinds: string[] } | null;
  /**
   * The hold ids `currentHoldIds(engine, 'atom')` returns (#10270): a page whose held atom generation carries one of them,
   * for the page's current input pin and not a partial hold, is skipped by the phase and so is left out of discovery.
   */
  holdIds: readonly string[];
}

/** One extractable page with the identity its state rows pin to (its body is read from its canonical snapshot). */
export interface ExtractablePageRow {
  id: number;
  knowledge_revision: string;
  source_incarnation: string;
  slug: string;
  content_hash: string;
}

export const EXTRACTABLE_PAGES_SQL = `
    SELECT p.id, p.knowledge_revision,
           (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,
           p.slug,
           p.content_hash
    FROM pages p
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
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true'))
      AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars IS NOT NULL)
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
  ))
    ORDER BY p.updated_at DESC
    LIMIT $4
  `;

export const EXTRACTABLE_PAGES_FILTERED_SQL = `
    SELECT p.id, p.knowledge_revision,
           (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,
           p.slug,
           p.content_hash
    FROM pages p
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
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true'))
      AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars IS NOT NULL)
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
      AND p.slug = ANY($6::text[])
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
  ))
    ORDER BY p.updated_at DESC
    LIMIT $4
  `;

export const EXTRACTABLE_PAGES_CONNECTORS_OUT_SQL = `
    SELECT p.id, p.knowledge_revision,
           (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,
           p.slug,
           p.content_hash
    FROM pages p
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
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true'))
      AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars IS NOT NULL)
    AND NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=scan.source_incarnation AND newer.page_id=scan.page_id AND newer.updated_at > scan.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > scan.updated_at)
)
      AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false' AND NOT (p.type IN ('email','meeting') AND EXISTS (SELECT 1 FROM sources cs
        WHERE cs.id = p.source_id AND cs.config->>'kind' IN ('google','github','meetings','slack','imessage','apple-contacts')))
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
  ))
    ORDER BY p.updated_at DESC
    LIMIT $4
  `;

export const EXTRACTABLE_PAGES_CONNECTORS_OUT_FILTERED_SQL = `
    SELECT p.id, p.knowledge_revision,
           (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,
           p.slug,
           p.content_hash
    FROM pages p
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
    AND (ac.completed_keys->0->>'failure' IS NULL OR ac.completed_keys->0->>'held'='true'))
      AND NOT EXISTS (
  SELECT 1 FROM extract_atoms_page_state scan
  WHERE scan.source_incarnation=(SELECT s.incarnation FROM sources s WHERE s.id=p.source_id)
    AND scan.page_id=p.id AND scan.content_hash=p.content_hash
    AND (scan.tombstoned OR scan.partial_input_chars IS NOT NULL)
    AND NOT EXISTS (
    SELECT 1 FROM extract_atoms_page_state newer
    WHERE newer.source_incarnation=scan.source_incarnation AND newer.page_id=scan.page_id AND newer.updated_at > scan.updated_at)
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id=p.source_id AND w.visibility='world' AND w.subject IN ('*', p.slug) AND w.withdrawn_at > scan.updated_at)
)
      AND COALESCE(p.frontmatter->>'extract_atoms', '') <> 'false' AND NOT (p.type IN ('email','meeting') AND EXISTS (SELECT 1 FROM sources cs
        WHERE cs.id = p.source_id AND cs.config->>'kind' IN ('google','github','meetings','slack','imessage','apple-contacts')))
      AND NOT EXISTS (SELECT 1 FROM sources xs WHERE xs.id = p.source_id AND xs.config->>'extract_atoms' = 'false')
      AND NOT EXISTS (SELECT 1 FROM derived_generations dg
        WHERE dg.source_id = p.source_id AND dg.kind = 'atom' AND dg.state = 'held' AND dg.owner_key = 'source_slug:' || p.slug
          AND dg.hold_id = ANY($5::text[]) AND COALESCE(dg.held_context->>'partial', 'false') <> 'true'
          AND dg.input_pin IN (p.content_hash, p.content_hash || ':' || p.id::text || ':' || p.knowledge_revision::text))
      AND p.slug = ANY($6::text[])
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
  ))
    ORDER BY p.updated_at DESC
    LIMIT $4
  `;

export const ATOM_SOURCE_HASHES_SQL = `SELECT frontmatter->>'source_hash' AS h
         FROM pages
        WHERE type = 'atom'
          AND source_id = $1
          AND deleted_at IS NULL
          AND COALESCE(frontmatter->>'managed_extraction', '') <> 'true'
          AND frontmatter->>'source_hash' = ANY($2::text[])`;

export const TOMBSTONED_TRANSCRIPTS_SQL = `SELECT file_path, content_hash
         FROM extract_atoms_transcript_state
        WHERE source_id = $1
          AND (tombstoned OR partial_input_chars IS NOT NULL)
          AND content_hash = ANY($2::text[])`;

export const SOURCE_PAGE_ATOM_TITLES_SQL = `SELECT slug, title FROM pages WHERE type = 'atom' AND deleted_at IS NULL AND source_id = $1 AND frontmatter->>'source_slug' = $2`;

/** The three statements of the release, in master's order. */
export const RELEASE_PARTIAL_DISPOSITIONS_SQL = [
  `UPDATE extract_atoms_page_state scan SET partial_input_chars=NULL, updated_at=now()
         FROM sources s WHERE s.id=$1 AND scan.source_incarnation=s.incarnation AND scan.partial_input_chars < $2`,
  `UPDATE extract_atoms_transcript_state SET partial_input_chars=NULL, updated_at=now()
        WHERE source_id=$1 AND partial_input_chars < $2`,
  `DELETE FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1
         AND (completed_keys->0->>'partial')::integer < $2`,
] as const;

/**
 * Pages of `sourceId` awaiting atom extraction (no current atom of their current content, no still-current tombstoned,
 * partial, completed or held disposition, no held atom generation for their current input, not in a source with
 * `extract_atoms` off), newest first, at most `limit`.
 */
export async function listExtractablePages(raw: Raw, query: ExtractablePageQuery): Promise<ExtractablePageRow[]> {
  const filtered = query.affectedSlugs !== null && query.affectedSlugs.length > 0;
  const sql = query.connectorExclusion
    ? (filtered ? EXTRACTABLE_PAGES_CONNECTORS_OUT_FILTERED_SQL : EXTRACTABLE_PAGES_CONNECTORS_OUT_SQL)
    : (filtered ? EXTRACTABLE_PAGES_FILTERED_SQL : EXTRACTABLE_PAGES_SQL);
  const params: unknown[] = [query.sourceId, query.types, query.minChars, query.limit, [...query.holdIds]];
  if (filtered) params.push(query.affectedSlugs);
  return raw.executeRaw<ExtractablePageRow>(sql, params);
}

/** The `source_hash` of every live, unmanaged atom of `sourceId` among `hashes` (one row per atom). */
export async function listAtomSourceHashes(raw: Raw, sourceId: string, hashes: readonly string[]): Promise<string[]> {
  const rows = await raw.executeRaw<{ h: string }>(ATOM_SOURCE_HASHES_SQL, [sourceId, [...hashes]]);
  return rows.map(r => r.h);
}

/** The transcripts of `sourceId` among `hashes` that are tombstoned or partial (cut at the input cap). */
export async function listTombstonedTranscripts(raw: Raw, sourceId: string, hashes: readonly string[]): Promise<Array<{ file_path: string; content_hash: string }>> {
  return raw.executeRaw<{ file_path: string; content_hash: string }>(TOMBSTONED_TRANSCRIPTS_SQL, [sourceId, [...hashes]]);
}

/** The live atoms of `sourceId` bound to the source page `sourceSlug`: slug and title. */
export async function listSourcePageAtomTitles(raw: Raw, sourceId: string, sourceSlug: string): Promise<Array<{ slug: string; title: string }>> {
  return raw.executeRaw<{ slug: string; title: string }>(SOURCE_PAGE_ATOM_TITLES_SQL, [sourceId, sourceSlug]);
}

/**
 * Clears the partial dispositions recorded below `maxInputChars` (page state, transcript state and `managed-atoms`
 * checkpoints), so the items they covered are offered again. Master's three statements, in order.
 */
export async function releasePartialAtomDispositions(raw: Raw, sourceId: string, maxInputChars: number): Promise<void> {
  for (const sql of RELEASE_PARTIAL_DISPOSITIONS_SQL) await raw.executeRaw(sql, [sourceId, maxInputChars]);
}
