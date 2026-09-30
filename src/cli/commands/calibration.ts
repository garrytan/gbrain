/**
 * `gbrain calibration`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import { loadConfig } from '../../core/config.ts';
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  // v0.36.1.0 (T7): print/regenerate the active calibration profile.
  // MCP op `get_calibration_profile` (read-scoped) backs the same data path.
  const { runCalibration } = await import('../../commands/calibration.ts');
  const calibrationConfig = loadConfig() ?? ({} as never);
  await runCalibration(engine, args, calibrationConfig);
}
