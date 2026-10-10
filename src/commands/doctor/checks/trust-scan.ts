/**
 * trust_scan (#5575, DX-6 / ENG-8): rows at `agent_written` or lower that
 * the write gate's current detector has not scanned. Activation control
 * (CEO-20) only covers scanned rows, so unscanned legacy rows can still be
 * injected by proactive surfaces. The fix is `actor: 'user'` (`fix.next:
 * tell_user_to_run`): `gbrain trust scan` records flag receipts in bounded,
 * resumable batches and changes no row, but a flagged row reads as flagged
 * (and leaves proactive context under `trust.agent_activation suppress`), so
 * no agent starts the legacy scan; the user runs it
 * after reading user_message (ideally after claiming their own sources:
 * trust_sources_unclaimed).
 * A brain before the trust or write-gate migrations is ok. Read-only.
 */
import type { Check } from '../../doctor.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { readTrustScanState } from '../../../core/eligibility/scan.ts';
import { isUndefinedColumnError, isUndefinedTableError } from '../../../core/utils.ts';

const SCAN_USER_MESSAGE = 'gbrain can check your memory written before its write gate for text that reads like instructions to an AI '
  + '(for example "from now on always say..."). Anything it flags stays in your brain, in search and in what agents get automatically, '
  + 'shown with its flag until you confirm it in gbrain trust review (with trust.agent_activation suppress, agents stop getting it automatically). If some sources are your own notes, claim them first (gbrain trust claim-sources) so the check '
  + 'treats them as yours. To run the check, run gbrain trust scan on the brain host.';

async function runTrustScan(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  try {
    const state = await readTrustScanState(engine);
    const details = { detector_version: state.detector_version, unscanned: state.unscanned, total_unscanned: state.total_unscanned, completed_at: state.completed_at };
    if (state.total_unscanned === 0) {
      checks.push({ name: 'trust_scan', status: 'ok', details,
        message: 'Every agent-written or lower row has been scanned by the current write-gate detector; flagged rows carry their flag, and proactive surfaces withhold them when trust.agent_activation is suppress.' });
      return checks;
    }
    checks.push({ name: 'trust_scan', status: 'warn', details,
      message: `${state.total_unscanned} agent-written or lower row(s) have not been scanned by the write-gate detector (v${state.detector_version}), `
        + 'so instruction-like ones are not flagged yet. Tell the user about gbrain trust scan; they run it if they want it: it records receipts in resumable batches and changes no row, '
        + 'but flagged rows (their own older notes included, unless they claimed those sources first with gbrain trust claim-sources) read as flagged until confirmed, and stay out of proactive context under trust.agent_activation suppress.',
      fix: { argv: ['gbrain', 'trust', 'scan'], consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify('trust_scan'),
        why: 'Scans legacy agent-written and unverified rows with the deterministic detector and records flag receipts; it moves, deletes or rewrites nothing, but flagged rows read as flagged (and leave proactive context under trust.agent_activation suppress) until the owner confirms them, so the user runs it after reading user_message; no agent starts it.',
        user_message: SCAN_USER_MESSAGE } });
  } catch (err) {
    if (isUndefinedColumnError(err, 'trust_tier') || isUndefinedTableError(err)) {
      checks.push({ name: 'trust_scan', status: 'ok', details: { schema: 'pre_trust' }, message: 'This schema predates the write gate; the scan arrives with its migration.' });
    } else {
      checks.push(checkError('trust_scan', 'read the trust scan state', err));
    }
  }
  return checks;
}

export const trustScanEntry: DoctorEntry = { name: 'trust_scan', emits: ['trust_scan'], run: runTrustScan };
