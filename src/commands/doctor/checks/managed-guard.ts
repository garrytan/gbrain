import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { GUARDED_TABLES, PAGE_CHILD_TABLES } from '../../../core/persistence/writer-guard-schema.ts';

const RUNBOOK = 'docs/guides/write-refusals.md#managed-guard-page-children';

/**
 * Every column gbrain's own schema creates on a managed-writer-guarded table.
 * test/doctor-managed-guard.test.ts pins this list to the union of the
 * committed catalog goldens: a migration that adds a column to one of these
 * tables regenerates the goldens and then updates this list.
 */
export const GUARDED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  pages: ['body_bytes', 'body_flags', 'body_generation', 'body_lines', 'body_storage', 'chunker_version', 'compiled_truth', 'content_hash', 'contextual_retrieval_mode', 'corpus_generation', 'created_at', 'database_only_reason',
    'deleted_at', 'effective_date', 'effective_date_source', 'embedding_signature', 'emotional_weight', 'emotional_weight_recomputed_at', 'frontmatter',
    'generation', 'id', 'import_filename', 'ingested_at', 'ingested_via', 'knowledge_revision', 'last_retrieved_at', 'links_attendance_blocked_at',
    'links_attendance_blocked_revision', 'links_extract_failure', 'links_extracted_at', 'page_kind', 'revision_principal_id', 'revision_principal_kind', 'revision_write_request_id',
    'salience_touched_at', 'search_vector', 'segment_count', 'segmenter_version', 'slug', 'source_id', 'source_kind', 'source_path', 'source_uri',
    'text_projection_revision', 'timeline', 'timeline_lead', 'title', 'trust_tier', 'truth_bytes', 'truth_lead', 'type', 'updated_at', 'withheld_source_path', 'write_origin'],
  tags: ['id', 'page_id', 'tag', 'tag_source'],
  slug_aliases: ['alias_slug', 'canonical_slug', 'created_at', 'id', 'notes', 'source_id'],
  page_aliases: ['alias_norm', 'alias_text', 'case_sensitive', 'created_at', 'id', 'origin', 'slug', 'source_id'],
  facts: ['attributed_to', 'claim_metric', 'claim_period', 'claim_unit', 'claim_value', 'confidence', 'consolidated_at', 'consolidated_into', 'context', 'created_at',
    'dim_status', 'dimension', 'embedded_at', 'embedded_text_hash', 'embedding', 'embedding_model', 'entity_slug', 'event_type', 'expired_at', 'fact',
    'id', 'kind', 'last_write_principal_id', 'last_write_principal_kind', 'last_write_request_id', 'last_written_at', 'notability', 'row_num', 'source',
    'source_id', 'source_markdown_slug', 'source_session', 'source_window', 'superseded_by', 'trust_tier', 'valid_from', 'valid_until', 'value', 'value_hash', 'visibility',
    'write_origin', 'write_principal_id', 'write_principal_kind', 'write_request_id'],
  takes: ['active', 'claim', 'created_at', 'embedded_at', 'embedded_text_hash', 'embedding', 'embedding_model', 'holder', 'id', 'kind',
    'last_write_principal_id', 'last_write_principal_kind', 'last_write_request_id', 'last_written_at', 'page_id', 'resolved_at', 'resolved_by',
    'resolved_outcome', 'resolved_quality', 'resolved_source', 'resolved_unit', 'resolved_value', 'row_num', 'since_date', 'source', 'superseded_by',
    'trust_tier', 'until_date', 'updated_at', 'weight', 'write_origin', 'write_principal_id', 'write_principal_kind', 'write_request_id'],
  timeline_entries: ['created_at', 'date', 'detail', 'event_page_id', 'id', 'last_write_principal_id', 'last_write_principal_kind', 'last_write_request_id',
    'last_written_at', 'page_id', 'source', 'summary', 'trust_tier', 'write_origin', 'write_principal_id', 'write_principal_kind', 'write_request_id'],
  sources: ['archive_expires_at', 'archived', 'archived_at', 'chunker_version', 'config', 'contextual_retrieval_mode', 'created_at', 'id', 'incarnation',
    'last_commit', 'last_sync_at', 'local_path', 'name', 'newest_content_at', 'purge_epoch', 'trust_frontmatter_overrides', 'upstream_behind', 'upstream_checked_at',
    'upstream_commit'],
  page_segment_texts: ['body', 'byte_len', 'created_at', 'line_count', 'sha256', 'source_id'],
  page_body_manifest: ['byte_len', 'byte_start', 'cut_kind', 'date_max', 'date_min', 'entry_state', 'facts_slots', 'gen_from', 'gen_to', 'hash_state',
    'line_count', 'line_start', 'occurrence_id', 'outline', 'page_id', 'protected_regions', 'region', 'seq', 'sha256', 'source_id', 'staging_id', 'staging_key',
    'static_proj_bytes', 'static_proj_lines'],
};

/**
 * #5983/#5974: a column gbrain never creates on a guarded table means another
 * tool or a manual migration changed the schema the managed-writer guard reads.
 * #7145: each extra column is named as table.column and classified by what it
 * does to gbrain: `blocks_inserts` (NOT NULL with no default, so every gbrain
 * INSERT into that table fails: fail), `guard_source_column` (a `source_id` on
 * tags, timeline_entries or takes: builds before v0.60.38.0 resolved the row's
 * source from it, so a process still running one refuses every coordinated
 * write there: warn) or `harmless` (nullable or defaulted, and gbrain neither
 * reads nor writes it: ok, information). The worst class decides the status.
 */
export async function checkManagedGuardSchemaDrift(engine: BrainEngine): Promise<Check> {
  const name = 'managed_guard_schema_drift';
  try {
    const rows = await engine.executeRaw<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null; is_identity: string | null; is_generated: string | null }>(
      `SELECT table_name,column_name,is_nullable,column_default,is_identity,is_generated FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`, [[...GUARDED_TABLES]]);
    const columns = rows.filter(row => !GUARDED_TABLE_COLUMNS[row.table_name]?.includes(row.column_name)).map(row => {
      const column = `${row.table_name}.${row.column_name}`;
      if (row.is_nullable === 'NO' && row.column_default === null && row.is_identity !== 'YES' && (row.is_generated ?? 'NEVER') === 'NEVER') {
        return { column, class: 'blocks_inserts' as const,
          why: 'NOT NULL with no default: every row gbrain inserts into this table leaves it empty, so the insert fails.',
          next: `ask the user, then give it a default (ALTER TABLE ${row.table_name} ALTER COLUMN ${row.column_name} SET DEFAULT <value>) or allow NULL (ALTER TABLE ${row.table_name} ALTER COLUMN ${row.column_name} DROP NOT NULL).` };
      }
      if (row.column_name === 'source_id' && PAGE_CHILD_TABLES.includes(row.table_name)) {
        return { column, class: 'guard_source_column' as const,
          why: 'Builds before v0.60.38.0 resolve the row\'s source from it, so a gbrain process still running one refuses every coordinated tag, timeline or take write with writer_coordinator_required; this build resolves the row through its page.',
          next: 'upgrade or restart every process running gbrain on this brain (gbrain sources writer status --json names their versions).' };
      }
      return { column, class: 'harmless' as const, why: 'Nullable or defaulted, and gbrain neither reads nor writes it.', next: 'nothing for gbrain.' };
    });
    const extra = columns.map(c => c.column);
    const pageChildSource = columns.filter(c => c.class === 'guard_source_column').map(c => c.column);
    const blocking = columns.filter(c => c.class === 'blocks_inserts');
    const details = { extra_columns: extra, columns, page_child_source_columns: pageChildSource, runbook: RUNBOOK };
    if (!extra.length) return { name, status: 'ok', message: 'Guarded tables carry only the columns gbrain creates.', details };
    const lead = `${extra.length} column(s) on managed-writer-guarded tables were not created by gbrain: ${columns.map(c => `${c.column} (${c.class})`).join(', ')}.`;
    if (!blocking.length && !pageChildSource.length) {
      return { name, status: 'ok', severity: 'info', details,
        message: `${lead} Each is nullable or defaulted and gbrain neither reads nor writes it, so no gbrain write is affected. Another tool or a manual migration added it; keep it unless the user decides otherwise.` };
    }
    return { name, status: blocking.length ? 'fail' : 'warn', details, fix_unavailable_reason: 'operator_judgement',
      message: `${lead} `
        + (blocking.length ? `${blocking.map(c => c.column).join(', ')}: NOT NULL with no default, so every gbrain insert into ${blocking.length === 1 ? 'that table' : 'those tables'} fails; ${blocking[0]!.next} ` : '')
        + (pageChildSource.length ? `${pageChildSource.join(', ')} made every coordinated tag, timeline or take write fail with writer_coordinator_required before v0.60.38.0; `
          + 'this release ignores it and resolves those rows through their page, but a process still on an older build does not: upgrade or restart it. ' : '')
        + 'Another tool or a manual migration changed this schema. Find out what added the columns before anything else writes there; '
        + `do not drop them without asking the user, because another tool may read them. details.columns gives each column's class and next step. Recovery after the fix: ${RUNBOOK}.` };
  } catch (error) {
    return { name, status: 'warn', message: `Guarded table columns could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown', runbook: RUNBOOK } };
  }
}

/** #5974: recent writes the database refused during preparation or publication. */
export async function checkPublicationRefusals(engine: BrainEngine): Promise<Check> {
  const name = 'publication_refusals';
  try {
    const [row] = await engine.executeRaw<{ guard: number; trigger: number; opaque: number }>(
      `SELECT COUNT(*) FILTER (WHERE error_code='writer_coordinator_required' AND error_detail->>'origin'='database_guard')::int AS guard,
              COUNT(*) FILTER (WHERE error_detail->>'origin'='database_trigger')::int AS trigger,
              COUNT(*) FILTER (WHERE error_detail IS NULL AND error_message LIKE 'Publication failed (P0001)%')::int AS opaque
       FROM persistence_requests WHERE state IN ('failed','conflict','recovering') AND COALESCE(completed_at,updated_at) > now()-interval '7 days'`);
    const details = { guard_refusals: row.guard, trigger_refusals: row.trigger, unclassified_p0001: row.opaque, window_days: 7, runbook: RUNBOOK };
    const total = row.guard + row.trigger + row.opaque;
    if (!total) return { name, status: 'ok', message: 'No write was refused by a database guard in the last 7 days.', details };
    return { name, status: 'warn', details, message: `${total} write(s) in the last 7 days were refused by the database and not committed `
      + `(${row.guard} by the managed-writer guard, ${row.trigger} by another trigger, ${row.opaque} recorded before refusals were classified). `
      + 'This is a gbrain defect, a schema change by another tool, or a version mismatch between gbrain processes, not a content conflict. '
      + 'Run gbrain sources writer status --probe --json and read recent_failures[].error_detail (table, operation, guard branch, executing build), '
      + `check managed_guard_schema_drift above, then follow ${RUNBOOK}. Retry each refused write with a new request ID after the cause is fixed.` };
  } catch (error) {
    return { name, status: 'warn', message: `Publication refusals could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown', runbook: RUNBOOK } };
  }
}
