/**
 * learning_note (nightly learning PR 4): what the nightly learning ledger recorded and how the owner answered the note.
 * Reports the newest learning_derive run that recorded anything (when, how many items, by kind) and, over the last 30
 * days of change items (fact_added, promise_found, page_filled), how many were shown and the kept and undone shares of
 * those. A report, never a failure: a brain with no ledger, or an empty one, says so and is ok.
 */
import type { Check } from '../../doctor.ts';
import { rethrowCapabilityRefusal } from '../../../core/engine-capability-refusal.ts';
import { checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const SHARE_DAYS = 30;

async function runLearningNote(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('learning_note');
  try {
    const { hasCapability } = await import('../../../core/engine-capabilities.ts');
    const { CHANGE_KINDS, learningTablePresent } = await import('../../../core/learning/kinds.ts');
    if (!hasCapability(engine, 'raw_sql') || !await learningTablePresent(engine)) {
      checks.push({ name: 'learning_note', status: 'ok', message: 'No learning ledger on this brain yet; the nightly cycle creates it.' });
      return checks;
    }
    const [newest] = await engine.executeRaw<{ run_id: string; at: string }>(
      `SELECT run_id::text AS run_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at FROM learning_items ORDER BY created_at DESC, id DESC LIMIT 1`);
    if (!newest) {
      checks.push({ name: 'learning_note', status: 'ok', message: 'The nightly cycle has not recorded anything it learned yet.' });
      return checks;
    }
    const kinds = await engine.executeRaw<{ kind: string; n: number | string }>(
      'SELECT kind, count(*)::int AS n FROM learning_items WHERE run_id = $1::uuid GROUP BY kind ORDER BY kind', [newest.run_id]);
    const [answers] = await engine.executeRaw<{ shown: number | string; kept: number | string; undone: number | string }>(
      `SELECT count(*) FILTER (WHERE shown_at IS NOT NULL OR state IN ('kept', 'undone'))::int AS shown,
              count(*) FILTER (WHERE state = 'kept')::int AS kept, count(*) FILTER (WHERE state = 'undone')::int AS undone
         FROM learning_items WHERE kind = ANY($1::text[]) AND created_at >= now() - make_interval(days => $2)`, [[...CHANGE_KINDS], SHARE_DAYS]);
    const items = kinds.reduce((sum, k) => sum + Number(k.n), 0);
    const shown = Number(answers?.shown ?? 0), kept = Number(answers?.kept ?? 0), undone = Number(answers?.undone ?? 0);
    const pct = (n: number) => shown ? ` (${Math.round(100 * n / shown)}%)` : '';
    const byKind = kinds.map(k => `${k.kind} ${Number(k.n)}`).join(', ');
    checks.push({
      name: 'learning_note',
      status: 'ok',
      message: `last run ${newest.at} recorded ${items} item${items === 1 ? '' : 's'} (${byKind}); last ${SHARE_DAYS} days: ${shown} change item${shown === 1 ? '' : 's'} shown, ${kept} kept${pct(kept)}, ${undone} undone${pct(undone)}. See them with gbrain learned.`,
      details: { last_run_id: newest.run_id, last_run_at: newest.at, last_run_items: items, by_kind: Object.fromEntries(kinds.map(k => [k.kind, Number(k.n)])), days: SHARE_DAYS, shown, kept, undone },
    });
  } catch (err) {
    rethrowCapabilityRefusal(err);
    checks.push(checkError('learning_note', 'read the learning ledger', err));
  }
  return checks;
}

export const learningNoteEntry: DoctorEntry = { name: 'learning_note', emits: ['learning_note'], run: runLearningNote };
