/**
 * How much of the direct (session) lane this process may hold. The CLI sets it
 * once per command; every other caller (embedders, tests) stays resident.
 * - resident: daemons (serve, jobs, autopilot, sync --watch) keep the full pool.
 * - short_lived: a command that owns a consumer or takes a lease gets one connection.
 * - one_shot: a command that takes no lease routes nothing through the direct
 *   pool; schema DDL still uses one connection for its session advisory lock
 *   and long statement timeout. Taking a lease or starting a persistence
 *   consumer makes it short_lived.
 * GBRAIN_DIRECT_POOL_BY_COMMAND=0 restores the earlier behavior: resident everywhere.
 *
 * No imports: db-lock.ts reads this on PGLite too.
 */
export type DirectPoolProfile = 'resident' | 'short_lived' | 'one_shot';

const RESIDENT_COMMANDS = new Set(['serve', 'jobs', 'autopilot']);
/** The claim owners (persistence/claim-phase.ts) that exit, plus the diagnostics that report the direct route. */
const SHORT_LIVED_COMMANDS = new Set(['sync', 'mcp', 'dream', 'cycle', 'sources', 'migrate-graduation', 'put', 'import', 'doctor', 'engine']);

let processProfile: DirectPoolProfile = 'resident';

export function directPoolProfileForCommand(command: string, args: readonly string[]): DirectPoolProfile {
  if (RESIDENT_COMMANDS.has(command) || (command === 'sync' && args.includes('--watch'))) return 'resident';
  return SHORT_LIVED_COMMANDS.has(command) ? 'short_lived' : 'one_shot';
}

export function setDirectPoolProfile(profile: DirectPoolProfile): void {
  processProfile = profile;
}

/** A one-shot command that takes a lease or starts a persistence consumer runs them on the direct lane, so it becomes short-lived. */
export function noteDirectPoolLease(): void {
  if (processProfile === 'one_shot') processProfile = 'short_lived';
}

export function directPoolProfile(): DirectPoolProfile {
  return process.env.GBRAIN_DIRECT_POOL_BY_COMMAND === '0' ? 'resident' : processProfile;
}
