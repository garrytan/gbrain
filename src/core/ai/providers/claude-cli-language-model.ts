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
} from '@ai-sdk/provider';
import {
  buildToolUseInstructions,
  extractToolCalls as extractToolCallsShared,
  renderPrompt,
  stripProviderPrefix,
} from './cli-tool-protocol.ts';

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
 * Opt-in, NOT default: the config dir also holds the CLI's session
 * credentials, so the empty-dir form logs the child out wherever the CLI
 * reads its session from the config dir (observed on macOS with Claude Code
 * 2.1.x too — #4741; nothing here seeds or looks up credential material).
 * For hermetic-with-auth use the explicit-path form with a pre-seeded config.
 * SkillOpt runs that need hermetic measurements (no user-level CLAUDE.md /
 * settings.json / hooks bleeding into rollouts) flip it deliberately — see
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

// The `<use_tools>` protocol (instruction block, prompt rendering, block
// extraction with gbrain-minted ids) lives in ./cli-tool-protocol.ts and is
// shared with the codex-cli adapter; behavior is unchanged.
const TOOL_CALL_ID_PREFIX = 'toolu_claude_cli_';
function extractToolCalls(raw: string) {
  return extractToolCallsShared(raw, TOOL_CALL_ID_PREFIX, 'claude-cli');
}

export class ClaudeCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'claude-cli';
  readonly modelId: string;
  readonly supportedUrls = {};

  constructor(modelId: string) {
    this.modelId = stripProviderPrefix(modelId);
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
