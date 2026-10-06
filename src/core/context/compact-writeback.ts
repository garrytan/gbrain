/** Shared compact extraction gate: preserve banking but honor explicit opt-out. */
import { rm, writeFile } from 'node:fs/promises';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { resolveWritebackConfig, compactWritebackSkipReason } from '../facts/writeback-config.ts';
import { HARVEST_RECEIPT_SUFFIX, writebackOffSidecarJson } from './corpus-segments.ts';

/** Call under the corpus claim, before extraction or receipt publication.
 * Only a confirmed off retires work; uncertain config remains retryable. */
export async function applyCompactWritebackGate(
  engine: BrainEngine,
  fileCfg: GBrainConfig | null,
  full: string,
): Promise<string | null> {
  const reason = compactWritebackSkipReason(await resolveWritebackConfig(engine, fileCfg, { gate: true }));
  if (reason === 'writeback_off') {
    await writeFile(full + '.ingested', writebackOffSidecarJson());
    await rm(full + HARVEST_RECEIPT_SUFFIX, { force: true });
  }
  return reason;
}
