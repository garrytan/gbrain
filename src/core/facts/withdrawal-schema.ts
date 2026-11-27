import { requireLedgerPoliciesSql } from '../derived-state-maintainers.ts';

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

/**
 * Whitespace the fact fingerprint and the fence overlay fold, as an explicit regex class: the code points Rust
 * `is_pg_space` (rust/crates/gbrain-store/src/cli_reads/pg_text.rs) and PGLite's `[[:space:]]` take. Postgres
 * `[[:space:]]` follows the database locale (en_US.utf8 leaves out U+0085 and adds U+1680), so a locale class would
 * give one claim two fingerprints across engines (v353).
 */
export const FACT_SPACE_CLASS = '[\\x09-\\x0d \\u0085\\u2000-\\u2006\\u2008-\\u200a\\u2028\\u2029\\u205f\\u3000]';

// Built-ins are schema-qualified instead of pinning search_path on these SQL
// functions, which must stay inlinable (an index expression uses them); the
// results are byte-identical (test/fact-fingerprint-search-path.test.ts).
const normalizeClaimSql = (space: string) => `pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.lower(claim), '${FINGERPRINT_PUNCTUATION.replace(/'/g, "''")}', '${' '.repeat([...FINGERPRINT_PUNCTUATION].length)}'), '${space}+', ' ', 'g'), '\\.(?=[. ]|$)', ' ', 'g'), ' +', ' ', 'g'), ' ')`;
const NORMALIZE_CLAIM_SQL = normalizeClaimSql(FACT_SPACE_CLASS);
const fingerprintBody = (space: string) => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${normalizeClaimSql(space)}, 'UTF8')), 'hex')`;

/** SQL: `claim` holds a FACT_SPACE_CLASS character the locale's `[[:space:]]` leaves out (U+0085 on en_US.utf8). */
const keepsListSpaceSql = (claim: string) =>
  `pg_catalog.regexp_replace(${claim}, '[[:space:]]', '', 'g') OPERATOR(pg_catalog.~) '${FACT_SPACE_CLASS}'`;
/** SQL: `claim` holds a character the locale's `[[:space:]]` takes and FACT_SPACE_CLASS leaves out (U+1680 on en_US.utf8). */
const localeOnlySpaceSql = (claim: string) =>
  `pg_catalog.regexp_replace(${claim}, '${FACT_SPACE_CLASS}', '', 'g') OPERATOR(pg_catalog.~) '[[:space:]]'`;

/**
 * The v2 fingerprint (`gbrain_fact_fingerprint` before v353: whitespace by the locale's `[[:space:]]`) of SQL
 * expression `claim`, spelled with built-ins only so a guard function can match a legacy ledger hash at any migration
 * point, before v353 creates gbrain_fact_fingerprint_v2.
 */
export function factFingerprintV2Sql(claim: string): string {
  return fingerprintBody('[[:space:]]').replace(/\bclaim\b/g, () => claim);
}

/**
 * `factFingerprintV2Sql(claim)` where no current fingerprint can equal it, else NULL: the old fold left a character of
 * FACT_SPACE_CLASS in place (U+0085 on en_US.utf8), which the current fold never leaves. Where the old fold folded a
 * character the current one keeps (U+1680), the v2 hash is the current hash of another spelling, so a ledger row under it
 * may be that spelling's and matching it would differ from PGLite and the Rust store; such a row matches that spelling only.
 */
export function legacyFingerprintV2Sql(claim: string): string {
  return `CASE WHEN ${keepsListSpaceSql(claim)} THEN ${factFingerprintV2Sql(claim)} END`;
}

/** Every character either fold (the current class, any locale's `[[:space:]]`) may treat as space outside ASCII; a claim with none has one fingerprint. */
const FOLDS_MAY_DIFFER = /[\u0085\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/** Whether `claim`'s v2 fingerprint may differ from its current one (no query is needed for any other claim). */
export const mayHaveLegacyFingerprint = (claim: string): boolean => FOLDS_MAY_DIFFER.test(claim);

/** The fingerprint SQL functions, also re-created on their own by the search_path migration. */
export const FACT_FINGERPRINT_FUNCTION_STATEMENTS = [
  // _v1 and _v2 fold whitespace by the locale's [[:space:]]. Where that folds a character the current fold keeps
  // (U+1680 on en_US.utf8), the old hash is the current hash of another spelling ("X Y" for "X\u1680Y"), so matching it
  // would let a withdrawal or purge of that spelling reach this claim on Postgres only; there each answers NULL, as
  // legacyFingerprintV2Sql. PGLite's [[:space:]] is the explicit list, so there _v1 is unchanged and _v2 is NULL (it
  // equals the current fingerprint).
  `CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint_v1(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$
      SELECT CASE WHEN ${keepsListSpaceSql('claim')} OR NOT ${localeOnlySpaceSql('claim')} THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(claim)), '[[:space:]]+', ' ', 'g'), 'UTF8')), 'hex') END
    $fn$`,
  `CREATE OR REPLACE FUNCTION gbrain_fact_normalize(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$ SELECT ${NORMALIZE_CLAIM_SQL} $fn$`,
  // Inlined rather than calling gbrain_fact_normalize: index builds resolve
  // functions with a restricted search_path, so the index expression must
  // reference only built-ins.
  `CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$ SELECT ${fingerprintBody(FACT_SPACE_CLASS)} $fn$`,
  // v353: the current fingerprint under its version name, and the locale-folded one every ledger hash Postgres
  // stored before v353 carries (where no current fingerprint can equal it). A ledger hash matches a claim by any of
  // fingerprint, _v2 and _v1.
  `CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint_v3(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$ SELECT ${fingerprintBody(FACT_SPACE_CLASS)} $fn$`,
  `CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint_v2(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$ SELECT ${legacyFingerprintV2Sql('claim')} $fn$`,
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
 * matching through gbrain_fact_fingerprint_v1, and rows Postgres wrote before
 * v353 folded whitespace by locale and keep matching through _v2.
 */
/**
 * GBRA-574 A1: whether row `r`'s entity is unbacked, as SQL: a bare name key (no directory, the form conversation
 * extraction keeps for a full name with no page, entities/resolve-on-save.ts) with no live page at that slug in the
 * row's source (`source`, default `r.source_id`). Withdrawal and purge treat such a fact as subject '*': forgetting or
 * purging it is source-wide, and a withdrawal or tombstone of its claim under any subject reaches it, so a later page or
 * re-key never brings a forgotten claim back. Spelled here so the guards import no module outside the schema inputs.
 */
export function unbackedEntitySql(r: string, source = `${r}.source_id`): string {
  return `COALESCE(strpos(${r}.entity_slug, '/') = 0 AND NOT EXISTS (SELECT 1 FROM pages unbacked_page
    WHERE unbacked_page.source_id = ${source} AND unbacked_page.slug = ${r}.entity_slug AND unbacked_page.deleted_at IS NULL), false)`;
}

/**
 * GBRA-574: whether withdrawal subject `subject` (SQL) is an owned memory page (a member page or the scope page). Such a
 * withdrawal stays on that page (GST-359 D, GST-2346), so it never reaches a row on an unbacked name key.
 */
export function ownedMemorySubjectSql(subject: string): string {
  return `(starts_with(${subject}, 'memory/members/') OR ${subject} = 'memory/scope')`;
}

/**
 * The insert and update guard that stamps a row matching a withdrawal as withdrawn. GST-2346: a row on a member page
 * (memory/members/<id>) matches only that page's own withdrawals: it is its member's own, a withdrawal made later still expires it, and the member's
 * save checks the withdrawals of claims that member reads (facts/single-prepare.ts), so a claim it never read cannot
 * expire the row it saves. GBRA-574: a row on an unbacked name key matches a withdrawal of its claim under any subject but an owned memory page. #7632/#7659: a writing role that RLS keeps from reading fact_withdrawals is refused
 * (derived-state-maintainers.ts requireLedgerPoliciesSql) instead of saving the row active. Re-created alone by the
 * member_page_withdrawal_scope and guard_ledgers_fail_closed migrations.
 */
export const FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION gbrain_preserve_fact_withdrawal() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
    DECLARE withdrawn TIMESTAMPTZ;
    BEGIN
      IF NEW.expired_at IS NULL THEN
        ${requireLedgerPoliciesSql('fact_withdrawals', ['SELECT'], '        ')}
        -- Serializes insertion with source-locked withdrawal, including a
        -- concurrent reimport. Ordinary row locks work on both engines.
        PERFORM id FROM sources WHERE id = NEW.source_id FOR SHARE;
        SELECT min(withdrawn_at) INTO withdrawn FROM fact_withdrawals
          WHERE source_id = NEW.source_id AND visibility = NEW.visibility
            AND (CASE WHEN starts_with(COALESCE(NEW.source_markdown_slug, ''), 'memory/members/') THEN subject = NEW.source_markdown_slug
              ELSE subject = '*' OR subject = NEW.entity_slug OR (${unbackedEntitySql('NEW')} AND NOT ${ownedMemorySubjectSql('subject')}) END)
            AND fact_hash IN (gbrain_fact_fingerprint(NEW.fact), ${legacyFingerprintV2Sql('NEW.fact')}, gbrain_fact_fingerprint_v1(NEW.fact));
        IF withdrawn IS NOT NULL THEN
          NEW.expired_at := withdrawn;
          NEW.valid_until := LEAST(COALESCE(NEW.valid_until, withdrawn), withdrawn);
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$`;

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
  FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL,
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
