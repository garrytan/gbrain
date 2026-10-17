/** AI SDK LanguageModelV2 adapter for the subscription-backed Codex CLI. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2Content, LanguageModelV2Message, LanguageModelV2Prompt } from '@ai-sdk/provider';

function codexBin(): string { return process.env.GBRAIN_CODEX_CLI_BIN ?? 'codex'; }

export class CodexCliProcessError extends Error {
  readonly apiErrorStatus: number | undefined;
  readonly exitCode: number | undefined;
  constructor(message: string, opts: { apiErrorStatus?: number; exitCode?: number } = {}) {
    super(message); this.name = 'CodexCliProcessError'; this.apiErrorStatus = opts.apiErrorStatus; this.exitCode = opts.exitCode;
  }
}

function renderPrompt(prompt: LanguageModelV2Prompt): string {
  const out: string[] = [];
  for (const msg of prompt as ReadonlyArray<LanguageModelV2Message>) {
    if (msg.role === 'system') { out.push(`System: ${msg.content}`); continue; }
    const parts = msg.content.map((p: any) => {
      if (p.type === 'text') return p.text;
      if (p.type === 'tool-result') return `[tool_result ${typeof p.output === 'string' ? p.output : JSON.stringify(p.output)}]`;
      if (p.type === 'tool-call') return `[tool_use ${p.toolName}(${p.input})]`;
      return '';
    }).filter(Boolean).join('\n');
    if (parts) out.push(`${msg.role === 'assistant' ? 'Assistant' : 'User'}: ${parts}`);
  }
  return `${out.join('\n\n')}\n\nReturn only a JSON object with one string field named "text" containing your response.`;
}

let serialTail: Promise<void> = Promise.resolve();
async function withConcurrencyOne<T>(fn: () => Promise<T>): Promise<T> {
  const previous = serialTail;
  let release!: () => void;
  serialTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await fn(); } finally { release(); }
}

function classifyFailure(raw: string, code: number | null): CodexCliProcessError {
  if (/not logged in|login required|authentication required|unauthorized|401\b/i.test(raw)) {
    return new CodexCliProcessError('codex-cli authentication required: run `codex login`', { apiErrorStatus: 401, exitCode: code ?? undefined });
  }
  if (/usage limit|quota|rate limit|too many requests|credits? exhausted|402\b|429\b/i.test(raw)) {
    const status = /402\b|credits? exhausted/i.test(raw) ? 402 : 429;
    return new CodexCliProcessError(`codex-cli subscription quota exhausted (${status})`, { apiErrorStatus: status, exitCode: code ?? undefined });
  }
  return new CodexCliProcessError(`codex-cli exited ${code}\n--- raw ---\n${raw.trim().slice(0, 1000)}`, { exitCode: code ?? undefined });
}

async function runCodex(prompt: string, model: string, signal?: AbortSignal): Promise<string> {
  return withConcurrencyOne(async () => {
    if (signal?.aborted) throw new CodexCliProcessError('codex-cli adapter aborted');
    const dir = await mkdtemp(join(tmpdir(), 'gbrain-codex-cli-'));
    const schema = join(dir, 'output-schema.json');
    const output = join(dir, 'last-message.json');
    await writeFile(schema, JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }));
    try {
      return await new Promise<string>((resolve, reject) => {
        const args = ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-schema', schema, '--output-last-message', output, '--model', model, '-'];
        const child = spawn(codexBin(), args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = ''; let settled = false;
        const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
        const timer = setTimeout(() => { child.kill('SIGTERM'); fail(new CodexCliProcessError('codex-cli timed out after 120000ms')); }, 120_000);
        const onAbort = () => { child.kill('SIGTERM'); fail(new CodexCliProcessError('codex-cli adapter aborted')); };
        if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', c => { stdout += String(c); }); child.stderr.on('data', c => { stderr += String(c); });
        child.on('error', e => fail(new CodexCliProcessError(`codex-cli spawn failed: ${e.message}`)));
        child.on('close', async code => {
          clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (settled) return;
          if (code !== 0) { settled = true; reject(classifyFailure(`${stderr}\n${stdout}`, code)); return; }
          try {
            const parsed = JSON.parse(await readFile(output, 'utf8')) as { text?: unknown };
            if (typeof parsed.text !== 'string') throw new Error('missing text field');
            settled = true; resolve(parsed.text);
          } catch (error) { fail(new CodexCliProcessError(`codex-cli returned invalid structured output: ${(error as Error).message}`)); }
        });
        child.stdin.end(prompt);
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

function normalizeModel(model: string): string { const i = model.indexOf(':'); return i >= 0 ? model.slice(i + 1) : model; }

export class CodexCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'codex-cli'; readonly modelId: string; readonly supportedUrls = {};
  constructor(modelId: string) { this.modelId = normalizeModel(modelId); }
  async doGenerate(options: LanguageModelV2CallOptions) {
    const text = await runCodex(renderPrompt(options.prompt), this.modelId, options.abortSignal);
    const content: LanguageModelV2Content[] = [{ type: 'text', text }];
    return { content, finishReason: 'stop' as const, usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, cachedInputTokens: undefined }, warnings: [] };
  }
  async doStream(): Promise<never> { throw new Error('codex-cli LanguageModel does not support streaming.'); }
}
