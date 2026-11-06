/**
 * `gbrain sources guard <source> --install|--uninstall|--status [--mode enforce] [--json]` (PR B Part 5,
 * docs/designs/REFRESH_WRITE_BARRIER.md): the commit guard on a managed source's canonical worktree. Trusted local CLI
 * only (no operation exposes it), on the worktree's registered owner host, and install/uninstall run under the
 * worktree's native writer lock. The hook goes in a hooks directory private to that worktree, so a person's own linked
 * checkout of the same repository is not guarded. `--mode enforce` also refuses cherry-pick, revert, rebase and
 * sequencer commits: in a managed worktree only the owner commits.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { acquireWorktree, getWorktreeBinding, managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { existingHostIdFor } from '../core/persistence/identity.ts';
import { installOwnerGuard, ownerGuardStatus, uninstallOwnerGuard, type GuardMode, type OwnerGuardStatus } from '../core/git/commit-guard.ts';

const USAGE = 'gbrain sources guard <source> --install|--uninstall|--status [--mode enforce] [--json]';
const LOCK_WAIT_MS = 10_000;

export interface SourcesGuardOptions { sourceId: string; action: 'install' | 'uninstall' | 'status'; mode: GuardMode }
export type SourcesGuardResult = OwnerGuardStatus & { source_id: string; action: SourcesGuardOptions['action']; changed: boolean };

export function parseSourcesGuardArgs(args: string[]): SourcesGuardOptions {
  const positional: string[] = [];
  const actions: SourcesGuardOptions['action'][] = [];
  let mode: GuardMode = 'default';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--install' || arg === '--uninstall' || arg === '--status') { actions.push(arg.slice(2) as SourcesGuardOptions['action']); continue; }
    if (arg === '--mode') {
      const value = args[++i];
      if (value !== 'enforce' && value !== 'default') throw opError('invalid_params', `--mode takes enforce (or default); got ${value ?? 'nothing'}.`, `Usage: ${USAGE}`);
      mode = value;
      continue;
    }
    if (arg.startsWith('-')) throw opError('invalid_params', `Unknown flag ${arg}.`, `Usage: ${USAGE}`);
    positional.push(arg);
  }
  if (positional.length !== 1) throw opError('invalid_params', 'Name exactly one source.', `Usage: ${USAGE}`);
  if (actions.length > 1) throw opError('invalid_params', 'Pass one of --install, --uninstall or --status.', `Usage: ${USAGE}`);
  const action = actions[0] ?? 'status';
  if (mode === 'enforce' && action !== 'install') throw opError('invalid_params', '--mode applies to --install only.', `Usage: ${USAGE}`);
  return { sourceId: positional[0]!, action, mode };
}

/** The owner check `sources refresh` makes: this process's host identity, read without minting, owns the worktree. */
async function ownedBinding(engine: BrainEngine, sourceId: string) {
  if (!await managedPersistenceEnabled(engine)) {
    throw opError('invalid_params', `This brain is not managed, so source ${sourceId} has no canonical worktree to guard.`,
      'In an unmanaged checkout, gbrain git guard --install (run inside the checkout) installs the opt-in guard.');
  }
  const hostId = existingHostIdFor(engine);
  const binding = await getWorktreeBinding(engine, sourceId, hostId);
  if (!binding) {
    throw opError('invalid_params', `Source ${sourceId} has no claimed canonical worktree.`,
      `Check the source with gbrain sources writer status --source ${sourceId} --json; an unmanaged checkout takes gbrain git guard --install.`);
  }
  if (binding.owner_host_id !== hostId || !binding.local_path) {
    throw opError('permission_denied', `Only the registered owner host (${binding.owner_host_id}) of source ${sourceId} may guard its worktree; this process has ${hostId ? `host identity ${hostId}` : 'no host identity'}.`,
      `Run it on the owner host with the HOME or GBRAIN_HOME its writer uses; check the owner with gbrain sources writer status ${sourceId}. Nothing was changed.`);
  }
  return { ...binding, local_path: binding.local_path };
}

export async function sourcesGuard(engine: BrainEngine, opts: SourcesGuardOptions): Promise<SourcesGuardResult> {
  const binding = await ownedBinding(engine, opts.sourceId);
  if (opts.action === 'status') return { ...ownerGuardStatus(binding.local_path), source_id: opts.sourceId, action: 'status', changed: false };
  const lock = await acquireWorktree(binding, LOCK_WAIT_MS, undefined, engine);
  if (!lock) {
    throw opError('writer_busy', `Source ${opts.sourceId}'s worktree writer lock stayed busy for ${LOCK_WAIT_MS / 1000}s.`,
      'A page write or a refresh holds the worktree; retry once it finishes. Nothing was changed.', { retryable: true });
  }
  try {
    const result = opts.action === 'install' ? installOwnerGuard(binding.local_path, opts.mode) : uninstallOwnerGuard(binding.local_path);
    return { ...result, source_id: opts.sourceId, action: opts.action };
  } finally { await lock.release(); }
}

function describe(r: SourcesGuardResult): string {
  const state = r.installed ? `installed (${r.mode} mode)` : 'not installed';
  const lines = [`Commit guard on source ${r.source_id} (${r.worktree}): ${state}${r.action !== 'status' ? (r.changed ? ', changed' : ', already current') : ''}.`,
    `Effective hooks path: ${r.hooks_path}`];
  if (r.foreign.length) lines.push(`Another tool's hooks live there: ${r.foreign.join(', ')}.`);
  return lines.join('\n');
}

export async function runSourcesGuard(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) { console.log(`Usage: ${USAGE}`); return; }
  try {
    const result = await sourcesGuard(engine, parseSourcesGuardArgs(args));
    console.log(json ? JSON.stringify(result) : describe(result));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources guard', render: cliRenderContext() });
    console.log(json ? JSON.stringify(env) : `Refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(error.code === 'invalid_params' ? 2 : 1);
  }
}
