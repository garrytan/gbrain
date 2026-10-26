import { execFile as execFileCb } from '../spawn.ts';
import { promisify } from 'node:util';
import type { ChatOpts, ChatResult } from './gateway.ts';
import { AIConfigError, AITransientError } from './errors.ts';
import { invokeAI } from './invocation-guard.ts';

const execFile = promisify(execFileCb);

export async function chatViaOpenClaw(modelStr: string, opts: ChatOpts): Promise<ChatResult> {
  if (opts.abortSignal?.aborted) throw new DOMException('OpenClaw raw inference was aborted.', 'AbortError');
  if (opts.tools?.length) throw new AIConfigError('OpenClaw raw inference does not expose a tool loop.');
  const modelId = modelStr.replace(/^openclaw:/i, '').trim() || 'default';
  const prompt = renderOpenClawPrompt(opts);
  return invokeAI({ operation: 'gateway.chat.openclaw', kind: 'chat', model: modelStr,
    maxInputTokens: Buffer.byteLength(prompt), estimatedInputTokens: Math.ceil(prompt.length / 4) },
  () => runOpenClaw(modelId, prompt, opts), result => result.providerMetadata?.openclaw?.usageReported
    ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } : null);
}

async function runOpenClaw(modelId: string, prompt: string, opts: ChatOpts): Promise<ChatResult> {
  const args = ['infer', 'model', 'run', '--gateway', '--json', '--prompt', prompt];
  if (modelId !== 'default') args.push('--model', modelId);

  let stdout = '';
  try {
    const result = await execFile('openclaw', args, {
      maxBuffer: 20 * 1024 * 1024,
      signal: opts.abortSignal,
      timeout: opts.timeoutMs ?? 300_000,
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    if (opts.abortSignal?.aborted) throw new DOMException('OpenClaw raw inference was aborted.', 'AbortError');
    throw new AITransientError(
      'OpenClaw raw inference failed; inspect the local OpenClaw diagnostic.',
      'Verify `openclaw infer model run --gateway --json --prompt "Return OK"` works and that the Gateway/OAuth profile is healthy.',
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AITransientError('OpenClaw raw inference returned malformed JSON.');
  }

  if (!parsed?.ok) {
    throw new AITransientError(
      'OpenClaw raw inference returned a failure envelope.',
      'Check `openclaw models status --json` and Gateway logs for the selected model.',
    );
  }

  const text = parsed.outputs?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) throw new AITransientError('OpenClaw raw inference returned no text.');
  const actualModel = parsed.provider && parsed.model ? `${parsed.provider}/${parsed.model}` : modelId;
  const usage = parsed.usage;
  const usageReported = Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0
    && Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0;
  return {
    text,
    blocks: text ? [{ type: 'text', text }] : [],
    stopReason: 'end',
    usage: {
      input_tokens: usageReported ? usage.input_tokens : 0,
      output_tokens: usageReported ? usage.output_tokens : 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model: `openclaw:${actualModel}`,
    providerId: 'openclaw',
    providerMetadata: { openclaw: { transport: parsed.transport, capability: parsed.capability, usageReported } },
  };
}

function renderOpenClawPrompt(opts: ChatOpts): string {
  const lines: string[] = [];
  if (opts.system?.trim()) {
    lines.push('SYSTEM:', opts.system.trim(), '');
  }
  for (const msg of opts.messages) {
    const role = msg.role.toUpperCase();
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map(block => block.type === 'text' ? block.text : JSON.stringify(block)).join('\n');
    lines.push(`${role}:`, content, '');
  }
  return lines.join('\n').trim();
}

