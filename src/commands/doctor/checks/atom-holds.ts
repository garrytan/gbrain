/**
 * extract_atoms_held_failed (#6325): managed atom origins the drain stopped
 * retrying after MAX_DETERMINISTIC_FAILURES failed extractions of the same
 * content (code `held_failed`). A held origin leaves the atom backlog, so this
 * is the surface that keeps it from being skipped silently: each row names its
 * last request id and the reviewed retry command. Reads the database only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { listHeldManagedAtoms } from '../../../core/persistence/atom-maintenance.ts';
import { shellQuote } from '../../../core/agent-output.ts';
import { checkError, doctorVerify } from '../check-fix.ts';

const retryArgv = (sourceId: string, requestId: string): string[] =>
  ['gbrain', 'jobs', 'submit', 'extract-atoms-drain', '--params', JSON.stringify({ sourceId, retryRequestId: requestId })];

async function runAtomHeldFailedCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const held = await listHeldManagedAtoms(connectedEngine(ctx));
    const items = held.map(item => ({ ...item, receipt_command: `gbrain write-request -- ${item.request_id}`,
      retry_command: shellQuote(retryArgv(item.source_id, item.request_id)) }));
    const details = { held: items.length, items, code: 'held_failed' };
    if (!items.length) {
      checks.push({ name: 'extract_atoms_held_failed', status: 'ok', message: 'No managed atom page or transcript is held after repeated extraction failures.', details });
      return checks;
    }
    const first = items[0]!;
    checks.push({ name: 'extract_atoms_held_failed', status: 'warn', details,
      message: `${items.length} managed atom origin(s) held after ${first.attempts} failed extraction attempts on the same content (held_failed): `
        + `${items.slice(0, 5).map(item => `${item.source_id}:${item.locator} (request ${item.request_id}: ${item.failure})`).join('; ')}${items.length > 5 ? `; and ${items.length - 5} more` : ''}. `
        + 'They are out of the atom backlog until their content changes or an explicit retry runs.',
      fix: { argv: retryArgv(first.source_id, first.request_id), consent: ['paid'], actor: 'agent', requires_exclusive: false,
        why: `Queues one reviewed paid retry of the held atom batch ${first.request_id} (${first.source_id}:${first.locator}); read its receipt first with gbrain write-request -- ${first.request_id}. Repeat per held item in details.items.`,
        verify: doctorVerify('extract_atoms_held_failed') } });
  } catch (error) {
    checks.push(checkError('extract_atoms_held_failed', 'list held managed atom origins', error, { details: { health: 'unknown' } }));
  }
  return checks;
}

export const atomHeldFailedEntry: DoctorEntry = { name: 'extract_atoms_held_failed', emits: ['extract_atoms_held_failed'], run: runAtomHeldFailedCheck };
