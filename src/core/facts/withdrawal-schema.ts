/**
 * Characters folded to a space before hashing, so punctuation variants of one
 * claim share a fingerprint. Explicit (not [[:punct:]]) so the SQL and the JS
 * overlay agree regardless of database locale; non-ASCII letters survive.
 * `+` and `#` are kept ("C++", "C#", "F#" never collide with "C" or "F"), and a
 * dot folds only when a space, another dot or the end follows it, so sentence
 * periods fold while ".NET", "Node.js" and "3.5" keep theirs.
 */
export const FINGERPRINT_PUNCTUATION = '!"$%&\'()*,-/:;<=>?@[\\]^_`{|}~\u2018\u2019\u201a\u201c\u201d\u201e\u00ab\u00bb\u2039\u203a\u2013\u2014\u2015\u2026\u00b7\u2022\u00a1\u00bf';

/** JS twin of gbrain_fact_normalize for text the database already lowercased and space-collapsed. */
export function normalizeLoweredClaim(claim: string): string {
  let out = '';
  for (const char of claim) out += FINGERPRINT_PUNCTUATION.includes(char) ? ' ' : char;
  return out.replace(/ +/g, ' ').replace(/\.(?=[. ]|$)/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
}

// Built-ins are schema-qualified instead of pinning search_path on these SQL
// functions, which must stay inlinable (an index expression uses them); the
// results are byte-identical (test/fact-fingerprint-search-path.test.ts).
const NORMALIZE_CLAIM_SQL = `pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.lower(claim), '${FINGERPRINT_PUNCTUATION.replace(/'/g, "''")}', '${' '.repeat([...FINGERPRINT_PUNCTUATION].length)}'), '[[:space:]]+', ' ', 'g'), '\\.(?=[. ]|$)', ' ', 'g'), ' +', ' ', 'g'), ' ')`;

/** The fingerprint SQL functions, also re-created on their own by the search_path migration. */
export const FACT_FINGERPRINT_FUNCTION_STATEMENTS = [
  `CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint_v1(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(claim)), '[[:space:]]+', ' ', 'g'), 'UTF8')), 'hex')
    $fn$`,
  `CREATE OR REPLACE FUNCTION gbrain_fact_normalize(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$ SELECT ${NORMALIZE_CLAIM_SQL} $fn$`,
  // Inlined rather than calling gbrain_fact_normalize: index builds resolve
  // functions with a restricted search_path, so the index expression must
  // reference only built-ins.
  `CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$ SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${NORMALIZE_CLAIM_SQL}, 'UTF8')), 'hex') $fn$`,
] as const;

/**
 * Durable withdrawal survives deletion/recreation of the derived facts index.
 *
 * `subject` scopes a withdrawal to the entity whose fact was forgotten (the
 * withdrawn row's entity_slug). '*' applies to every subject: a subjectless
 * fact cannot say whom it was about, and rows recorded before subject scoping
 * keep their source-wide reach, so an upgrade never resurrects a forgotten
 * claim. A withdrawal matches a fact when `subject = '*' OR subject =
 * entity_slug`. Fingerprints fold case, whitespace and punctuation (v174);
 * ledger rows written earlier carry the exact v1 fingerprint and keep
 * matching through gbrain_fact_fingerprint_v1.
 */
export const FACT_WITHDRAWAL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS fact_withdrawals (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','world')),
    subject TEXT NOT NULL DEFAULT '*',
    fact_hash TEXT NOT NULL,
    withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, visibility, subject, fact_hash)
  )`,
  ...FACT_FINGERPRINT_FUNCTION_STATEMENTS,
  `CREATE OR REPLACE FUNCTION gbrain_preserve_fact_withdrawal() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
    DECLARE withdrawn TIMESTAMPTZ;
    BEGIN
      IF NEW.expired_at IS NULL THEN
        -- Serializes insertion with source-locked withdrawal, including a
        -- concurrent reimport. Ordinary row locks work on both engines.
        PERFORM id FROM sources WHERE id = NEW.source_id FOR SHARE;
        SELECT min(withdrawn_at) INTO withdrawn FROM fact_withdrawals
          WHERE source_id = NEW.source_id AND visibility = NEW.visibility
            AND (subject = '*' OR subject = NEW.entity_slug)
            AND fact_hash IN (gbrain_fact_fingerprint(NEW.fact), gbrain_fact_fingerprint_v1(NEW.fact));
        IF withdrawn IS NOT NULL THEN
          NEW.expired_at := withdrawn;
          NEW.valid_until := LEAST(COALESCE(NEW.valid_until, withdrawn), withdrawn);
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$`,
  `DROP TRIGGER IF EXISTS facts_preserve_withdrawal ON facts`,
  `CREATE TRIGGER facts_preserve_withdrawal BEFORE INSERT OR UPDATE OF fact, source_id, visibility, entity_slug, expired_at ON facts
    FOR EACH ROW EXECUTE FUNCTION gbrain_preserve_fact_withdrawal()`,
] as const;

export const FACT_WITHDRAWAL_SCHEMA_SQL = FACT_WITHDRAWAL_SCHEMA_STATEMENTS.join(';\n') + ';\n';

/** Only explicit existing withdrawal markers are safe to infer on upgrade. */
export const FACT_WITHDRAWAL_BACKFILL_SQL = `INSERT INTO fact_withdrawals(source_id, visibility, fact_hash, withdrawn_at)
  SELECT source_id, visibility, gbrain_fact_fingerprint(fact), min(expired_at)
  FROM facts WHERE expired_at IS NOT NULL AND context LIKE '%forgotten:%'
  GROUP BY source_id, visibility, gbrain_fact_fingerprint(fact)
  ON CONFLICT DO NOTHING`;

/** Subject-scoped withdrawal keys; existing rows keep the source-wide '*' subject. */
export const FACT_WITHDRAWAL_SUBJECT_SQL = `ALTER TABLE fact_withdrawals ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT '*';
ALTER TABLE fact_withdrawals DROP CONSTRAINT IF EXISTS fact_withdrawals_pkey;
ALTER TABLE fact_withdrawals ADD CONSTRAINT fact_withdrawals_pkey PRIMARY KEY (source_id, visibility, subject, fact_hash);
` + FACT_WITHDRAWAL_SCHEMA_SQL;

/**
 * Punctuation-folded fingerprints (migration v174). Existing rows keep their
 * exact (v1) hash and still match; a v2 row is added wherever a fact row still
 * carries the claim text, facts that became matching are expired like the
 * trigger would, and the fingerprint index keys claim lookups.
 */
export const FACT_WITHDRAWAL_NORMALIZED_SQL = FACT_WITHDRAWAL_SCHEMA_SQL + `
INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash, withdrawn_at)
  SELECT DISTINCT w.source_id, w.visibility, w.subject, gbrain_fact_fingerprint(f.fact), w.withdrawn_at
  FROM fact_withdrawals w JOIN facts f ON f.source_id = w.source_id AND f.visibility = w.visibility
    AND gbrain_fact_fingerprint_v1(f.fact) = w.fact_hash
  ON CONFLICT DO NOTHING;
DROP INDEX IF EXISTS idx_facts_withdrawal_fingerprint;
CREATE INDEX idx_facts_withdrawal_fingerprint ON facts (source_id, visibility, gbrain_fact_fingerprint(fact));
UPDATE facts f SET expired_at = w.withdrawn_at, valid_until = LEAST(COALESCE(f.valid_until, w.withdrawn_at), w.withdrawn_at)
  FROM (SELECT source_id, visibility, subject, fact_hash, min(withdrawn_at) AS withdrawn_at FROM fact_withdrawals
    GROUP BY source_id, visibility, subject, fact_hash) w
  WHERE f.expired_at IS NULL AND f.source_id = w.source_id AND f.visibility = w.visibility
    AND (w.subject = '*' OR w.subject = f.entity_slug) AND gbrain_fact_fingerprint(f.fact) = w.fact_hash;
`;

/** Rename/merge: withdrawals follow the entity ($1 source, $2 old slug, $3 new slug). */
export const MOVE_WITHDRAWAL_SUBJECT_SQL = `WITH moved AS (
    DELETE FROM fact_withdrawals WHERE source_id = $1 AND subject = $2 AND $2 <> $3
    RETURNING visibility, fact_hash, withdrawn_at
  )
  INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash, withdrawn_at)
  SELECT $1, visibility, $3, fact_hash, withdrawn_at FROM moved ON CONFLICT DO NOTHING`;
