/** AI SDK LanguageModelV2 adapter for the subscription-backed Grok CLI. */
import { spawn } from 'node:child_process';
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2Content, LanguageModelV2Message, LanguageModelV2Prompt } from '@ai-sdk/provider';

function grokBin(): string { return process.env.GBRAIN_GROK_CLI_BIN ?? 'grok'; }

export class GrokCliProcessError extends Error {
  readonly apiErrorStatus: number | undefined;
  readonly exitCode: number | undefined;
  constructor(message: string, opts: { apiErrorStatus?: number; exitCode?: number } = {}) {
    super(message); this.name = 'GrokCliProcessError'; this.apiErrorStatus = opts.apiErrorStatus; this.exitCode = opts.exitCode;
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
  return out.join('\n\n');
}

function extractText(stdout: string): string {
  const raw = stdout.trim();
  if (!raw) return '';
  try {
    const parsed: any = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    for (const key of ['result', 'response', 'text', 'content', 'message']) {
      const value = parsed?.[key];
      if (typeof value === 'string') return value;
      if (value && typeof value.content === 'string') return value.content;
    }
    if (Array.isArray(parsed)) {
      const texts = parsed.flatMap((item: any) => [item?.text, item?.content, item?.message?.content]).filter((v: unknown) => typeof v === 'string');
      if (texts.length) return texts.join('');
    }
  } catch { /* malformed JSON: plain output is still a valid completion */ }
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function runGrok(prompt: string, model: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(grokBin(), ['--single', prompt, '--output-format', 'plain', '--model', model, '--max-turns', '1', '--no-subagents', '--disable-web-search', '--tools', '', '--verbatim'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const finishReject = (err: Error) => { if (!settled) { settled = true; reject(err); } };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finishReject(new GrokCliProcessError('grok-cli timed out after 120000ms')); }, 120_000);
    const onAbort = () => { child.kill('SIGTERM'); finishReject(new GrokCliProcessError('grok-cli adapter aborted')); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', c => { stdout += String(c); }); child.stderr.on('data', c => { stderr += String(c); });
    child.on('error', e => finishReject(new GrokCliProcessError(`grok-cli spawn failed: ${e.message}`)));
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (settled) return;
      const raw = `${stderr}\n${stdout}`;
      if (/not signed in|not logged in|run [`']?grok login/i.test(raw)) { settled = true; reject(new GrokCliProcessError('grok-cli authentication required: run `grok login`', { apiErrorStatus: 401, exitCode: code ?? undefined })); return; }
      if (code !== 0) { settled = true; reject(new GrokCliProcessError(`grok-cli exited ${code}\n--- raw ---\n${(stderr.trim() || stdout.trim()).slice(0, 1000)}`, { exitCode: code ?? undefined })); return; }
      settled = true; resolve(extractText(stdout));
    });
  });
}

function normalizeModel(model: string): string { const i = model.indexOf(':'); return i >= 0 ? model.slice(i + 1) : model; }

export class GrokCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'grok-cli'; readonly modelId: string; readonly supportedUrls = {};
  constructor(modelId: string) { this.modelId = normalizeModel(modelId); }
  async doGenerate(options: LanguageModelV2CallOptions) {
    const text = await runGrok(renderPrompt(options.prompt), this.modelId, options.abortSignal);
    const content: LanguageModelV2Content[] = [{ type: 'text', text }];
    return { content, finishReason: 'stop' as const, usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, cachedInputTokens: undefined }, warnings: [] };
  }
  async doStream(): Promise<never> { throw new Error('grok-cli LanguageModel does not support streaming.'); }
}
