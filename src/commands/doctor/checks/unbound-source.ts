import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { unboundBindCommand } from '../../../core/persistence/unbound-source.ts';

/**
 * #5254: pages written database-only while their filesystem source had no
 * canonical owner (`persistence.unbound_write=database_only`): the marker with
 * no recorded origin, the same predicate persistence uses (#6536). While the source
 * stays unbound that is the chosen mode, so the count reports ok with the bind
 * command; once the source is bound those pages sit outside its canonical
 * files and are never materialized automatically, so it warns.
 */
export async function checkUnboundSource(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.listUnboundSourcePages();
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
