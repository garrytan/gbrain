/**
 * MessagesClient adapter that shells out to `claude --print` instead of the
 * Anthropic SDK. Lets Claude Max subscribers run Minions subagents on their
 * existing OAuth subscription without an ANTHROPIC_API_KEY.
 *
 * Gated by GBRAIN_USE_CLAUDE_CLI=1 in src/commands/jobs.ts. Default behavior
 * (Anthropic SDK with ANTHROPIC_API_KEY) is unchanged when the env var is unset.
 *
 * Baseline implementation (this commit): single-turn text completion only.
 * Multi-turn conversations work because the subagent handler accumulates
 * messages and re-invokes client.create per turn. Tool use is NOT yet
 * supported — tools passed in params.tools are ignored and the adapter
 * returns a text-only Anthropic.Message shape with stop_reason: 'end_turn'.
 *
 * Tool use lands as a follow-up commit on top of this baseline.
 *
 * Caveats:
 *   - Token counts are approximate (claude --print does emit usage but the
 *     numbers do not always line up with the Anthropic API's accounting).
 *   - The model alias passed to claude must be one Claude CLI recognizes
 *     ('sonnet', 'opus', 'haiku', 'claude-sonnet-4-6', etc.). Provider-prefixed
 *     ids ('anthropic:claude-sonnet-4-6') are stripped before dispatch.
 */
import { spawn } from 'node:child_process';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesClient } from './subagent.ts';

const CLAUDE_BIN = process.env.GBRAIN_CLAUDE_CLI_BIN ?? 'claude';

/** Strip provider prefixes ('anthropic:' / 'litellm:') Claude CLI does not understand. */
function normalizeModel(model: string): string {
  const idx = model.indexOf(':');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

/**
 * Flatten an Anthropic messages array into a single text prompt for `claude --print`.
 * Tool blocks are stringified as JSON placeholders so the model at least sees them
 * during the conversation; native tool_use round-tripping is the follow-up commit.
 */
function flattenMessages(
  system: Anthropic.MessageCreateParamsNonStreaming['system'],
  messages: Anthropic.MessageCreateParamsNonStreaming['messages'],
): string {
  const parts: string[] = [];

  // System prompt: either a plain string or an array of text blocks (with
  // cache_control we ignore).
  if (typeof system === 'string') {
    parts.push(`System: ${system}\n`);
  } else if (Array.isArray(system)) {
    const sysText = system
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('\n');
    if (sysText) parts.push(`System: ${sysText}\n`);
  }

  for (const m of messages) {
    const tag = m.role === 'user' ? 'User' : 'Assistant';
    if (typeof m.content === 'string') {
      parts.push(`${tag}: ${m.content}`);
      continue;
    }
    const rendered = m.content
      .map(b => {
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_use') {
          const tu = b as { type: 'tool_use'; id: string; name: string; input: unknown };
          return `[tool_use ${tu.name}(${JSON.stringify(tu.input)})]`;
        }
        if (b.type === 'tool_result') {
          const tr = b as { type: 'tool_result'; tool_use_id: string; content: unknown };
          const text = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
          return `[tool_result ${text}]`;
        }
        return '';
      })
      .filter(s => s.length > 0)
      .join('\n');
    parts.push(`${tag}: ${rendered}`);
  }

  return parts.join('\n\n');
}

/** Parsed shape of `claude --print --output-format json`. */
interface ClaudeJsonResult {
  type: 'result';
  subtype: 'success' | string;
  is_error: boolean;
  result: string;
  stop_reason: string | null;
  session_id: string;
  num_turns: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number }>;
}

/**
 * Run one Claude CLI invocation and return its parsed `--output-format json` result.
 * Errors propagate as exceptions (non-zero exit OR is_error: true).
 */
function runClaude(
  prompt: string,
  model: string,
  signal?: AbortSignal,
): Promise<ClaudeJsonResult> {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--output-format', 'json', '--model', model];
    const child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new Error('claude-cli adapter aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', err => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error(`claude-cli spawn failed: ${err instanceof Error ? err.message : String(err)}`));
    });

    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(new Error(`claude-cli exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as ClaudeJsonResult;
        if (parsed.is_error) {
          reject(new Error(`claude-cli reported error: ${parsed.result || parsed.subtype}`));
          return;
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`claude-cli output not JSON: ${e instanceof Error ? e.message : String(e)}\n--- raw ---\n${stdout.slice(0, 500)}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Build a MessagesClient that dispatches via the Claude CLI subprocess.
 * Returned shape matches the Anthropic SDK's messages client, so the
 * subagent handler does not need to know which backend is in use.
 */
export function makeClaudeCliClient(): MessagesClient {
  return {
    async create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      opts?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message> {
      const model = normalizeModel(params.model);
      const prompt = flattenMessages(params.system, params.messages);
      const result = await runClaude(prompt, model, opts?.signal);

      const inTokens = result.usage?.input_tokens ?? 0;
      const outTokens = result.usage?.output_tokens ?? 0;
      const cacheRead = result.usage?.cache_read_input_tokens ?? 0;
      const cacheCreate = result.usage?.cache_creation_input_tokens ?? 0;

      const message: Anthropic.Message = {
        id: `msg_claude_cli_${result.session_id}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: result.result, citations: null }],
        stop_reason: (result.stop_reason as Anthropic.Message['stop_reason']) ?? 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: inTokens,
          output_tokens: outTokens,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreate,
        } as Anthropic.Usage,
      };
      return message;
    },
  };
}
