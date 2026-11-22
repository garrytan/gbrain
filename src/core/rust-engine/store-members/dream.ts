/** Dream verdict members (BrainEngine getDreamVerdict, putDreamVerdict, sweepDreamVerdicts). */
import type { DreamVerdict, DreamVerdictInput } from '../../engine.ts';
import { wellFormedJson } from '../../text-safe.ts';
import { storeCall, type StoreMember } from './common.ts';

export const getDreamVerdict: StoreMember<[filePath: string, contentHash: string], DreamVerdict | null> = async (brain, filePath, contentHash) => {
  const row: DreamVerdict | null = await storeCall({ member: 'getDreamVerdict' }, () => brain.getDreamVerdict(filePath, contentHash));
  // PGLite parses the timestamptz into a Date and prints it with toISOString (millisecond precision).
  return row === null ? null : { ...row, judged_at: new Date(row.judged_at).toISOString() };
};

export const putDreamVerdict: StoreMember<[filePath: string, contentHash: string, verdict: DreamVerdictInput], void> = async (brain, filePath, contentHash, verdict) => {
  await storeCall({ member: 'putDreamVerdict' }, () => brain.putDreamVerdict(filePath, contentHash, wellFormedJson(verdict)));
};

export const sweepDreamVerdicts: StoreMember<[], number> = (brain) =>
  storeCall({ member: 'sweepDreamVerdicts' }, () => brain.sweepDreamVerdicts());
