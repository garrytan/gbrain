import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, type ChildProcess } from 'child_process';

export const GBRAIN_INGEST_INFERENCE_MODEL = 'gpt-5.4-mini';
export const DEFAULT_CODEX_OAUTH_TIMEOUT_MS = 120_000;

export type CodexOAuthInferenceErrorCode =
  | 'configuration_error'
  | 'model_rejected'
  | 'runner_failed'
  | 'timeout'
  | 'aborted'
  | 'empty_output'
  | 'oauth_unavailable';

export class CodexOAuthInferenceError extends Error {
  constructor(message: string, public readonly code: CodexOAuthInferenceErrorCode) {
    super(message);
    this.name = 'CodexOAuthInferenceError';
  }
}

export interface CodexOAuthRunnerRequest {
  prompt: string;
  model: typeof GBRAIN_INGEST_INFERENCE_MODEL;
  signal?: AbortSignal;
}

export interface CodexOAuthRunnerResult {
  text: string;
  route: 'codex-oauth';
  model?: string;
}

export type CodexOAuthRunner = (request: CodexOAuthRunnerRequest) => Promise<CodexOAuthRunnerResult>;

export interface CodexOAuthInferenceRequest {
  prompt: string;
  model: string;
  runner?: CodexOAuthRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const INFERENCE_SECRET_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'GBRAIN_EMBEDDINGS_OPENAI_API_KEY',
  'GBRAIN_OPENAI_EMBEDDING_API_KEY',
]);

export function sanitizeInferenceEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (INFERENCE_SECRET_ENV_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function classifyRunnerError(error: unknown): CodexOAuthInferenceError {
  if (error instanceof CodexOAuthInferenceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const stderr = typeof (error as any)?.stderr === 'string' ? (error as any).stderr : '';
  const combined = `${message}\n${stderr}`;
  if (/aborted|aborterror/i.test(combined)) {
    return new CodexOAuthInferenceError('Codex OAuth inference was aborted', 'aborted');
  }
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(combined)) {
    return new CodexOAuthInferenceError('Codex OAuth inference timed out', 'timeout');
  }
  if (/ENOENT|not found|No such file/i.test(combined)) {
    return new CodexOAuthInferenceError('Codex CLI is not available for OAuth inference', 'configuration_error');
  }
  if (/(login|auth|oauth|unauthenticated|authentication|sign in|interactive|browser|device code)/i.test(combined)) {
    return new CodexOAuthInferenceError('Codex OAuth route is unavailable or requires interactive authentication', 'oauth_unavailable');
  }
  return new CodexOAuthInferenceError('Codex OAuth inference failed', 'runner_failed');
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function waitForChild(
  child: ChildProcess,
  signal?: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      killProcessTree(child, 'SIGTERM');
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 2_000).unref?.();
      settle(() => reject(new CodexOAuthInferenceError('Codex OAuth inference was aborted', 'aborted')));
    };

    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000);
    });
    child.on('error', error => {
      settle(() => reject(error));
    });
    child.on('close', code => {
      settle(() => resolve({ code, stderr }));
    });
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

async function liveCodexOAuthRunner(request: CodexOAuthRunnerRequest): Promise<CodexOAuthRunnerResult> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-oauth-'));
  const outputPath = join(dir, 'last-message.txt');
  try {
    const child = spawn('codex', [
      'exec',
      '--model', request.model,
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--output-last-message', outputPath,
      request.prompt,
    ], {
      env: sanitizeInferenceEnv(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const { code, stderr } = await waitForChild(child, request.signal);
    if (code !== 0) {
      const error = new Error(`Codex OAuth process exited with code ${code}`);
      (error as any).stderr = stderr;
      throw error;
    }
    const text = readFileSync(outputPath, 'utf8').trim();
    if (!text) {
      throw new CodexOAuthInferenceError('Codex OAuth runner returned an empty response', 'empty_output');
    }
    return { text, route: 'codex-oauth', model: request.model };
  } catch (e) {
    throw classifyRunnerError(e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function deriveAbortReason(signal?: AbortSignal): CodexOAuthInferenceError {
  const reason = signal?.reason;
  if (reason instanceof CodexOAuthInferenceError) return reason;
  return new CodexOAuthInferenceError('Codex OAuth inference was aborted', 'aborted');
}

async function runWithBoundaries(
  run: (signal?: AbortSignal) => Promise<CodexOAuthRunnerResult>,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<CodexOAuthRunnerResult> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onExternalAbort = () => abort(deriveAbortReason(opts.signal));
  if (opts.signal) {
    if (opts.signal.aborted) throw deriveAbortReason(opts.signal);
    opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  if (opts.timeoutMs > 0) {
    timeout = setTimeout(() => {
      abort(new CodexOAuthInferenceError('Codex OAuth inference timed out', 'timeout'));
    }, opts.timeoutMs);
  }

  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(deriveAbortReason(controller.signal)), { once: true });
      }),
    ]);
  } catch (e) {
    throw classifyRunnerError(e);
  } finally {
    if (timeout) clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function runCodexOAuthInference(request: CodexOAuthInferenceRequest): Promise<CodexOAuthRunnerResult> {
  if (request.model !== GBRAIN_INGEST_INFERENCE_MODEL) {
    throw new CodexOAuthInferenceError(
      `GBrain ingest inference requires model=${GBRAIN_INGEST_INFERENCE_MODEL}; got ${String(request.model || '(omitted)')}`,
      'model_rejected',
    );
  }
  if (!request.prompt.trim()) {
    throw new CodexOAuthInferenceError('GBrain ingest inference prompt is empty', 'runner_failed');
  }
  const runner = request.runner ?? liveCodexOAuthRunner;
  const result = await runWithBoundaries((signal) => runner({
      prompt: request.prompt,
      model: GBRAIN_INGEST_INFERENCE_MODEL,
      signal,
    }), {
      timeoutMs: request.timeoutMs ?? DEFAULT_CODEX_OAUTH_TIMEOUT_MS,
      signal: request.signal,
  });
  if (!result.text.trim()) {
    throw new CodexOAuthInferenceError('Codex OAuth runner returned an empty response', 'empty_output');
  }
  return { ...result, text: result.text.trim(), model: result.model ?? GBRAIN_INGEST_INFERENCE_MODEL };
}
