/**
 * `behavior_changes` doctor check: the one-time `behavior_changes` safety
 * notice, readable again (src/core/behavior-change-notice.ts). Read-only: it
 * neither records the brain's baseline nor writes a shown marker, so the
 * notice itself is still delivered once per channel. Always `ok`: the changes
 * are on by design and the fix is the optional chain-removal guidance.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { loadConfig, type GBrainConfig } from '../../../core/config.ts';
import {
  BEHAVIOR_NOTICE_SINCE,
  behaviorBrainKey,
  behaviorChangesNotice,
  behaviorNoticeShown,
  brainPredatesRelease,
  chainDisclosure,
  currentBrainId,
} from '../../../core/behavior-change-notice.ts';
import type { Check } from '../../doctor.ts';
import { checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';


export async function checkBehaviorChanges(engine: BrainEngine | null, opts: { cfg?: GBrainConfig | null; brainKey?: string } = {}): Promise<Check> {
  try {
    let cfg = opts.cfg;
    if (cfg === undefined) { try { cfg = loadConfig(); } catch { cfg = null; } }
    const brainKey = opts.brainKey ?? behaviorBrainKey(cfg, await currentBrainId());
    if (!(await brainPredatesRelease(engine, brainKey, { persist: false }))) {
      return { name: 'behavior_changes', status: 'ok', message: `Nothing to disclose: this brain is a fresh install at v${BEHAVIOR_NOTICE_SINCE} or later, so the one-time behavior-change notice does not apply.` };
    }
    const notice = behaviorChangesNotice(await chainDisclosure(engine, cfg));
    return {
      name: 'behavior_changes', status: 'ok', message: notice.why, ...(notice.fix ? { fix: notice.fix } : {}),
      details: { since: BEHAVIOR_NOTICE_SINCE, shown: { cli: behaviorNoticeShown(brainKey, 'cli'), stdio: behaviorNoticeShown(brainKey, 'stdio') } },
    };
  } catch (e) {
    return checkError('behavior_changes', 'read the behavior-change disclosure', e);
  }
}

async function runBehaviorChanges(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await checkBehaviorChanges(connectedEngine(ctx)));
  return checks;
}

export const behaviorChangesEntry: DoctorEntry = {
  name: 'behavior_changes',
  emits: ['behavior_changes'],
  run: runBehaviorChanges,
};
