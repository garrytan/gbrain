/**
 * Durable withdrawal survives deletion/recreation of the derived facts index.
 *
 * `subject` scopes a withdrawal to the entity whose fact was forgotten (the
 * withdrawn row's entity_slug). '*' applies to every subject: a subjectless
 * fact cannot say whom it was about, and rows recorded before subject scoping
 * keep their source-wide reach, so an upgrade never resurrects a forgotten
 * claim. A withdrawal matches a fact when `subject = '*' OR subject =
 * entity_slug`.
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
  `CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$
      SELECT encode(sha256(convert_to(regexp_replace(lower(btrim(claim)), '[[:space:]]+', ' ', 'g'), 'UTF8')), 'hex')
    $fn$`,
  `CREATE OR REPLACE FUNCTION gbrain_preserve_fact_withdrawal() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE withdrawn TIMESTAMPTZ;
    BEGIN
      IF NEW.expired_at IS NULL THEN
        -- Serializes insertion with source-locked withdrawal, including a
        -- concurrent reimport. Ordinary row locks work on both engines.
        PERFORM id FROM sources WHERE id = NEW.source_id FOR SHARE;
        SELECT min(withdrawn_at) INTO withdrawn FROM fact_withdrawals
          WHERE source_id = NEW.source_id AND visibility = NEW.visibility
            AND (subject = '*' OR subject = NEW.entity_slug)
            AND fact_hash = gbrain_fact_fingerprint(NEW.fact);
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

/** Rename/merge: withdrawals follow the entity ($1 source, $2 old slug, $3 new slug). */
export const MOVE_WITHDRAWAL_SUBJECT_SQL = `WITH moved AS (
    DELETE FROM fact_withdrawals WHERE source_id = $1 AND subject = $2 AND $2 <> $3
    RETURNING visibility, fact_hash, withdrawn_at
  )
  INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash, withdrawn_at)
  SELECT $1, visibility, $3, fact_hash, withdrawn_at FROM moved ON CONFLICT DO NOTHING`;
