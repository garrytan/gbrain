/**
 * How much of the direct (session) lane this process may hold. The CLI sets it
 * once per command; every other caller (embedders, tests) stays resident.
 * - resident: daemons (serve, jobs, autopilot, sync --watch) keep the full pool; a stdio
 *   `serve --access read-only` is one_shot instead (#7599): harnesses run one per session, and on Postgres
 *   it starts no persistence consumer, takes no notifier lease and runs no sweep.
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

/**
 * Every value of `flag` in `args`, in either form (`--access read-only`, `--access=read-only`; a bare flag at the end reads '').
 * The one parse behind serve's ceilings (`parseAccessFlag`, `parseSurfaceFlag` in src/mcp/surface.ts) and the pool profile; it
 * lives here because this module imports nothing. Reading only the bare form let `--access=read-only` and `--surface=verbs` pass
 * flag validation and start a serve without the ceiling they asked for.
 */
export function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => arg === flag ? [args[i + 1] ?? ''] : arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : []);
}

/** `serve ... --access read-only`: a stdio serve that runs no resident write duty on Postgres (#7599). */
export function isReadOnlyServeArgs(args: readonly string[]): boolean {
  return flagValues(args, '--access').includes('read-only');
}

/**
 * Whether a serve skips the resident write duties (#7599): a read-only stdio serve on Postgres. A PGLite serve holds the
 * brain's only engine handle, so the CLI's reads, writes and syncs go through it, and a read-only one keeps those duties.
 */
export const readOnlyServeSkipsResidentDuties = (readOnly: boolean, engineKind: string): boolean => readOnly && engineKind !== 'pglite';

export function directPoolProfileForCommand(command: string, args: readonly string[]): DirectPoolProfile {
  if (command === 'serve' && isReadOnlyServeArgs(args)) return 'one_shot';
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
