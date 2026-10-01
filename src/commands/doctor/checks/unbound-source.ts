import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { unboundBindCommand } from '../../../core/persistence/unbound-source.ts';

/**
 * #5254: pages written database-only while their filesystem source had no
 * canonical owner (`persistence.unbound_write=database_only`). While the source
 * stays unbound that is the chosen mode, so the count reports ok with the bind
 * command; once the source is bound those pages sit outside its canonical
 * files and are never materialized automatically, so it warns.
 */
export async function checkUnboundSource(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ source_id: string; pages: number; bound: boolean; local_path: string | null }>(
      `SELECT p.source_id,COUNT(*)::int AS pages,
        EXISTS(SELECT 1 FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation
          WHERE b.source_id=p.source_id) AS bound,
        COALESCE((SELECT s.local_path FROM sources s WHERE s.id=p.source_id),
          CASE WHEN p.source_id='default' THEN (SELECT c.value FROM config c WHERE c.key='sync.repo_path') END) AS local_path
       FROM pages p WHERE p.database_only_reason='unbound_source' AND p.deleted_at IS NULL
       GROUP BY p.source_id ORDER BY p.source_id`);
    const sources = rows.map(row => ({ source_id: row.source_id, pages: row.pages, bound: row.bound }));
    const total = rows.reduce((sum, row) => sum + row.pages, 0);
    if (!total) return { name: 'unbound_source', status: 'ok', message: 'No page was written database-only to an unbound source.', details: { total, sources } };
    const bound = rows.filter(row => row.bound);
    const unbound = rows.filter(row => !row.bound);
    const counts = (list: typeof rows) => list.map(row => `${row.source_id}: ${row.pages}`).join(', ');
    const unboundText = unbound.length ? `${counts(unbound)} written database-only because the source has no canonical owner `
      + `(persistence.unbound_write=database_only). To give a source a canonical owner, ${unbound.map(row => unboundBindCommand(row.source_id, row.local_path)).join('; ')}. `
      + 'Pages already written stay database-only.' : '';
    if (!bound.length) return { name: 'unbound_source', status: 'ok', message: unboundText, details: { total, sources } };
    return { name: 'unbound_source', status: 'warn', details: { total, sources },
      message: `${counts(bound)} page(s) written database-only while the source was unbound now sit outside canonical files: `
        + 'binding does not materialize them, so they are not in the checkout, its Git history or file backups. '
        + 'There is no bulk materialization command; when a canonical file already exists at a page\'s slug path, preview both sides with '
        + 'gbrain sources reconcile <source> <slug> --brain <brain> --preview and apply the agreed resolution. Otherwise save its content under a new slug and delete the database-only page.'
        + (unboundText ? ` ${unboundText}` : '') };
  } catch (error) {
    return { name: 'unbound_source', status: 'warn', details: { total: null, sources: [] },
      message: `Unbound-source pages could not be counted: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
