/**
 * Doctor `embedding_state` (#6696 B3, BRAIN): where indexed text stands against
 * the ACTIVE embedding column, from the derived classifier in
 * src/core/embedding-state.ts. The ops tier reads only index-backed counts
 * (unknown without a covering partial index); every other tier counts exactly.
 *
 * It warns only on what no other check owns: chunks of pages soft-deleted
 * longer than the purge window (fix: `gbrain pages purge-deleted`), and live
 * pages with body text but no chunk rows on a keyed brain (fix: `gbrain embed
 * --stale`). The pending backlog stays the `embeddings` check's warning (it
 * ages the backlog; this check only counts it), and quarantined pages stay
 * `quarantined_pages`'. keyword_only (embed_skip by design), deleted chunks
 * still inside the window and a brain keyless by choice are information.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError, doctorVerify, infoCheck, keylessEnablementFix } from '../check-fix.ts';
import { EMBEDDING_STATE_DOCS, embeddingStateFix, readEmbeddingState, type EmbeddingState } from '../../../core/embedding-state.ts';

const LABELS: Record<EmbeddingState, string> = {
  embedded: 'embedded', pending: 'pending', keyword_only: 'keyword-only', quarantined: 'quarantined',
  empty: 'empty', deleted_page_chunks: 'on deleted pages', chunkless_healable: 'chunkless (healable)',
};

async function runEmbeddingState(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('embedding_state');
  try {
    const state = await readEmbeddingState(engine, { mode: ctx.tier === 'ops' ? 'ops' : 'full', ...(ctx.sourceIds ? { sourceIds: ctx.sourceIds } : {}) });
    const details: Record<string, unknown> = { ...state, exact: state.basis === 'exact' };
    if (state.status === 'unknown') {
      checks.push({ name: 'embedding_state', status: 'warn',
        message: `Embedding state is unknown on the ops tier: the active embedding column '${state.active_column}' has no covering partial index (WHERE ${state.active_column} IS NULL), and the ops tier never scans. The standard tier counts it exactly.`,
        details: { ...details, code: 'embedding_state_unknown', health: 'unknown', exact: false },
        fix: agentFix(['gbrain', 'doctor', '--only', 'embedding_state', '--json'], 'The standard tier counts every embedding state exactly; it reads the database and changes nothing.', 'embedding_state', { docs: EMBEDDING_STATE_DOCS }) });
      return checks;
    }
    const counts = state.counts;
    const deleted = state.deleted_page_chunks as { within_window: number; past_window: number; window_hours: number };
    const enabled = state.embeddings_enabled === true;
    const healable = enabled ? counts.chunkless_healable ?? 0 : 0;
    const listed = (Object.keys(LABELS) as EmbeddingState[]).filter(s => counts[s] !== undefined).map(s => `${counts[s]} ${LABELS[s]}`).join(', ');
    const summary = `Embedding state (${state.basis}, column '${state.active_column}'): ${listed}; ${state.unsearchable}${state.unsearchable_complete ? '' : '+'} unsearchable.`;
    const notes: string[] = [];
    if ((counts.pending ?? 0) > 0) notes.push(enabled ? 'The pending backlog is the embeddings check\'s to age and warn on.' : 'Embeddings are disabled by choice: keyword search reads the pending chunks.');
    if ((counts.quarantined ?? 0) > 0) notes.push('Quarantined pages are reviewed under quarantined_pages.');
    if ((counts.keyword_only ?? 0) > 0) notes.push('Keyword-only chunks sit on embed_skip pages by design (split the page or approve a higher content_sanity.bytes_block; `gbrain pages unsearchable --state keyword_only` lists them).');
    if (deleted.within_window > 0) notes.push(`${deleted.within_window} chunk(s) on pages soft-deleted within ${deleted.window_hours}h wait for the purge lifecycle.`);
    if (deleted.past_window > 0 || healable > 0) {
      const warnings: string[] = [];
      if (deleted.past_window > 0) warnings.push(`${deleted.past_window} chunk(s) belong to pages soft-deleted more than ${deleted.window_hours}h ago; \`gbrain pages purge-deleted\` removes them (preview with --dry-run --json; it is brain-wide and irreversible, so ask the user first).`);
      if (healable > 0) warnings.push(`${healable} live page(s) have body text but no chunk rows, so search cannot read their body; \`gbrain embed --stale\` chunks and embeds them (paid).`);
      const fix = embeddingStateFix(deleted.past_window > 0 ? 'deleted_page_chunks' : 'chunkless_healable', { embeddingsEnabled: enabled, verify: doctorVerify('embedding_state') });
      checks.push({ name: 'embedding_state', status: 'warn', message: [summary, ...warnings, ...notes].join(' '),
        details: { ...details, code: deleted.past_window > 0 ? 'deleted_page_chunks_overdue' : 'chunkless_pages_healable' }, ...(fix ? { fix } : {}) });
      return checks;
    }
    const message = [summary, ...notes].join(' ');
    if (!enabled) {
      checks.push(infoCheck('embedding_state', message, 'disabled_by_choice', keylessEnablementFix(), details));
    } else if ((counts.keyword_only ?? 0) > 0 || deleted.within_window > 0) {
      checks.push(infoCheck('embedding_state', message, (counts.keyword_only ?? 0) > 0 ? 'disabled_by_choice' : 'not_applicable', undefined, details));
    } else {
      checks.push({ name: 'embedding_state', status: 'ok', message, details });
    }
  } catch (err) {
    checks.push(checkError('embedding_state', 'read embedding state', err, { details: { health: 'unknown', exact: false } }));
  }
  return checks;
}

export const embeddingStateEntry: DoctorEntry = { name: 'embedding_state', emits: ['embedding_state'], run: runEmbeddingState, tier: 'ops', opsPglite: 'not_applicable' };
