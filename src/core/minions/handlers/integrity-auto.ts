/**
 * `integrity-auto` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { MinionHandler } from '../types.ts';

export const integrityAutoHandler: MinionHandler = async () => {
  const { runIntegrity } = await import('../../../commands/integrity.ts');
  await runIntegrity(['auto']);
  return { ok: true };
};
