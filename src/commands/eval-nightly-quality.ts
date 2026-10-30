/** Scheduler entry point for the existing opt-in probe, without autopilot effects. */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfigWithEngine } from '../core/config.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { runNightlyQualityProbeStep } from './autopilot-probes.ts';
import type { NightlyProbeResult } from '../core/cycle/nightly-quality-probe.ts';

export async function runEvalNightlyQuality(engine: BrainEngine, args: string[], probe?: () => Promise<NightlyProbeResult>): Promise<void> {
  if (args.some(arg => !['--json', '--help', '-h', '--retry-incomplete'].includes(arg))) {
    console.error('Usage: gbrain eval nightly-quality [--json] [--retry-incomplete]');
    setCliExitVerdict(2);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log('gbrain eval nightly-quality [--json] [--retry-incomplete]: existing opt-in probe, existing daily cap and 24-hour gate; no autopilot tick.');
    return;
  }
  // Nested eval commands print their own reports. This process owns stdout;
  // keep those diagnostics on stderr and emit exactly one final envelope.
  const write = process.stdout.write;
  const log = console.log;
  console.log = (...values: unknown[]) => console.error(...values);
  process.stdout.write = ((chunk: Parameters<typeof process.stdout.write>[0], ...rest: unknown[]) =>
    (process.stderr.write as (...values: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  let result: NightlyProbeResult;
  try {
    result = await (probe ? probe() : runNightlyQualityProbeStep(engine, await loadConfigWithEngine(engine), args.includes('--retry-incomplete')));
  } finally {
    process.stdout.write = write;
    console.log = log;
  }
  console.log(args.includes('--json') ? JSON.stringify(result) : `Nightly quality: ${result.outcome}`);
  setCliExitVerdict(result.exit_code || (result.outcome === 'inconclusive' ? 2 : 0));
}
