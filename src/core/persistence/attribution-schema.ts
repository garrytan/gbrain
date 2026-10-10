/**
 * Write attribution (Foundations 1, F1): which journal request and principal
 * wrote each content row and each live page revision. One canonical copy used
 * by the f1_write_attribution schema migration. Like the facts/takes DDL it
 * is not in the schema blob: a fresh install replays every migration, so the
 * columns land after every migration-added column on fresh and upgraded
 * brains alike, and no trigger can run before the columns it names exist.
 *
 * The actor reaches the database as three transaction-local settings that
 * withCoordinatedWrite / withWriteAttribution set (persistence/context.ts):
 * gbrain.write_request (persistence_requests.id, empty for maintenance),
 * gbrain.write_principal_kind and gbrain.write_principal_id. BEFORE ROW
 * triggers copy them into the rows, so no INSERT/UPDATE site carries
 * attribution itself. Every column is nullable with no default (metadata-only
 * ADD COLUMN on both engines, #5216). All-NULL reads as "unrecorded".
 *
 * A column added to facts, takes or timeline_entries must be classified here
 * (content or projection) and the trigger function re-created by that
 * migration (re-run WRITE_ATTRIBUTION_SCHEMA_SQL, as v192 re-runs the writer
 * guard); the classification test in test/write-attribution.test.ts fails
 * until it is.
 */
import { TRUST_ROW_COLUMNS } from '../trust/schema.ts';

/** created_by and last_mutated_by on facts, takes and timeline_entries. */
export const ROW_ATTRIBUTION_COLUMNS = [
  'write_request_id', 'write_principal_kind', 'write_principal_id',
  'last_write_request_id', 'last_write_principal_kind', 'last_write_principal_id', 'last_written_at',
] as const;
/** The actor that wrote the live page revision (pages.knowledge_revision). */
export const REVISION_ATTRIBUTION_COLUMNS = ['revision_write_request_id', 'revision_principal_kind', 'revision_principal_id'] as const;
/** page_versions: origin of the snapshotted revision, and the write that archived it. */
export const VERSION_ATTRIBUTION_COLUMNS = [
  'write_request_id', 'write_principal_kind', 'write_principal_id',
  'archived_write_request_id', 'archived_principal_kind', 'archived_principal_id',
] as const;

export type AttributedTable = 'facts' | 'takes' | 'timeline_entries';
/** A change to any of these is a canonical mutation and moves last_write_*. */
export const WRITE_ATTRIBUTION_CONTENT_COLUMNS: Record<AttributedTable, readonly string[]> = {
  facts: ['id', 'source_id', 'entity_slug', 'fact', 'kind', 'visibility', 'notability', 'context', 'valid_from',
    'valid_until', 'expired_at', 'superseded_by', 'consolidated_at', 'consolidated_into', 'source', 'source_session',
    'confidence', 'created_at', 'row_num', 'source_markdown_slug', 'claim_metric', 'claim_value', 'claim_unit',
    'claim_period', 'event_type', 'dimension', 'value', 'value_hash', 'dim_status', 'attributed_to'],
  takes: ['id', 'page_id', 'row_num', 'claim', 'kind', 'holder', 'weight', 'since_date', 'until_date', 'source',
    'superseded_by', 'active', 'resolved_at', 'resolved_outcome', 'resolved_value', 'resolved_unit', 'resolved_source',
    'resolved_by', 'created_at', 'resolved_quality'],
  timeline_entries: ['id', 'page_id', 'date', 'source', 'summary', 'detail', 'event_page_id', 'created_at'],
};
/**
 * Columns whose change leaves attribution untouched: physical projections
 * (embeddings and their identity) and the trust tier and its origin record,
 * which trust/schema.ts stamps and guards (a confirmation or backfill is not a
 * content rewrite, so it does not move last_write_*).
 */
export const WRITE_ATTRIBUTION_PROJECTION_COLUMNS: Record<AttributedTable, readonly string[]> = {
  facts: ['embedding', 'embedded_at', 'embedding_model', 'embedded_text_hash', ...TRUST_ROW_COLUMNS],
  takes: ['embedding', 'embedded_at', 'updated_at', 'embedding_model', 'embedded_text_hash', ...TRUST_ROW_COLUMNS],
  timeline_entries: [...TRUST_ROW_COLUMNS],
};

const ATTRIBUTED_TABLES = Object.keys(WRITE_ATTRIBUTION_CONTENT_COLUMNS) as AttributedTable[];
const SETTINGS = `
    req := NULLIF(current_setting('gbrain.write_request', true), '')::uuid;
    principal_kind := NULLIF(current_setting('gbrain.write_principal_kind', true), '');
    principal_id := NULLIF(current_setting('gbrain.write_principal_id', true), '');`;
const tuple = (row: 'NEW' | 'OLD', columns: readonly string[]) => `(${columns.map(column => `${row}.${column}`).join(', ')})`;
const contentChanged = (table: AttributedTable) => {
  const columns = WRITE_ATTRIBUTION_CONTENT_COLUMNS[table];
  return `${tuple('NEW', columns)} IS DISTINCT FROM ${tuple('OLD', columns)}`;
};
const typed = (column: string) => column.endsWith('request_id') ? 'UUID' : column.endsWith('_at') ? 'TIMESTAMPTZ' : 'TEXT';
const addColumns = (table: string, columns: readonly string[]) =>
  `ALTER TABLE ${table} ${columns.map(column => `ADD COLUMN IF NOT EXISTS ${column} ${typed(column)}`).join(', ')}`;

/**
 * INSERT: stamp created_by and last_mutated_by from the settings; without
 * settings keep supplied values (engine copy, backfill). UPDATE: created_by is
 * immutable once set; last_mutated_by moves only when a content column
 * changed (to NULL when no actor is set: an unattributed writer mutated it).
 * Either pair may be filled while it is still NULL (journal backfill).
 */
const STAMP_ROW_FUNCTION = `CREATE OR REPLACE FUNCTION gbrain_stamp_write_attribution() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE req uuid; principal_kind text; principal_id text; changed boolean;
BEGIN${SETTINGS}
  IF TG_OP = 'INSERT' THEN
    IF principal_kind IS NOT NULL THEN
      NEW.write_request_id := req; NEW.write_principal_kind := principal_kind; NEW.write_principal_id := principal_id;
      NEW.last_write_request_id := req; NEW.last_write_principal_kind := principal_kind; NEW.last_write_principal_id := principal_id;
      NEW.last_written_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.write_request_id, OLD.write_principal_kind, OLD.write_principal_id) IS DISTINCT FROM (NULL::uuid, NULL::text, NULL::text) THEN
    NEW.write_request_id := OLD.write_request_id; NEW.write_principal_kind := OLD.write_principal_kind; NEW.write_principal_id := OLD.write_principal_id;
  END IF;
  ${ATTRIBUTED_TABLES.map((table, index) => `${index === 0 ? 'IF' : 'ELSIF'} TG_TABLE_NAME = '${table}' THEN
    changed := ${contentChanged(table)};`).join('\n  ')}
  ELSE
    RAISE EXCEPTION 'gbrain_stamp_write_attribution is not classified for table %', TG_TABLE_NAME;
  END IF;
  IF changed THEN
    NEW.last_write_request_id := req; NEW.last_write_principal_kind := principal_kind; NEW.last_write_principal_id := principal_id;
    NEW.last_written_at := now();
  ELSIF (OLD.last_write_request_id, OLD.last_write_principal_kind, OLD.last_write_principal_id, OLD.last_written_at)
      IS DISTINCT FROM (NULL::uuid, NULL::text, NULL::text, NULL::timestamptz) THEN
    NEW.last_write_request_id := OLD.last_write_request_id; NEW.last_write_principal_kind := OLD.last_write_principal_kind;
    NEW.last_write_principal_id := OLD.last_write_principal_id; NEW.last_written_at := OLD.last_written_at;
  END IF;
  RETURN NEW;
END $fn$`;

/**
 * Sorts after pages_knowledge_revision, which assigns the new revision. Tag
 * writes bump the revision through an update of the page row, so they are
 * attributed too.
 */
const STAMP_REVISION_FUNCTION = `CREATE OR REPLACE FUNCTION gbrain_stamp_revision_attribution() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE req uuid; principal_kind text; principal_id text;
BEGIN${SETTINGS}
  IF TG_OP = 'INSERT' THEN
    IF principal_kind IS NOT NULL THEN
      NEW.revision_write_request_id := req; NEW.revision_principal_kind := principal_kind; NEW.revision_principal_id := principal_id;
    END IF;
  ELSIF NEW.knowledge_revision IS DISTINCT FROM OLD.knowledge_revision THEN
    NEW.revision_write_request_id := req; NEW.revision_principal_kind := principal_kind; NEW.revision_principal_id := principal_id;
  ELSIF (OLD.revision_write_request_id, OLD.revision_principal_kind, OLD.revision_principal_id) IS DISTINCT FROM (NULL::uuid, NULL::text, NULL::text) THEN
    NEW.revision_write_request_id := OLD.revision_write_request_id; NEW.revision_principal_kind := OLD.revision_principal_kind;
    NEW.revision_principal_id := OLD.revision_principal_id;
  END IF;
  RETURN NEW;
END $fn$`;

/**
 * A version row snapshots the page before the archiving write changes it, in
 * the same transaction, so the page row still carries the snapshotted
 * revision and its writer. The archiving actor comes from the settings.
 */
const STAMP_VERSION_FUNCTION = `CREATE OR REPLACE FUNCTION gbrain_stamp_version_attribution() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE req uuid; principal_kind text; principal_id text;
BEGIN${SETTINGS}
  IF (NEW.write_request_id, NEW.write_principal_kind, NEW.write_principal_id) IS NOT DISTINCT FROM (NULL::uuid, NULL::text, NULL::text) THEN
    SELECT p.revision_write_request_id, p.revision_principal_kind, p.revision_principal_id
      INTO NEW.write_request_id, NEW.write_principal_kind, NEW.write_principal_id
      FROM pages p WHERE p.id = NEW.page_id AND p.knowledge_revision = NEW.knowledge_revision;
  END IF;
  IF principal_kind IS NOT NULL THEN
    NEW.archived_write_request_id := req; NEW.archived_principal_kind := principal_kind; NEW.archived_principal_id := principal_id;
  END IF;
  RETURN NEW;
END $fn$`;

export const WRITE_ATTRIBUTION_SCHEMA_STATEMENTS = [
  addColumns('pages', REVISION_ATTRIBUTION_COLUMNS),
  addColumns('page_versions', VERSION_ATTRIBUTION_COLUMNS),
  ...ATTRIBUTED_TABLES.map(table => addColumns(table, ROW_ATTRIBUTION_COLUMNS)),
  STAMP_ROW_FUNCTION,
  STAMP_REVISION_FUNCTION,
  STAMP_VERSION_FUNCTION,
  ...ATTRIBUTED_TABLES.flatMap(table => [
    `DROP TRIGGER IF EXISTS gbrain_write_attribution ON ${table}`,
    `CREATE TRIGGER gbrain_write_attribution BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION gbrain_stamp_write_attribution()`,
  ]),
  `DROP TRIGGER IF EXISTS pages_revision_attribution ON pages`,
  `CREATE TRIGGER pages_revision_attribution BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION gbrain_stamp_revision_attribution()`,
  `DROP TRIGGER IF EXISTS page_versions_write_attribution ON page_versions`,
  `CREATE TRIGGER page_versions_write_attribution BEFORE INSERT ON page_versions FOR EACH ROW EXECUTE FUNCTION gbrain_stamp_version_attribution()`,
] as const;

export const WRITE_ATTRIBUTION_SCHEMA_SQL = `${WRITE_ATTRIBUTION_SCHEMA_STATEMENTS.join(';\n')};\n`;
