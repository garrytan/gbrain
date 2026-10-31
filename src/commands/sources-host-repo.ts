/**
 * `gbrain sources host-repo <id> --dir <path> [--push-remote <url>] [--dry-run | --expect <plan_hash>] [--json]` (G7b-2):
 * the CLI face of src/core/persistence/hosted-repo.ts. Without --expect it previews; the apply is the command the preview
 * prints. Trusted local CLI only (no operation exposes it), and every run on a production source needs the user's yes.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { hostRepo, type HostRepoOptions, type HostRepoPlan } from '../core/persistence/hosted-repo.ts';

const USAGE = 'gbrain sources host-repo <id> --dir <path> [--push-remote <url>] [--dry-run | --expect <plan_hash>] [--json]';

export function parseHostRepoArgs(args: string[]): HostRepoOptions {
  const positional: string[] = [];
  let dir: string | undefined, pushRemote: string | undefined, expect: string | undefined, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--dir') { dir = args[++i]; continue; }
    if (arg === '--push-remote') { pushRemote = args[++i]; continue; }
    if (arg === '--expect') { expect = args[++i]; continue; }
    if (arg.startsWith('-')) throw opError('invalid_params', `Unknown flag ${arg}.`, `Usage: ${USAGE}`);
    positional.push(arg);
  }
  if (positional.length !== 1 || !dir) throw opError('invalid_params', 'Name one source and its --dir.', `Usage: ${USAGE}`);
  if (expect !== undefined && !/^[a-f0-9]{64}$/.test(expect)) throw opError('invalid_params', '--expect takes the plan_hash the preview printed.', `Usage: ${USAGE}`);
  if (dryRun && expect !== undefined) throw opError('invalid_params', 'Pass --dry-run or --expect, not both.', `Usage: ${USAGE}`);
  return { sourceId: positional[0]!, dir, dryRun, ...(pushRemote !== undefined ? { pushRemote } : {}), ...(expect !== undefined ? { expect } : {}) };
}

function describe(plan: HostRepoPlan): string {
  const lines = [...plan.summary];
  if (plan.dry_run) {
    lines.push(`Hook: ${plan.hook.state} (${plan.hook.path}); worktree link: ${plan.worktree_link}.`);
    lines.push(plan.apply ? `Apply (after the user agrees): ${plan.apply.join(' ')}` : 'Nothing to apply.');
  } else lines.push(plan.action === 'host' ? `Done: source ${plan.source_id} is hosted at ${plan.repository}.`
    : plan.action === 'reinstall_hook' ? 'Done: the pre-receive hook is reinstalled.' : 'Nothing changed.');
  for (const step of plan.next) lines.push(`Next: ${step.join(' ')}`);
  return lines.join('\n');
}

export async function runHostRepo(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  try {
    const plan = await hostRepo(engine, parseHostRepoArgs(args));
    console.log(json ? JSON.stringify(plan) : describe(plan));
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    const env = toAgentError(error, { transport: 'cli', command: 'sources host-repo', render: cliRenderContext() });
    console.log(json ? JSON.stringify(env) : `Refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? USAGE}`);
    setCliExitVerdict(error.code === 'invalid_params' ? 2 : 1);
  }
}
