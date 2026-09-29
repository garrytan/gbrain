#!/usr/bin/env bun
/**
 * Hermetic repeated-consolidation experiment: three dream cycles
 * (synthesize → extract → extract_facts) on a fixed PGLite brain with a
 * scripted model that invents quotes, swaps speakers and invents numbers.
 * Prints the measurements as JSON. $0: no network, no paid calls.
 *
 *   bun run scripts/repeated-consolidation-experiment.ts [--per-cycle]
 *
 * To compare two trees, copy test/helpers/repeated-consolidation.ts and this
 * script into a checkout of the other tree and run it there.
 */
import { runRepeatedConsolidation } from '../test/helpers/repeated-consolidation.ts';

const perCycle = process.argv.includes('--per-cycle');
const m = await runRepeatedConsolidation();
const { per_cycle, ...summary } = m;
console.log(JSON.stringify(perCycle ? m : summary, null, 2));
if (per_cycle.some(c => Object.values(c.statuses).some(s => s !== 'ok'))) {
  process.stderr.write('warning: a cycle phase did not finish ok; the measurements are not comparable\n');
  process.exitCode = 1;
}
