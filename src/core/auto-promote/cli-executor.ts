import type {
  RestrictedRunnerExecutor,
  RestrictedRunnerExecutorRequest,
  RestrictedRunnerExecutorResult,
} from '../services/restricted-runner-service.ts';

export interface RunCommandResult { code: number; stdout: string; stderr: string; }
export type RunCommand = (
  cmd: string,
  args: string[],
  input: string,
  opts: { timeoutMs: number },
) => Promise<RunCommandResult>;

export interface CliRunnerExecutorOptions {
  runCommand?: RunCommand;
  timeoutMs?: number;
  model?: string | null;
}

export function createCliRunnerExecutor(options: CliRunnerExecutorOptions = {}): RestrictedRunnerExecutor {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const timeoutMs = options.timeoutMs ?? 120_000;
  return async (req: RestrictedRunnerExecutorRequest): Promise<RestrictedRunnerExecutorResult> => {
    const argv = buildArgv(req, req.model ?? options.model ?? null);
    if (!argv) {
      return fail('runner_unavailable', `no CLI mapping for runner ${req.runner.kind}`);
    }
    try {
      const out = await runCommand(argv.cmd, argv.args, argv.input, { timeoutMs });
      if (out.code !== 0) {
        return fail('runner_unavailable', out.stderr.slice(0, 500) || `exit ${out.code}`);
      }
      return { status: 'succeeded', output: out.stdout, token_usage_json: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, cost_estimate_usd: null };
    } catch (error) {
      return fail('runner_unavailable', error instanceof Error ? error.message : String(error));
    }
  };
}

function buildArgv(req: RestrictedRunnerExecutorRequest, model: string | null): { cmd: string; args: string[]; input: string } | null {
  const prompt = req.prompt + (req.input ? `\n\n${req.input}` : '');
  if (req.runner.kind === 'claude_code') {
    const args = ['-p', '--output-format', 'json', '--tools', ''];
    if (model) args.push('--model', model);
    return { cmd: 'claude', args, input: prompt };
  }
  if (req.runner.kind === 'codex') {
    const args = ['exec', '--sandbox', 'read-only', '--ignore-rules'];
    if (model) args.push('--model', model);
    args.push('-');
    return { cmd: 'codex', args, input: prompt };
  }
  return null; // local_model/remote_model handled in a later iteration; not in this plan's scope
}

function fail(failureClass: RestrictedRunnerExecutorResult['failure_class'], output: string): RestrictedRunnerExecutorResult {
  return { status: 'failed', output, failure_class: failureClass, token_usage_json: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, cost_estimate_usd: null };
}

const defaultRunCommand: RunCommand = async (cmd, args, input, opts) => {
  const proc = Bun.spawn([cmd, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: safeEnv() });
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* already exited */ } }, opts.timeoutMs);
  try {
    await writeStdin(proc.stdin, input);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

type ChildStdin = Bun.FileSink | WritableStream<Uint8Array> | null | undefined;

async function writeStdin(stdin: ChildStdin, input: string): Promise<void> {
  if (!stdin) return;
  if ('getWriter' in stdin) {
    const writer = stdin.getWriter();
    try {
      if (input) await writer.write(new TextEncoder().encode(input));
    } finally {
      await writer.close();
    }
    return;
  }
  if (input) stdin.write(input);
  await stdin.end();
}

function safeEnv(): Record<string, string> {
  const allow = ['PATH', 'HOME', 'USER', 'LANG', 'TZ'];
  const env: Record<string, string> = {};
  for (const k of allow) { const v = process.env[k]; if (v) env[k] = v; }
  return env;
}
