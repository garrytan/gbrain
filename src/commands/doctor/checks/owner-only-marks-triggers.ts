/**
 * owner_only_marks_triggers doctor check (GST-3032): the five delete triggers that mark rows derived from an owner-only
 * origin before it goes (migration v322, access/owner-only-marks.ts). A trigger left uncreated (another role owns the
 * table) is named with its owner fix; while one is missing on a brain holding an owner-only source or a mark, owner-only
 * lineage reads closed (every derived row and synthesized concept counts as owner-only) and the check says so. On a brain
 * that has held owner-only data it also names each database login that reads sources but cannot read and add marks, with
 * the GRANT and CREATE POLICY statements the operator runs (tell_user_to_run), and the row-security mark a login whose reads
 * row-level security limits leaves behind. Read-only.
 */

import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError, doctorVerify } from '../check-fix.ts';
import { OWNER_ONLY_MARKS_SINCE } from '../../../core/access/owner-only-marks.ts';

const DOCS = 'docs/ENGINES.md#owner-only-delete-triggers';
const ROW_SECURITY = ' A database login whose reads row-level security limits made a permanent delete while this brain held owner-only data (the (\'*\', \'row_security\') mark), so owner-only lineage reads closed: every derived row and synthesized concept stays owner-only for everyone but the owner. This holds while such a login keeps making permanent deletes here: clearing the mark does not end it, because that login\'s next permanent delete sets it again. Ways out: run permanent deletes as the table owner (without FORCE ROW LEVEL SECURITY) or a BYPASSRLS login, then, having checked what was deleted, delete the mark as the owner; or remove the owner-only source and, once the rows derived from it may be read by others again, its marks. See ' + DOCS + '.';

async function runOwnerOnlyMarksTriggers(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('owner_only_marks_triggers');
  try {
    if (Number(await engine.getConfig('version')) < OWNER_ONLY_MARKS_SINCE) {
      checks.push({ name: 'owner_only_marks_triggers', status: 'ok', message: 'Skipped (the schema predates the owner-only delete triggers; the migration run creates them)' });
      return checks;
    }
    const state = await engine.ownerOnlyMarkTriggers();
    const rowSecurity = state.rowSecurity ? ` ${ROW_SECURITY}` : '';
    const grants = state.deniedLogins.flatMap(l => [
      `GRANT SELECT, INSERT ON public.owner_only_marks TO ${l.login};`,
      `DROP POLICY IF EXISTS ${l.readPolicy} ON public.owner_only_marks;`,
      `CREATE POLICY ${l.readPolicy} ON public.owner_only_marks FOR SELECT TO ${l.login} USING (true);`,
      `DROP POLICY IF EXISTS ${l.addPolicy} ON public.owner_only_marks;`,
      `CREATE POLICY ${l.addPolicy} ON public.owner_only_marks FOR INSERT TO ${l.login} WITH CHECK (true);`,
    ]);
    const denied = grants.length ? ` This brain has held owner-only data, and ${state.deniedLogins.length} database login(s) that read sources cannot read and add owner_only_marks (${state.deniedLogins.map(l => l.login).join(', ')}): they read owner-only lineage closed (every derived row and synthesized concept counts as owner-only) and their permanent deletes are refused (owner_only_marks_unwritable). Fix, as the table owner: ${grants.join(' ')}` : '';
    if (state.unflagged) {
      checks.push({ name: 'owner_only_marks_triggers', status: 'fail', message: `owner_only_marks holds marks but the held flag (a comment on the table) is unset, as after engine graduation or a data-only restore, so the owner-only guard does not read them and rows derived from a removed owner-only source may read as open to other members. Fix: run gbrain apply-migrations --force-schema as the owner of owner_only_marks; every migration run sets the flag. See ${DOCS}.`,
        fix: agentFix(['gbrain', 'apply-migrations', '--force-schema'], 'Every migration run sets the held flag when marks exist without it.', 'owner_only_marks_triggers', { requires_exclusive: true, docs: DOCS }),
        details: { unflagged: true, closed: state.closed, docs: DOCS } });
      return checks;
    }
    if (state.missing.length === 0 && grants.length) {
      checks.push({ name: 'owner_only_marks_triggers', status: 'fail', message: `${denied.trimStart()}${rowSecurity} See ${DOCS}.`,
        fix: { argv: ['psql', '-c', grants.join(' ')], consent: [], actor: 'host_admin', requires_exclusive: false, docs: DOCS,
          why: 'Lets each named login read and add owner-only marks, so it reads owner-only lineage exactly and its permanent deletes go through.',
          verify: doctorVerify('owner_only_marks_triggers') },
        details: { denied_logins: state.deniedLogins.map(l => l.login), sql: grants, closed: state.closed, row_security: state.rowSecurity, docs: DOCS } });
      return checks;
    }
    if (state.missing.length === 0 && state.rowSecurity) {
      checks.push({ name: 'owner_only_marks_triggers', status: 'warn', message: ROW_SECURITY.trimStart(),
        fix_unavailable_reason: 'no_safe_automatic_fix', details: { closed: state.closed, row_security: true, docs: DOCS } });
      return checks;
    }
    if (state.missing.length === 0) {
      checks.push({ name: 'owner_only_marks_triggers', status: state.closed ? 'warn' : 'ok', message: state.closed
        ? 'Every owner-only delete trigger exists, but owner-only lineage still reads closed: a trigger was missing earlier, so a delete in that gap may have left no marks. Every derived row and synthesized concept stays owner-only until the owner clears the unguarded mark.'
        : 'Every owner-only delete trigger exists, so rows derived from a removed owner-only source stay owner-only',
        details: { closed: state.closed } });
      return checks;
    }
    const named = state.missing.map(m => `${m.table} (owner ${m.owner})`).join(', ');
    const closed = state.closed ? ' Until they exist owner-only lineage reads closed: every derived row and synthesized concept counts as owner-only.' : '';
    const risk = `${state.missing.length} owner-only delete trigger(s) are missing or disabled (${named}), so removing an owner-only source or deleting one of its rows would leave the rows derived from it unmarked.${closed}${denied}${rowSecurity}`;
    const details = { missing: state.missing.map(m => m.table), owners: state.missing.map(m => m.owner), closed: state.closed, row_security: state.rowSecurity, docs: DOCS };
    if (state.missing.every(m => m.owned)) {
      checks.push({ name: 'owner_only_marks_triggers', status: 'fail', message: `${risk} Fix: run gbrain apply-migrations --force-schema; every migration run creates the triggers on tables its role owns.`,
        fix: agentFix(['gbrain', 'apply-migrations', '--force-schema'], 'Every migration run creates the owner-only delete triggers on tables its role owns.', 'owner_only_marks_triggers', { requires_exclusive: true, docs: DOCS }),
        details });
      return checks;
    }
    const sql = state.missing.map(m => `ALTER TABLE public.${m.table} OWNER TO ${state.role};`);
    checks.push({ name: 'owner_only_marks_triggers', status: 'fail', message: `${risk} CREATE TRIGGER needs the table's owner. Fix: connected as ${[...new Set(state.missing.map(m => m.owner))].join(' or ')}, run gbrain apply-migrations --force-schema, or run ${sql.join(' ')} and then gbrain apply-migrations --force-schema as this role. See ${DOCS}.`,
      fix_unavailable_reason: 'no_safe_automatic_fix', details: { ...details, sql } });
  } catch (e) {
    checks.push(checkError('owner_only_marks_triggers', 'check the owner-only delete triggers', e));
  }
  return checks;
}

export const ownerOnlyMarksTriggersEntry: DoctorEntry = { name: 'owner_only_marks_triggers', emits: ['owner_only_marks_triggers'], run: runOwnerOnlyMarksTriggers };
