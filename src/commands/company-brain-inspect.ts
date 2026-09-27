import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspectCompanyBrain } from '../core/company-brain/inspection.ts';
import { COMPANY_BRAIN_PROFILE, type CompanyBrainPlan } from '../core/company-brain/types.ts';
import { isThinClient, loadConfig } from '../core/config.ts';
import { OperationError } from '../core/ops/contract.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';

export const COMPANY_BRAIN_INSPECT_HELP = `Inspect an existing company repository without importing it:
  gbrain sources inspect <path> [--profile company-brain] [--json]
                         [--include <glob>] [--exclude <glob>] [--out <file>]

Only committed Markdown is inspected. Dirty and unsupported files are reported.
No database, network, provider, repository hooks, or source edits are required.
The optional --out writes a private plan file and refuses to overwrite a file.
Repeat --include and --exclude to choose repository-relative paths.
Without --profile, a recognizable company layout is recommended, never activated.
Run connect on the company brain's host after reviewing the plan.
`;

export interface CompanyBrainInspectionArgs {
  path: string;
  profile?: typeof COMPANY_BRAIN_PROFILE;
  include: string[];
  exclude: string[];
  json: boolean;
  out?: string;
}

export function parseCompanyBrainInspectionArgs(args: string[]): CompanyBrainInspectionArgs {
  const result: CompanyBrainInspectionArgs = { path: '', include: [], exclude: [], json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { result.json = true; continue; }
    if (!arg.startsWith('-')) {
      if (result.path) throw new OperationError('invalid_params', 'Inspect accepts exactly one repository path.');
      result.path = arg;
      continue;
    }
    const equal = arg.indexOf('=');
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    if (!['--profile', '--include', '--exclude', '--out'].includes(flag)) {
      throw new OperationError('invalid_params', `Unknown inspect option ${JSON.stringify(flag)}.`);
    }
    const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
    if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${flag} requires a value.`);
    if (flag === '--profile') {
      if (value !== COMPANY_BRAIN_PROFILE || result.profile) throw new OperationError('invalid_params', 'Select --profile company-brain once.');
      result.profile = COMPANY_BRAIN_PROFILE;
    } else if (flag === '--include') result.include.push(value);
    else if (flag === '--exclude') result.exclude.push(value);
    else {
      if (result.out) throw new OperationError('invalid_params', 'Choose one --out file.');
      result.out = value;
    }
  }
  if (!result.path) throw new OperationError('invalid_params', 'A local repository path is required.');
  return result;
}

export function renderCompanyBrainInspection(plan: CompanyBrainPlan): string {
  const lines = [
    `Company-brain inspection: ${plan.ready ? 'ready for destination review' : 'blocked'}`,
    `Repository: ${JSON.stringify(plan.revision?.root ?? '<unavailable>')}`,
    `Revision: ${plan.revision?.commit ?? '<unavailable>'}`,
    `Profile: ${plan.profile} (${plan.profile_selection}); schema ${plan.schema?.identity ?? '<unavailable>'}`,
    `Files: ${plan.counts.tracked} tracked; ${plan.counts.included} included; ${plan.counts.excluded} excluded; ${plan.counts.unsupported} unsupported`,
    `Uncommitted: ${plan.counts.dirty_eligible} eligible changes; ${plan.counts.untracked} untracked files`,
  ];
  for (const item of plan.findings) {
    lines.push(`${item.severity.toUpperCase()} [${item.code}]${item.path ? ` ${JSON.stringify(item.path)}` : ''}: ${item.message}`);
  }
  lines.push('No source was registered, schema activated, or content imported.');
  lines.push(plan.ready
    ? 'Next: connect this plan to an explicitly selected initialized company brain.'
    : 'Correct or exclude the reported inputs, then inspect again.');
  return `${lines.join('\n')}\n`;
}

export async function runCompanyBrainInspection(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    await writeStdoutFinal(COMPANY_BRAIN_INSPECT_HELP);
    return;
  }
  let json = args.includes('--json');
  try {
    const options = parseCompanyBrainInspectionArgs(args);
    json = options.json;
    if (isThinClient(loadConfig())) throw new OperationError('permission_denied',
      'Company repository inspection runs locally on the brain host, not through a thin-client installation.');
    const plan = await inspectCompanyBrain(options);
    if (options.out) {
      const out = resolve(options.out);
      mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        throw new OperationError('plan_output_failed', (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'The plan output already exists. Choose a new --out path; nothing was overwritten.'
          : 'The private plan output could not be written. Check the output directory and retry.');
      }
    }
    await writeStdoutFinal(json ? `${JSON.stringify({ schema_version: 1, status: plan.ready ? 'ready' : 'blocked',
      code: plan.ready ? 'ok' : plan.findings.find(item => item.severity === 'error')?.code ?? 'source_not_ready', plan })}\n`
      : renderCompanyBrainInspection(plan));
    if (!plan.ready) setCliExitVerdict(1);
  } catch (error) {
    const known = error instanceof OperationError;
    const code = known ? error.code : 'inspection_failed';
    const message = known ? error.message : 'Inspection could not complete. Check the local repository and retry.';
    if (json) await writeStdoutFinal(`${JSON.stringify({ schema_version: 1, status: 'blocked', code, message })}\n`);
    else console.error(`Error [${code}]: ${message}\nRun: gbrain sources inspect --help`);
    setCliExitVerdict(code === 'invalid_params' ? 2 : 1);
  }
}
