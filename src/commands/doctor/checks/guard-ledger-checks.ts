/**
 * guard_ledger_checks doctor check (GST-2885, #7632/#7659): every purge and withdrawal guard carries its
 * row_security_active('<ledger>') check, so a write role that row-level security keeps from the ledger is refused
 * instead of reading it empty and storing purged content again or saving a withdrawn fact active.
 *
 * A guard left without it (another role owned it when v318 ran, or an older gbrain replayed its schema) is named with
 * its owner. When the doctor's role may re-create it, the fix is the migration run (every run re-creates the guards its
 * role owns, guard-ledger-checks.ts); otherwise the role that owns it runs the printed ALTER FUNCTION ... OWNER TO, or
 * that migration run itself. PGLite has no row-level security, so the check does not apply there. Read-only.
 */

import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { ledgerGuardsWithoutCheck } from '../../../core/guard-ledger-checks.ts';

const DOCS = 'docs/ENGINES.md#purge-and-withdrawal-guards';

async function runGuardLedgerChecks(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  // PGLite and the Rust store have no row-level security.
  if (engine.kind === 'pglite' || engine.kind === 'rust') {
    checks.push({ name: 'guard_ledger_checks', status: 'ok', message: 'Skipped (PGLite has no row-level security, so every guard reads its ledgers in full)' });
    return checks;
  }
  ctx.progress.heartbeat('guard_ledger_checks');
  try {
    const stale = await ledgerGuardsWithoutCheck(engine);
    const functions = stale.map(g => g.sig);
    const owners = stale.map(g => g.owner);
    const named = stale.map(g => `${g.sig} (owner ${g.owner})`).join(', ');
    const risk = `${stale.length} purge or withdrawal guard(s) lack their ledger check (${named}), so a write role that row-level security keeps from the ledger reads it empty and can store purged content again or save a withdrawn fact active.`;
    if (stale.length === 0) {
      checks.push({ name: 'guard_ledger_checks', status: 'ok', message: 'Every purge and withdrawal guard refuses a write role that row-level security keeps from its ledger' });
    } else if (stale.every(g => g.owned)) {
      checks.push({
        name: 'guard_ledger_checks', status: 'fail',
        message: `${risk} Fix: run gbrain apply-migrations --yes --no-autopilot-install; every migration run re-creates the guards its role owns.`,
        fix: agentFix(['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'],
          'Every migration run re-creates the purge and withdrawal guards its role owns with their ledger checks.', 'guard_ledger_checks', { requires_exclusive: true, docs: DOCS }),
        details: { functions, owners },
      });
    } else {
      const sql = stale.map(g => `ALTER FUNCTION ${g.qualified} OWNER TO ${g.role};`);
      checks.push({
        name: 'guard_ledger_checks', status: 'fail',
        message: `${risk} CREATE OR REPLACE FUNCTION needs the owner. Fix: connected as ${[...new Set(owners)].join(' or ')}, the role that owns each guard, run gbrain apply-migrations --yes --no-autopilot-install, or run ${sql.join(' ')} and then gbrain apply-migrations --yes --no-autopilot-install as this role. See ${DOCS}.`,
        fix_unavailable_reason: 'no_safe_automatic_fix',
        details: { functions, owners, sql, docs: DOCS },
      });
    }
  } catch (e) {
    checks.push(checkError('guard_ledger_checks', 'check purge and withdrawal guards', e));
  }
  return checks;
}

export const guardLedgerChecksEntry: DoctorEntry = { name: 'guard_ledger_checks', emits: ['guard_ledger_checks'], run: runGuardLedgerChecks };
