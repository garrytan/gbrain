/**
 * `gbrain dream reset-key <base-key>` / `gbrain dream reset-key --list [--json]`
 * — the operator controls for the dream paid-loop breaker (dream-breaker.ts).
 */
import type { BrainEngine } from '../core/engine.ts';
import {
  countDeadDreamSubmissions, dreamBreakerBaseKey, dreamBreakerResetCommand, loadDreamBreakerThreshold,
  resetDreamBreakerKey, DREAM_BREAKER_CONFIG_KEY, DREAM_BREAKER_KEY_PREFIXES, DREAM_PATTERNS_SOURCE_KEY_PREFIX,
} from '../core/cycle/dream-breaker.ts';
import { setCliExitVerdict, writeJsonDocument } from '../core/cli-force-exit.ts';
import { opError } from '../core/ops/contract.ts';
import { usageError, writeCliRefusal } from '../cli/cli-error.ts';

const HELP = `Usage: gbrain dream reset-key <base-key>
       gbrain dream reset-key --list [--json]

The paid-loop breaker refuses to resubmit a dream synthesize or patterns key
whose submissions died ${'`'}${DREAM_BREAKER_CONFIG_KEY}${'`'} times (default 3) within 24 hours.
Patterns deaths (and patterns runs cancelled at their timeout after paid work)
count under ${'`'}${DREAM_PATTERNS_SOURCE_KEY_PREFIX}<source id>${'`'}, whatever reflections each
run read; a completed run resets it, so only consecutive deaths trip it.

  <base-key>   Re-enable one key (without any :c<i>of<n> chunk suffix). The reset
               is stored in the brain and survives restarts; deaths after it
               count again.
  --list       Show tripped keys with their dead-submission counts.
  --json       Machine-readable --list output.
`;

export async function runDreamResetKey(engine: BrainEngine | null, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  const list = args.includes('--list');
  const json = args.includes('--json');
  const positional = args.filter(arg => !arg.startsWith('--'));
  if (list === (positional.length === 1) || positional.length > 1) {
    setCliExitVerdict(writeCliRefusal(usageError('gbrain dream reset-key takes exactly one of <base-key> or --list.',
      'Example: gbrain dream reset-key --list --json'), 'dream', { json, human: HELP }));
    return;
  }
  if (!engine) {
    setCliExitVerdict(writeCliRefusal(opError('database_error', 'gbrain dream reset-key needs the brain database; the connection failed.',
      'Fix the brain connection (`gbrain doctor --json` names the cause), then retry.'), 'dream', { json }));
    return;
  }
  if (list) {
    const threshold = await loadDreamBreakerThreshold(engine);
    const rows = await countDeadDreamSubmissions(engine);
    const tripped = threshold === 0 ? [] : rows.filter(row => row.dead_submissions >= threshold);
    if (json) {
      await writeJsonDocument(JSON.stringify({ threshold, enabled: threshold > 0, tripped: tripped.map(row => ({ ...row, reset_command: dreamBreakerResetCommand(row.base_key) })) }, null, 2));
      return;
    }
    if (threshold === 0) { console.log(`The paid-loop breaker is disabled (${DREAM_BREAKER_CONFIG_KEY}=0).`); return; }
    if (tripped.length === 0) { console.log(`No tripped dream keys (limit ${threshold} dead submissions in 24h).`); return; }
    console.log(`Tripped dream keys (limit ${threshold} dead submissions in 24h):`);
    for (const row of tripped) console.log(`  ${row.dead_submissions}x  ${row.base_key}\n        last death ${row.last_dead_at}; reset: ${dreamBreakerResetCommand(row.base_key)}`);
    return;
  }
  const baseKey = dreamBreakerBaseKey(positional[0]!);
  if (!DREAM_BREAKER_KEY_PREFIXES.some(prefix => baseKey.startsWith(prefix))) {
    setCliExitVerdict(writeCliRefusal(usageError(`Not a dream breaker key: ${baseKey}. Keys start with ${DREAM_BREAKER_KEY_PREFIXES.join(' or ')}; run gbrain dream reset-key --list.`,
      'Run `gbrain dream reset-key --list --json` for the tripped keys and their reset commands.'), 'dream', { json }));
    return;
  }
  const before = (await countDeadDreamSubmissions(engine)).find(row => row.base_key === baseKey)?.dead_submissions ?? 0;
  await resetDreamBreakerKey(engine, baseKey);
  console.log(`Reset ${baseKey} (${before} dead submission(s) in the last 24h no longer count). The next dream cycle may submit it again.`);
  if (json) await writeJsonDocument(JSON.stringify({ status: 'reset', base_key: baseKey, dead_submissions_before: before }));
}
