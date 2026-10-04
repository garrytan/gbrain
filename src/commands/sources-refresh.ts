/**
 * `gbrain sources refresh <source-id>` (F0): fast-forward a managed source's
 * checkout to its upstream through the drained, worktree-wide refresh in
 * `src/core/persistence/worktree-refresh.ts`, then run the managed `--no-pull`
 * sync for every source bound to that worktree. Trusted local CLI on the
 * registered owner host only; not an MCP operation.
 *
 * Every outcome, refusals included, is printed on stdout (one JSON object with
 * --json) with the next command filled in; exit 1 means it did not finish.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { refreshWorktree, type RefreshOptions, type WorktreeRefreshResult } from '../core/persistence/worktree-refresh.ts';

const USAGE = 'Usage: gbrain sources refresh <source-id> [--dry-run] [--wait-drain <seconds>] [--fetch-timeout-ms <ms>] [--resume | --abandon] [--json]';

function numberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const raw = args[index + 1];
  const value = Number(raw);
  if (raw === undefined || raw.startsWith('--') || !Number.isFinite(value) || value < 0) {
    throw new OperationError('invalid_params', `${flag} needs a non-negative number; got ${raw ?? 'nothing'}.`, USAGE);
  }
  return value;
}

export function parseRefreshArgs(args: string[]): { sourceId: string; json: boolean; options: RefreshOptions } {
  const valued = new Set(['--wait-drain', '--fetch-timeout-ms']);
  const known = new Set(['--dry-run', '--resume', '--abandon', '--json', ...valued]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valued.has(arg)) { i++; continue; }
    if (arg.startsWith('-')) {
      if (!known.has(arg)) throw new OperationError('invalid_params', `Unknown sources refresh flag: ${arg}.`, USAGE);
      continue;
    }
    positional.push(arg);
  }
  if (positional.length !== 1) throw new OperationError('invalid_params', 'sources refresh needs exactly one source id.', USAGE);
  if (args.includes('--resume') && args.includes('--abandon')) throw new OperationError('invalid_params', '--resume and --abandon are exclusive.', USAGE);
  const waitDrain = numberFlag(args, '--wait-drain');
  return { sourceId: positional[0], json: args.includes('--json'), options: {
    dryRun: args.includes('--dry-run'), resume: args.includes('--resume'), abandon: args.includes('--abandon'),
    ...(waitDrain !== undefined ? { waitDrainMs: Math.round(waitDrain * 1000) } : {}),
    ...(args.includes('--fetch-timeout-ms') ? { fetchTimeoutMs: numberFlag(args, '--fetch-timeout-ms') } : {}),
  } };
}

function describe(result: WorktreeRefreshResult): string {
  const head = (value: string | null) => value ? value.slice(0, 12) : '-';
  const lines = [`Refresh ${result.status}: sources ${result.source_ids.join(', ')}; ${head(result.old_head)} -> ${head(result.target_head)}${result.upstream_ref ? ` (${result.upstream_ref})` : ''}.`];
  if (result.incoming_files !== undefined) lines.push(`Incoming files: ${result.incoming_files}.`);
  for (const member of result.synced) lines.push(`  ${member.source_id}: sync ${member.status}, last_commit ${head(member.last_commit)}`);
  if (result.preserved_uncommitted.length) lines.push(`Preserved uncommitted paths (outside the incoming diff): ${result.preserved_uncommitted.slice(0, 20).join(', ')}${result.preserved_uncommitted.length > 20 ? ' ...' : ''}`);
  for (const blocked of result.sync_blocked ?? []) lines.push(`  ${blocked.source_id} blocked (${blocked.code}): ${blocked.message} Resume: ${blocked.resume}`);
  if (result.next) lines.push(`Next: ${result.next}`);
  return lines.join('\n');
}

export async function runSourcesRefresh(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const parsed = parseRefreshArgs(args);
    const result = await refreshWorktree(engine, parsed.sourceId, parsed.options);
    console.log(json ? JSON.stringify(result) : describe(result));
    if (['sync_blocked', 'syncing'].includes(result.status)) setCliExitVerdict(1);
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    // F0's legacy refusal keys stay (its `fix` is the stored command string); the v1 envelope keys ride beside them (D1).
    const env = toAgentError(error, { transport: 'cli', command: 'sources refresh', render: cliRenderContext() });
    const refusal = { status: 'refused', code: error.code, cause: error.message, fix: error.suggestion ?? null, docs: error.docs ?? null,
      ...(error.detail ? { detail: error.detail } : {}),
      error: env.error, message: env.message, suggestion: env.suggestion, docs_cmd: env.docs_cmd, class: env.class, retryable: env.retryable,
      contract_version: env.contract_version };
    console.log(json ? JSON.stringify(refusal) : `Refresh refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}${error.docs ? `\nDocs: ${error.docs}` : ''}`);
    setCliExitVerdict(1);
  }
}
