/**
 * owner_only_marks_triggers doctor check (GST-3032): the five delete triggers that mark rows derived from an owner-only
 * origin before it goes (migration v322, access/owner-only-marks.ts). A trigger left uncreated (another role owns the
 * table) is named with its owner fix; while one is missing on a brain holding an owner-only source or a mark, owner-only
 * lineage reads closed (every derived row and synthesized concept counts as owner-only) and the check says so. Read-only.
 */

import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { OWNER_ONLY_MARKS_SINCE } from '../../../core/access/owner-only-marks.ts';

const DOCS = 'docs/ENGINES.md#owner-only-delete-triggers';

async function runOwnerOnlyMarksTriggers(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const name = 'owner_only_marks_triggers';
  ctx.progress.heartbeat(name);
  try {
    if (Number(await engine.getConfig('version')) < OWNER_ONLY_MARKS_SINCE) {
      return [{ name, status: 'ok', message: 'Skipped (the schema predates the owner-only delete triggers; the migration run creates them)' }];
    }
    const state = await engine.ownerOnlyMarkTriggers();
    if (state.missing.length === 0) {
      return [{ name, status: state.closed ? 'warn' : 'ok', message: state.closed
        ? 'Every owner-only delete trigger exists, but owner-only lineage still reads closed: a trigger was missing earlier, so a delete in that gap may have left no marks. Every derived row and synthesized concept stays owner-only until the owner clears the unguarded mark.'
        : 'Every owner-only delete trigger exists, so rows derived from a removed owner-only source stay owner-only',
        details: { closed: state.closed } }];
    }
    const named = state.missing.map(m => `${m.table} (owner ${m.owner})`).join(', ');
    const closed = state.closed ? ' Until they exist owner-only lineage reads closed: every derived row and synthesized concept counts as owner-only.' : '';
    const risk = `${state.missing.length} owner-only delete trigger(s) are missing (${named}), so removing an owner-only source or deleting one of its rows would leave the rows derived from it unmarked.${closed}`;
    const details = { missing: state.missing.map(m => m.table), owners: state.missing.map(m => m.owner), closed: state.closed, docs: DOCS };
    if (state.missing.every(m => m.owned)) {
      return [{ name, status: 'fail', message: `${risk} Fix: run gbrain apply-migrations --yes --no-autopilot-install; every migration run creates the triggers on tables its role owns.`,
        fix: agentFix(['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'], 'Every migration run creates the owner-only delete triggers on tables its role owns.', name, { requires_exclusive: true, docs: DOCS }),
        details }];
    }
    const sql = state.missing.map(m => `ALTER TABLE public.${m.table} OWNER TO ${state.role};`);
    return [{ name, status: 'fail', message: `${risk} CREATE TRIGGER needs the table's owner. Fix: connected as ${[...new Set(state.missing.map(m => m.owner))].join(' or ')}, run gbrain apply-migrations --yes --no-autopilot-install, or run ${sql.join(' ')} and then gbrain apply-migrations --yes --no-autopilot-install as this role. See ${DOCS}.`,
      fix_unavailable_reason: 'no_safe_automatic_fix', details: { ...details, sql } }];
  } catch (e) {
    return [checkError(name, 'check the owner-only delete triggers', e)];
  }
}

export const ownerOnlyMarksTriggersEntry: DoctorEntry = { name: 'owner_only_marks_triggers', emits: ['owner_only_marks_triggers'], run: runOwnerOnlyMarksTriggers };
