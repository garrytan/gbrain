/**
 * The extract_atoms phase's ledger writes and its transcript-key reads (cycle/extract-atoms-page-state.ts,
 * cycle/extract-atoms-input.ts, cycle/extract-atoms.ts, cycle/extract-atoms-generation.ts): the page identity read,
 * the page and transcript rows of `extract_atoms_page_state` and `extract_atoms_transcript_state`, and the
 * derived-generation and page reads that resolve a transcript's key and atom slug, and the conversation-page read of the
 * transcript page index (transcripts/discover.ts indexTranscriptPages). Each statement is the text those
 * functions sent through `executeRaw`, unchanged; the page-state write is sync 21's text (GST-4020 #10542)
 * (test/extract-atoms-state-sql-pin.test.ts pins each one against master). The Rust store serves them from its ledger
 * records (store format 17, rust/docs/store/extract-atoms.md); its page-state write predates GST-4020's digest and read
 * clock and is not reached while the Rust engine refuses `listExtractablePages`.
 */
type Raw = { executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> };

/** The page a ledger write pins: the identity discovery read, and the content and slug it read. */
export interface AtomPagePin {
  pageId: number;
  sourceIncarnation: string;
  sourceId: string;
  slug: string;
  contentHash: string;
  revision: string;
}

/** A live transcript generation of a kind: its id, key, locator and input pin. */
export interface LiveTranscriptGeneration { id: number; owner_key: string; locator: string | null; input_pin: string | null }

export const ATOM_PAGE_IDENTITY_SQL = `SELECT p.id, s.incarnation, p.knowledge_revision FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.source_id=$1 AND p.slug=$2 AND p.content_hash=$3 AND p.deleted_at IS NULL`;

export const ATOM_PAGE_STATE_SQL = `INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned, input_sha256, updated_at)
      SELECT s.incarnation, p.id, p.content_hash, $7::integer, $8::boolean, $9::text, CASE WHEN $8::boolean THEN COALESCE($10::timestamptz, now()) ELSE now() END
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.id=$1 AND s.incarnation=$2::uuid AND p.source_id=$3 AND p.slug=$4
        AND p.content_hash=$5 AND p.knowledge_revision=$6::uuid AND p.deleted_at IS NULL
      FOR SHARE OF p, s
      ON CONFLICT (source_incarnation, page_id, content_hash) DO UPDATE
        SET fail_count=extract_atoms_page_state.fail_count + EXCLUDED.fail_count,
            tombstoned=EXCLUDED.tombstoned, input_sha256=EXCLUDED.input_sha256,
            updated_at=CASE WHEN EXCLUDED.tombstoned THEN EXCLUDED.updated_at ELSE extract_atoms_page_state.updated_at END
      RETURNING fail_count`;

export const ATOM_PAGE_PARTIAL_SQL = `INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned, partial_input_chars)
      SELECT s.incarnation, p.id, p.content_hash, 0, false, $7::integer
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.id=$1 AND s.incarnation=$2::uuid AND p.source_id=$3 AND p.slug=$4
        AND p.content_hash=$5 AND p.knowledge_revision=$6::uuid AND p.deleted_at IS NULL
      FOR SHARE OF p, s
      ON CONFLICT (source_incarnation, page_id, content_hash) DO UPDATE
        SET partial_input_chars=EXCLUDED.partial_input_chars, updated_at=now()
      RETURNING page_id`;

export const ATOM_TRANSCRIPT_PARTIAL_SQL = `INSERT INTO extract_atoms_transcript_state (source_id, file_path, content_hash, fail_count, tombstoned, partial_input_chars, updated_at)
       VALUES ($1, $2, $3, 0, FALSE, $4, now())
       ON CONFLICT (source_id, file_path, content_hash) DO UPDATE SET partial_input_chars=EXCLUDED.partial_input_chars, updated_at=now()`;

export const ATOM_TRANSCRIPT_TOMBSTONE_SQL = `INSERT INTO extract_atoms_transcript_state (source_id, file_path, content_hash, fail_count, tombstoned, updated_at)
       VALUES ($1, $2, $3, 0, TRUE, now())
       ON CONFLICT (source_id, file_path, content_hash) DO UPDATE SET tombstoned = TRUE, updated_at = now()`;

export const ATOM_TRANSCRIPT_STRIKE_SQL = `INSERT INTO extract_atoms_transcript_state
             (source_id, file_path, content_hash, fail_count, updated_at)
           VALUES ($1, $2, $3, 1, now())
           ON CONFLICT (source_id, file_path, content_hash)
           DO UPDATE SET fail_count = extract_atoms_transcript_state.fail_count + 1,
                         updated_at = now()
           RETURNING fail_count AS cnt`;

export const LIVE_TRANSCRIPT_GENERATIONS_SQL = `SELECT id, owner_key, locator, input_pin FROM derived_generations WHERE source_id=$1 AND kind=$2 AND state='live' AND owner_key LIKE $3`;

export const MOVE_GENERATION_LOCATOR_SQL = `UPDATE derived_generations SET locator=$2, updated_at=now() WHERE id=$1`;

export const LIVE_PAGE_SOURCE_PATH_SQL = `SELECT frontmatter->>'source_path' AS source_path FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`;

export const LIVE_GENERATION_LOCATOR_SQL = `SELECT locator FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`;

/** The live page of `sourceId` with this slug and content hash: its id, its source's incarnation and its revision. */
export async function readAtomPageIdentity(raw: Raw, sourceId: string, slug: string, contentHash: string): Promise<{ id: number; incarnation: string; knowledge_revision: string } | null> {
  const [row] = await raw.executeRaw<{ id: number; incarnation: string; knowledge_revision: string }>(ATOM_PAGE_IDENTITY_SQL, [sourceId, slug, contentHash]);
  return row ?? null;
}

/**
 * The pinned page's row gains `failIncrement` failures and is tombstoned (completed) when `tombstone`, and otherwise
 * loses its completion (GST-4020): the row's fail count, or null when the page no longer matches the pin. A completion
 * stores `inputSha256` (the model input's digest) and is stamped at `readAt`, the database time discovery read the
 * page (now() when absent); a failure keeps the row's time. Sync 21's statement and parameters (GST-4020 #10542).
 */
export async function writeAtomPageState(raw: Raw, pin: AtomPagePin, failIncrement: number, tombstone: boolean,
  inputSha256: string | null = null, readAt: string | null = null): Promise<number | null> {
  const [row] = await raw.executeRaw<{ fail_count: number }>(ATOM_PAGE_STATE_SQL,
    [pin.pageId, pin.sourceIncarnation, pin.sourceId, pin.slug, pin.contentHash, pin.revision, failIncrement, tombstone, inputSha256, readAt]);
  return row ? Number(row.fail_count) : null;
}

/** The pinned page's row records the input cap it was cut at; false when the page no longer matches the pin. */
export async function recordAtomPagePartial(raw: Raw, pin: AtomPagePin, maxInputChars: number): Promise<boolean> {
  const rows = await raw.executeRaw(ATOM_PAGE_PARTIAL_SQL,
    [pin.pageId, pin.sourceIncarnation, pin.sourceId, pin.slug, pin.contentHash, pin.revision, maxInputChars]);
  return rows.length > 0;
}

/** The transcript's row records the input cap it was cut at. `contentHash` is the 16-character prefix. */
export async function recordAtomTranscriptPartial(raw: Raw, sourceId: string, filePath: string, contentHash: string, maxInputChars: number): Promise<void> {
  await raw.executeRaw(ATOM_TRANSCRIPT_PARTIAL_SQL, [sourceId, filePath, contentHash, maxInputChars]);
}

/** The transcript's row is tombstoned. `contentHash` is the 16-character prefix. */
export async function stampAtomTranscriptTombstone(raw: Raw, sourceId: string, filePath: string, contentHash: string): Promise<void> {
  await raw.executeRaw(ATOM_TRANSCRIPT_TOMBSTONE_SQL, [sourceId, filePath, contentHash]);
}

/** One more failure of the transcript (a new row starts at 1): the count. `contentHash` is the 16-character prefix. */
export async function strikeAtomTranscript(raw: Raw, sourceId: string, filePath: string, contentHash: string): Promise<number | null> {
  const rows = await raw.executeRaw<{ cnt: number | string }>(ATOM_TRANSCRIPT_STRIKE_SQL, [sourceId, filePath, contentHash]);
  const cnt = rows[0]?.cnt;
  return cnt == null ? null : Number(cnt);
}

/** The live generations of `sourceId` and `kind` whose owner key starts with `keyPrefix` (no LIKE wildcard in it). */
export async function listLiveTranscriptGenerations(raw: Raw, sourceId: string, kind: string, keyPrefix: string): Promise<LiveTranscriptGeneration[]> {
  return raw.executeRaw<LiveTranscriptGeneration>(LIVE_TRANSCRIPT_GENERATIONS_SQL, [sourceId, kind, `${keyPrefix}%`]);
}

/** Points the generation `id` at `locator` (a moved transcript file). */
export async function moveGenerationLocator(raw: Raw, id: number, locator: string): Promise<void> {
  await raw.executeRaw(MOVE_GENERATION_LOCATOR_SQL, [id, locator]);
}

/** The `source_path` frontmatter of the live page of `sourceId` with this slug; undefined when there is no such page. */
export async function readLivePageSourcePath(raw: Raw, sourceId: string, slug: string): Promise<{ source_path: string | null } | undefined> {
  const [row] = await raw.executeRaw<{ source_path: string | null }>(LIVE_PAGE_SOURCE_PATH_SQL, [sourceId, slug]);
  return row;
}

/** The locator of the live generation of `sourceId`, `kind` and `ownerKey`; undefined when there is none. */
export async function readLiveGenerationLocator(raw: Raw, sourceId: string, kind: string, ownerKey: string): Promise<{ locator: string | null } | undefined> {
  const [row] = await raw.executeRaw<{ locator: string | null }>(LIVE_GENERATION_LOCATOR_SQL, [sourceId, kind, ownerKey]);
  return row;
}

export const CONVERSATION_PAGE_FRONTMATTER_SQL = `SELECT slug, frontmatter FROM pages
     WHERE type = 'conversation' AND source_id = $1 AND deleted_at IS NULL`;

/** The slug and frontmatter of each live conversation page of `sourceId` (the transcript page index of the phase). */
export async function listConversationPageFrontmatter(raw: Raw, sourceId: string): Promise<Array<{ slug: string; frontmatter: unknown }>> {
  return raw.executeRaw<{ slug: string; frontmatter: unknown }>(CONVERSATION_PAGE_FRONTMATTER_SQL, [sourceId]);
}
