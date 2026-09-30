/**
 * `orphans` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

export function makeOrphansHandler(engine: BrainEngine): MinionHandler {
  return async (_job) => {
    const result = await engine.findOrphanPages();
    return { count: result.length, orphans: result };
  };
}
