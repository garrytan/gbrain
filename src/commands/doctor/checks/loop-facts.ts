import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { loopFactDrift } from '../../../core/persistence/loop-fact-retirement.ts';
import { sortSourcesById } from '../../../core/source-rows.ts';

/**
 * #5869: closed commitment loops whose fact is still active (and retirable:
 * same source, no open loop shares it), left by `loops_close` before its
 * coordinated retirement. Names the explicit-only repair's preview. Read-only.
 */
export async function loopFactsDriftCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const sources = sourceIds ?? sortSourcesById(await engine.listAllSources()).map(row => row.id);
    const drifted = (await loopFactDrift(engine, sources)).length;
    const details = { drifted, repair: 'loop-facts', docs: 'docs/guides/repair.md#explicit-only-repair-kinds' };
    if (!drifted) return { name: 'loop_facts_drift', status: 'ok', details, message: 'Every closed commitment loop has its fact retired.' };
    return { name: 'loop_facts_drift', status: 'warn', details,
      message: `${drifted} closed commitment loop(s) still have an active commitment fact, so entity cards and recall keep the finished promise. `
        + 'Preview the retirement on the brain host: gbrain repair loop-facts — then run the apply command it prints after the user agrees.' };
  } catch (error) {
    return { name: 'loop_facts_drift', status: 'warn', details: { count: 'unknown' },
      message: `Closed-loop commitment facts could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
