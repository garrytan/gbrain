import { remediationSelection, remediateFlags, combinedRemediateCommand } from '/code/garrytan/gbrain/src/commands/doctor/remediate-consent.ts';
import { computePlanHash } from '/code/garrytan/gbrain/src/core/consent.ts';
import { combinedRemediateCommand as crc } from '/code/garrytan/gbrain/src/commands/doctor/remediate.ts';
// A keyless brain: target 90 unreachable (max 65), one pending repair step.
const plan: any = { plan: [{ id: 'extract.stale' }], repair_steps: [{ id: 'repair:safe-chunks', kind: 'safe-chunks', affected: 2, paid: false, est_usd_cost: 0 }],
  est_total_usd_cost: 0, target_unreachable: true, max_reachable_score: 65, brain_score_current: 65 };
const planArgs = ['--remediation-plan', '--json'];
const hPlan = computePlanHash(remediationSelection('host', plan, remediateFlags(planArgs)));
const cmd = crc(plan, plan.max_reachable_score, { planHash: hPlan });
console.log('plan_hash from --remediation-plan:', hPlan);
console.log('combined_command:', cmd);
const runArgs = cmd.split(' ').slice(2);
const hRun = computePlanHash(remediationSelection('host', plan, remediateFlags(runArgs)));
console.log('hash --remediate recomputes for that command:', hRun, hRun === hPlan ? 'MATCH' : 'MISMATCH');
