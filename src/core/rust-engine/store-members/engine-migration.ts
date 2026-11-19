/**
 * The source-side reads of `gbrain migrate --to <engine>` (engine-sql/engine-migration.ts), so a Rust brain can be the
 * brain a migration moves. `facts`, `open_loops`, the write history, the manual link statements and the live timeline
 * count are store reads; `sources`, `loop_suppressions` and a page's migration columns are composed here from reads the
 * store already serves. What the store does not keep and what each read answers for it:
 * rust/docs/store/engine-migration.md.
 */
import type {
  EngineMigrationHistory, ManualLinkTransition, MigrationPageColumns, MigrationRows, MigrationTable,
} from '../../engine-sql/engine-migration.ts';
import { MIGRATION_SOURCE_COLUMNS } from '../../engine-sql/engine-migration.ts';
import type { SourceRecordRow } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readEngineMigrationHistory: StoreMember<[], EngineMigrationHistory> = (brain) =>
  storeCall({ member: 'readEngineMigrationHistory' }, () => brain.readEngineMigrationHistory());

/** The `loop_suppressions` columns. The store keeps no suppressions, so the table is always empty. */
const LOOP_SUPPRESSION_COLUMNS = ['id', 'source_id', 'kind', 'value', 'created_at'];

export const readMigrationRows: StoreMember<[table: MigrationTable], MigrationRows | null> = async (brain, table) => {
  if (table === 'loop_suppressions') return { columns: [...LOOP_SUPPRESSION_COLUMNS], rows: [] };
  if (table === 'sources') {
    // `default` first, then by id, as the store lists them. The store keeps no commit, archive-date, retrieval-mode or
    // frontmatter-trust columns: each reads as a fresh source row has it.
    const sources: SourceRecordRow[] = await storeCall({ member: 'readMigrationRows' }, () => brain.listSourceRecords());
    const rows = sources.map(s => ({
      id: s.id, name: s.name ?? s.id, local_path: s.local_path ?? null, last_commit: s.last_commit ?? null,
      last_sync_at: s.last_sync_at ?? null, config_json: typeof s.config === 'string' ? s.config : JSON.stringify(s.config ?? {}),
      archived: s.archived ?? false, archived_at: null, archive_expires_at: null, contextual_retrieval_mode: null,
      trust_frontmatter_overrides: false, newest_content_at: s.newest_content_at ?? null, created_at: s.created_at,
    }));
    return { columns: [...MIGRATION_SOURCE_COLUMNS], rows };
  }
  const result: MigrationRows = await storeCall({ member: 'readMigrationRows' }, () => brain.readMigrationRows(table));
  // A loop's evidence is JSON text, as the SQL read casts it.
  if (table === 'open_loops') {
    result.rows = result.rows.map(r => ({ ...r, evidence: r.evidence == null ? null : JSON.stringify(r.evidence) }));
  }
  return result;
};

/** The page row as the store's snapshot carries it, before the Page codec. */
interface StorePageRow {
  page_kind?: MigrationPageColumns['page_kind']; source_path?: string | null; effective_date?: string | null;
  effective_date_source?: MigrationPageColumns['effective_date_source']; import_filename?: string | null;
  source_kind?: string | null; source_uri?: string | null; ingested_via?: string | null; ingested_at?: string | null;
  knowledge_revision?: string | null; text_projection_revision?: string | null;
}

export const readMigrationPageColumns: StoreMember<[slug: string, sourceId: string], MigrationPageColumns | null> = async (brain, slug, sourceId) => {
  const snapshot: { page: StorePageRow } | null = await storeCall({ member: 'readMigrationPageColumns', slug },
    () => brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }));
  if (snapshot === null) return null;
  const p = snapshot.page;
  const revision = (r: string | null | undefined) => (r == null ? null : r.toLowerCase());
  return {
    page_kind: p.page_kind ?? null, source_path: p.source_path ?? null, effective_date: p.effective_date ?? null,
    effective_date_source: p.effective_date_source ?? null, import_filename: p.import_filename ?? null,
    source_kind: p.source_kind ?? null, source_uri: p.source_uri ?? null, ingested_via: p.ingested_via ?? null,
    ingested_at: p.ingested_at ?? null,
    // IS NOT DISTINCT FROM: two missing revisions are equal.
    sealed: revision(p.text_projection_revision) === revision(p.knowledge_revision),
  };
};

export const listManualLinkTransitions: StoreMember<[slug: string, sourceId: string], ManualLinkTransition[]> = (brain, slug, sourceId) =>
  storeCall({ member: 'listManualLinkTransitions', slug }, () => brain.listManualLinkTransitions(sourceId, slug));

export const countLiveTimelineEntries: StoreMember<[], number> = async (brain) =>
  Number(await storeCall({ member: 'countLiveTimelineEntries' }, () => brain.countLiveTimelineEntries()));
