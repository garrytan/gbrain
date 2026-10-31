/**
 * dream_write_deferred (W3, GBRA-224, #7587): read-only view of the dream
 * write deferrals (cycle/dream-write-deferral.ts). A deferral is an accepted
 * consolidate or purge write that was still pending after its publish wait;
 * the next passes reconcile it. Under the replay bound it is ok (the details
 * list it); one that is still pending after the bound warns, naming the
 * receipt and its read-only status command. Page class for doctor --alert.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { DREAM_WRITE_DEFERRAL_ENABLED_KEY, DREAM_WRITE_DEFERRAL_MAX_REPLAYS, dreamWriteDeferralEnabled, readDreamWriteDeferrals, writeStatusCommand } from '../../../core/cycle/dream-write-deferral.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';

export async function dreamWriteDeferredCheck(engine: BrainEngine): Promise<Check> {
  const deferrals = await readDreamWriteDeferrals(engine);
  const items = deferrals.map(entry => ({ phase: entry.phase, source_id: entry.source_id, request_id: entry.request_id,
    replays: entry.replays, bound: DREAM_WRITE_DEFERRAL_MAX_REPLAYS, deferred_at: entry.deferred_at, status_command: writeStatusCommand(entry.request_id) }));
  const escalated = items.filter(item => item.replays >= DREAM_WRITE_DEFERRAL_MAX_REPLAYS);
  const details = { enabled: await dreamWriteDeferralEnabled(engine), bound: DREAM_WRITE_DEFERRAL_MAX_REPLAYS, pending: items.length, items };
  if (escalated.length === 0) {
    return { name: 'dream_write_deferred', status: 'ok',
      message: items.length ? `${items.length} dream write(s) deferred and still reconciling (under the ${DREAM_WRITE_DEFERRAL_MAX_REPLAYS}-pass bound)` : 'No deferred dream writes', details };
  }
  const first = escalated[0]!;
  return { name: 'dream_write_deferred', status: 'warn',
    message: `${escalated.length} dream write(s) still pending after ${DREAM_WRITE_DEFERRAL_MAX_REPLAYS} passes: `
      + escalated.slice(0, 3).map(item => `${item.phase} in ${item.source_id} (request_id ${item.request_id})`).join('; ')
      + `. The phase submits nothing more for that source until the receipt ends. Read it with ${first.status_command}; `
      + `if the writer is stuck, gbrain sources writer status --source ${first.source_id} --json names why. `
      + `(${DREAM_WRITE_DEFERRAL_ENABLED_KEY}=false turns deferral off.)`,
    details, fix: agentFix(['gbrain', 'write-request', '--', first.request_id], 'Read-only: the deferred write\'s receipt and why it has not committed.', 'dream_write_deferred') };
}
