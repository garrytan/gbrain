/**
 * LanguageModelV2 adapter for ChatGPT-managed Codex OAuth.
 *
 * One short-lived official `codex app-server` process handles each generation.
 * The subprocess gets a dedicated owner-only CODEX_HOME, no inherited API key,
 * no execution environment, and no Codex tools. GBrain remains the only tool
 * dispatcher; Codex is used strictly as a language model transport.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
} from '@ai-sdk/provider';
import { renderPrompt } from './claude-cli-language-model.ts';
import { CODEX_OAUTH_MODELS } from '../recipes/codex-oauth.ts';
import { acquireLock, releaseLock } from '../../pglite-lock.ts';

const EXPECTED_CODEX_VERSION = '0.147.0';
const CALL_TIMEOUT_MS = 120_000;
const MAX_PROTOCOL_LINE_CHARS = 16 * 1024 * 1024;

const DISABLED_FEATURES = [
  'shell_tool',
  'view_image',
  'unified_exec',
  'shell_snapshot',
  'code_mode',
  'code_mode_only',
  'code_mode_host',
  'standalone_web_search',
  'memories',
  'hooks',
  'request_permissions_tool',
  'deferred_executor',
  'token_budget',
  'current_time_reminder',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'enable_mcp_apps',
  'tool_suggest',
  'recommended_plugins',
  'plugins',
  'in_app_browser',
  'browser_use',
  'browser_use_full_cdp_access',
  'browser_use_external',
  'computer_use',
  'remote_plugin',
  'plugin_sharing',
  'image_generation',
  'skill_mcp_dependency_install',
  'skill_search',
  'guardian_approval',
  'goals',
  'tool_call_mcp_elicitation',
  'auth_elicitation',
  'fast_mode',
  'workspace_dependencies',
] as const;

const CLI_CONFIG = [
  'web_search="disabled"',
  'tools.update_plan.enabled=false',
  'tools.experimental_request_user_input.enabled=false',
  'skills.bundled.enabled=false',
  'skills.include_instructions=false',
  'include_permissions_instructions=false',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
  'include_environment_context=false',
  'project_doc_max_bytes=0',
  'check_for_update_on_startup=false',
  'cli_auth_credentials_store="file"',
  'analytics.enabled=false',
  'feedback.enabled=false',
  'otel.exporter="none"',
  'otel.trace_exporter="none"',
  'otel.metrics_exporter="none"',
  'otel.log_user_prompt=false',
  'notify=[]',
  'suppress_unstable_features_warning=true',
  'model_reasoning_effort="max"',
  'orchestrator.skills.enabled=false',
  'orchestrator.mcp.enabled=false',
  'agents.enabled=false',
] as const;

type JsonObject = Record<string, unknown>;

interface TokenUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}

interface CodexResult {
  text: string;
  usage: TokenUsage;
}

function modelCatalog(): JsonObject {
  const display: Record<(typeof CODEX_OAUTH_MODELS)[number], [string, string]> = {
    'gpt-5.6-luna': ['GPT-5.6-Luna', 'Fast and affordable agentic coding model.'],
    'gpt-5.6-terra': ['GPT-5.6-Terra', 'Balanced agentic coding model for everyday work.'],
    'gpt-5.6-sol': ['GPT-5.6-Sol', 'Latest frontier agentic coding model.'],
  };
  return {
    models: CODEX_OAUTH_MODELS.map((slug, index) => ({
      slug,
      display_name: display[slug][0],
      description: display[slug][1],
      default_reasoning_level: 'max',
      supported_reasoning_levels: [{
        effort: 'max',
        description: 'Maximum reasoning depth for the hardest problems',
      }],
      shell_type: 'disabled',
      visibility: 'list',
      supported_in_api: true,
      priority: index + 1,
      availability_nux: null,
      upgrade: null,
      base_instructions: 'Act only as a language model. Do not use tools.',
      include_skills_usage_instructions: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: false,
      supports_reasoning_summary_parameter: true,
      default_reasoning_summary: 'none',
      support_verbosity: true,
      default_verbosity: 'low',
      apply_patch_tool_type: null,
      web_search_tool_type: 'text',
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      supports_parallel_tool_calls: false,
      context_window: 272_000,
      max_context_window: 272_000,
      experimental_supported_tools: [],
      input_modalities: ['text'],
      supports_search_tool: false,
      use_responses_lite: true,
      // Codex 0.147 bundles these models as code_mode_only. Direct is the
      // upstream-supported selector that prevents exec/wait registration.
      tool_mode: 'direct',
      multi_agent_version: null,
    })),
  };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function privateMode(path: string, kind: string): void {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`codex-oauth ${kind} must not be accessible by group or other users`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`codex-oauth ${kind} must be owned by the GBrain service user`);
  }
}

function validateCodexHome(configured: string | undefined): string {
  if (!configured || !isAbsolute(configured)) {
    throw new Error('codex-oauth requires absolute GBRAIN_CODEX_HOME for its dedicated OAuth store');
  }
  const homeLink = lstatSync(configured);
  if (homeLink.isSymbolicLink() || !homeLink.isDirectory()) {
    throw new Error('codex-oauth GBRAIN_CODEX_HOME must be a real directory, not a symlink');
  }
  const home = realpathSync(configured);
  privateMode(home, 'home');

  const authPath = join(home, 'auth.json');
  if (!existsSync(authPath)) {
    throw new Error('codex-oauth dedicated home is not logged in; run the Codex device login first');
  }
  const authLink = lstatSync(authPath);
  if (authLink.isSymbolicLink() || !authLink.isFile()) {
    throw new Error('codex-oauth auth.json must be a regular file, not a symlink');
  }
  privateMode(authPath, 'auth file');

  const configPath = join(home, 'config.toml');
  if (existsSync(configPath)) {
    const activeLines = readFileSync(configPath, 'utf8')
      .split(/\r?\n/)
      .filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'));
    if (activeLines.length > 0) {
      throw new Error('codex-oauth dedicated home must not contain active config.toml settings');
    }
  }

  for (const name of ['AGENTS.md', 'hooks.json', 'requirements.toml', 'plugins', 'marketplaces', 'rules', '.agents']) {
    if (existsSync(join(home, name))) {
      throw new Error(`codex-oauth dedicated home contains forbidden ${name}`);
    }
  }
  const skillsPath = join(home, 'skills');
  if (existsSync(skillsPath)) {
    const customSkills = readdirSync(skillsPath).filter(name => name !== '.system');
    if (customSkills.length > 0) {
      throw new Error('codex-oauth dedicated home contains custom skills');
    }
  }
  return home;
}

function validateCodexBinary(configured: string | undefined): string {
  if (!configured || !isAbsolute(configured)) {
    throw new Error('codex-oauth requires absolute GBRAIN_CODEX_CLI_BIN pinned to Codex 0.147.0');
  }
  const bin = realpathSync(configured);
  const st = statSync(bin);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!st.isFile() || (st.mode & 0o111) === 0 || (st.mode & 0o022) !== 0 ||
      (uid !== null && st.uid !== 0 && st.uid !== uid)) {
    throw new Error('codex-oauth Codex binary must be trusted, executable, and not group/world writable');
  }
  return bin;
}

function childEnv(codexHome: string, envSnapshot: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: codexHome,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(codexHome, '.config'),
    XDG_CACHE_HOME: join(codexHome, '.cache'),
    XDG_DATA_HOME: join(codexHome, '.local', 'share'),
  };
  for (const name of [
    'PATH',
    'LANG',
    'LC_ALL',
    'TZ',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    if (envSnapshot[name] !== undefined) env[name] = envSnapshot[name];
  }
  return env;
}

function appServerArgs(catalogPath: string): string[] {
  const args = ['app-server', '--stdio', '--strict-config'];
  args.push('-c', `model_catalog_json=${JSON.stringify(catalogPath)}`);
  for (const config of CLI_CONFIG) args.push('-c', config);
  for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
  return args;
}

function isDisabled(value: unknown): boolean {
  return value === false || (isObject(value) && value.enabled === false);
}

function layerValue(layers: unknown[], path: string): unknown {
  const parts = path.split('.');
  for (const layer of layers) {
    if (!isObject(layer) || layer.disabledReason != null || !isObject(layer.config)) continue;
    let value: unknown = layer.config;
    for (const part of parts) {
      if (!isObject(value) || !(part in value)) {
        value = undefined;
        break;
      }
      value = value[part];
    }
    if (value !== undefined) return value;
  }
  return undefined;
}

function assertIsolatedConfig(raw: unknown, catalogPath: string): void {
  const config = isObject(raw) && isObject(raw.config) ? raw.config : null;
  const origins = isObject(raw) && isObject(raw.origins) ? raw.origins : null;
  const layers = isObject(raw) && Array.isArray(raw.layers) ? raw.layers : null;
  const tools = config && isObject(config.tools) ? config.tools : null;
  const agents = config && isObject(config.agents) ? config.agents : null;
  const features = config && isObject(config.features) ? config.features : null;
  const mcpServers = config && isObject(config.mcp_servers) ? config.mcp_servers : null;
  const modelProviders = config && isObject(config.model_providers) ? config.model_providers : null;
  const otel = config && isObject(config.otel) ? config.otel : null;
  const notify = config?.notify;
  const layeredNotify = layers ? layerValue(layers, 'notify') : undefined;

  if (!config || !origins || !layers || config.web_search !== 'disabled' ||
      config.model_reasoning_effort !== 'max' || !tools || !agents || !isDisabled(agents.enabled) ||
      config.cli_auth_credentials_store !== 'file' ||
      config.openai_base_url != null || config.chatgpt_base_url != null ||
      config.experimental_thread_config_endpoint != null || config.model_provider != null ||
      !modelProviders || Object.keys(modelProviders).length !== 0 ||
      !otel || otel.exporter !== 'none' || otel.trace_exporter !== 'none' ||
      otel.metrics_exporter !== 'none' || otel.log_user_prompt !== false ||
      !Array.isArray(notify) || notify.length !== 0 ||
      !Array.isArray(layeredNotify) || layeredNotify.length !== 0 ||
      config.include_permissions_instructions !== false || config.include_apps_instructions !== false ||
      config.include_collaboration_mode_instructions !== false || config.include_environment_context !== false ||
      config.instructions != null || config.developer_instructions != null || !mcpServers ||
      Object.keys(mcpServers).length !== 0 || !features ||
      DISABLED_FEATURES.some(feature => !isDisabled(features[feature])) ||
      layerValue(layers, 'model_catalog_json') !== catalogPath ||
      layerValue(layers, 'tools.update_plan.enabled') !== false ||
      layerValue(layers, 'tools.experimental_request_user_input.enabled') !== false ||
      layerValue(layers, 'skills.bundled.enabled') !== false ||
      layerValue(layers, 'skills.include_instructions') !== false ||
      layerValue(layers, 'orchestrator.skills.enabled') !== false ||
      layerValue(layers, 'orchestrator.mcp.enabled') !== false ||
      layerValue(layers, 'agents.enabled') !== false ||
      layerValue(layers, 'cli_auth_credentials_store') !== 'file' ||
      layerValue(layers, 'otel.exporter') !== 'none' ||
      layerValue(layers, 'otel.trace_exporter') !== 'none' ||
      layerValue(layers, 'otel.metrics_exporter') !== 'none' ||
      layerValue(layers, 'otel.log_user_prompt') !== false ||
      DISABLED_FEATURES.some(feature => layerValue(layers, `features.${feature}`) !== false)) {
    throw new Error('codex-oauth effective Codex config failed the no-tools isolation check');
  }
}

function isolatedThreadConfig(): JsonObject {
  return {
    model_reasoning_effort: 'max',
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    include_permissions_instructions: false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    'tools.update_plan.enabled': false,
    'tools.experimental_request_user_input.enabled': false,
    'skills.bundled.enabled': false,
    'skills.include_instructions': false,
    'orchestrator.skills.enabled': false,
    'orchestrator.mcp.enabled': false,
    'agents.enabled': false,
    notify: [],
    ...Object.fromEntries(DISABLED_FEATURES.map(feature => [`features.${feature}`, false])),
  };
}

class CodexRpc {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly lines: Interface;
  private readonly completion: Promise<CodexResult>;
  private readonly closed: Promise<void>;
  private resolveCompletion!: (result: CodexResult) => void;
  private rejectCompletion!: (error: Error) => void;
  private fatal: Error | null = null;
  private deliberatelyClosed = false;
  private terminating = false;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private agentText: string | null = null;
  private finalAgentText: string | null = null;
  private usage: TokenUsage = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  };

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.closed = new Promise(resolve => child.once('close', () => resolve()));
    this.completion = new Promise<CodexResult>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    void this.completion.catch(() => {});

    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => this.onLine(line));
    child.on('error', () => this.fail(new Error('codex-oauth could not start the pinned Codex runtime')));
    child.on('close', code => {
      if (!this.deliberatelyClosed && !this.fatal) {
        this.fail(new Error(`codex-oauth app-server exited before completion (code ${code ?? 'unknown'})`));
      }
    });
    child.stdin.on('error', () => {
      if (!this.deliberatelyClosed) this.fail(new Error('codex-oauth app-server input closed unexpectedly'));
    });
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ method, id, params });
    return result;
  }

  notify(method: string): void {
    this.write({ method });
  }

  waitForTurn(): Promise<CodexResult> {
    return this.completion;
  }

  bindThread(threadId: string): void {
    if (this.threadId !== null && this.threadId !== threadId) {
      throw new Error('codex-oauth received a mismatched thread id');
    }
    this.threadId = threadId;
  }

  bindTurn(threadId: string, turnId: string): void {
    this.bindThread(threadId);
    if (this.turnId !== null && this.turnId !== turnId) {
      throw new Error('codex-oauth received a mismatched turn id');
    }
    this.turnId = turnId;
  }

  abort(): void {
    this.fail(new Error('codex-oauth generation aborted'));
  }

  async close(): Promise<void> {
    this.deliberatelyClosed = true;
    this.lines.close();
    this.terminate();
    await this.closed;
  }

  private write(message: JsonObject): void {
    if (this.fatal) throw this.fatal;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    if (this.fatal) return;
    if (line.length > MAX_PROTOCOL_LINE_CHARS) {
      this.fail(new Error('codex-oauth app-server protocol line exceeded the safety limit'));
      return;
    }
    let message: JsonObject;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isObject(parsed)) throw new Error('not an object');
      message = parsed;
    } catch {
      this.fail(new Error('codex-oauth app-server emitted invalid JSON'));
      return;
    }

    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        this.fail(new Error(`codex-oauth rejected unexpected server request ${message.method}`));
        return;
      }
      this.onNotification(message.method, message.params);
      return;
    }

    if (typeof message.id !== 'number') {
      this.fail(new Error('codex-oauth app-server emitted an uncorrelated response'));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.fail(new Error('codex-oauth app-server emitted an unknown response id'));
      return;
    }
    if (message.error !== undefined) {
      this.fail(new Error(`codex-oauth request failed (code ${isObject(message.error) ? String(message.error.code ?? 'unknown') : 'unknown'})`));
      return;
    }
    this.pending.delete(message.id);
    pending.resolve(message.result);
  }

  private onNotification(method: string, rawParams: unknown): void {
    const params = isObject(rawParams) ? rawParams : {};
    if (method === 'error' || method === 'thread/realtime/error' || method === 'model/rerouted') {
      this.fail(new Error(`codex-oauth rejected ${method} from the Codex runtime`));
      return;
    }
    if (method === 'turn/started') {
      const turn = isObject(params.turn) ? params.turn : null;
      if (typeof params.threadId !== 'string' || !turn || typeof turn.id !== 'string') {
        this.fail(new Error('codex-oauth received malformed turn context'));
        return;
      }
      try {
        this.bindTurn(params.threadId, turn.id);
      } catch (error) {
        this.fail(error as Error);
      }
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (!this.matchesContext(params.threadId, params.turnId)) return;
      const item = params.item;
      if (!isObject(item) || typeof item.type !== 'string') {
        this.fail(new Error('codex-oauth received malformed item'));
        return;
      }
      if (item.type === 'agentMessage') {
        if (method !== 'item/completed') return;
        if (typeof item.text !== 'string') {
          this.fail(new Error('codex-oauth received malformed agent message'));
          return;
        }
        this.agentText = item.text;
        if (item.phase === 'final_answer') this.finalAgentText = item.text;
        return;
      }
      if (item.type === 'userMessage' || item.type === 'reasoning') return;
      this.fail(new Error(`codex-oauth rejected unexpected Codex item type ${item.type}`));
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      if (!this.matchesContext(params.threadId, params.turnId)) return;
      const tokenUsage = isObject(params.tokenUsage) ? params.tokenUsage : null;
      const total = tokenUsage && isObject(tokenUsage.total) ? tokenUsage.total : null;
      if (total) {
        const inputTokens = typeof total.inputTokens === 'number' ? total.inputTokens : undefined;
        const outputTokens = typeof total.outputTokens === 'number' ? total.outputTokens : undefined;
        const totalTokens = typeof total.totalTokens === 'number'
          ? total.totalTokens
          : inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined;
        this.usage = { inputTokens, outputTokens, totalTokens };
      }
      return;
    }
    if (method === 'turn/completed') {
      const turn = isObject(params.turn) ? params.turn : null;
      if (!turn || !this.matchesContext(params.threadId, turn.id) || turn.status !== 'completed') {
        this.fail(new Error('codex-oauth turn did not complete successfully'));
        return;
      }
      const text = this.finalAgentText ?? this.agentText;
      if (text === null) {
        this.fail(new Error('codex-oauth turn completed without an agent message'));
        return;
      }
      this.resolveCompletion({ text, usage: this.usage });
    }
  }

  private matchesContext(threadId: unknown, turnId: unknown): boolean {
    if (typeof threadId !== 'string' || typeof turnId !== 'string' ||
        this.threadId === null || this.turnId === null ||
        threadId !== this.threadId || turnId !== this.turnId) {
      this.fail(new Error('codex-oauth received a notification outside the active turn'));
      return false;
    }
    return true;
  }

  private fail(error: Error): void {
    if (this.fatal) return;
    this.fatal = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.rejectCompletion(error);
    this.deliberatelyClosed = true;
    this.terminate();
  }

  private terminate(): void {
    if (this.terminating || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.terminating = true;
    this.child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    }, 2_000);
    killTimer.unref();
    this.child.once('close', () => clearTimeout(killTimer));
  }
}

function assertTextOnlyPrompt(prompt: LanguageModelV2Prompt): void {
  for (const message of prompt) {
    if (message.role === 'user' && message.content.some(part => part.type === 'file')) {
      throw new Error('codex-oauth supports text prompts only');
    }
  }
}

function toolEnvelopeSchema(): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'text', 'calls'],
    properties: {
      kind: { type: 'string', enum: ['final', 'tool_calls'] },
      text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      calls: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'name', 'input'],
          properties: {
            id: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            input: { type: 'object' },
          },
        },
      },
    },
  };
}

function toolInstructions(tools: LanguageModelV2FunctionTool[], choice: LanguageModelV2CallOptions['toolChoice']): string {
  const specs = tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
  const choiceLine = choice?.type === 'required'
    ? 'You must return kind "tool_calls" with at least one call.'
    : choice?.type === 'tool'
      ? `You must return kind "tool_calls" and may call only ${JSON.stringify(choice.toolName)}.`
      : 'Return kind "tool_calls" when a tool is needed; otherwise return kind "final".';
  return [
    'Available GBrain tools:',
    JSON.stringify(specs),
    choiceLine,
    'For kind "final", set text to the answer and calls to [].',
    'For kind "tool_calls", set text to null and calls to objects with unique id, exact tool name, and object input.',
  ].join('\n');
}

function parseToolEnvelope(
  raw: string,
  tools: LanguageModelV2FunctionTool[],
  choice: LanguageModelV2CallOptions['toolChoice'],
): { text: string | null; calls: Array<{ id: string; name: string; input: string }> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('codex-oauth tool response was not valid JSON');
  }
  if (!isObject(parsed) || !hasExactKeys(parsed, ['kind', 'text', 'calls']) ||
      (parsed.kind !== 'final' && parsed.kind !== 'tool_calls') || !Array.isArray(parsed.calls)) {
    throw new Error('codex-oauth tool response violated its output schema');
  }
  const allowed = new Set(tools.map(tool => tool.name));
  const ids = new Set<string>();
  const calls: Array<{ id: string; name: string; input: string }> = [];
  for (const call of parsed.calls) {
    if (!isObject(call) || !hasExactKeys(call, ['id', 'name', 'input']) ||
        typeof call.id !== 'string' || call.id.length === 0 ||
        typeof call.name !== 'string' || !allowed.has(call.name) || !isObject(call.input) ||
        ids.has(call.id)) {
      throw new Error('codex-oauth rejected invalid or duplicate tool call');
    }
    ids.add(call.id);
    calls.push({ id: call.id, name: call.name, input: JSON.stringify(call.input) });
  }
  if (parsed.kind === 'final') {
    if (typeof parsed.text !== 'string' || calls.length !== 0 ||
        choice?.type === 'required' || choice?.type === 'tool') {
      throw new Error('codex-oauth rejected invalid final tool envelope');
    }
    return { text: parsed.text, calls: [] };
  }
  if (parsed.text !== null || calls.length === 0 ||
      (choice?.type === 'tool' && calls.some(call => call.name !== choice.toolName))) {
    throw new Error('codex-oauth rejected invalid tool-call envelope');
  }
  return { text: null, calls };
}

async function runCodexUnlocked(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  outputSchema: JsonObject | undefined,
  signal: AbortSignal | undefined,
  envSnapshot: Readonly<NodeJS.ProcessEnv>,
): Promise<CodexResult> {
  const codexHome = validateCodexHome(envSnapshot.GBRAIN_CODEX_HOME);
  const codexBin = validateCodexBinary(envSnapshot.GBRAIN_CODEX_CLI_BIN);
  const cwd = mkdtempSync(join(tmpdir(), 'gbrain-codex-oauth-'));
  let child: ChildProcessWithoutNullStreams | null = null;
  let rpc: CodexRpc | null = null;
  let combined: AbortSignal | null = null;
  let onAbort: (() => void) | null = null;
  try {
    chmodSync(cwd, 0o700);
    const catalogPath = join(cwd, 'models.json');
    writeFileSync(catalogPath, JSON.stringify(modelCatalog()), { mode: 0o600 });
    child = spawn(codexBin, appServerArgs(catalogPath), {
      cwd,
      env: childEnv(codexHome, envSnapshot),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rpcClient = new CodexRpc(child);
    rpc = rpcClient;
    // Drain stderr without retaining it: auth/runtime errors can contain sensitive detail.
    child.stderr.resume();
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    onAbort = () => rpcClient.abort();
    combined.addEventListener('abort', onAbort, { once: true });
    if (combined.aborted) rpcClient.abort();

    const initialized = await rpcClient.request('initialize', {
      clientInfo: { name: 'gbrain', title: 'GBrain OAuth provider', version: '0.44.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    let initializedHome: string | null = null;
    try {
      if (isObject(initialized) && typeof initialized.codexHome === 'string') {
        initializedHome = realpathSync(initialized.codexHome);
      }
    } catch {
      initializedHome = null;
    }
    if (!isObject(initialized) || initializedHome !== codexHome) {
      throw new Error('codex-oauth app-server used an unexpected OAuth home');
    }
    const runtimeVersion = typeof initialized.userAgent === 'string'
      ? initialized.userAgent.match(/\/(\d+\.\d+\.\d+)\b/)?.[1]
      : undefined;
    if (runtimeVersion !== EXPECTED_CODEX_VERSION) {
      throw new Error(`codex-oauth requires Codex ${EXPECTED_CODEX_VERSION}; found ${runtimeVersion ?? 'unknown'}`);
    }
    rpcClient.notify('initialized');

    assertIsolatedConfig(await rpcClient.request('config/read', { includeLayers: true, cwd }), catalogPath);

    const account = await rpcClient.request('account/read', { refreshToken: true });
    if (!isObject(account) || !isObject(account.account) || account.account.type !== 'chatgpt' ||
        account.requiresOpenaiAuth !== true) {
      throw new Error('codex-oauth requires a ChatGPT-managed OAuth login; API-key auth is refused');
    }

    const models: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const catalog = await rpcClient.request('model/list', {
        limit: 100,
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      });
      if (!isObject(catalog) || !Array.isArray(catalog.data) ||
          (catalog.nextCursor !== null && catalog.nextCursor !== undefined && typeof catalog.nextCursor !== 'string')) {
        throw new Error('codex-oauth received a malformed model catalog');
      }
      models.push(...catalog.data);
      if (!catalog.nextCursor) break;
      if (page === 9 || cursors.has(catalog.nextCursor)) {
        throw new Error('codex-oauth rejected cyclic or oversized model catalog pagination');
      }
      cursors.add(catalog.nextCursor);
      cursor = catalog.nextCursor;
    }
    for (const required of CODEX_OAUTH_MODELS) {
      const entry = models.find(candidate => isObject(candidate) && candidate.model === required);
      const efforts = entry && isObject(entry) && Array.isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts
        : [];
      if (!entry || !efforts.some(effort => isObject(effort) && effort.reasoningEffort === 'max')) {
        throw new Error(`codex-oauth isolated catalog lacks ${required} with max reasoning`);
      }
    }

    const threadStart = await rpcClient.request('thread/start', {
      model,
      modelProvider: 'openai',
      allowProviderModelFallback: false,
      cwd,
      config: isolatedThreadConfig(),
      baseInstructions: 'Answer only from the supplied conversation and developer instructions.',
      developerInstructions: [
        'Act only as a language model. Do not use tools, files, shell, apps, plugins, skills, memory, web, or subagents.',
        systemPrompt,
      ].filter(Boolean).join('\n\n'),
      personality: 'none',
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      runtimeWorkspaceRoots: [],
    });
    if (!isObject(threadStart) || !isObject(threadStart.thread) ||
        typeof threadStart.thread.id !== 'string' || threadStart.model !== model ||
        threadStart.thread.ephemeral !== true || threadStart.thread.path !== null ||
        threadStart.thread.cwd !== cwd ||
        threadStart.modelProvider !== 'openai' || threadStart.reasoningEffort !== 'max' ||
        threadStart.cwd !== cwd || threadStart.approvalPolicy !== 'never' ||
        !isObject(threadStart.sandbox) || threadStart.sandbox.type !== 'readOnly' ||
        threadStart.sandbox.networkAccess !== false ||
        !Array.isArray(threadStart.instructionSources) || threadStart.instructionSources.length !== 0 ||
        !Array.isArray(threadStart.runtimeWorkspaceRoots) || threadStart.runtimeWorkspaceRoots.length !== 0) {
      throw new Error('codex-oauth thread isolation or Luna/max routing verification failed');
    }
    rpcClient.bindThread(threadStart.thread.id);

    const turnStart = await rpcClient.request('turn/start', {
      threadId: threadStart.thread.id,
      input: [{ type: 'text', text: userPrompt, text_elements: [] }],
      environments: [],
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      model,
      effort: 'max',
      ...(outputSchema ? { outputSchema } : {}),
    });
    if (!isObject(turnStart) || !isObject(turnStart.turn) || typeof turnStart.turn.id !== 'string') {
      throw new Error('codex-oauth turn did not start');
    }
    rpcClient.bindTurn(threadStart.thread.id, turnStart.turn.id);
    return await rpcClient.waitForTurn();
  } finally {
    if (combined && onAbort) combined.removeEventListener('abort', onAbort);
    if (rpc) await rpc.close();
    else if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function runCodex(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  outputSchema: JsonObject | undefined,
  signal: AbortSignal | undefined,
  envSnapshot: Readonly<NodeJS.ProcessEnv>,
): Promise<CodexResult> {
  const codexHome = validateCodexHome(envSnapshot.GBRAIN_CODEX_HOME);
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // ponytail: one OAuth store is globally serialized; split stores only if
  // concurrent GBrain reasoning latency becomes material.
  const lock = await acquireLock(join(codexHome, '.gbrain-oauth-runtime'), {
    timeoutMs: CALL_TIMEOUT_MS,
    failFastOnServe: false,
    signal: combined,
  }).catch(error => {
    if (combined.aborted) throw new Error('codex-oauth generation aborted');
    throw error;
  });
  try {
    if (combined.aborted) throw new Error('codex-oauth generation aborted');
    return await runCodexUnlocked(model, systemPrompt, userPrompt, outputSchema, combined, envSnapshot);
  } finally {
    await releaseLock(lock);
  }
}

function normalizeModel(model: string): string {
  const idx = model.indexOf(':');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

export class CodexOAuthLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'codex-oauth';
  readonly modelId: string;
  readonly supportedUrls = {};
  private readonly envSnapshot: Readonly<NodeJS.ProcessEnv>;

  constructor(modelId: string, envSnapshot: Readonly<NodeJS.ProcessEnv>) {
    this.modelId = normalizeModel(modelId);
    this.envSnapshot = { ...envSnapshot };
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: 'stop' | 'tool-calls';
    usage: { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined };
    warnings: Array<{ type: 'unsupported-setting'; setting: string; details?: string }>;
  }> {
    assertTextOnlyPrompt(options.prompt);
    if (!CODEX_OAUTH_MODELS.includes(this.modelId as (typeof CODEX_OAUTH_MODELS)[number])) {
      throw new Error(`codex-oauth model is not allowlisted: ${this.modelId}`);
    }
    const providerTools = options.tools?.filter(tool => tool.type !== 'function') ?? [];
    if (providerTools.length > 0) {
      throw new Error('codex-oauth provider-defined tools are not supported');
    }
    const tools = options.toolChoice?.type === 'none'
      ? []
      : (options.tools ?? []) as LanguageModelV2FunctionTool[];
    if (tools.length > 0 && options.responseFormat?.type === 'json') {
      throw new Error('codex-oauth does not combine GBrain tools with structured response format');
    }
    if (tools.length === 0 && (options.toolChoice?.type === 'required' || options.toolChoice?.type === 'tool')) {
      throw new Error('codex-oauth tool choice requires at least one function tool');
    }

    const { systemText, userPrompt } = renderPrompt(options.prompt);
    const systemPrompt = tools.length > 0
      ? [systemText, toolInstructions(tools, options.toolChoice)].filter(Boolean).join('\n\n')
      : systemText;
    const outputSchema = tools.length > 0
      ? toolEnvelopeSchema()
      : options.responseFormat?.type === 'json'
        ? (options.responseFormat.schema as JsonObject | undefined) ?? { type: 'object' }
        : undefined;
    const result = await runCodex(
      this.modelId,
      systemPrompt,
      userPrompt,
      outputSchema,
      options.abortSignal,
      this.envSnapshot,
    );
    const content: LanguageModelV2Content[] = [];
    let finishReason: 'stop' | 'tool-calls' = 'stop';

    if (tools.length > 0) {
      const envelope = parseToolEnvelope(result.text, tools, options.toolChoice);
      if (envelope.text !== null) content.push({ type: 'text', text: envelope.text });
      for (const call of envelope.calls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          providerExecuted: false,
        });
      }
      if (envelope.calls.length > 0) finishReason = 'tool-calls';
    } else {
      content.push({ type: 'text', text: result.text });
    }

    const warnings: Array<{ type: 'unsupported-setting'; setting: string; details?: string }> = [];
    if (options.maxOutputTokens !== undefined) {
      warnings.push({
        type: 'unsupported-setting',
        setting: 'maxOutputTokens',
        details: 'Codex app-server 0.147 has no per-turn output-token limit.',
      });
    }
    for (const setting of ['temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed', 'stopSequences'] as const) {
      if (options[setting] !== undefined) warnings.push({ type: 'unsupported-setting', setting });
    }

    return {
      content,
      finishReason,
      usage: result.usage,
      warnings,
    };
  }

  async doStream(): Promise<never> {
    throw new Error('codex-oauth does not support streaming; use doGenerate');
  }
}
