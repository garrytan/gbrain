/**
 * memory_proposals_pending (GST-1158, GBRA-284): QM's proposed timeline entries and links waiting for the owner's
 * decision. Reports the count and the oldest one's age so a held proposal does not quietly expire unseen; the fix
 * lists them. A brain with none, or a schema before the table, reports ok.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify } from '../check-fix.ts';

export async function runMemoryProposalsDoctor(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  const { pendingProposalSummary } = await import('../../../core/persistence/memory-proposals.ts');
  const { pending, oldest_hours: oldest } = await pendingProposalSummary(engine);
  if (pending === 0) {
    checks.push({ name: 'memory_proposals_pending', status: 'ok', message: 'No memory proposals await the owner.' });
    return checks;
  }
  checks.push({ name: 'memory_proposals_pending', status: 'warn',
    message: `${pending} memory proposal(s) from QM await your decision${oldest !== null ? ` (oldest ${oldest} hours)` : ''}; review: gbrain memory-proposals list`,
    details: { pending, oldest_hours: oldest },
    fix: { argv: ['gbrain', 'memory-proposals', 'list'], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Lists the proposed timeline entries and links with their pages; approving or denying each one is the owner\'s call.', verify: doctorVerify('memory_proposals_pending') } });
  return checks;
}

export const memoryProposalsEntry: DoctorEntry = { name: 'memory_proposals_pending', emits: ['memory_proposals_pending'], run: runMemoryProposalsDoctor };
