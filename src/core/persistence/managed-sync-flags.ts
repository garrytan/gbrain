/**
 * #6696 C2: the sync flags a managed source refuses. Managed sync keeps every failed-receipt and ignored-file
 * guard, so `--skip-failed` (acknowledge failures and move on) and `--include-gitignored` (walk ignored files)
 * have no managed meaning. G3: a strict (git-canonical) source also refuses `--working-tree`, since it indexes commits only;
 * only the managed-sync guard reads the source row, so only it refuses that one. `managedSyncFlagRefusal` is the one refusal for them: code `managed_sync_flag_refused`,
 * `detail` = the flag, and a fix that reruns the same command without it. It is thrown at parse in `gbrain sync`
 * (`src/commands/sync/managed-no-pull.ts`), before the socket call in the serve-delegation ladder
 * (`src/commands/sync-delegate.ts`), and by the managed-sync guard (`resolveManagedSyncContext`) that jobs, MCP and
 * the cycle reach, so nothing runs before the refusal and every surface names the flag.
 */
import { opError, type OperationError } from '../ops/contract.ts';
import { shellQuote } from '../agent-output.ts';

export type ManagedForbiddenFlag = '--skip-failed' | '--include-gitignored' | '--working-tree';

const WHY: Record<ManagedForbiddenFlag, string> = {
  '--skip-failed': 'A managed sync never acknowledges a failed receipt to move past it: fix the file, and the plain sync retries it.',
  '--include-gitignored': 'A managed sync imports only files Git tracks and does not ignore: commit the file, or change .gitignore, to sync it.',
  '--working-tree': 'A strict (git-canonical) source indexes committed bytes only: commit the edit, through gbrain git commit-push, to sync it.',
};

/** The first managed-forbidden flag these options set, or null; `--working-tree` only on a strict source (G3). */
export function managedForbiddenFlag(opts: { skipFailed?: boolean; includeGitignored?: boolean; workingTree?: boolean }, strict = false): ManagedForbiddenFlag | null {
  return opts.skipFailed ? '--skip-failed' : opts.includeGitignored ? '--include-gitignored' : strict && opts.workingTree === true ? '--working-tree' : null;
}

/** `args` is the `gbrain sync` argv after `sync`; the fix reruns it without the flag. */
export function managedSyncFlagRefusal(flag: ManagedForbiddenFlag, sourceId: string | null, args: string[]): OperationError {
  const rerun = ['gbrain', 'sync', ...args.filter(arg => arg !== flag)];
  return opError('managed_sync_flag_refused', `Managed sync refuses ${flag}; nothing was synced.`,
    `${WHY[flag]} Run ${shellQuote(rerun)} without ${flag}.`, {
      detail: flag,
      fix: { argv: rerun, consent: [], actor: 'agent', requires_exclusive: false, why: WHY[flag],
        verify: { argv: sourceId ? ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] : ['gbrain', 'sources', 'status', '--json'] } },
    });
}
