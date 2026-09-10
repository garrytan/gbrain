/** Durable withdrawal survives deletion/recreation of the derived facts index. */
export const FACT_WITHDRAWAL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS fact_withdrawals (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','world')),
    fact_hash TEXT NOT NULL,
    withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, visibility, fact_hash)
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
        SELECT withdrawn_at INTO withdrawn FROM fact_withdrawals
          WHERE source_id = NEW.source_id AND visibility = NEW.visibility
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
  `CREATE TRIGGER facts_preserve_withdrawal BEFORE INSERT OR UPDATE OF fact, source_id, visibility, expired_at ON facts
    FOR EACH ROW EXECUTE FUNCTION gbrain_preserve_fact_withdrawal()`,
] as const;

export const FACT_WITHDRAWAL_SCHEMA_SQL = FACT_WITHDRAWAL_SCHEMA_STATEMENTS.join(';\n') + ';\n';

/** Only explicit existing withdrawal markers are safe to infer on upgrade. */
export const FACT_WITHDRAWAL_BACKFILL_SQL = `INSERT INTO fact_withdrawals(source_id, visibility, fact_hash, withdrawn_at)
  SELECT source_id, visibility, gbrain_fact_fingerprint(fact), min(expired_at)
  FROM facts WHERE expired_at IS NOT NULL AND context LIKE '%forgotten:%'
  GROUP BY source_id, visibility, gbrain_fact_fingerprint(fact)
  ON CONFLICT DO NOTHING`;
