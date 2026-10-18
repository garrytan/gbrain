/**
 * #6712 PR 2 (L3): every `gbrain sync` flag in one table, with where it travels when the run is handed to a resident
 * process. The serve-delegation ladder (`src/commands/sync-delegate.ts`), its wire validator
 * (`src/core/context/sync-ipc.ts`) and the PGLite owner lane (`src/commands/sync-persistence-delegate.ts`,
 * `src/core/persistence/sync-wire.ts`) derive their allowlists from it, so a flag is classified once.
 *
 * Routes, per hand-off:
 * - `forward`: the flag's `field` goes on the wire and the resident process runs with it.
 * - `client`: the client consumes the flag itself (deadlines, output, the opt-out) or it means nothing to that
 *   resident (`--lanes` on the PGLite owner, which never runs bulk lanes); it is accepted and never sent.
 * - `refuse`: the hand-off cannot honor it. The serve ladder refuses it by name (PGLite) or keeps the run in this
 *   process (Postgres); the owner lane refuses it.
 *
 * Fields a newer gbrain stopped using stay readable from an older peer for a window in `src/core/wire-skew.ts`; they
 * are never in this table, so a newer client never sends them.
 */

export type SyncFlagRoute = 'forward' | 'client' | 'refuse';
export type SyncWireType = 'boolean' | 'number' | 'string' | 'string[]';

export interface SyncFlagSpec {
  /** `boolean`: presence sets the field; `value`: one value; `repeat`: one value per occurrence. */
  arity: 'boolean' | 'value' | 'repeat';
  /** The SyncOpts and wire field the flag sets (none for flags the client consumes). */
  field?: string;
  /** The wire type of `field`. */
  type?: SyncWireType;
  /** A fixed value instead of `true` (`--no-lanes` is `--lanes 1`). */
  sets?: number;
  /** Serve-delegated sync (`sync_start` over the serve's IPC socket). */
  serve: SyncFlagRoute;
  /** The PGLite persistence owner lane (`writer_sync`). */
  owner: SyncFlagRoute;
  /** #6712 PR 3 (L7): listed in the "Managed brains" section of `gbrain sync --help` (at most 10; the rest are classic or advanced). */
  managed?: true;
}

const bool = (field: string, serve: SyncFlagRoute, owner: SyncFlagRoute): SyncFlagSpec => ({ arity: 'boolean', field, type: 'boolean', serve, owner });
const local = (arity: SyncFlagSpec['arity'], serve: SyncFlagRoute = 'refuse', owner: SyncFlagRoute = 'refuse'): SyncFlagSpec => ({ arity, serve, owner });
const managed = <T extends SyncFlagSpec>(spec: T): T & { managed: true } => ({ ...spec, managed: true });

export const SYNC_FLAGS = {
  '--source': managed({ arity: 'value', field: 'sourceId', type: 'string', serve: 'client', owner: 'forward' }),
  '--full': bool('full', 'forward', 'forward'),
  '--dry-run': managed(bool('dryRun', 'forward', 'forward')),
  '--no-pull': managed(bool('noPull', 'forward', 'forward')),
  '--no-embed': bool('noEmbed', 'forward', 'forward'),
  '--no-extract': bool('noExtract', 'forward', 'forward'),
  '--no-schema-pack': bool('noSchemaPack', 'forward', 'forward'),
  '--skip-failed': bool('skipFailed', 'forward', 'forward'),
  '--retry-failed': bool('retryFailed', 'forward', 'forward'),
  '--include-gitignored': bool('includeGitignored', 'forward', 'forward'),
  '--no-bulk': managed(bool('noBulk', 'forward', 'forward')),
  '--working-tree': bool('workingTree', 'refuse', 'forward'),
  '--reset-checkpoint': bool('resetCheckpoint', 'refuse', 'forward'),
  '--lanes': { arity: 'value', field: 'lanes', type: 'number', serve: 'forward', owner: 'client' },
  '--no-lanes': managed({ arity: 'boolean', field: 'lanes', type: 'number', sets: 1, serve: 'forward', owner: 'client' }),
  '--repo': { arity: 'value', field: 'repoPath', type: 'string', serve: 'refuse', owner: 'forward' },
  '--src-subpath': { arity: 'value', field: 'srcSubpath', type: 'string', serve: 'refuse', owner: 'forward' },
  '--strategy': { arity: 'value', field: 'strategy', type: 'string', serve: 'refuse', owner: 'forward' },
  '--exclude': { arity: 'repeat', field: 'exclude', type: 'string[]', serve: 'refuse', owner: 'forward' },
  '--include-hidden': { arity: 'repeat', field: 'includeHidden', type: 'string[]', serve: 'refuse', owner: 'forward' },
  '--timeout': managed(local('value', 'client', 'client')),
  '--hard-deadline': managed(local('value', 'client', 'client')),
  '--no-hard-deadline': local('boolean', 'client', 'client'),
  '--json': managed(local('boolean', 'client', 'client')),
  '--redact-paths': local('boolean'),
  '--yes': local('boolean', 'client', 'client'),
  '--no-delegate': local('boolean', 'client', 'client'),
  '--all': managed(local('boolean')),
  '--watch': local('boolean'),
  '--interval': local('value'),
  '--workers': local('value'),
  '--concurrency': local('value'),
  '--parallel': local('value'),
  '--serial': local('boolean'),
  '--max-sources': local('value'),
  '--no-auto-embed': local('boolean'),
  '--missing-path': local('value'),
  '--acknowledge-managed': local('boolean'),
  '--break-lock': managed(local('boolean')),
  '--force-break-lock': local('boolean'),
  '--max-age': local('value'),
} as const satisfies Record<string, SyncFlagSpec>;

export type SyncFlag = keyof typeof SYNC_FLAGS;
type Lane = 'serve' | 'owner';

/** #6712 PR 3 (L7): the flags `gbrain sync --help` lists under "Managed brains", in table order. */
export const MANAGED_HELP_FLAGS: SyncFlag[] = (Object.keys(SYNC_FLAGS) as SyncFlag[]).filter(flag => (SYNC_FLAGS[flag] as SyncFlagSpec).managed);

/** The flags a hand-off takes the given route for. */
export function syncFlagsRouted(lane: Lane, route: SyncFlagRoute): SyncFlag[] {
  return (Object.keys(SYNC_FLAGS) as SyncFlag[]).filter(flag => (SYNC_FLAGS[flag] as SyncFlagSpec)[lane] === route);
}

/** The wire fields a hand-off forwards, with their types (one entry per field). */
export function syncWireFields(lane: Lane): Record<string, SyncWireType> {
  const out: Record<string, SyncWireType> = {};
  for (const spec of Object.values(SYNC_FLAGS) as SyncFlagSpec[]) if (spec[lane] === 'forward' && spec.field && spec.type) out[spec.field] = spec.type;
  return out;
}
