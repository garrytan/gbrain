/**
 * ai-sdk LanguageModelV2 implementation that dispatches via the `codex exec`
 * CLI subprocess. Used by the `codex-cli` recipe to route gateway.toolLoop /
 * gateway.chat calls through the Codex CLI's ChatGPT OAuth session instead of
 * the OpenAI SDK + OPENAI_API_KEY.
 *
 * Per-call routing is the contract: the gateway resolves the model string
 * to this recipe based on the `codex-cli:` prefix, instantiates one of
 * these objects per modelId, and dispatches doGenerate. Sibling subagent
 * jobs with `claude-cli:...` or `litellm:...` continue routing through their
 * own providers in the same worker; no env-var switch, no global state.
 *
 * Tool use is supported via prompt-instructed JSON emission — the SAME
 * `<use_tools>[{id,name,input}, ...]</use_tools>` protocol the claude-cli
 * provider teaches (see claude-cli-language-model.ts). The protocol helpers
 * are mirrored here rather than extracted so this change stays additive-only;
 * extraction into a shared cli-tool-protocol module is a natural follow-up
 * once two providers prove the shape.
 *
 * Context isolation:
 *   - Spawned from a dedicated tmpdir (`-C`) so AGENTS.md auto-discovery has
 *     no local files to find; `--skip-git-repo-check` skips the repo probe.
 *   - `--ignore-user-config` stops ~/.codex/config.toml from loading — user
 *     MCP servers (including gbrain's own MCP → recursion + PGLite lock
 *     contention), custom model defaults, and instruction overrides all stay
 *     out of the subprocess. Auth state (auth.json) still loads.
 *   - `--sandbox read-only` pins the agent sandbox down for defense in
 *     depth; with the tool-use protocol the model answers in text and has
 *     nothing to execute anyway.
 *   - Codex has no `--system-prompt` flag, so system messages are rendered
 *     as a leading `## System` section of the stdin prompt.
 *
 * Output channel: `-o <file>` writes the agent's final message verbatim;
 * stdout carries progress logs and is discarded. Token usage is not exposed
 * on this channel, so usage fields are undefined (the budget ledger treats
 * subscription-billed calls as nominal anyway — see the recipe comment).
 *
 * doStream is not yet implemented; the model declares no streaming. Callers
 * (gateway.toolLoop primarily) use doGenerate.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
  LanguageModelV2Message,
  LanguageModelV2ProviderDefinedTool,
} from '@ai-sdk/provider';

function codexBin(): string {
  return process.env.GBRAIN_CODEX_CLI_BIN ?? 'codex';
}
const CODEX_CWD = join(tmpdir(), `gbrain-codex-cli-cwd-${process.pid}`);
let cwdEnsured = false;
function ensureCleanCwd(): string {
  if (!cwdEnsured) {
    mkdirSync(CODEX_CWD, { recursive: true });
    cwdEnsured = true;
  }
  return CODEX_CWD;
}

/**
 * Build the prompt addendum that teaches the model the
 * `<use_tools>...</use_tools>` emission format. Returns the empty string
 * when no tools are registered for this turn so the model gets a normal
 * text-completion prompt without protocol noise.
 *
 * Mirrors claude-cli-language-model.ts `buildToolUseInstructions`.
 */
function buildToolUseInstructions(
  tools: ReadonlyArray<LanguageModelV2FunctionTool | LanguageModelV2ProviderDefinedTool> | undefined,
): string {
  if (!tools || tools.length === 0) return '';

  const functionTools = tools.filter((t): t is LanguageModelV2FunctionTool => t.type === 'function');
  if (functionTools.length === 0) return '';

  const toolSpecs = functionTools.map(t => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));

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
 * Render the ai-sdk message array into a single text prompt for `codex exec -`
 * stdin. Codex has no --system-prompt flag, so system messages become a
 * leading `## System` section. Tool calls and tool results are rendered as
 * placeholders so the model sees the conversation in a coherent shape even
 * though the adapter does not natively round-trip tool calls through the CLI.
 */
function renderPrompt(prompt: LanguageModelV2Prompt): { systemText: string; userPrompt: string } {
  const systemParts: string[] = [];
  const convo: string[] = [];

  for (const msg of prompt as ReadonlyArray<LanguageModelV2Message>) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'user') {
      const text = msg.content
        .map(p => {
          if (p.type === 'text') return p.text;
          // File parts get a stub — multimodal is not supported via subprocess yet.
          if (p.type === 'file') return `[file ${p.mediaType ?? 'unknown'}]`;
          return '';
        })
        .filter(s => s.length > 0)
        .join('\n');
      if (text) convo.push(`User: ${text}`);
      continue;
    }
    if (msg.role === 'assistant') {
      const rendered = msg.content
        .map(p => {
          if (p.type === 'text') return p.text;
          if (p.type === 'reasoning') return ''; // dropped on replay
          if (p.type === 'tool-call') {
            return `[tool_use ${p.toolName}(${p.input})]`;
          }
          if (p.type === 'tool-result') {
            const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
            return `[tool_result ${out}]`;
          }
          return '';
        })
        .filter(s => s.length > 0)
        .join('\n');
      if (rendered) convo.push(`Assistant: ${rendered}`);
      continue;
    }
    if (msg.role === 'tool') {
      const rendered = msg.content
        .map(p => {
          const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
          return `[tool_result ${out}]`;
        })
        .join('\n');
      if (rendered) convo.push(`User: ${rendered}`);
      continue;
    }
  }

  return { systemText: systemParts.join('\n'), userPrompt: convo.join('\n\n') };
}

/**
 * Spawn `codex exec` with the contamination-suppression flags and return the
 * final agent message from the `-o` output file. Aborts propagate to SIGTERM
 * on the child.
 */
function runCodex(
  fullPrompt: string,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const outFile = join(
      ensureCleanCwd(),
      `codex-out-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`,
    );
    const args = [
      'exec',
      // Agent isolation: this subprocess must behave like a raw LLM, not a
      // full Codex agent. `--ignore-user-config` stops ~/.codex/config.toml
      // (user MCP servers, model defaults, instruction overrides) from
      // loading — without it, each call would boot the user's MCP servers,
      // including gbrain's own MCP → recursion + PGLite single-writer lock
      // contention. `--sandbox read-only` pins the sandbox for defense in
      // depth. `-C` + `--skip-git-repo-check` keep AGENTS.md discovery and
      // the repo probe out of a clean tmpdir.
      '--ignore-user-config',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '-C', ensureCleanCwd(),
      '-m', model,
      '-o', outFile,
      // Read the prompt from stdin — argv has a hard size ceiling and
      // subagent prompts (context + tool specs) routinely exceed it.
      '-',
    ];
    // Env scrub: guarantee the CLI authenticates via its own OAuth session
    // (subscription), never via an inherited API key. Without this, an
    // OPENAI_API_KEY in gbrain's env (the exact setup this recipe is meant
    // to replace) silently flips billing to per-token API usage.
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    const child = spawn(codexBin(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: ensureCleanCwd(),
      env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new Error('codex-cli adapter aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const readOutFile = (): string | null => {
      try {
        const text = readFileSync(outFile, 'utf8');
        rmSync(outFile, { force: true });
        return text;
      } catch {
        return null;
      }
    };

    child.on('error', err => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error(`codex-cli spawn failed: ${err instanceof Error ? err.message : String(err)}`));
    });

    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(new Error(`codex-cli exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const text = readOutFile();
      if (text === null || text.trim().length === 0) {
        reject(new Error(
          `codex-cli exited 0 but wrote no final message to -o file\n--- stderr ---\n${stderr.slice(0, 500)}`,
        ));
        return;
      }
      resolve(text.trim());
    });

    // stdin error handler: if the binary does not exist (ENOENT) or the child
    // dies before draining stdin, write/end can emit an unhandled 'error'
    // (EPIPE) that would crash the worker. The spawn-level 'error' / non-zero
    // 'close' handlers above already surface the real failure, so the stdin
    // error itself is safe to swallow.
    child.stdin.on('error', () => { /* surfaced via child 'error'/'close' */ });
    try {
      child.stdin.write(fullPrompt);
      child.stdin.end();
    } catch (e) {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error(`codex-cli stdin write failed (is the codex binary installed?): ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}

interface ParsedToolCall {
  id: string;
  name: string;
  /** Stringified JSON, matching the ai-sdk LanguageModelV2ToolCall.input contract. */
  input: string;
}

/**
 * Locate and parse the `<use_tools>...</use_tools>` block in the assistant's
 * raw text response. Returns the parsed tool calls plus whatever prose
 * surrounded the block. Returns an empty `toolCalls` array when no block is
 * present, malformed, or unterminated — the caller then treats the full
 * raw text as a final text response.
 *
 * Mirrors claude-cli-language-model.ts `extractToolCalls`.
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
    // Unterminated block — recover gracefully.
    return { toolCalls: [], beforeText: raw.trim(), afterText: '' };
  }

  const beforeText = raw.slice(0, openIdx).trim();
  const afterText = raw.slice(closeIdx + closeTag.length).trim();
  let inner = raw.slice(openIdx + openTag.length, closeIdx).trim();

  if (inner.startsWith('```')) {
    inner = inner.replace(/^```(?:json|JSON)?\s*\n?/, '').replace(/\n?```$/, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
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
      : `toolu_codex_cli_${Math.random().toString(36).slice(2, 12)}`;
    const inputJson = JSON.stringify(e.input ?? {});
    toolCalls.push({ id, name, input: inputJson });
  }

  return { toolCalls, beforeText, afterText };
}

/**
 * Strip provider prefixes (`openai:`, `litellm:`, `codex-cli:`) that the
 * underlying CLI does not understand. The gateway hands us a bare model id
 * via `recipe.aliases` resolution, but defensive normalization here keeps
 * direct LanguageModelV2 construction (in tests, for example) ergonomic.
 */
function normalizeModel(model: string): string {
  const idx = model.indexOf(':');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

export class CodexCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'codex-cli';
  readonly modelId: string;
  readonly supportedUrls = {};

  constructor(modelId: string) {
    this.modelId = normalizeModel(modelId);
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown';
    usage: { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined };
    warnings: never[];
  }> {
    const { systemText, userPrompt } = renderPrompt(options.prompt);
    const toolInstructions = buildToolUseInstructions(options.tools);
    // No --system-prompt flag on codex exec: system text + tool protocol
    // lead the stdin prompt as a `## System` section instead.
    const fullPrompt = [
      systemText ? `## System\n\n${systemText}` : '',
      toolInstructions,
      userPrompt,
    ].filter(s => s.length > 0).join('\n\n');

    const raw = await runCodex(fullPrompt, this.modelId, options.abortSignal);
    const { toolCalls, beforeText, afterText } = extractToolCalls(raw);

    const content: LanguageModelV2Content[] = [];
    if (beforeText) content.push({ type: 'text', text: beforeText });
    for (const call of toolCalls) {
      content.push({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      });
    }
    if (afterText) content.push({ type: 'text', text: afterText });
    if (content.length === 0) {
      // Empty response — still hand the caller a well-formed content array.
      content.push({ type: 'text', text: raw });
    }

    const finishReason = toolCalls.length > 0 ? 'tool-calls' as const : 'stop' as const;

    return {
      content,
      finishReason,
      // The -o output channel carries no token accounting; leave usage
      // undefined rather than fabricate numbers (subscription billing makes
      // the ledger nominal for this recipe anyway).
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      warnings: [],
    };
  }

  async doStream(): Promise<never> {
    throw new Error(
      'codex-cli LanguageModel does not support streaming. Use doGenerate or set ' +
      'the model on a non-streaming chat surface (gateway.toolLoop is non-streaming).',
    );
  }
}
