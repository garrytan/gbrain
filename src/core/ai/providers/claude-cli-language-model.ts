/**
 * ai-sdk LanguageModelV2 implementation that dispatches via the `claude --print`
 * CLI subprocess. Used by the `claude-cli` recipe to route gateway.toolLoop /
 * gateway.chat calls through Claude Code's OAuth session instead of the
 * Anthropic SDK + ANTHROPIC_API_KEY.
 *
 * Per-call routing is the contract: the gateway resolves the model string
 * to this recipe based on the `claude-cli:` prefix, instantiates one of
 * these objects per modelId, and dispatches doGenerate. Sibling subagent
 * jobs with `litellm:gpt-5.4` continue routing through litellm-proxy in
 * the same worker; no env-var switch, no global state.
 *
 * Tool use is supported via system-prompt-instructed JSON emission:
 *   The recipe injects a fenced instruction block into the system prompt
 *   that teaches the model the `<use_tools>[{name,input}, ...]</use_tools>`
 *   emission format (ids are gbrain-minted, never model-authored — #4155). The adapter parses those blocks back into ai-sdk
 *   `tool-call` content parts. Parallel tool calls (multiple entries in
 *   the JSON array) round-trip cleanly — this is the case that breaks
 *   on the codex-proxy / litellm GPT-5.x bridge today.
 *
 * Context isolation:
 *   The subprocess is spawned from a dedicated tmpdir so claude-cli's
 *   CLAUDE.md auto-discovery has no local files to find. `--system-prompt`
 *   replaces the default system prompt; `--disable-slash-commands` skips
 *   skill resolution. User-level ~/.claude/CLAUDE.md still loads because
 *   the only way to skip it is `--bare`, which forces ANTHROPIC_API_KEY
 *   auth and defeats the whole point of this provider. The ~42k cached
 *   tokens from user-level instructions are accepted as a cost-trivial
 *   trade-off on the subscription path. #4119: when those user-level
 *   instructions must NOT leak into a measurement (SkillOpt rollouts),
 *   set GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG — see resolveHermeticConfigDir.
 *
 * doStream is not yet implemented; the model declares no streaming. Callers
 * (gateway.toolLoop primarily) use doGenerate.
 */
import { randomUUIDv7 } from 'bun';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import {
  claudeCliConfigDir,
  claudeCliCwdDir,
  sweepDeadClaudeCliScratchDirs,
} from './claude-cli-scratch.ts';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
  LanguageModelV2Message,
  LanguageModelV2ProviderDefinedTool,
} from '@ai-sdk/provider';

function claudeBin(): string {
  return process.env.GBRAIN_CLAUDE_CLI_BIN ?? 'claude';
}
// #4472: the per-PID dir names + the transcript-fingerprint predicate live in
// claude-cli-scratch.ts so transcript discovery can exclude the sessions these
// subprocess cwds mint under ~/.claude/projects/ without importing this module.
const CLAUDE_CWD = claudeCliCwdDir();
let cwdEnsured = false;
function ensureCleanCwd(): string {
  if (!cwdEnsured) {
    // #4472: the per-PID naming leaks one scratch dir per crashed/killed
    // gbrain process forever — sweep dead-PID leftovers once per process at
    // provider init. Best-effort: a sweep failure never breaks a chat call.
    try { sweepDeadClaudeCliScratchDirs(); } catch { /* best-effort */ }
    mkdirSync(CLAUDE_CWD, { recursive: true });
    cwdEnsured = true;
  }
  return CLAUDE_CWD;
}

// #4119 — opt-in hermetic config dir for the child. See resolveHermeticConfigDir.
const CLAUDE_HERMETIC_CONFIG = claudeCliConfigDir();
let hermeticEnsured = false;
/**
 * Resolve the CLAUDE_CONFIG_DIR the child should run with when
 * GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG is set (#4119). Returns null when the
 * knob is unset/off — the child then inherits the user's real config dir
 * (today's behavior). `1`/`true` → a per-process empty tmpdir; any other
 * non-empty value is used verbatim as the config-dir path.
 *
 * Opt-in, NOT default: on non-macOS installs the config dir also holds the
 * OAuth session credentials, so pointing the child at an empty dir logs it
 * out (macOS keeps credentials in the keychain and survives). SkillOpt runs
 * that need hermetic measurements (no user-level CLAUDE.md / settings.json /
 * hooks bleeding into rollouts) flip it deliberately — see
 * docs/guides/skillopt.md, "Hermetic claude-cli rollouts".
 */
export function resolveHermeticConfigDir(
  raw: string | undefined = process.env.GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG,
): string | null {
  const v = raw?.trim();
  if (!v || v === '0' || v.toLowerCase() === 'false') return null;
  if (v === '1' || v.toLowerCase() === 'true') {
    if (!hermeticEnsured) {
      mkdirSync(CLAUDE_HERMETIC_CONFIG, { recursive: true });
      hermeticEnsured = true;
    }
    return CLAUDE_HERMETIC_CONFIG;
  }
  return v;
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
  /** HTTP status of the underlying API failure (e.g. 429 on a spend/rate limit). */
  api_error_status?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Typed failure for a `claude --print` run that reported an error. Carries the
 * API HTTP status (`apiErrorStatus`, e.g. 429 on a spend/rate limit) and the
 * subprocess exit code so callers can branch on the failure class instead of
 * regexing a raw stderr/stdout blob.
 */
export class ClaudeCliProcessError extends Error {
  readonly apiErrorStatus: number | undefined;
  readonly exitCode: number | undefined;

  constructor(message: string, opts: { apiErrorStatus?: number; exitCode?: number } = {}) {
    super(message);
    this.name = 'ClaudeCliProcessError';
    this.apiErrorStatus = opts.apiErrorStatus;
    this.exitCode = opts.exitCode;
  }
}

type EnvelopeParse =
  | { ok: true; envelope: ClaudeJsonResult }
  | { ok: false; reason: 'not-json'; error: unknown }
  | { ok: false; reason: 'no-result-event' };

/**
 * Unwrap `--output-format json` stdout into the result envelope. Tolerates both
 * output shapes: the bare result object, and the verbose-mode event ARRAY —
 * with `"verbose": true` in ~/.claude/settings.json the CLI emits
 * [{type:"system",subtype:"init",...}, ..., {type:"result",...}] instead of the
 * bare object, and there is no CLI flag to force it off (no --no-verbose;
 * --settings '{}' merges, does not replace). Verified on CLI 2.1.145.
 */
function parseResultEnvelope(stdout: string): EnvelopeParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, reason: 'not-json', error };
  }
  if (Array.isArray(parsed)) {
    const resultEvent = parsed.find(
      (ev): ev is ClaudeJsonResult =>
        !!ev && typeof ev === 'object' && (ev as { type?: unknown }).type === 'result',
    );
    if (!resultEvent) {
      return { ok: false, reason: 'no-result-event' };
    }
    parsed = resultEvent;
  }
  // JSON.parse accepts bare primitives (null / numbers / strings); none of
  // them is a result envelope, and letting one through would make the
  // envelope field reads throw inside the subprocess close callback.
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'not-json', error: new Error('top-level JSON value is not an object') };
  }
  return { ok: true, envelope: parsed as ClaudeJsonResult };
}

/**
 * Build the ClaudeCliProcessError for an error-reporting result envelope,
 * surfacing `api_error_status` + the human-readable `result` message instead of
 * an opaque blob.
 */
function envelopeError(envelope: ClaudeJsonResult, exitCode: number | undefined): ClaudeCliProcessError {
  const status = typeof envelope.api_error_status === 'number' ? envelope.api_error_status : undefined;
  const detail = envelope.result || envelope.subtype;
  const message = status !== undefined
    ? `claude-cli API error ${status}: ${detail}`
    : `claude-cli reported error: ${detail}`;
  return new ClaudeCliProcessError(message, { apiErrorStatus: status, exitCode });
}

/**
 * Build the system-prompt addendum that teaches the model the
 * `<use_tools>...</use_tools>` emission format. Returns the empty string
 * when no tools are registered for this turn so the model gets a normal
 * text-completion prompt without protocol noise.
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
    '  {"name": "<tool name>", "input": <input object matching the tool\'s input_schema>}',
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
 * Render the ai-sdk message array into a single text prompt for `claude --print`
 * stdin. System messages are extracted up-front and concatenated into the
 * `--system-prompt` flag value. Tool calls and tool results are rendered as
 * placeholders so the model sees the conversation in a coherent shape even
 * though the adapter does not natively round-trip tool calls through claude-cli.
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
 * Spawn `claude --print` with the contamination-suppression flags and return
 * the parsed `--output-format json` envelope. Aborts propagate to SIGTERM on
 * the child.
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
      // Agent isolation: this subprocess must behave like a raw LLM, not a
      // full Claude Code agent. `--tools ""` disables every built-in tool
      // (Bash/Read/WebSearch/...); `--strict-mcp-config` ignores all user-level
      // MCP servers (without it, each call would boot the user's MCP servers —
      // including gbrain's own MCP → recursion + PGLite single-writer lock
      // contention). Verified against claude CLI 2.1.145 --help.
      '--tools', '',
      '--strict-mcp-config',
    ];
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
    // Env scrub: guarantee the CLI authenticates via its own OAuth session
    // (subscription), never via an inherited API key. Without this, an
    // ANTHROPIC_API_KEY in gbrain's env (the exact setup this recipe is meant
    // to replace) silently flips billing to per-token API usage.
    //
    // Also scrub the CLAUDE_CODE_USE_* backend-switch flags: Bedrock, Vertex
    // AI, Mantle, Microsoft Foundry, and Claude Platform on AWS are each
    // gated by one of these, take priority over subscription OAuth when set,
    // and route billing through a cloud account instead. Clearing the switch
    // is sufficient — provider-specific creds (AWS_*, ANTHROPIC_VERTEX_*,
    // ANTHROPIC_FOUNDRY_*, ANTHROPIC_AWS_*, ...) are inert without it.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    // Prefix wipe, not a denylist (review hardening): the backend-switch
    // family grows one CLAUDE_CODE_USE_* flag per new cloud backend, and any
    // future switch inherited from gbrain's env would silently re-route the
    // child's billing. Subscription-only is the recipe's contract.
    for (const k of Object.keys(env)) {
      if (k.startsWith('CLAUDE_CODE_USE_')) delete env[k];
    }
    // #4119 opt-in hermetic config: point the child's CLAUDE_CONFIG_DIR at an
    // isolated directory so user-level ~/.claude state (CLAUDE.md memory,
    // settings.json, hooks) can't leak into measurements. Off by default —
    // see resolveHermeticConfigDir for the auth caveat that makes it opt-in.
    const hermeticConfigDir = resolveHermeticConfigDir();
    if (hermeticConfigDir) env.CLAUDE_CONFIG_DIR = hermeticConfigDir;
    const child = spawn(claudeBin(), args, {
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
        // Even on a non-zero exit the CLI writes a formatted result envelope
        // to stdout (e.g. an API 429 arrives as {is_error:true,
        // api_error_status:429, result:"<human-readable message>", ...}).
        // Surface that as a typed error instead of burying the status inside
        // a raw blob. Only an error-reporting envelope qualifies: a SUCCESS
        // envelope followed by a non-zero exit is a process failure whose
        // reason lives in stderr, so it falls through to the blob fallback
        // (as does any stdout without a parseable envelope).
        const attempt = parseResultEnvelope(stdout);
        if (attempt.ok && attempt.envelope.type === 'result' && attempt.envelope.is_error === true) {
          reject(envelopeError(attempt.envelope, code ?? undefined));
          return;
        }
        // The blob goes AFTER the `--- raw ---` marker: it can carry
        // model/page-derived text, and classifyGlobalLlmError's phrase
        // regexes only scan text before the marker (an auth-looking essay in
        // stdout must never read as a whole-run auth outage).
        reject(new ClaudeCliProcessError(
          `claude-cli exited ${code}\n--- raw ---\n${stderr.trim() || stdout.trim()}`,
          { exitCode: code ?? undefined },
        ));
        return;
      }
      const attempt = parseResultEnvelope(stdout);
      if (!attempt.ok) {
        if (attempt.reason === 'no-result-event') {
          reject(new Error(`claude-cli JSON event array had no "result" event\n--- raw ---\n${stdout.slice(0, 500)}`));
          return;
        }
        const e = attempt.error;
        reject(new Error(`claude-cli output not JSON: ${e instanceof Error ? e.message : String(e)}\n--- raw ---\n${stdout.slice(0, 500)}`));
        return;
      }
      const envelope = attempt.envelope;
      if (envelope.is_error) {
        reject(envelopeError(envelope, 0));
        return;
      }
      resolve(envelope);
    });

    // stdin error handler: if the binary does not exist (ENOENT) or the child
    // dies before draining stdin, write/end can emit an unhandled 'error'
    // (EPIPE) that would crash the worker. The spawn-level 'error' / non-zero
    // 'close' handlers above already surface the real failure, so the stdin
    // error itself is safe to swallow.
    child.stdin.on('error', () => { /* surfaced via child 'error'/'close' */ });
    try {
      child.stdin.write(userPrompt);
      child.stdin.end();
    } catch (e) {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error(`claude-cli stdin write failed (is the claude binary installed?): ${e instanceof Error ? e.message : String(e)}`));
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
    // #4155: ALWAYS mint — never trust a model-authored id. Each doGenerate
    // is a fresh subprocess replayed from an id-stripped transcript
    // (renderPrompt), so the model structurally CANNOT keep ids unique
    // across turns; it echoed the prompt's example entropy-free (toolu_01,
    // toolu_02 every turn) and collided real dream jobs to death before the
    // job-wide unique constraint was retired (migration v131). The prompt no
    // longer asks for an id; a stray `id` field from older cached behavior
    // is deliberately ignored — nothing round-trips it (renderPrompt strips
    // ids on replay; the loop pairs results in-memory within one turn).
    const id = `toolu_claude_cli_${randomUUIDv7()}`;
    const inputJson = JSON.stringify(e.input ?? {});
    toolCalls.push({ id, name, input: inputJson });
  }

  return { toolCalls, beforeText, afterText };
}

// Module-scoped so the counter survives the fresh ClaudeCliLanguageModel
// instance created for every doGenerate call (gateway resolves the provider
// per-call). Keeps the historical `toolu_claude_cli_` prefix — one grep target.

/**
 * Strip provider prefixes (`anthropic:`, `litellm:`, `claude-cli:`) that the
 * underlying CLI does not understand. The gateway hands us a bare model id
 * via `recipe.aliases` resolution, but defensive normalization here keeps
 * direct LanguageModelV2 construction (in tests, for example) ergonomic.
 */
function normalizeModel(model: string): string {
  const idx = model.indexOf(':');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

export class ClaudeCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'claude-cli';
  readonly modelId: string;
  readonly supportedUrls = {};

  constructor(modelId: string) {
    this.modelId = normalizeModel(modelId);
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown';
    usage: {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
      totalTokens: number | undefined;
      cachedInputTokens: number | undefined;
    };
    warnings: never[];
  }> {
    const { systemText, userPrompt } = renderPrompt(options.prompt);
    const toolInstructions = buildToolUseInstructions(options.tools);
    const systemPrompt = [systemText, toolInstructions].filter(s => s.length > 0).join('\n');

    const result = await runClaude(systemPrompt, userPrompt, this.modelId, options.abortSignal);
    const { toolCalls, beforeText, afterText } = extractToolCalls(result.result);

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
      content.push({ type: 'text', text: result.result ?? '' });
    }

    const finishReason = toolCalls.length > 0 ? 'tool-calls' as const : 'stop' as const;
    const inputTokens = result.usage?.input_tokens;
    const outputTokens = result.usage?.output_tokens;
    const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
    // `cache_creation_input_tokens` is deliberately NOT surfaced here — the AI
    // SDK's LanguageModelV2Usage has no corresponding field, and folding it in
    // would need a claude-cli-specific branch in the gateway's usage assembly
    // (src/core/ai/gateway.ts). Out of scope for this fix.
    const cachedInputTokens =
      result.usage?.cache_read_input_tokens !== undefined
        ? Number(result.usage.cache_read_input_tokens)
        : undefined;

    return {
      content,
      finishReason,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens !== undefined && outputTokens !== undefined ? totalTokens : undefined,
        cachedInputTokens,
      },
      warnings: [],
    };
  }

  async doStream(): Promise<never> {
    throw new Error(
      'claude-cli LanguageModel does not support streaming. Use doGenerate or set ' +
      'the model on a non-streaming chat surface (gateway.toolLoop is non-streaming).',
    );
  }
}
