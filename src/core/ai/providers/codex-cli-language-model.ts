/**
 * ai-sdk LanguageModelV2 implementation that dispatches via the `codex exec`
 * CLI subprocess. Used by the `codex-cli` recipe to route gateway.toolLoop /
 * gateway.chat calls through the Codex CLI's ChatGPT login (Plus / Pro /
 * Business / Enterprise seat) instead of the OpenAI SDK + OPENAI_API_KEY.
 *
 * The sibling of claude-cli-language-model.ts for OpenAI models. Same shape:
 * the gateway resolves `codex-cli:<model>` to this recipe, instantiates one of
 * these per modelId, and calls doGenerate. The `<use_tools>` in-band tool
 * protocol, prompt rendering and id minting are shared with claude-cli via
 * ./cli-tool-protocol.ts — the only Codex-specific parts are the argv, the
 * JSONL event stream, and the isolation flags.
 *
 * Model ids: `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-6-astra`,
 * `gpt-5.5`, ... — whatever the account's Codex model catalog lists. An
 * optional `@<effort>` suffix pins reasoning effort per model string
 * (`codex-cli:gpt-5.6-luna@low`), so a utility tier can run fast while the
 * reasoning tier thinks; GBRAIN_CODEX_CLI_REASONING_EFFORT sets the default
 * for suffix-less ids. The effort vocabulary is the CLI's
 * (`minimal|low|medium|high|xhigh` plus model-dependent `max`/`ultra`); the
 * level itself is validated by the CLI/catalog, but its SHAPE is checked
 * here (`[a-z][a-z0-9_-]*`) because it is interpolated into a TOML `-c`
 * override — anything else is refused before a subprocess exists.
 *
 * Agent isolation — the subprocess must behave like a raw model, not a coding
 * agent operating on this machine:
 *   --ephemeral               no session rollout is written under $CODEX_HOME
 *                             (so transcript discovery never ingests gbrain's
 *                             own calls — the #4472 class claude-cli needed a
 *                             scratch-dir fingerprint for)
 *   --ignore-user-config      no config.toml: no MCP servers (gbrain's own MCP
 *                             would recurse), no hooks, no plugins, no
 *                             project trust entries
 *   --ignore-rules            no execpolicy rules
 *   --skip-git-repo-check, spawned with cwd = an empty per-process tmpdir
 *                             no AGENTS.md discovery
 *   -s read-only              sandbox floor even if a tool slipped through
 *   --disable shell_tool / multi_agent / apps / browser_use / computer_use /
 *   plugins / memories / view_image, -c web_search="disabled"
 *                             every built-in tool surface off; the model can
 *                             only answer in text (which is where the
 *                             <use_tools> protocol lives)
 *   -c skills.max_context_tokens=1
 *                             the skills catalog under $CODEX_HOME/skills is
 *                             loaded regardless of config; the minimum budget
 *                             drops every description from the prompt. The
 *                             CLI reports that as an informational
 *                             `item.type: "error"` event which is NOT a turn
 *                             failure — see isSkillsBudgetNotice.
 *   -c hide_agent_reasoning=true, -c model_reasoning_summary="none"
 *                             keep the JSONL small; reasoning is dropped on
 *                             replay anyway.
 *
 * Auth: the CLI owns it. OPENAI_API_KEY / OPENAI_BASE_URL are scrubbed from the
 * child env and `forced_login_method="chatgpt"` is pinned, so an API key in
 * gbrain's env (the setup this recipe exists to replace) cannot silently flip
 * billing to per-token API usage.
 *
 * Output: `--json` JSONL on stdout plus `-o <file>` for the final agent
 * message. The file is the primary text source (exact bytes, no event
 * reassembly); the events supply usage (`turn.completed`) and failures
 * (`turn.failed`, `error`). doStream is not implemented; toolLoop uses
 * doGenerate.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { AIConfigError } from '../errors.ts';

const TOOL_CALL_ID_PREFIX = 'toolu_codex_cli_';
const CODE_MODE_DISABLED_NOTICE = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';

function codexBin(): string {
  return process.env.GBRAIN_CODEX_CLI_BIN ?? 'codex';
}

/** Effort levels the Codex CLI documents; model catalogs may add `max`/`ultra`. */
export const CODEX_CLI_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type CodexCliEffort = typeof CODEX_CLI_EFFORTS[number];

/** Codex CLI release the isolation argv (`--strict-config`, the `--disable` set) is verified against. */
export const MIN_CODEX_CLI_VERSION = '0.159.0';

/**
 * The only shape an effort level may take. It is interpolated into
 * `-c model_reasoning_effort="<effort>"`, a TOML override sitting beside the
 * sandbox and login pins, so a quote, newline or space must never reach it.
 */
const EFFORT_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;

function checkedEffort(effort: string, source: string): string {
  if (!EFFORT_SHAPE.test(effort)) {
    throw new AIConfigError(
      `codex-cli: reasoning effort ${JSON.stringify(effort)} from ${source} is not a valid level name`,
      `Use one of ${CODEX_CLI_EFFORTS.join(', ')} (letters, digits, '-' and '_' only), e.g. codex-cli:gpt-5.6-luna@low.`,
    );
  }
  return effort;
}

/**
 * Split `gpt-5.6-luna@low` into the CLI model id and an optional reasoning
 * effort. A bare id keeps the CLI/catalog default unless
 * GBRAIN_CODEX_CLI_REASONING_EFFORT names one. Unknown level NAMES are passed
 * through (the CLI validates against the live catalog, and a hard-coded list
 * here would reject a level a newer model legitimately supports), but a value
 * outside `[a-z][a-z0-9_-]*` throws AIConfigError.
 */
export function parseCodexModelId(
  raw: string,
  envDefault: string | undefined = process.env.GBRAIN_CODEX_CLI_REASONING_EFFORT,
): { model: string; effort: string | undefined } {
  const bare = stripProviderPrefix(raw);
  const at = bare.lastIndexOf('@');
  if (at > 0 && at < bare.length - 1) {
    const effort = bare.slice(at + 1).trim().toLowerCase();
    return { model: bare.slice(0, at), effort: checkedEffort(effort, 'the model id suffix') };
  }
  const fallback = envDefault?.trim().toLowerCase();
  return { model: bare, effort: fallback ? checkedEffort(fallback, 'GBRAIN_CODEX_CLI_REASONING_EFFORT') : undefined };
}

/** One line of `codex exec --json` output. Only the fields this adapter reads. */
export interface CodexExecEvent {
  type: string;
  thread_id?: string;
  item?: { id?: string; type?: string; text?: string; message?: string; [k: string]: unknown };
  message?: string;
  error?: { message?: string; [k: string]: unknown } | string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface CodexExecResult {
  text: string;
  usage: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | undefined;
  /** Non-fatal startup/code-mode and skills-budget notices, for diagnostics. */
  notices: string[];
}

/**
 * Typed failure for a `codex exec` run. `apiErrorStatus` is inferred from the
 * text of a structured CLI failure event (`turn.failed`, `error`, an error
 * item) for the classes callers branch on (429 usage limit, 401/403 auth) —
 * the JSONL carries no HTTP status — so normalizeAIError can route a
 * whole-run auth/limit outage the same way it does for claude-cli. Raw,
 * unstructured output never gets a status.
 */
export class CodexCliProcessError extends Error {
  readonly apiErrorStatus: number | undefined;
  readonly exitCode: number | undefined;
  constructor(message: string, opts: { apiErrorStatus?: number; exitCode?: number } = {}) {
    super(message);
    this.name = 'CodexCliProcessError';
    this.apiErrorStatus = opts.apiErrorStatus;
    this.exitCode = opts.exitCode;
  }
}

/**
 * Map a Codex failure message to the HTTP status class gbrain's error
 * normalizer already understands. Conservative: only unambiguous phrasings.
 * Request-shaped failures ("invalid max_output_tokens", "too many tokens",
 * context length) must stay per-item, so token wording only counts when it
 * names a credential token.
 */
export function inferApiErrorStatus(message: string): number | undefined {
  const m = message.toLowerCase();
  if (/usage limit|rate limit|too many requests/.test(m)) return 429;
  if (/not logged in|login required|\bunauthori[sz]ed\b|(?:access|auth|refresh|id)[ _-]?token (?:is |has )?(?:invalid|expired)|(?:invalid|expired) (?:access|auth|refresh|id)[ _-]?token|run `?codex login/.test(m)) return 401;
  if (/forbidden|not (?:permitted|allowed) for (?:this|your) (?:plan|account)/.test(m)) return 403;
  return undefined;
}

/**
 * The skills catalog budget notice is emitted as an `item.completed` with
 * `item.type === "error"` even though the turn proceeds normally. Treat it
 * (and only it) as informational.
 */
export function isSkillsBudgetNotice(message: string): boolean {
  return /skills? context budget|skill descriptions were removed/i.test(message);
}

type Parsed =
  | { ok: true; events: CodexExecEvent[] }
  | { ok: false; reason: 'no-events' | 'not-jsonl'; error?: unknown };

/** Parse the JSONL stream, tolerating stray non-JSON lines (banners, warnings). */
export function parseExecEvents(stdout: string): Parsed {
  const events: CodexExecEvent[] = [];
  let sawJson = false;
  let lastError: unknown;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') {
        events.push(v as CodexExecEvent);
        sawJson = true;
      }
    } catch (e) { lastError = e; }
  }
  if (!sawJson) return { ok: false, reason: lastError ? 'not-jsonl' : 'no-events', error: lastError };
  return { ok: true, events };
}

/**
 * Reduce the event stream (plus the `-o` file, when present) to a result or a
 * typed error. Exported for tests; `runCodex` wires it to the subprocess.
 */
export function summarizeExec(
  events: CodexExecEvent[],
  lastMessageFile: string | undefined,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | null = null,
): CodexExecResult | CodexCliProcessError {
  const notices: string[] = [];
  let failure: string | undefined;
  let agentText: string | undefined;
  let completed = false;
  let started = false;
  let usage: CodexExecResult['usage'];
  for (const ev of events) {
    if (ev.type === 'turn.started') started = true;
    else if (ev.type === 'item.completed' && ev.item) {
      if (ev.item.type === 'agent_message' && typeof ev.item.text === 'string') agentText = ev.item.text;
      else if (ev.item.type === 'error') {
        const msg = String(ev.item.message ?? '');
        if (isSkillsBudgetNotice(msg) || (!started && msg === CODE_MODE_DISABLED_NOTICE)) notices.push(msg);
        else failure ??= msg;
      }
    } else if (ev.type === 'error') {
      failure ??= typeof ev.error === 'string' ? ev.error : ev.error?.message ?? ev.message ?? 'codex exec reported an error';
    } else if (ev.type === 'turn.failed') {
      failure ??= typeof ev.error === 'string' ? ev.error : ev.error?.message ?? 'codex exec turn failed';
    } else if (ev.type === 'turn.completed') {
      completed = true;
      if (ev.usage) usage = {
        input_tokens: numberOrUndefined(ev.usage.input_tokens),
        cached_input_tokens: numberOrUndefined(ev.usage.cached_input_tokens),
        output_tokens: numberOrUndefined(ev.usage.output_tokens),
      };
    }
  }
  if (failure !== undefined) {
    return new CodexCliProcessError(`codex-cli reported error: ${failure}`,
      { apiErrorStatus: inferApiErrorStatus(failure), exitCode: exitCode ?? undefined });
  }
  // Partial text (including tool calls) is never a successful process result.
  if (exitCode !== 0 || exitSignal) {
    return new CodexCliProcessError(
      exitSignal ? `codex-cli terminated by ${exitSignal}` : `codex-cli exited ${exitCode}`,
      { exitCode: exitCode ?? undefined });
  }
  if (!completed) {
    return new CodexCliProcessError('codex-cli stream ended without turn.completed', { exitCode });
  }
  // `-o` is exact bytes of the final message; the event text is the fallback
  // for CLI builds whose agent_message item is the only carrier.
  let text: string | undefined;
  if (lastMessageFile && existsSync(lastMessageFile)) {
    try { text = readFileSync(lastMessageFile, 'utf8'); } catch { /* fall through to event text */ }
  }
  text ??= agentText;
  if (text === undefined) {
    return new CodexCliProcessError(
      `codex-cli produced no agent message (events: ${events.map(e => e.type).join(',') || 'none'})`,
      { exitCode: exitCode ?? undefined });
  }
  return { text, usage, notices };
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// One empty cwd per gbrain process so `codex exec` finds no AGENTS.md and
// writes nothing that could be mistaken for user content. Removed at exit.
let scratchCwd: string | null = null;
function ensureScratchCwd(): string {
  if (!scratchCwd) {
    scratchCwd = mkdtempSync(join(tmpdir(), 'gbrain-codex-cli-cwd-'));
    process.once('exit', () => { try { rmSync(scratchCwd!, { recursive: true, force: true }); } catch { /* best-effort */ } });
  }
  mkdirSync(scratchCwd, { recursive: true });
  return scratchCwd;
}

/** Argv for one `codex exec` call. Exported so tests can pin the isolation set. */
export function buildCodexArgs(model: string, effort: string | undefined, lastMessageFile: string): string[] {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--model', model,
    '--output-last-message', lastMessageFile,
    '--disable', 'shell_tool',
    '--disable', 'multi_agent',
    '--disable', 'apps',
    '--disable', 'browser_use',
    '--disable', 'computer_use',
    '--disable', 'plugins',
    '--disable', 'memories',
    '--disable', 'view_image',
    '--disable', 'image_generation',
    '--disable', 'multi_agent_v2',
    '--disable', 'browser_use_external',
    '--disable', 'in_app_browser',
    '--disable', 'code_mode_host',
    '--disable', 'skill_search',
    '--disable', 'sleep_tool',
    '--disable', 'tool_suggest',
    '--disable', 'goals',
    '--disable', 'hooks',
    '-c', 'web_search="disabled"',
    '-c', 'tools.experimental_request_user_input.enabled=false',
    '-c', 'tools.update_plan.enabled=false',
    '-c', 'agents.enabled=false',
    '-c', 'skills.max_context_tokens=1',
    '-c', 'hide_agent_reasoning=true',
    '-c', 'model_reasoning_summary="none"',
    '-c', 'forced_login_method="chatgpt"',
  ];
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  // Prompt arrives on stdin (`-` sentinel) so long system prompts never hit
  // argv limits and never appear in `ps` output.
  args.push('-');
  return args;
}

/** stderr shapes of a CLI that does not know one of the isolation flags/settings. */
const REJECTED_FLAG_RE = /unexpected argument|unknown (?:option|argument|feature|field|key|config)|unrecognized (?:option|argument)/i;

/**
 * Spawn `codex exec` and resolve the final message + usage. Aborts propagate
 * to SIGTERM on the child.
 */
function runCodex(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  effort: string | undefined,
  signal?: AbortSignal,
): Promise<CodexExecResult> {
  return new Promise((resolve, reject) => {
    // Pre-aborted: refuse before any scratch dir or subprocess exists, so no
    // child can emit an 'error' that has no listener yet.
    if (signal?.aborted) { reject(new Error('codex-cli adapter aborted')); return; }
    const cwd = ensureScratchCwd();
    const lastMessageFile = join(mkdtempSync(join(cwd, 'out-')), 'last-message.md');
    const args = buildCodexArgs(model, effort, lastMessageFile);
    // Codex has no separate system-prompt channel in exec mode; the rendered
    // system text leads the single stdin prompt, fenced so the model sees the
    // boundary. renderPrompt already labels turns (User:/Assistant:).
    const stdinPrompt = systemPrompt
      ? `<system>\n${systemPrompt}\n</system>\n\n${userPrompt}`
      : userPrompt;

    const env = { ...process.env };
    // Subscription-only is the recipe's contract: never let an inherited API
    // key or base URL re-route the child's billing or endpoint.
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    delete env.CODEX_API_KEY;

    const child = spawn(codexBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    const cleanup = () => { try { rmSync(join(lastMessageFile, '..'), { recursive: true, force: true }); } catch { /* best-effort */ } };
    const onAbort = () => {
      child.kill('SIGTERM');
      cleanup();
      reject(new Error('codex-cli adapter aborted'));
    };

    // Every child/stdin handler is attached before the abort listener, so no
    // path leaves a spawn error without a listener.
    child.on('error', err => {
      if (signal) signal.removeEventListener('abort', onAbort);
      cleanup();
      reject(new Error(`codex-cli spawn failed: ${err instanceof Error ? err.message : String(err)}`));
    });

    child.on('close', (code, exitSignal) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const parsed = parseExecEvents(stdout);
      if (!parsed.ok) {
        cleanup();
        // The blob goes AFTER the `--- raw ---` marker: classifyGlobalLlmError's
        // phrase regexes only scan text before the marker, so model/page text
        // in stdout can never read as a whole-run auth outage. For the same
        // reason no apiErrorStatus is inferred from it — a numeric status is
        // classified before the marker check and would bypass it.
        const raw = (stderr.trim() || stdout.trim()).slice(0, 800);
        const head = code !== 0 || exitSignal
          ? `codex-cli ${exitSignal ? `terminated by ${exitSignal}` : `exited ${code}`}`
          : 'codex-cli output had no JSON events';
        const tooOld = code !== 0 && !exitSignal && REJECTED_FLAG_RE.test(stderr)
          ? `: codex CLI ${MIN_CODEX_CLI_VERSION} or newer required (it rejected one of gbrain's isolation flags or settings); upgrade with \`npm i -g @openai/codex\``
          : '';
        reject(new CodexCliProcessError(`${head}${tooOld}\n--- raw ---\n${raw}`, { exitCode: code ?? undefined }));
        return;
      }
      const summary = summarizeExec(parsed.events, lastMessageFile, code, exitSignal);
      cleanup();
      if (summary instanceof CodexCliProcessError) { reject(summary); return; }
      resolve(summary);
    });

    child.stdin.on('error', () => { /* surfaced via child 'error'/'close' */ });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      child.stdin.write(stdinPrompt);
      child.stdin.end();
    } catch (e) {
      if (signal) signal.removeEventListener('abort', onAbort);
      cleanup();
      reject(new Error(`codex-cli stdin write failed (is the codex binary installed?): ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}

export class CodexCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'codex-cli';
  /** Bare CLI model id, without provider prefix or `@effort` suffix. */
  readonly modelId: string;
  readonly effort: string | undefined;
  readonly supportedUrls = {};

  constructor(modelId: string) {
    const parsed = parseCodexModelId(modelId);
    this.modelId = parsed.model;
    this.effort = parsed.effort;
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

    const result = await runCodex(systemPrompt, userPrompt, this.modelId, this.effort, options.abortSignal);
    const { toolCalls, beforeText, afterText } = extractToolCallsShared(result.text, TOOL_CALL_ID_PREFIX, 'codex-cli');

    const content: LanguageModelV2Content[] = [];
    if (beforeText) content.push({ type: 'text', text: beforeText });
    for (const call of toolCalls) {
      content.push({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.input });
    }
    if (afterText) content.push({ type: 'text', text: afterText });
    if (content.length === 0) content.push({ type: 'text', text: result.text ?? '' });

    const inputTokens = result.usage?.input_tokens;
    const outputTokens = result.usage?.output_tokens;
    return {
      content,
      finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
        cachedInputTokens: result.usage?.cached_input_tokens,
      },
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
