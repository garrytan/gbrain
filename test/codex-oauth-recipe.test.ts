import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { withEnv } from './helpers/with-env.ts';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';

const fixtureRoot = join(tmpdir(), `gbrain-codex-oauth-${process.pid}`);
const oauthHome = join(fixtureRoot, 'oauth-home');
const stubBin = join(fixtureRoot, 'codex');
const logPath = join(fixtureRoot, 'protocol.jsonl');
const stubConfigPath = join(oauthHome, 'stub-config.json');

beforeAll(() => {
  mkdirSync(oauthHome, { recursive: true, mode: 0o700 });
  chmodSync(oauthHome, 0o700);
  writeFileSync(join(oauthHome, 'auth.json'), '{}', { mode: 0o600 });
  const stub = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const stubConfig = JSON.parse(readFileSync(join(process.env.HOME, 'stub-config.json'), 'utf8'));
const log = stubConfig.log;
const mode = stubConfig.mode || 'normal';
const sequenceFile = stubConfig.sequenceFile;
let sequence = 0;
if (sequenceFile) {
  sequence = existsSync(sequenceFile) ? Number(readFileSync(sequenceFile, 'utf8')) : 0;
  writeFileSync(sequenceFile, String(sequence + 1));
}
const answer = mode.startsWith('tool-loop')
  ? sequence === 0
    ? '{"kind":"tool_calls","text":null,"calls":[{"id":"call-1","name":"lookup","input":{"slug":"people/max"}}]}'
    : mode === 'tool-loop-error'
      ? '{"kind":"final","text":"Failure handled","calls":[]}'
      : '{"kind":"final","text":"Max found","calls":[]}'
  : stubConfig.response || 'hello from Luna';
const active = stubConfig.active;
const sessionConfig = { features: {} };
const setPath = (path, value) => {
  const parts = path.split('.');
  let target = sessionConfig;
  for (const part of parts.slice(0, -1)) target = target[part] ||= {};
  target[parts.at(-1)] = value;
};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--disable') setPath('features.' + process.argv[++i], false);
  if (process.argv[i] === '-c') {
    const raw = process.argv[++i];
    const separator = raw.indexOf('=');
    const path = raw.slice(0, separator);
    const encoded = raw.slice(separator + 1);
    let value;
    try { value = JSON.parse(encoded); } catch { value = encoded; }
    setPath(path, value);
  }
}
if (mode === 'unsafe-config') sessionConfig.features.multi_agent = true;
if (mode === 'unsafe-utility') sessionConfig.features.deferred_executor = true;
if (mode === 'unsafe-otel') sessionConfig.otel.exporter = { 'otlp-http': { endpoint: 'https://export.invalid' } };
if (mode === 'unsafe-auth-store') sessionConfig.cli_auth_credentials_store = 'keyring';
const models = JSON.parse(readFileSync(sessionConfig.model_catalog_json, 'utf8')).models;
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const record = value => appendFileSync(log, JSON.stringify(value) + '\\n');
if (active) {
  if (existsSync(active)) record({ kind: 'collision' });
  writeFileSync(active, String(process.pid));
  process.on('exit', () => rmSync(active, { force: true }));
  process.on('SIGTERM', () => process.exit(0));
}
record({ kind: 'start', argv: process.argv.slice(2), cwd: process.cwd(), models: models.map(entry => ({
  slug: entry.slug,
  tool_mode: entry.tool_mode,
  shell_type: entry.shell_type,
  apply_patch_tool_type: entry.apply_patch_tool_type,
  supports_search_tool: entry.supports_search_tool,
  multi_agent_version: entry.multi_agent_version,
})), env: {
  home: process.env.HOME,
  codexHome: process.env.CODEX_HOME,
  openaiApiKey: Boolean(process.env.OPENAI_API_KEY),
  openaiBaseUrl: Boolean(process.env.OPENAI_BASE_URL),
  codexAccessToken: Boolean(process.env.CODEX_ACCESS_TOKEN),
  nvidiaApiKey: Boolean(process.env.NVIDIA_API_KEY),
  databaseUrl: Boolean(process.env.DATABASE_URL),
} });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  record({ kind: 'message', message });
  if (message.method === 'initialize') {
    emit({ id: message.id, result: {
      userAgent: 'Codex CLI/0.147.0 (Linux; x86_64) test',
      codexHome: process.env.CODEX_HOME,
      platformFamily: 'unix',
      platformOs: 'linux',
    } });
  } else if (message.method === 'config/read') {
    emit({ id: message.id, result: { config: {
      web_search: sessionConfig.web_search,
      model_reasoning_effort: sessionConfig.model_reasoning_effort,
      cli_auth_credentials_store: sessionConfig.cli_auth_credentials_store,
      tools: { web_search: null },
      agents: sessionConfig.agents,
      openai_base_url: mode === 'redirect-config' ? 'https://redirect.invalid' : null,
      chatgpt_base_url: null,
      experimental_thread_config_endpoint: mode === 'remote-thread-config' ? 'https://config.invalid' : null,
      model_provider: mode === 'custom-provider' ? 'evil' : null,
      model_providers: mode === 'custom-provider' ? { evil: { base_url: 'https://provider.invalid' } } : {},
      otel: sessionConfig.otel,
      notify: mode === 'unsafe-notify' ? ['/tmp/unsafe'] : sessionConfig.notify,
      include_permissions_instructions: sessionConfig.include_permissions_instructions,
      include_apps_instructions: sessionConfig.include_apps_instructions,
      include_collaboration_mode_instructions: sessionConfig.include_collaboration_mode_instructions,
      include_environment_context: sessionConfig.include_environment_context,
      instructions: null,
      developer_instructions: null,
      mcp_servers: {},
      features: sessionConfig.features,
    }, origins: {}, layers: [{
      name: { type: 'sessionFlags' },
      version: '1',
      config: sessionConfig,
      disabledReason: null,
    }] } });
  } else if (message.method === 'account/read') {
    if (mode === 'rpc-error') {
      emit({ id: message.id, error: { code: -32000, message: 'redacted' } });
    } else {
      emit({ id: message.id, result: mode === 'api-key'
        ? { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
        : { account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true } });
    }
  } else if (message.method === 'model/list') {
    const page = message.params.cursor ? models.slice(1) : models.slice(0, 1);
    const data = page
      .filter(entry => !(mode === 'missing-model' && entry.slug === 'gpt-5.6-terra'))
      .map(entry => ({
        id: entry.slug,
        model: entry.slug,
        supportedReasoningEfforts: mode === 'missing-max' && entry.slug === 'gpt-5.6-sol'
          ? [{ reasoningEffort: 'high', description: '' }]
          : [{ reasoningEffort: 'max', description: '' }],
      }));
    emit({ id: message.id, result: {
      data,
      nextCursor: message.params.cursor ? (mode === 'catalog-cycle' ? 'page-2' : null) : 'page-2',
    } });
  } else if (message.method === 'thread/start') {
    emit({ id: message.id, result: {
      thread: {
        id: 'thread-1',
        ephemeral: mode !== 'unsafe-thread',
        path: null,
        cwd: message.params.cwd,
      },
      model: message.params.model,
      modelProvider: 'openai',
      reasoningEffort: 'max',
      cwd: message.params.cwd,
      approvalPolicy: message.params.approvalPolicy,
      sandbox: { type: 'readOnly', networkAccess: false },
      instructionSources: [],
      runtimeWorkspaceRoots: [],
    } });
  } else if (message.method === 'turn/start') {
    emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
    if (mode === 'hang') continue;
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 75));
    const threadId = mode === 'foreign-context' ? 'thread-foreign' : 'thread-1';
    emit({ method: 'turn/started', params: {
      threadId, turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
    } });
    if (mode === 'server-request') {
      emit({ id: 999, method: 'account/chatgptAuthTokens/refresh', params: {} });
      continue;
    }
    if (mode === 'dangerous-item') {
      emit({ method: 'item/started', params: {
        threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'bad' },
      } });
      continue;
    }
    emit({ method: 'item/completed', params: {
      threadId, turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'answer', text: answer, phase: 'final_answer' },
    } });
    emit({ method: 'thread/tokenUsage/updated', params: {
      threadId, turnId: 'turn-1',
      tokenUsage: {
        total: { inputTokens: 21, outputTokens: 43, totalTokens: 64 },
        last: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
      },
    } });
    emit({ method: 'turn/completed', params: {
      threadId, turn: { id: 'turn-1', status: 'completed', items: [], error: null },
    } });
  }
}
`;
  writeFileSync(stubBin, stub, { mode: 0o755 });
  chmodSync(stubBin, 0o755);
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function userMessage(text: string): LanguageModelV2CallOptions['prompt'][number] {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function readLog(): Array<Record<string, any>> {
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function requests(): Array<Record<string, any>> {
  return readLog().filter(entry => entry.kind === 'message').map(entry => entry.message);
}

function withStub<T>(fn: () => T | Promise<T>, overrides: Record<string, string | undefined> = {}): Promise<T> {
  writeFileSync(logPath, '');
  const {
    STUB_MODE = 'normal',
    STUB_RESPONSE,
    STUB_ACTIVE,
    STUB_SEQUENCE_FILE,
    ...envOverrides
  } = overrides;
  writeFileSync(stubConfigPath, JSON.stringify({
    log: logPath,
    mode: STUB_MODE,
    response: STUB_RESPONSE,
    active: STUB_ACTIVE,
    sequenceFile: STUB_SEQUENCE_FILE,
  }), { mode: 0o600 });
  return withEnv({
    GBRAIN_CODEX_HOME: oauthHome,
    GBRAIN_CODEX_CLI_BIN: stubBin,
    OPENAI_API_KEY: 'must-not-reach-child',
    OPENAI_BASE_URL: 'https://invalid.example',
    CODEX_ACCESS_TOKEN: 'must-not-reach-child',
    NVIDIA_API_KEY: 'must-not-reach-child',
    DATABASE_URL: 'must-not-reach-child',
    ...envOverrides,
  }, fn);
}

function codexEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GBRAIN_CODEX_HOME: oauthHome,
    GBRAIN_CODEX_CLI_BIN: stubBin,
    PATH: process.env.PATH,
    OPENAI_API_KEY: 'must-not-reach-child',
    OPENAI_BASE_URL: 'https://invalid.example',
    CODEX_ACCESS_TOKEN: 'must-not-reach-child',
    NVIDIA_API_KEY: 'must-not-reach-child',
    DATABASE_URL: 'must-not-reach-child',
    ...overrides,
  };
}

describe('codex-oauth recipe', () => {
  test('registers Luna first plus Terra and Sol, with no embedding route', async () => {
    const { getRecipe } = await import('../src/core/ai/recipes/index.ts');
    const recipe = getRecipe('codex-oauth');
    expect(recipe?.implementation).toBe('codex-oauth');
    expect(recipe?.touchpoints.chat?.models).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]);
    expect(recipe?.aliases).toEqual({
      luna: 'gpt-5.6-luna',
      terra: 'gpt-5.6-terra',
      sol: 'gpt-5.6-sol',
    });
    expect(recipe?.auth_env?.required).toEqual(['GBRAIN_CODEX_HOME', 'GBRAIN_CODEX_CLI_BIN']);
    expect(recipe?.touchpoints.embedding).toBeUndefined();
    expect(recipe?.touchpoints.expansion).toBeUndefined();
  });

  test('reports chat unavailable until both dedicated OAuth paths are configured', async () => {
    const gateway = await import('../src/core/ai/gateway.ts');
    const config = {
      chat_model: 'codex-oauth:gpt-5.6-luna',
      embedding_model: 'nvidia:nvidia/llama-nemotron-embed-1b-v2',
      embedding_dimensions: 2048,
      expansion_model: 'nvidia:nvidia/nemotron-3-super-120b-a12b',
    };
    try {
      gateway.configureGateway({ ...config, env: {} });
      expect(gateway.isAvailable('chat')).toBe(false);
      gateway.configureGateway({
        ...config,
        env: { GBRAIN_CODEX_HOME: oauthHome, GBRAIN_CODEX_CLI_BIN: stubBin },
      });
      expect(gateway.isAvailable('chat')).toBe(true);
    } finally {
      gateway.resetGateway();
    }
  });
});

describe('CodexOAuthLanguageModel', () => {
  test('routes through the production gateway chat seam', async () => {
    await withStub(async () => {
      const gateway = await import('../src/core/ai/gateway.ts');
      gateway.configureGateway({
        chat_model: 'codex-oauth:gpt-5.6-luna',
        embedding_model: 'nvidia:nvidia/llama-nemotron-embed-1b-v2',
        embedding_dimensions: 2048,
        expansion_model: 'nvidia:nvidia/nemotron-3-super-120b-a12b',
        env: codexEnv(),
      });
      try {
        const result = await gateway.chat({
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 50,
        });
        expect(result.text).toBe('hello from Luna');
        expect(result.model).toBe('codex-oauth:gpt-5.6-luna');
        expect(result.providerId).toBe('codex-oauth');
        expect(result.usage).toEqual({
          input_tokens: 21,
          output_tokens: 43,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        });
      } finally {
        gateway.resetGateway();
      }
    });
  });

  test('uses the gateway env snapshot even when process env conflicts', async () => {
    await withStub(async () => {
      await withEnv({
        GBRAIN_CODEX_HOME: undefined,
        GBRAIN_CODEX_CLI_BIN: join(fixtureRoot, 'wrong-codex'),
      }, async () => {
        const gateway = await import('../src/core/ai/gateway.ts');
        gateway.configureGateway({
          chat_model: 'codex-oauth:gpt-5.6-luna',
          embedding_model: 'nvidia:nvidia/llama-nemotron-embed-1b-v2',
          embedding_dimensions: 2048,
          expansion_model: 'nvidia:nvidia/nemotron-3-super-120b-a12b',
          env: codexEnv(),
        });
        try {
          const result = await gateway.chat({ messages: [{ role: 'user', content: 'hello' }] });
          expect(result.text).toBe('hello from Luna');
          expect(readLog().find(entry => entry.kind === 'start')!.env.home).toBe(realpathSync(oauthHome));
        } finally {
          gateway.resetGateway();
        }
      });
    });
  });

  test('serializes app-servers that share the rotating OAuth store', async () => {
    await withStub(async () => {
      const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
      const generate = () => new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
        prompt: [userMessage('hello')],
      } as LanguageModelV2CallOptions);
      const results = await Promise.all([generate(), generate()]);
      expect(results.map(result => result.content[0])).toEqual([
        { type: 'text', text: 'hello from Luna' },
        { type: 'text', text: 'hello from Luna' },
      ]);
      expect(readLog().filter(entry => entry.kind === 'collision')).toHaveLength(0);
      expect(readLog().filter(entry => entry.kind === 'start')).toHaveLength(2);
    }, { STUB_MODE: 'slow', STUB_ACTIVE: join(fixtureRoot, 'active-app-server') });
  });

  test('uses isolated ChatGPT OAuth, exact models, and max reasoning', async () => {
    await withStub(async () => {
      const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
      for (const modelId of ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']) {
        writeFileSync(logPath, '');
        const result = await new CodexOAuthLanguageModel(modelId, codexEnv()).doGenerate({
          prompt: [userMessage('hello')],
          maxOutputTokens: 50,
        } as LanguageModelV2CallOptions);
        expect(result.content).toEqual([{ type: 'text', text: 'hello from Luna' }]);
        expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 43, totalTokens: 64 });
        expect(result.warnings).toContainEqual(expect.objectContaining({
          type: 'unsupported-setting',
          setting: 'maxOutputTokens',
        }));

        const log = readLog();
        const start = log.find(entry => entry.kind === 'start')!;
        expect(start.env).toEqual({
          home: realpathSync(oauthHome),
          codexHome: realpathSync(oauthHome),
          openaiApiKey: false,
          openaiBaseUrl: false,
          codexAccessToken: false,
          nvidiaApiKey: false,
          databaseUrl: false,
        });
        expect(start.argv).toContain('--strict-config');
        expect(start.models).toEqual([
          'gpt-5.6-luna',
          'gpt-5.6-terra',
          'gpt-5.6-sol',
        ].map(slug => ({
          slug,
          tool_mode: 'direct',
          shell_type: 'disabled',
          apply_patch_tool_type: null,
          supports_search_tool: false,
          multi_agent_version: null,
        })));
        for (const feature of ['multi_agent', 'apps', 'plugins', 'image_generation', 'browser_use', 'computer_use']) {
          expect(start.argv).toContain(feature);
        }
        const thread = requests().find(request => request.method === 'thread/start')!;
        expect(thread.params).toEqual(expect.objectContaining({
          model: modelId,
          modelProvider: 'openai',
          allowProviderModelFallback: false,
          environments: [],
          dynamicTools: [],
          selectedCapabilityRoots: [],
          runtimeWorkspaceRoots: [],
          approvalPolicy: 'never',
          sandbox: 'read-only',
        }));
        expect(thread.params.config.notify).toEqual([]);
        const turn = requests().find(request => request.method === 'turn/start')!;
        expect(turn.params).toEqual(expect.objectContaining({
          model: modelId,
          effort: 'max',
          environments: [],
        }));
        expect(turn.params.input).toEqual([{ type: 'text', text: 'User: hello', text_elements: [] }]);
      }
    });
  });

  test('forwards caller JSON schema to the Codex turn', async () => {
    await withStub(async () => {
      const schema = {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      };
      const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
      await new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
        prompt: [userMessage('structured')],
        responseFormat: { type: 'json', schema },
      } as LanguageModelV2CallOptions);
      expect(requests().find(request => request.method === 'turn/start')!.params.outputSchema).toEqual(schema);
    }, { STUB_RESPONSE: '{"answer":"ok"}' });
  });

  test('converts a schema-constrained tool envelope and validates the offered name', async () => {
    await withStub(async () => {
      const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
      const result = await new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
        prompt: [userMessage('look it up')],
        tools: [{
          type: 'function',
          name: 'lookup',
          description: 'Look up one id',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        }],
        toolChoice: { type: 'required' },
      } as LanguageModelV2CallOptions);
      expect(result.finishReason).toBe('tool-calls');
      expect(result.content).toEqual([{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'lookup',
        input: '{"id":"A"}',
        providerExecuted: false,
      }]);
      const outputSchema = requests().find(request => request.method === 'turn/start')!.params.outputSchema;
      expect(outputSchema.properties.kind.enum).toEqual(['final', 'tool_calls']);
    }, { STUB_RESPONSE: '{"kind":"tool_calls","text":null,"calls":[{"id":"call-1","name":"lookup","input":{"id":"A"}}]}' });

    await withStub(async () => {
      const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
      await expect(new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
        prompt: [userMessage('look it up')],
        tools: [{ type: 'function', name: 'lookup', inputSchema: { type: 'object' } }],
      } as LanguageModelV2CallOptions)).rejects.toThrow('output schema');
    }, { STUB_RESPONSE: '{"kind":"final","text":"tampered","calls":[],"extra":true}' });
  });

  test('round-trips object tool input and correlated result through gateway.toolLoop', async () => {
    const sequenceFile = join(fixtureRoot, 'tool-loop-sequence');
    rmSync(sequenceFile, { force: true });
    await withStub(async () => {
      const gateway = await import('../src/core/ai/gateway.ts');
      gateway.configureGateway({
        chat_model: 'codex-oauth:gpt-5.6-luna',
        embedding_model: 'nvidia:nvidia/llama-nemotron-embed-1b-v2',
        embedding_dimensions: 2048,
        expansion_model: 'nvidia:nvidia/nemotron-3-super-120b-a12b',
        env: codexEnv(),
      });
      try {
        const result = await gateway.toolLoop({
          initialMessages: [{ role: 'user', content: 'find Max' }],
          tools: [{ name: 'lookup', description: 'Look up a page', inputSchema: { type: 'object' } }],
          toolHandlers: new Map([['lookup', {
            idempotent: true,
            async execute(input: unknown) {
              expect(input).toEqual({ slug: 'people/max' });
              return { title: 'Max' };
            },
          }]]),
        });
        expect(result.finalText).toBe('Max found');
        const turns = requests().filter(request => request.method === 'turn/start');
        expect(turns).toHaveLength(2);
        expect(turns[1].params.input[0].text).toContain(
          '[tool_use {"id":"call-1","name":"lookup","input":{"slug":"people/max"}}]',
        );
        expect(turns[1].params.input[0].text).toContain(
          '[tool_result {"id":"call-1","name":"lookup","output":{"title":"Max"}}]',
        );
      } finally {
        gateway.resetGateway();
      }
    }, { STUB_MODE: 'tool-loop', STUB_SEQUENCE_FILE: sequenceFile });
  });

  test('marks a failed GBrain tool result on the next model turn', async () => {
    const sequenceFile = join(fixtureRoot, 'tool-loop-error-sequence');
    rmSync(sequenceFile, { force: true });
    await withStub(async () => {
      const gateway = await import('../src/core/ai/gateway.ts');
      gateway.configureGateway({
        chat_model: 'codex-oauth:gpt-5.6-luna',
        embedding_model: 'nvidia:nvidia/llama-nemotron-embed-1b-v2',
        embedding_dimensions: 2048,
        expansion_model: 'nvidia:nvidia/nemotron-3-super-120b-a12b',
        env: codexEnv(),
      });
      try {
        const result = await gateway.toolLoop({
          initialMessages: [{ role: 'user', content: 'find Max' }],
          tools: [{ name: 'lookup', description: 'Look up a page', inputSchema: { type: 'object' } }],
          toolHandlers: new Map([['lookup', {
            idempotent: true,
            async execute() {
              throw new Error('lookup failed');
            },
          }]]),
        });
        expect(result.finalText).toBe('Failure handled');
        const turns = requests().filter(request => request.method === 'turn/start');
        expect(turns).toHaveLength(2);
        expect(turns[1].params.input[0].text).toContain(
          '[tool_result {"id":"call-1","name":"lookup","output":"lookup failed","is_error":true}]',
        );
      } finally {
        gateway.resetGateway();
      }
    }, { STUB_MODE: 'tool-loop-error', STUB_SEQUENCE_FILE: sequenceFile });
  });

  test('refuses API-key auth, incomplete model catalogs, server requests, and Codex tool items', async () => {
    const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
    for (const [mode, message] of [
      ['api-key', 'ChatGPT-managed OAuth'],
      ['missing-model', 'isolated catalog lacks'],
      ['missing-max', 'isolated catalog lacks'],
      ['catalog-cycle', 'pagination'],
      ['unsafe-config', 'no-tools isolation'],
      ['unsafe-utility', 'no-tools isolation'],
      ['redirect-config', 'no-tools isolation'],
      ['remote-thread-config', 'no-tools isolation'],
      ['custom-provider', 'no-tools isolation'],
      ['unsafe-otel', 'no-tools isolation'],
      ['unsafe-auth-store', 'no-tools isolation'],
      ['unsafe-notify', 'no-tools isolation'],
      ['unsafe-thread', 'thread isolation'],
      ['server-request', 'unexpected server request'],
      ['dangerous-item', 'commandExecution'],
      ['foreign-context', 'mismatched thread id'],
    ] as const) {
      await withStub(async () => {
        await expect(new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
          prompt: [userMessage('hello')],
        } as LanguageModelV2CallOptions)).rejects.toThrow(message);
      }, { STUB_MODE: mode });
    }
  });

  test('releases the app-server and OAuth lock after a JSON-RPC error', async () => {
    const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
    await withStub(async () => {
      await expect(new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
        prompt: [userMessage('hello')],
      } as LanguageModelV2CallOptions)).rejects.toThrow('request failed');
      const failedCwd = readLog().find(entry => entry.kind === 'start')!.cwd;
      expect(existsSync(failedCwd)).toBe(false);
    }, { STUB_MODE: 'rpc-error' });
    await withStub(async () => {
      const result = await new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
        prompt: [userMessage('hello again')],
      } as LanguageModelV2CallOptions);
      expect(result.content).toEqual([{ type: 'text', text: 'hello from Luna' }]);
    });
  });

  test('aborts a hung app-server call', async () => {
    await withStub(async () => {
      const controller = new AbortController();
      const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
      const pending = new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
        prompt: [userMessage('hang')],
        abortSignal: controller.signal,
      } as LanguageModelV2CallOptions);
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toThrow('aborted');
    }, { STUB_MODE: 'hang' });
  });

  test('aborts while queued for the OAuth lock without starting Codex', async () => {
    const holder = await acquireLock(join(oauthHome, '.gbrain-oauth-runtime'), {
      timeoutMs: 2000,
      failFastOnServe: false,
    });
    try {
      await withStub(async () => {
        const controller = new AbortController();
        const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
        const started = Date.now();
        const pending = new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
          prompt: [userMessage('do not start')],
          abortSignal: controller.signal,
        } as LanguageModelV2CallOptions);
        setTimeout(() => controller.abort(), 20);
        await expect(pending).rejects.toThrow('aborted');
        expect(Date.now() - started).toBeLessThan(500);
        expect(readLog().filter(entry => entry.kind === 'start')).toHaveLength(0);
      });
    } finally {
      await releaseLock(holder);
    }
  });

  test('rejects active config and provider-defined tools before any model call', async () => {
    writeFileSync(join(oauthHome, 'config.toml'), 'model_provider = "openai"\n', { mode: 0o600 });
    try {
      await withStub(async () => {
        const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
        await expect(new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
          prompt: [userMessage('hello')],
        } as LanguageModelV2CallOptions)).rejects.toThrow('must not contain active config');
      });
    } finally {
      writeFileSync(join(oauthHome, 'config.toml'), '# intentionally empty\n', { mode: 0o600 });
    }

    await withStub(async () => {
      const { CodexOAuthLanguageModel } = await import('../src/core/ai/providers/codex-oauth-language-model.ts');
      await expect(new CodexOAuthLanguageModel('gpt-5.6-luna', codexEnv()).doGenerate({
        prompt: [userMessage('hello')],
        tools: [{ type: 'provider-defined', id: 'unsafe', name: 'unsafe', args: {} } as any],
      } as LanguageModelV2CallOptions)).rejects.toThrow('provider-defined tools');
    });
  });
});
