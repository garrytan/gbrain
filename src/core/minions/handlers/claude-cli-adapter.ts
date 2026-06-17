/**
 * MessagesClient adapter that shells out to `claude --print` instead of the
 * Anthropic SDK. Lets Claude Max subscribers run Minions subagents on their
 * existing OAuth subscription without an ANTHROPIC_API_KEY.
 *
 * Gated by GBRAIN_SUBAGENT_PROVIDER=claude-cli in src/commands/jobs.ts.
 * Default behavior (Anthropic SDK with ANTHROPIC_API_KEY) is unchanged when
 * the env var is unset or set to any other value.
 *
 * Tool use: supported via system-prompt-instructed JSON emission. When
 * params.tools is non-empty, the adapter injects a fenced instruction block
 * into the system prompt telling the model to emit `<use_tools>...</use_tools>`
 * blocks for tool calls. The adapter parses those blocks back into
 * Anthropic tool_use content blocks so the subagent loop dispatches them
 * exactly as it would with the native SDK.
 *
 * Caveats:
 *   - Token counts come from claude-cli's reporting; cache-tier numbers are
 *     approximate and the system-prompt addendum the adapter injects is not
 *     reflected in the model's accounting.
 *   - The model alias passed to claude must be one Claude CLI recognizes
 *     ('sonnet', 'opus', 'haiku', 'claude-sonnet-4-6', etc.). Provider-prefixed
 *     ids ('anthropic:claude-sonnet-4-6') are stripped before dispatch.
 *   - The adapter does not register tools with claude via --mcp-config; it
 *     uses pure prompt instruction. This avoids MCP setup and works across
 *     claude-cli versions, but relies on the model's instruction-following
 *     for the emission format.
 *
 * Context isolation: the adapter spawns claude-cli from a clean working
 * directory (no CLAUDE.md to auto-discover) and passes --disable-slash-commands
 * + --system-prompt to suppress skill resolution and replace the default
 * system prompt. This is the maximum contamination-suppression that still
 * preserves OAuth / Claude Max subscription auth. The --bare flag would
 * also strip user-level ~/.claude/CLAUDE.md but it forces ANTHROPIC_API_KEY
 * auth, defeating the whole point of this adapter; the ~42k cached tokens
 * from user-level instructions are accepted as a cost-trivial trade-off
 * because the Max subscription absorbs the per-call cost. Behavioral
 * contamination (subagent picking up operator-level coding conventions) is
 * the real residual risk; mitigated by gbrain's strong per-call system
 * prompt overriding any drift.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesClient } from './subagent.ts';

const CLAUDE_BIN = process.env.GBRAIN_CLAUDE_CLI_BIN ?? 'claude';
const CLAUDE_CWD = join(tmpdir(), `gbrain-claude-cli-cwd-${process.pid}`);
let cwdEnsured = false;
function ensureCleanCwd(): string {
  if (!cwdEnsured) {
    mkdirSync(CLAUDE_CWD, { recursive: true });
    cwdEnsured = true;
  }
  return CLAUDE_CWD;
}

/** Strip provider prefixes ('anthropic:' / 'litellm:') Claude CLI does not understand. */
function normalizeModel(model: string): string {
  const idx = model.indexOf(':');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

/**
 * Build the system-prompt addendum that teaches the model the
 * <use_tools>...</use_tools> emission format. Returns an empty string when
 * no tools are registered for this turn.
 */
function buildToolUseInstructions(tools: Anthropic.MessageCreateParamsNonStreaming['tools']): string {
  if (!tools || tools.length === 0) return '';

  // Render only the fields the model needs to call the tool. cache_control
  // and other API-side hints are not part of the model's decision surface.
  const toolSpecs = tools.map(t => {
    const tool = t as { name: string; description?: string; input_schema?: unknown };
    return {
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.input_schema ?? { type: 'object', properties: {} },
    };
  });

  return [
    '',
    '## Tool Use Protocol',
    '',
    'You have access to these tools:',
    '',
    '```json',
    JSON.stringify(toolSpecs, null, 2),
    '```',
    '',
    'To call one or more tools in this turn, emit EXACTLY ONE block of this form, ' +
      'with no other text outside the block on its own lines:',
    '',
    '<use_tools>',
    '[',
    '  {"id": "<unique tool call id, like toolu_01ABC>", "name": "<tool name>", "input": <input object matching the tool\'s input_schema>}',
    ']',
    '</use_tools>',
    '',
    'Multiple tool calls go in the array. Tool results are returned to you on the ' +
      'next turn as [tool_result <text>] entries. You may then call more tools or emit a final response.',
    '',
    'When you are ready to give a final answer instead of calling tools, respond with prose text only — ' +
      'do not include a <use_tools> block in that case.',
    '',
  ].join('\n');
}

/**
 * Flatten an Anthropic messages array into a single text prompt for `claude --print`.
 * Tool blocks are rendered so the model sees the conversation in a coherent shape:
 *   - tool_use blocks become `[tool_use <name>(<input>)]`
 *   - tool_result blocks become `[tool_result <content>]`
 * This preserves the chain even though the adapter does not round-trip native
 * Anthropic tool_use blocks through claude-cli.
 */
function buildSystemPrompt(
  system: Anthropic.MessageCreateParamsNonStreaming['system'],
  toolInstructions: string,
): string {
  let sysText = '';
  if (typeof system === 'string') {
    sysText = system;
  } else if (Array.isArray(system)) {
    sysText = system
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('\n');
  }
  return [sysText, toolInstructions].filter(s => s.length > 0).join('\n');
}

function flattenMessages(messages: Anthropic.MessageCreateParamsNonStreaming['messages']): string {
  const parts: string[] = [];
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
 *
 * Args include the contamination-suppression flags:
 *   --disable-slash-commands  : skip skill resolution (slash commands)
 *   --system-prompt <gbrain prompt> : replace the default system prompt entirely
 * Spawned from a clean tmpdir so local CLAUDE.md auto-discovery has nothing
 * to find. User-level CLAUDE.md still applies (unavoidable with OAuth).
 */
function runClaude(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  signal?: AbortSignal,
): Promise<ClaudeJsonResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--output-format', 'json',
      '--model', model,
      '--disable-slash-commands',
    ];
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
    const child = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: ensureCleanCwd(),
    });

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

    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

/**
 * Parsed shape of a single tool-call emission from the model. Matches the
 * Anthropic tool_use block surface so callers can spread it directly.
 */
interface ParsedToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Find and parse the <use_tools>...</use_tools> block in the assistant's
 * raw text response. Returns {toolCalls, beforeText, afterText} where the
 * text segments are whatever surrounded the block. When no block is found,
 * returns toolCalls=[] and the full text in beforeText.
 *
 * The block is tolerant of either fenced (```json ... ```) or bare JSON
 * inside the delimiters; both shapes appear in practice depending on the
 * model's interpretation of the instructions.
 */
function extractToolCalls(raw: string): {
  toolCalls: ParsedToolCall[];
  beforeText: string;
  afterText: string;
} {
  const openTag = '<use_tools>';
  const closeTag = '</use_tools>';
  const openIdx = raw.indexOf(openTag);
  if (openIdx === -1) {
    return { toolCalls: [], beforeText: raw.trim(), afterText: '' };
  }
  const closeIdx = raw.indexOf(closeTag, openIdx + openTag.length);
  if (closeIdx === -1) {
    // Unterminated block: treat as plain text rather than throwing — the
    // subagent loop will see no tool_use, exit, and the operator gets the
    // partial text in finalText.
    return { toolCalls: [], beforeText: raw.trim(), afterText: '' };
  }

  const beforeText = raw.slice(0, openIdx).trim();
  const afterText = raw.slice(closeIdx + closeTag.length).trim();
  let inner = raw.slice(openIdx + openTag.length, closeIdx).trim();

  // Strip optional ```json ... ``` fencing.
  if (inner.startsWith('```')) {
    inner = inner.replace(/^```(?:json|JSON)?\s*\n?/, '').replace(/\n?```$/, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    // Malformed JSON: fall back to text-only so the loop terminates gracefully.
    return { toolCalls: [], beforeText: raw.trim(), afterText: '' };
  }
  if (!Array.isArray(parsed)) {
    return { toolCalls: [], beforeText: raw.trim(), afterText: '' };
  }

  const toolCalls: ParsedToolCall[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : null;
    if (!name) continue;
    const id = typeof e.id === 'string' && e.id.length > 0
      ? e.id
      : `toolu_claude_cli_${Math.random().toString(36).slice(2, 12)}`;
    toolCalls.push({ id, name, input: e.input ?? {} });
  }

  return { toolCalls, beforeText, afterText };
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
      const toolInstructions = buildToolUseInstructions(params.tools);
      const systemPrompt = buildSystemPrompt(params.system, toolInstructions);
      const userPrompt = flattenMessages(params.messages);
      const result = await runClaude(systemPrompt, userPrompt, model, opts?.signal);

      const inTokens = result.usage?.input_tokens ?? 0;
      const outTokens = result.usage?.output_tokens ?? 0;
      const cacheRead = result.usage?.cache_read_input_tokens ?? 0;
      const cacheCreate = result.usage?.cache_creation_input_tokens ?? 0;

      const { toolCalls, beforeText, afterText } = extractToolCalls(result.result);

      // Build content blocks in the order the model produced them: any
      // leading prose, then the tool_use blocks, then any trailing prose.
      // The subagent loop concatenates text blocks for finalText and
      // dispatches each tool_use, so block ordering matters less here than
      // it would for human-facing rendering — but we preserve it anyway so
      // the persisted conversation history reads naturally on resume.
      const content: Anthropic.ContentBlock[] = [];
      if (beforeText) {
        content.push({ type: 'text', text: beforeText });
      }
      for (const call of toolCalls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input as Record<string, unknown>,
        } as Anthropic.ContentBlock);
      }
      if (afterText) {
        content.push({ type: 'text', text: afterText });
      }
      // Defensive: if the model returned nothing parseable (empty string,
      // pure whitespace), make sure we still hand the subagent loop a
      // well-formed content array so it does not crash on `blocks.filter`.
      if (content.length === 0) {
        content.push({ type: 'text', text: result.result ?? '' });
      }

      const stopReason: Anthropic.Message['stop_reason'] = toolCalls.length > 0
        ? 'tool_use'
        : ((result.stop_reason as Anthropic.Message['stop_reason']) ?? 'end_turn');

      const message: Anthropic.Message = {
        id: `msg_claude_cli_${result.session_id}`,
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: stopReason,
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
