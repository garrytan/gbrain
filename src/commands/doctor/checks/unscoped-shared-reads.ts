/**
 * GST-363 (PR 2): unscoped_shared_reads. On a brain that serves several people (config access.serves, else two or
 * more enabled members), every remote read through a credential bound to nobody is refused (requester_scope_required)
 * once its 14-day grace ends, or at once for a credential created after the brain started serving several people.
 * Fails while any live credential is bound to nobody, naming each with its state, its grace end and the command that
 * binds it; a credential the operator let read unscoped on purpose (--reads-unscoped) is listed as info. Warns
 * instead of failing while access.requester_scope_enforce is false (hosted). Not applicable on a one-person brain.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { unscopedConnections } from '../../../core/access/requester-scope.ts';

const NAME = 'unscoped_shared_reads';

async function runUnscopedSharedReads(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  try {
    const found = await unscopedConnections(engine);
    if (!found) {
      checks.push(infoCheck(NAME, 'Not applicable: this brain serves one person (fewer than two enabled members and no access.serves = several).', 'not_applicable'));
      return checks;
    }
    const optedOut = found.connections.filter(c => c.state === 'reads_unscoped');
    const pending = found.connections.filter(c => c.state !== 'reads_unscoped');
    const optedLine = optedOut.length ? ` Reading unscoped on purpose (--reads-unscoped): ${optedOut.map(c => c.connection).join(', ')}.` : '';
    if (!pending.length) {
      checks.push({ name: 'unscoped_shared_reads', status: 'ok', details: { connections: found.connections, enforce: found.serves.enforce, since: found.serves.since },
        message: `This brain serves several people, and every live credential is bound to a member or an audience.${optedLine}` });
      return checks;
    }
    const first = pending[0]!;
    checks.push({ name: 'unscoped_shared_reads', status: found.serves.enforce ? 'fail' : 'warn',
      details: { connections: found.connections, enforce: found.serves.enforce, since: found.serves.since },
      message: `This brain serves several people, but ${pending.length} credential(s) are bound to nobody: `
        + `${pending.map(c => `${c.connection} (${c.state}${c.refuses_at ? ` until ${c.refuses_at}` : ''})`).join(', ')}. `
        + (found.serves.enforce ? 'Their reads are refused with requester_scope_required once the grace ends.' : 'Enforcement is off (access.requester_scope_enforce false), so they read every page no rule restricts, for whoever is asking.')
        + optedLine,
      fix: agentFix(first.argv, `Binds ${first.connection} to the person it serves. Ask the user which member it is (gbrain access member list); a team that shares everything may use --reads-unscoped --yes instead.`, NAME,
        { ask_user: true, docs: 'docs/guides/write-refusals.md#requester_scope_required' }) });
  } catch (error) {
    checks.push(checkError(NAME, `run ${NAME}`, error));
  }
  return checks;
}

export const unscopedSharedReadsEntry: DoctorEntry = {
  name: 'unscoped_shared_reads',
  emits: ['unscoped_shared_reads'],
  run: runUnscopedSharedReads,
};
