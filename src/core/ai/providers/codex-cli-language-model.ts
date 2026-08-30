/**
 * ai-sdk LanguageModelV2 adapter for the logged-in local `codex exec` CLI.
 *
 * Authentication remains entirely inside Codex's own local login. The adapter
 * never reads or copies OAuth material. The subprocess receives a small
 * allowlisted environment, so API keys and unrelated process secrets cannot
 * silently change the auth or billing path.
 *
 * Each turn gets a fresh ephemeral temp workspace. Codex runs noninteractively
 * with user config/rules ignored, project instruction discovery disabled, and
 * a read-only sandbox, with every built-in execution/browser/app tool disabled.
 * Its final answer is constrained with --output-schema; bounded JSONL is
 * retained as a fallback/result-usage channel.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
  LanguageModelV2ProviderDefinedTool,
  LanguageModelV2ToolChoice,
} from '@ai-sdk/provider';

type ReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);
const MAX_ERROR_CHARS = 2_000;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 1_048_576;
const TERMINATE_GRACE_MS = 500;
const OUTPUT_CHARS_PER_TOKEN_BUDGET = 4;
const SAFE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const SAFE_ITEM_TYPES = new Set(['agent_message', 'reasoning']);
const REVIEWED_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'error',
  'item.started',
  'item.updated',
  'item.completed',
]);
const CODE_MODE_DISABLED_DIAGNOSTIC =
  'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; ' +
  'enable `features.code_mode_host` and install `codex-code-mode-host`.';

export const CODEX_CLI_DISABLED_TOOL_FEATURES = [
  // Fail closed over every feature in Codex CLI 0.147.0 that can expose an
  // execution, browser, app, media, search, delegation, or permission tool.
  // The JSONL parser independently rejects any non-message/reasoning item.
  'shell_tool',
  'unified_exec',
  'code_mode_host',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'standalone_web_search',
  'search_tool',
  'image_generation',
  'view_image',
  'artifact',
  'chronicle',
  'shell_snapshot',
  'tool_suggest',
  'skill_search',
  'request_permissions_tool',
  'computer_use',
  'apps',
  'multi_agent',
  'multi_agent_v2',
  'deferred_executor',
  'unavailable_dummy_tools',
] as const;

function codexBin(): string {
  return process.env.GBRAIN_CODEX_CLI_BIN ?? 'codex';
}

function normalizeModel(model: string): string {
  const colon = model.indexOf(':');
  if (colon >= 0) return model.slice(colon + 1);
  if (model.startsWith('codex-cli/')) return model.slice('codex-cli/'.length);
  return model;
}

function reasoningEffort(options: LanguageModelV2CallOptions): ReasoningEffort {
  const provider = options.providerOptions?.['codex-cli'] as
    | Record<string, unknown>
    | undefined;
  const raw = provider?.reasoningEffort ?? provider?.reasoning_effort;
  if (raw === undefined) return DEFAULT_REASONING_EFFORT;
  if (typeof raw !== 'string' || !REASONING_EFFORTS.has(raw as ReasoningEffort)) {
    throw new Error(
      `codex-cli reasoningEffort must be one of ${[...REASONING_EFFORTS].join(', ')}; ` +
        `received ${JSON.stringify(raw)}`,
    );
  }
  return raw as ReasoningEffort;
}

function renderJsonValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

function renderPrompt(prompt: LanguageModelV2Prompt): string {
  const rendered: string[] = [];
  for (const message of prompt as ReadonlyArray<LanguageModelV2Message>) {
    if (message.role === 'system') {
      rendered.push(`System:\n${message.content}`);
      continue;
    }
    if (message.role === 'user') {
      const parts = message.content
        .map((part) => {
          if (part.type === 'text') return part.text;
          if (part.type === 'file') return `[file ${part.mediaType ?? 'unknown'} omitted]`;
          return '';
        })
        .filter(Boolean);
      if (parts.length > 0) rendered.push(`User:\n${parts.join('\n')}`);
      continue;
    }
    if (message.role === 'assistant') {
      const parts = message.content
        .map((part) => {
          if (part.type === 'text') return part.text;
          if (part.type === 'reasoning') return '';
          if (part.type === 'tool-call') {
            return `[tool_call id=${part.toolCallId} name=${part.toolName} input=${renderJsonValue(part.input)}]`;
          }
          if (part.type === 'tool-result') {
            return `[tool_result id=${part.toolCallId} name=${part.toolName} output=${renderJsonValue(part.output.value)}]`;
          }
          return '';
        })
        .filter(Boolean);
      if (parts.length > 0) rendered.push(`Assistant:\n${parts.join('\n')}`);
      continue;
    }
    if (message.role === 'tool') {
      const parts = message.content.map((part) => {
        return `[tool_result id=${part.toolCallId} name=${part.toolName} output=${renderJsonValue(part.output.value)}]`;
      });
      if (parts.length > 0) rendered.push(`User:\n${parts.join('\n')}`);
    }
  }
  return rendered.join('\n\n');
}

function functionTools(
  tools:
    | ReadonlyArray<LanguageModelV2FunctionTool | LanguageModelV2ProviderDefinedTool>
    | undefined,
): LanguageModelV2FunctionTool[] {
  return (tools ?? []).filter(
    (tool): tool is LanguageModelV2FunctionTool => tool.type === 'function',
  );
}

interface ToolSelection {
  tools: LanguageModelV2FunctionTool[];
  required: boolean;
}

function selectTools(
  tools: LanguageModelV2FunctionTool[],
  choice: LanguageModelV2ToolChoice | undefined,
): ToolSelection {
  if (choice?.type === 'none') return { tools: [], required: false };
  if (choice?.type === 'tool') {
    const selected = tools.find((tool) => tool.name === choice.toolName);
    if (!selected) {
      throw new Error(`codex-cli toolChoice requested unknown tool "${choice.toolName}"`);
    }
    return { tools: [selected], required: true };
  }
  if (choice?.type === 'required') {
    if (tools.length === 0) {
      throw new Error('codex-cli toolChoice required needs at least one function tool');
    }
    return { tools, required: true };
  }
  return { tools, required: false };
}

function requestedOutputTokens(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('codex-cli maxOutputTokens must be a positive integer');
  }
  return value;
}

function outputCharBudget(maxOutputTokens: number): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    maxOutputTokens * OUTPUT_CHARS_PER_TOKEN_BUDGET,
  );
}

function outputSchema(
  tools: LanguageModelV2FunctionTool[],
  requireTool: boolean,
  maxOutputTokens: number | undefined,
): Record<string, unknown> {
  const nameSchema =
    tools.length > 0
      ? { type: 'string', enum: tools.map((tool) => tool.name) }
      : { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: {
        type: 'string',
        description: 'Final prose. Use an empty string when calling tools.',
        ...(maxOutputTokens !== undefined
          ? { maxLength: outputCharBudget(maxOutputTokens) }
          : {}),
      },
      tool_calls: {
        type: 'array',
        description: 'Zero or more GBrain tool calls in the same model turn.',
        ...(tools.length === 0 ? { maxItems: 0 } : {}),
        ...(requireTool ? { minItems: 1 } : {}),
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: nameSchema,
            input: {
              type: 'string',
              description: 'A JSON-encoded object matching the selected tool input schema.',
            },
          },
          required: ['id', 'name', 'input'],
        },
      },
    },
    required: ['text', 'tool_calls'],
  };
}

function buildPrompt(
  prompt: LanguageModelV2Prompt,
  tools: LanguageModelV2FunctionTool[],
  requireTool: boolean,
  maxOutputTokens: number | undefined,
): string {
  const conversation = renderPrompt(prompt);
  const toolSpecs = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
  const protocol =
    tools.length === 0
      ? [
          'Return the answer in the schema `text` field and an empty `tool_calls` array.',
        ]
      : [
          'Available GBrain tools:',
          JSON.stringify(toolSpecs, null, 2),
          requireTool
            ? 'You must return at least one call in `tool_calls`; do not answer with prose yet.'
            : 'If tools are needed, return them in `tool_calls`. Multiple same-turn calls belong in the same array.',
          'Each tool call `input` must be a JSON-encoded object matching that tool input_schema.',
          'When answering finally, put prose in `text` and return an empty `tool_calls` array.',
        ];
  return [
    'Act only as the language-model turn described below.',
    'Do not inspect the filesystem, run shell commands, browse, call MCP tools, or use any Codex built-in tool.',
    'Use only the supplied conversation and return one final response matching the enforced output schema.',
    ...(maxOutputTokens !== undefined
      ? [
          `The completed structured response must use at most ${maxOutputTokens} output tokens.`,
          `Keep the text field at most ${outputCharBudget(maxOutputTokens)} characters as a conservative schema proxy.`,
        ]
      : []),
    ...protocol,
    '',
    conversation,
  ].join('\n');
}

interface CodexUsage {
  inputTokens?: number;
  outputTokens?: number;
}

interface ParsedEvents {
  agentMessage?: string;
  builtInToolEvent?: string;
  error?: string;
  usage: CodexUsage;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  return errorText(obj.message) ?? errorText(obj.error);
}

function parseEvents(stdout: string): ParsedEvents {
  const parsed: ParsedEvents = { usage: {} };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new Error('codex-cli emitted malformed JSONL');
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('codex-cli emitted malformed JSONL event envelope');
    }
    const event = decoded as Record<string, unknown>;
    const type = typeof event.type === 'string' ? event.type : '';
    if (!REVIEWED_EVENT_TYPES.has(type)) {
      throw new Error(`codex-cli emitted unreviewed JSONL event type "${type || '<missing>'}"`);
    }
    if (type === 'error' || type === 'turn.failed') {
      const detail = errorText(event.error) ?? errorText(event.message);
      if (!detail) throw new Error(`codex-cli ${type} event was missing error detail`);
      parsed.error = detail;
    }
    if (type.startsWith('item.') && (!event.item || typeof event.item !== 'object' || Array.isArray(event.item))) {
      throw new Error(`codex-cli emitted malformed item event "${type}"`);
    }
    if (type === 'item.completed' && event.item && typeof event.item === 'object') {
      const item = event.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        parsed.agentMessage = item.text;
      }
    }
    if (
      type.startsWith('item.') &&
      event.item &&
      typeof event.item === 'object'
    ) {
      const item = event.item as Record<string, unknown>;
      const itemType = typeof item.type === 'string' ? item.type : '';
      if (!itemType) throw new Error(`codex-cli ${type} event was missing item type`);
      const isKnownFailClosedDiagnostic =
        itemType === 'error' && item.message === CODE_MODE_DISABLED_DIAGNOSTIC;
      if (itemType && !SAFE_ITEM_TYPES.has(itemType) && !isKnownFailClosedDiagnostic) {
        parsed.builtInToolEvent = itemType;
      }
    }
    if (type === 'turn.completed') {
      if (!event.usage || typeof event.usage !== 'object' || Array.isArray(event.usage)) {
        throw new Error('codex-cli turn.completed event had malformed usage');
      }
      const usage = event.usage as Record<string, unknown>;
      const inputTokens = usage.input_tokens;
      const outputTokens = usage.output_tokens;
      if (
        typeof inputTokens !== 'number' || !Number.isInteger(inputTokens) || inputTokens < 0 ||
        typeof outputTokens !== 'number' || !Number.isInteger(outputTokens) || outputTokens < 0
      ) {
        throw new Error('codex-cli turn.completed event had malformed usage');
      }
      parsed.usage.inputTokens = inputTokens;
      parsed.usage.outputTokens = outputTokens;
    }
  }
  return parsed;
}

interface CodexToolCall {
  id: string;
  name: string;
  input: string;
}

interface CodexFinal {
  text: string;
  toolCalls: CodexToolCall[];
}

function parseFinal(
  raw: string,
  allowedTools: ReadonlySet<string>,
  requireTool: boolean,
): CodexFinal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `codex-cli output was not valid structured JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('codex-cli output was not a JSON object');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== 'string' || !Array.isArray(obj.tool_calls)) {
    throw new Error('codex-cli output must contain string text and array tool_calls');
  }
  const toolCalls: CodexToolCall[] = [];
  for (const rawCall of obj.tool_calls) {
    if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) {
      throw new Error('codex-cli output contained a malformed tool call');
    }
    const call = rawCall as Record<string, unknown>;
    if (
      typeof call.id !== 'string' ||
      call.id.length === 0 ||
      typeof call.name !== 'string' ||
      call.name.length === 0
    ) {
      throw new Error('codex-cli output tool calls require non-empty id and name');
    }
    if (!allowedTools.has(call.name)) {
      throw new Error(`codex-cli output requested unknown tool "${call.name}"`);
    }
    let input: string;
    if (typeof call.input === 'string') {
      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(call.input);
      } catch {
        throw new Error(`codex-cli output tool "${call.name}" input was not JSON`);
      }
      if (!parsedInput || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) {
        throw new Error(`codex-cli output tool "${call.name}" input was not a JSON object`);
      }
      input = call.input;
    } else if (call.input && typeof call.input === 'object' && !Array.isArray(call.input)) {
      input = JSON.stringify(call.input);
    } else {
      throw new Error(`codex-cli output tool "${call.name}" input must be an object or JSON string`);
    }
    toolCalls.push({ id: call.id, name: call.name, input });
  }
  if (requireTool && toolCalls.length === 0) {
    throw new Error('codex-cli toolChoice required but output contained no tool calls');
  }
  return { text: obj.text, toolCalls };
}

interface CodexRunResult {
  final: CodexFinal;
  usage: CodexUsage;
}

function abortError(): Error {
  const error = new Error('codex-cli adapter aborted');
  error.name = 'AbortError';
  return error;
}

function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if it exited before group termination.
    }
  }
  child.kill(signal);
}

function codexEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? homedir(),
    PATH: SAFE_PATH,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE'] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  return env;
}

function readBoundedFinalMessage(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      `codex-cli final message could not be opened: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const before = fstatSync(fd);
    if (!before.isFile()) {
      throw new Error('codex-cli final message was not a regular file');
    }
    if (before.size > MAX_STDOUT_BYTES) {
      throw new Error(
        `codex-cli final message exceeded ${MAX_STDOUT_BYTES} bytes`,
      );
    }

    const bytes = Buffer.allocUnsafe(MAX_STDOUT_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total > MAX_STDOUT_BYTES) {
      throw new Error(
        `codex-cli final message exceeded ${MAX_STDOUT_BYTES} bytes`,
      );
    }

    const after = fstatSync(fd);
    if (!after.isFile() || before.size !== after.size || after.size !== total) {
      throw new Error('codex-cli final message changed while it was being read');
    }
    return bytes.subarray(0, total).toString('utf8').trim();
  } finally {
    closeSync(fd);
  }
}

async function runCodex(input: {
  prompt: string;
  schema: Record<string, unknown>;
  allowedTools: ReadonlySet<string>;
  requireTool: boolean;
  model: string;
  effort: ReasoningEffort;
  signal?: AbortSignal;
}): Promise<CodexRunResult> {
  if (input.signal?.aborted) throw abortError();

  const sessionDir = mkdtempSync(join(tmpdir(), 'gbrain-codex-cli-'));
  const schemaPath = join(sessionDir, 'output-schema.json');
  const finalPath = join(sessionDir, 'last-message.json');
  writeFileSync(schemaPath, JSON.stringify(input.schema));

  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    ...CODEX_CLI_DISABLED_TOOL_FEATURES.flatMap((feature) => [
      '--disable',
      feature,
    ]),
    '--strict-config',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--json',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    finalPath,
    '--cd',
    sessionDir,
    '--model',
    input.model,
    '--config',
    'project_doc_max_bytes=0',
    '--config',
    `model_reasoning_effort="${input.effort}"`,
    '-',
  ];

  try {
    const completed = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(codexBin(), args, {
        cwd: sessionDir,
        env: codexEnv(),
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let childClosed = false;
      let forcedError: Error | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const terminate = (error: Error): void => {
        if (forcedError) return;
        forcedError = error;
        terminateProcessTree(child, 'SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (!childClosed) terminateProcessTree(child, 'SIGKILL');
        }, TERMINATE_GRACE_MS);
        forceKillTimer.unref();
      };
      const onAbort = (): void => terminate(abortError());
      input.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk) => {
        if (forcedError) return;
        stdoutBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          terminate(new Error(`codex-cli stdout output exceeded ${MAX_STDOUT_BYTES} bytes`));
          return;
        }
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (forcedError) return;
        stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (stderrBytes > MAX_STDERR_BYTES) {
          terminate(new Error(`codex-cli stderr output exceeded ${MAX_STDERR_BYTES} bytes`));
          return;
        }
        stderr += String(chunk);
      });
      child.stdin.on('error', () => {
        // Spawn/nonzero/abort paths carry the actionable error.
      });
      child.on('error', (error) => {
        input.signal?.removeEventListener('abort', onAbort);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (forcedError) {
          rejectOnce(forcedError);
          return;
        }
        rejectOnce(
          new Error(
            `codex-cli spawn failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      });
      child.on('close', (code) => {
        childClosed = true;
        input.signal?.removeEventListener('abort', onAbort);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (settled) return;
        if (forcedError) {
          rejectOnce(forcedError);
          return;
        }
        settled = true;
        resolve({ code, stdout, stderr });
      });

      child.stdin.end(input.prompt);
    });

    const events = parseEvents(completed.stdout);
    if (events.builtInToolEvent) {
      throw new Error(
        `codex-cli emitted forbidden built-in tool event "${events.builtInToolEvent}"`,
      );
    }
    if (completed.code !== 0) {
      const detail =
        events.error ??
        completed.stderr.trim() ??
        completed.stdout.trim() ??
        'no diagnostic output';
      throw new Error(
        `codex-cli exited ${completed.code}: ${detail.slice(0, MAX_ERROR_CHARS)}`,
      );
    }
    if (events.error) {
      throw new Error(`codex-cli reported error: ${events.error.slice(0, MAX_ERROR_CHARS)}`);
    }

    const finalRaw = readBoundedFinalMessage(finalPath) ?? '';
    const candidates = [finalRaw, events.agentMessage ?? ''].filter(Boolean);
    let final: CodexFinal | undefined;
    let lastParseError: Error | undefined;
    for (const candidate of candidates) {
      try {
        final = parseFinal(candidate, input.allowedTools, input.requireTool);
        break;
      } catch (error) {
        lastParseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!final) {
      throw new Error(
        `codex-cli output could not be parsed: ${
          lastParseError?.message ?? 'no final agent message in output file or JSONL'
        }`,
      );
    }
    return { final, usage: events.usage };
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
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
    finishReason:
      | 'stop'
      | 'length'
      | 'content-filter'
      | 'tool-calls'
      | 'error'
      | 'other'
      | 'unknown';
    usage: {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
      totalTokens: number | undefined;
    };
    warnings: never[];
  }> {
    const selection = selectTools(functionTools(options.tools), options.toolChoice);
    const maxOutputTokens = requestedOutputTokens(options.maxOutputTokens);
    const allowedTools = new Set(selection.tools.map((tool) => tool.name));
    const result = await runCodex({
      prompt: buildPrompt(
        options.prompt,
        selection.tools,
        selection.required,
        maxOutputTokens,
      ),
      schema: outputSchema(
        selection.tools,
        selection.required,
        maxOutputTokens,
      ),
      allowedTools,
      requireTool: selection.required,
      model: this.modelId,
      effort: reasoningEffort(options),
      signal: options.abortSignal,
    });

    // Codex CLI 0.147.0 has no native max-output-token setting. The schema
    // and prompt above reduce overruns, but only reported post-call usage is
    // authoritative. Reject fail-closed here; the call's spend already occurred.
    if (maxOutputTokens !== undefined) {
      const reported = result.usage.outputTokens;
      if (reported === undefined) {
        throw new Error(
          `codex-cli did not report output token usage required to enforce maxOutputTokens ${maxOutputTokens}. ` +
            'Codex CLI has no native output-token cap; the call already occurred and its spend cannot be prevented.',
        );
      }
      if (reported > maxOutputTokens) {
        throw new Error(
          `codex-cli reported ${reported} output tokens, exceeding maxOutputTokens ${maxOutputTokens}. ` +
            'Codex CLI has no native output-token cap; this fail-closed check runs after the call and cannot prevent its already-incurred spend.',
        );
      }
    }

    const content: LanguageModelV2Content[] = [];
    if (result.final.text) {
      content.push({ type: 'text', text: result.final.text });
    }
    for (const call of result.final.toolCalls) {
      content.push({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });

    const inputTokens = result.usage.inputTokens;
    const outputTokens = result.usage.outputTokens;
    return {
      content,
      finishReason: result.final.toolCalls.length > 0 ? 'tool-calls' : 'stop',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens:
          inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined,
      },
      warnings: [],
    };
  }

  async doStream(): Promise<never> {
    throw new Error(
      'codex-cli LanguageModel does not support streaming; use doGenerate or gateway.toolLoop.',
    );
  }
}
