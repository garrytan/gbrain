/**
 * Memory trust tiers (#5575) in the database: the `trust_tier` and
 * `write_origin` columns, the BEFORE ROW trigger that stamps and guards them,
 * the page_versions snapshot, the per-token `min_trust` read floor and the
 * `trust_proposals` decision record. One canonical copy used by the trust
 * tiers schema migration. Like the attribution DDL it is not in the schema
 * blob: a fresh install replays every migration.
 *
 * The writer's tier reaches the trigger through transaction-local settings
 * that the attribution seam sets (persistence/context.ts):
 *   gbrain.write_trust_tier       the effective tier (trust/tier.ts computes it once)
 *   gbrain.write_origin           its origin record, JSON text
 *   gbrain.write_trust_promotion  a tier ceiling for an explicit raise (owner confirmation, CEO-9)
 *   gbrain.write_trust_backfill   'on' for the deterministic backfill (CEO-10)
 *   gbrain.write_trust_keep       comma list of tables whose content rewrites in this scope keep the
 *                                 stored tier: a gbrain-managed fence edit (remember/takes fence append,
 *                                 forget or accept strike) rewrites the page body without authoring it,
 *                                 and the fence row carries its own tier (ENG-1)
 *
 * Trigger semantics (CEO-12, CEO-16, CEO-10, ENG-13):
 * - INSERT: the row gets the writer's tier, or `unknown` without one; a
 *   supplied value is honored only under the backfill setting (never above
 *   operator_curated without promotion).
 * - UPDATE that changes a TRUST_CONTENT_COLUMNS column: an owner-tier writer
 *   (operator_curated or higher) restamps the row to its tier; any lower
 *   writer (or none, read as `unknown`) sets min(prior tier, writer tier).
 * - UPDATE that changes no content column keeps the stored tier, and so does
 *   a content change on a table named by gbrain.write_trust_keep (a fence
 *   edit; it can still lower, never raise).
 * - An UPDATE that sets a higher tier is honored under a covering promotion
 *   ceiling, or under the backfill setting from `unknown` to anything below
 *   user_confirmed. Inside a writer scope it is otherwise clamped back; with
 *   no writer scope it raises `trust_raise_refused`. Lowering is always allowed.
 * - A writer tier above operator_curated needs a covering promotion ceiling.
 *
 * `gbrain.write_trust_promotion` protects against bugs, not against a process
 * holding a raw database connection, which can set any setting.
 */
import { HASH_EPHEMERAL_FRONTMATTER_KEYS } from '../utils.ts';
import { OWNER_TIER_FLOOR, TRUST_TIERS, trustRankSql } from './tier.ts';

export type TrustTable = 'facts' | 'takes' | 'timeline_entries' | 'pages';
export const TRUST_TABLES: readonly TrustTable[] = ['facts', 'takes', 'timeline_entries', 'pages'];
/** Config key: when the last complete backfill apply finished (doctor `trust_tiers` stops recommending the backfill). */
export const TRUST_BACKFILL_COMPLETED_KEY = 'trust.backfill_completed_at';

/**
 * Frontmatter keys whose change is not a content change for the tier rule:
 * the hash-ephemeral keys (timestamps and gate-owned markers re-derived on
 * every import) and the stored quarantine override. The lower-only
 * `trust_tier` marker is content on purpose: deleting it by hand is the
 * owner act that lets the next owner sync restamp the page (CEO-21).
 */
export const TRUST_EPHEMERAL_FRONTMATTER_KEYS: readonly string[] = [...HASH_EPHEMERAL_FRONTMATTER_KEYS.filter(key => key !== 'trust_tier'), 'quarantine_override'];

/**
 * ENG-2: the columns whose change is a content rewrite. Lifecycle and
 * placement columns (expiry, supersession, consolidation, row numbers,
 * visibility, notability, confidence, active, resolution, weight, source)
 * keep the stored tier. Pages use the pages_knowledge_revision tuple
 * (page-state/schema.ts) with the ephemeral frontmatter keys removed.
 * Pinned by test/trust-tier-schema.test.ts.
 */
export const TRUST_CONTENT_COLUMNS: Readonly<Record<TrustTable, readonly string[]>> = {
  facts: ['fact', 'entity_slug', 'kind', 'claim_metric', 'claim_value', 'claim_unit', 'claim_period', 'value', 'event_type', 'dimension', 'context'],
  takes: ['claim', 'kind', 'holder'],
  timeline_entries: ['summary', 'detail', 'date'],
  pages: ['source_id', 'slug', 'type', 'page_kind', 'title', 'compiled_truth', 'timeline', 'frontmatter', 'deleted_at'],
};

/** Columns the migration adds to every trust table (and to page_versions, nullable there). */
export const TRUST_ROW_COLUMNS = ['trust_tier', 'write_origin'] as const;

export const TRUST_TIER_TRIGGER = 'trust_tier_stamp';
export const TRUST_VERSION_TRIGGER = 'page_versions_trust_snapshot';
/** Triggers that must fire before the tier trigger on the same row (PostgreSQL fires same-timing triggers by name). */
export const TRUST_TIER_TRIGGER_PREDECESSORS: Readonly<Record<TrustTable, readonly string[]>> = {
  facts: ['facts_preserve_withdrawal', 'gbrain_write_attribution', 'managed_writer_guard'],
  takes: ['gbrain_write_attribution', 'managed_writer_guard'],
  timeline_entries: ['gbrain_write_attribution', 'managed_writer_guard'],
  pages: ['managed_writer_guard', 'pages_knowledge_revision', 'pages_revision_attribution', 'trg_pages_search_vector'],
};

const tierList = TRUST_TIERS.map(tier => `'${tier}'`).join(',');
const rank = trustRankSql;
const lowerOf = (a: string, b: string) => `(CASE WHEN ${rank(a)} <= ${rank(b)} THEN ${a} ELSE ${b} END)`;
const contentExpr = (row: 'NEW' | 'OLD', table: TrustTable) => TRUST_CONTENT_COLUMNS[table]
  .map(column => table === 'pages' && column === 'frontmatter'
    // A non-object frontmatter (legacy or raw-SQL rows) has no keys to drop; jsonb `-` would raise on it.
    ? `(CASE WHEN jsonb_typeof(${row}.frontmatter) = 'object' THEN ${row}.frontmatter - ARRAY[${TRUST_EPHEMERAL_FRONTMATTER_KEYS.map(key => `'${key}'`).join(',')}]::text[] ELSE ${row}.frontmatter END)`
    : `${row}.${column}`)
  .join(', ');
const contentChanged = (table: TrustTable) => `(${contentExpr('NEW', table)}) IS DISTINCT FROM (${contentExpr('OLD', table)})`;
const refuse = (message: string, detail: string) => `RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='trust_raise_refused: ${message}',
      TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='trust_tier_guard', DETAIL=${detail}`;
const SETTINGS = `
  writer := NULLIF(current_setting('gbrain.write_trust_tier', true), '');
  origin_text := NULLIF(current_setting('gbrain.write_origin', true), '');
  promo := NULLIF(current_setting('gbrain.write_trust_promotion', true), '');
  backfill := COALESCE(current_setting('gbrain.write_trust_backfill', true), '') = 'on';
  keep := TG_TABLE_NAME = ANY(string_to_array(COALESCE(current_setting('gbrain.write_trust_keep', true), ''), ','));
  IF ${rank('writer')} = 0 AND writer IS NOT NULL OR ${rank('promo')} = 0 AND promo IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='gbrain trust setting names no tier', CONSTRAINT='trust_tier_guard';
  END IF;`;

const STAMP_TIER_FUNCTION = `CREATE OR REPLACE FUNCTION gbrain_stamp_trust_tier() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE writer text; origin_text text; promo text; backfill boolean; keep boolean; changed boolean; effective text;
BEGIN${SETTINGS}
  IF ${rank('writer')} > ${rank(`'${OWNER_TIER_FLOOR}'`)} AND (promo IS NULL OR ${rank('writer')} > ${rank('promo')}) THEN
    ${refuse('a write declared a tier above operator_curated without owner confirmation', `jsonb_build_object('op',TG_OP,'writer',writer)::text`)};
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF backfill THEN
      IF ${rank('NEW.trust_tier')} > ${rank(`'${OWNER_TIER_FLOOR}'`)} AND (promo IS NULL OR ${rank('NEW.trust_tier')} > ${rank('promo')}) THEN
        ${refuse('a copied row named a tier above operator_curated without owner confirmation', `jsonb_build_object('op',TG_OP,'to',NEW.trust_tier)::text`)};
      END IF;
      RETURN NEW;
    END IF;
    NEW.trust_tier := COALESCE(writer, 'unknown');
    NEW.write_origin := origin_text::jsonb;
    RETURN NEW;
  END IF;
  IF ${rank('NEW.trust_tier')} > ${rank('OLD.trust_tier')} THEN
    IF promo IS NOT NULL AND ${rank('NEW.trust_tier')} <= ${rank('promo')} THEN
      RETURN NEW;
    ELSIF backfill AND OLD.trust_tier = 'unknown' AND NEW.trust_tier <> 'user_confirmed' THEN
      RETURN NEW;
    ELSIF writer IS NULL THEN
      ${refuse('raising a tier needs owner confirmation', `jsonb_build_object('op',TG_OP,'from',OLD.trust_tier,'to',NEW.trust_tier,'backfill',backfill)::text`)};
    END IF;
    NEW.trust_tier := OLD.trust_tier;
  END IF;
  ${TRUST_TABLES.map((table, index) => `${index === 0 ? 'IF' : 'ELSIF'} TG_TABLE_NAME = '${table}' THEN
    changed := ${contentChanged(table)};`).join('\n  ')}
  ELSE
    RAISE EXCEPTION 'gbrain_stamp_trust_tier is not classified for table %', TG_TABLE_NAME;
  END IF;
  IF changed AND NOT keep THEN
    effective := COALESCE(writer, 'unknown');
    IF ${rank('effective')} < ${rank(`'${OWNER_TIER_FLOOR}'`)} THEN effective := ${lowerOf('OLD.trust_tier', 'effective')}; END IF;
    IF ${rank('NEW.trust_tier')} < ${rank('OLD.trust_tier')} THEN effective := ${lowerOf('NEW.trust_tier', 'effective')}; END IF;
    NEW.trust_tier := effective;
    IF NEW.write_origin IS NOT DISTINCT FROM OLD.write_origin THEN NEW.write_origin := origin_text::jsonb; END IF;
  END IF;
  RETURN NEW;
END $fn$`;

/**
 * A version row snapshots the page before the archiving write changes it, in
 * the same transaction, so the page row still carries the snapshotted tier
 * (ENG-10). A supplied value is honored only under the backfill setting.
 */
const SNAPSHOT_VERSION_FUNCTION = `CREATE OR REPLACE FUNCTION gbrain_snapshot_version_trust() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF COALESCE(current_setting('gbrain.write_trust_backfill', true), '') = 'on' AND NEW.trust_tier IS NOT NULL THEN RETURN NEW; END IF;
  SELECT p.trust_tier, p.write_origin INTO NEW.trust_tier, NEW.write_origin FROM pages p WHERE p.id = NEW.page_id;
  RETURN NEW;
END $fn$`;

/** NOT VALID first (no scan under the ADD), then a separate validation pass. */
const checkConstraint = (table: string, name: string, predicate: string) => [
  `DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = '${table}'::regclass) THEN
      ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${predicate}) NOT VALID;
    END IF;
  END $do$`,
  `ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`,
];

export const TRUST_PROPOSAL_ACTIONS = ['supersede_fact', 'supersede_take', 'forget', 'lower_page', 'confirm'] as const;
export const TRUST_PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected', 'undone', 'superseded'] as const;
const list = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');
const TRUST_TABLE_LIST = list(TRUST_TABLES);

/**
 * ENG-4: one typed trust-decision record. Handlers (lane L1) reuse the
 * decide_proposals coordinator primitives; CLI refs are `tp<id>`. `target`
 * is the row the decision changes; `related` is the row that caused it (the
 * contested lower-tier fact of a guarded supersession, the agent version of a
 * lowered page). before_state/after_state hold tiers, ids and revisions, the
 * exact state the accept path re-checks under lock.
 */
const TRUST_PROPOSALS_DDL = `CREATE TABLE IF NOT EXISTS trust_proposals (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN (${list(TRUST_PROPOSAL_ACTIONS)})),
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  target_table TEXT NOT NULL CHECK (target_table IN (${TRUST_TABLE_LIST})),
  target_id BIGINT NOT NULL,
  related_table TEXT CHECK (related_table IN (${TRUST_TABLE_LIST})),
  related_id BIGINT,
  before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposer TEXT NOT NULL,
  proposer_principal_kind TEXT,
  proposer_principal_id TEXT,
  write_request_id UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (${list(TRUST_PROPOSAL_STATUSES)})),
  decided_at TIMESTAMPTZ,
  decided_principal_kind TEXT,
  decided_principal_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((related_table IS NULL) = (related_id IS NULL))
)`;

export const TRUST_SCHEMA_STATEMENTS = [
  ...TRUST_TABLES.map(table => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS trust_tier TEXT NOT NULL DEFAULT 'unknown', ADD COLUMN IF NOT EXISTS write_origin JSONB`),
  ...TRUST_TABLES.flatMap(table => checkConstraint(table, `${table}_trust_tier_check`, `trust_tier IN (${tierList})`)),
  `ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS trust_tier TEXT, ADD COLUMN IF NOT EXISTS write_origin JSONB`,
  ...checkConstraint('page_versions', 'page_versions_trust_tier_check', `trust_tier IS NULL OR trust_tier IN (${tierList})`),
  ...['oauth_clients', 'access_tokens'].flatMap(table => [
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS min_trust TEXT`,
    ...checkConstraint(table, `${table}_min_trust_check`, `min_trust IS NULL OR min_trust IN (${tierList})`),
  ]),
  TRUST_PROPOSALS_DDL,
  `CREATE INDEX IF NOT EXISTS trust_proposals_pending_idx ON trust_proposals (source_id, created_at) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS trust_proposals_target_idx ON trust_proposals (target_table, target_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trust_proposals_pending_unique ON trust_proposals
    (action, target_table, target_id, COALESCE(related_table, ''), COALESCE(related_id, 0)) WHERE status = 'pending'`,
  STAMP_TIER_FUNCTION,
  SNAPSHOT_VERSION_FUNCTION,
  ...TRUST_TABLES.flatMap(table => [
    `DROP TRIGGER IF EXISTS ${TRUST_TIER_TRIGGER} ON ${table}`,
    `CREATE TRIGGER ${TRUST_TIER_TRIGGER} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION gbrain_stamp_trust_tier()`,
  ]),
  `DROP TRIGGER IF EXISTS ${TRUST_VERSION_TRIGGER} ON page_versions`,
  `CREATE TRIGGER ${TRUST_VERSION_TRIGGER} BEFORE INSERT ON page_versions FOR EACH ROW EXECUTE FUNCTION gbrain_snapshot_version_trust()`,
] as const;

export const TRUST_SCHEMA_SQL = `${TRUST_SCHEMA_STATEMENTS.join(';\n')};\n`;
