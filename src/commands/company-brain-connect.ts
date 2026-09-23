import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { isThinClient, loadConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { OperationError } from '../core/ops/contract.ts';
import { inspectCompanyBrain, validateCompanyBrainPlan } from '../core/company-brain/inspection.ts';
import { COMPANY_BRAIN_MAX_METADATA_BYTES, COMPANY_BRAIN_PROFILE, type CompanyBrainPlan } from '../core/company-brain/types.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { finishCliTeardown, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { withHumanLogsToStderr } from '../core/console-prefix.ts';

export const COMPANY_BRAIN_CONNECT_HELP = `Connect a reviewed company repository to an initialized local brain:
  gbrain sources connect <path> --brain <id> --source <id>
                         [--profile company-brain] [--include <glob>] [--exclude <glob>]
                         [--yes] [--json] [--request-id <uuid>]
  gbrain sources connect --plan <file> --brain <id> --source <id> [--yes] [--json]

Both destination flags are required. A saved plan and a repository path are mutually exclusive.
Connect previews the destination and asks before registering/indexing a new source.
Non-interactive use requires --yes; it never bypasses validation or access checks.
No embeddings, Git pull/push, source edits, grants, skills, or schedules are enabled.
Use sources inspect to create a private review plan before connecting.
Resume incomplete work with: gbrain sync --brain <id> --source <id> --no-embed --no-pull
`;

export interface CompanyBrainConnectArgs {
  path?: string;
  planFile?: string;
  brainId: string;
  sourceId: string;
  profile?: typeof COMPANY_BRAIN_PROFILE;
  include: string[];
  exclude: string[];
  json: boolean;
  yes: boolean;
  requestId: string;
}

export function parseCompanyBrainConnectArgs(args: string[], explicitBrain: string | null): CompanyBrainConnectArgs {
  const options: CompanyBrainConnectArgs = { brainId: explicitBrain ?? '', sourceId: '', include: [], exclude: [], json: false, yes: false, requestId: randomUUID() };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--yes') { options.yes = true; continue; }
    if (!arg.startsWith('-')) {
      if (options.path) throw new OperationError('invalid_params', 'Connect accepts exactly one repository path.');
      options.path = arg;
      continue;
    }
    const equal = arg.indexOf('=');
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    if (!['--source', '--profile', '--include', '--exclude', '--plan', '--request-id'].includes(flag)) {
      throw new OperationError('invalid_params', `Unknown connect option ${JSON.stringify(flag)}.`);
    }
    const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
    if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${flag} requires a value.`);
    if (seen.has(flag) && flag !== '--include' && flag !== '--exclude') throw new OperationError('invalid_params', `Pass ${flag} only once.`);
    seen.add(flag);
    if (flag === '--source') options.sourceId = value;
    else if (flag === '--plan') options.planFile = value;
    else if (flag === '--request-id') options.requestId = value.toLowerCase();
    else if (flag === '--include') options.include.push(value);
    else if (flag === '--exclude') options.exclude.push(value);
    else {
      if (value !== COMPANY_BRAIN_PROFILE) throw new OperationError('invalid_params', 'Only --profile company-brain is supported.');
      options.profile = COMPANY_BRAIN_PROFILE;
    }
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(options.brainId) || !isValidSourceId(options.sourceId)) {
    throw new OperationError('invalid_params', 'Connect requires explicit valid --brain and --source destinations. Ambient routing is not used.');
  }
  if (Boolean(options.path) === Boolean(options.planFile)) throw new OperationError('invalid_params', 'Provide one repository path or --plan file, not both.');
  if (options.planFile && (options.include.length || options.exclude.length)) throw new OperationError('invalid_params', 'A saved plan fixes its selection. Inspect again to change include/exclude rules.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.requestId)) throw new OperationError('invalid_params', '--request-id must be a UUID.');
  return options;
}

async function connectionPlan(options: CompanyBrainConnectArgs): Promise<CompanyBrainPlan> {
  if (!options.planFile) return inspectCompanyBrain({ path: options.path!, profile: options.profile, include: options.include, exclude: options.exclude });
  let fd: number | undefined;
  let saved: unknown;
  try {
    fd = openSync(options.planFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > COMPANY_BRAIN_MAX_METADATA_BYTES) throw new Error();
    const text = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text) > COMPANY_BRAIN_MAX_METADATA_BYTES) throw new Error();
    saved = JSON.parse(text);
  } catch {
    throw new OperationError('invalid_params', 'The plan must be a readable, bounded regular JSON file. Inspect the repository again.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (saved && typeof saved === 'object' && 'plan' in saved) saved = (saved as { plan: unknown }).plan;
  const path = (saved as Partial<CompanyBrainPlan> | null)?.revision?.root;
  if (typeof path !== 'string') throw new OperationError('plan_stale', 'The saved plan has no valid repository identity. Inspect again.');
  const validated = await validateCompanyBrainPlan(saved, { path, profile: options.profile, mode: 'apply' });
  if (!validated.valid || !validated.plan) throw new OperationError(validated.code, 'The saved plan is stale or not ready. Inspect the repository again.');
  return validated.plan;
}

export async function runCompanyBrainConnect(args: string[], connectEngine: () => Promise<BrainEngine>): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { await writeStdoutFinal(COMPANY_BRAIN_CONNECT_HELP); return; }
  const json = args.includes('--json');
  let engine: BrainEngine | undefined;
  let options: CompanyBrainConnectArgs | undefined;
  const emit = async (value: unknown) => writeStdoutFinal(`${JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)}\n`);
  try {
    options = parseCompanyBrainConnectArgs(args, getCliOptions().brain);
    const config = persistenceConfigForBrain(loadConfig(), options.brainId, options.brainId === 'host' ? [] : loadMounts());
    if (!config) throw new OperationError('destination_not_ready', 'The destination must already be initialized. Set up a separate company brain first.');
    if (isThinClient(config)) throw new OperationError('permission_denied', 'Connect runs on the company brain host; an ordinary remote token is not administration authority.');
    const plan = await connectionPlan(options);
    if (!plan.ready || !plan.revision) {
      if (json) await emit({ schema_version: 1, status: 'blocked', code: 'source_not_ready', plan });
      else console.error('The source is not ready. Run sources inspect and resolve its blocking findings.');
      setCliExitVerdict(1);
      return;
    }
    const params = { brain_id: options.brainId, source_id: options.sourceId, path: plan.revision.root, plan, request_id: options.requestId };
    const delegated = await maybeDelegateLocalAdministration('company_brain_preview', params, config, { timeoutMs: getCliOptions().timeoutMs ?? undefined });
    const local = { brainId: options.brainId, sourceId: options.sourceId, path: plan.revision.root, plan, remote: false as const, requestId: options.requestId };
    const preview = delegated.handled ? delegated.result : await (await import('../core/company-brain/runtime.ts')).previewCompanyBrain(engine = await connectEngine(), local);
    console.error(`Company source preview: ${JSON.stringify(preview, (_key, item) => typeof item === 'bigint' ? item.toString() : item)}`);
    console.error('This indexes the reviewed committed files. It does not change source files, access grants, or enable paid/background capabilities.');
    if (!options.yes && !process.stdin.isTTY) {
      if (json) await emit({ schema_version: 1, status: 'blocked', code: 'confirmation_required', brain_id: options.brainId, source_id: options.sourceId, request_id: options.requestId, preview, plan });
      else console.error('Connect requires confirmation. Review this preview, then rerun with --yes for non-interactive use.');
      setCliExitVerdict(2);
      return;
    }
    if (!options.yes) {
      const input = createInterface({ input: process.stdin, output: process.stderr });
      let answer: string;
      try { answer = await input.question('Connect this source? [y/N] '); } finally { input.close(); }
      if (!/^y(?:es)?$/i.test(answer.trim())) {
        if (json) await emit({ schema_version: 1, status: 'cancelled', code: 'declined', brain_id: options.brainId, source_id: options.sourceId });
        else await writeStdoutFinal('Cancelled. No source was connected.\n');
        return;
      }
    }
    console.error(`Request: ${options.requestId}`);
    let result: Record<string, unknown>;
    if (delegated.handled) {
      const connected = await maybeDelegateLocalAdministration('company_brain_connect', { ...params, request_id: options.requestId }, config,
        { timeoutMs: getCliOptions().timeoutMs ?? undefined });
      if (!connected.handled) throw new OperationError('owner_unavailable', 'The resident owner changed after preview. Retry with the same request ID.');
      result = connected.result as Record<string, unknown>;
    } else {
      const { connectCompanyBrain } = await import('../core/company-brain/runtime.ts');
      const connect = () => connectCompanyBrain(engine!, { ...local, requestId: options!.requestId });
      result = { ...(json ? await withHumanLogsToStderr(connect) : await connect()) };
    }
    const status = result.ok === true ? 'complete' : 'incomplete';
    const nextAction = `gbrain sync --brain ${options.brainId} --source ${options.sourceId} --no-embed --no-pull`;
    if (json) await emit({ schema_version: 1, status, ...result, brain_id: options.brainId, source_id: options.sourceId, request_id: options.requestId, next_action: nextAction });
    else await writeStdoutFinal(`Company source ${status}: ${options.brainId}/${options.sourceId}\n${JSON.stringify(result, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2)}\n${status === 'incomplete' ? 'Resume' : 'Next sync'}: ${nextAction}\n`);
    if (result.ok !== true) setCliExitVerdict(1);
  } catch (error) {
    const known = error instanceof OperationError;
    const code = known ? error.code : 'connect_failed';
    const message = known ? error.message : 'The company source could not complete. Inspect source status before retrying; partial progress may be retained.';
    const suggestion = known ? error.suggestion : undefined;
    if (json) await emit({ schema_version: 1, status: 'blocked', code, message, ...(suggestion ? { next_action: suggestion } : {}),
      ...(options ? { request_id: options.requestId } : {}) });
    else console.error(`Error [${code}]: ${message}${suggestion ? `\nFix: ${suggestion}` : ''}${options ? `\nRequest: ${options.requestId}` : ''}`);
    setCliExitVerdict(code === 'invalid_params' ? 2 : 1);
  } finally {
    if (engine) await finishCliTeardown({ engine, drainTimeoutMs: 1000 });
  }
}
