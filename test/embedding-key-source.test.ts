/**
 * #5137: env provider keys keep winning over config keys, but a different
 * config key shadowed by the environment is reported once per process, doctor
 * `embedding_key_source` reports the same, and the first embedding 401/403
 * prints embedding_auth_failed naming the key source. No key value or
 * fragment reaches any output.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergedProviderEnv, providerKeyShadows, providerKeySource } from '../src/core/ai/provider-env.ts';
import { _setKeyWarningSinkForTests, credentialEnvName, embeddingAuthFailedError, warnShadowedProviderKeys } from '../src/core/ai/key-warnings.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { redactProviderKeys } from '../src/core/ai/key-redact.ts';
import { configureGateway, embed, resetGateway } from '../src/core/ai/gateway.ts';
import { embeddingKeySource } from '../src/commands/doctor/checks/embedding-health.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const ENV_KEY = 'sk-test-ENVKEYexample0123456789abcdefWXYZ';
const CONFIG_KEY = 'sk-test-CONFIGKEYexample9876543210fedcbaQRST';
const fragments = (key: string) => [key, key.slice(0, 16), key.slice(-12)];
const cfg = (extra: Partial<GBrainConfig> = {}) => ({ engine: 'pglite', openai_api_key: CONFIG_KEY, ...extra }) as GBrainConfig;
const leaks = (text: string) => [...fragments(ENV_KEY), ...fragments(CONFIG_KEY)].filter(fragment => text.includes(fragment));

const lines: string[] = [];
afterEach(() => { _setKeyWarningSinkForTests(); lines.length = 0; resetGateway(); });

describe('providerKeyShadows (pure)', () => {
  test('reports an env value that differs from the config key, by name only', () => {
    expect(providerKeyShadows(cfg(), { OPENAI_API_KEY: ENV_KEY })).toEqual([{ variable: 'OPENAI_API_KEY', config_key: 'openai_api_key' }]);
    expect(providerKeyShadows(cfg(), { OPENAI_API_KEY: CONFIG_KEY })).toEqual([]);
    expect(providerKeyShadows(cfg(), { OPENAI_API_KEY: '' })).toEqual([]);
    expect(providerKeyShadows(cfg(), {})).toEqual([]);
    expect(providerKeyShadows(null, { OPENAI_API_KEY: ENV_KEY })).toEqual([]);
    expect(mergedProviderEnv(cfg(), { OPENAI_API_KEY: ENV_KEY }).OPENAI_API_KEY).toBe(ENV_KEY);
  });

  test('the GEMINI alias counts as the env key for google_api_key; TypeSafe has no config key, so its alias never warns', () => {
    const google = cfg({ google_api_key: CONFIG_KEY } as Partial<GBrainConfig>);
    expect(providerKeyShadows(google, { GEMINI_API_KEY: ENV_KEY })).toEqual([{ variable: 'GEMINI_API_KEY', config_key: 'google_api_key' }]);
    expect(providerKeyShadows(google, { GOOGLE_GENERATIVE_AI_API_KEY: ENV_KEY, GEMINI_API_KEY: CONFIG_KEY }))
      .toEqual([{ variable: 'GOOGLE_GENERATIVE_AI_API_KEY', config_key: 'google_api_key' }]);
    expect(providerKeyShadows(cfg(), { JEV_TYPESAFE_API_KEY: ENV_KEY })).toEqual([]);
    expect(providerKeyShadows(cfg(), { TYPESAFE_API_KEY: ENV_KEY, JEV_TYPESAFE_API_KEY: CONFIG_KEY })).toEqual([]);
  });

  test('providerKeySource names where the key in effect comes from', () => {
    expect(providerKeySource(cfg(), { OPENAI_API_KEY: ENV_KEY }, 'OPENAI_API_KEY')).toEqual({ kind: 'env', variable: 'OPENAI_API_KEY', config_key: 'openai_api_key', shadows_config: true });
    expect(providerKeySource(cfg(), {}, 'OPENAI_API_KEY')).toEqual({ kind: 'config', variable: 'OPENAI_API_KEY', config_key: 'openai_api_key' });
    expect(providerKeySource(null, {}, 'ZEROENTROPY_API_KEY')).toEqual({ kind: 'missing', variable: 'ZEROENTROPY_API_KEY' });
  });
});

describe('the shadow warning', () => {
  test('prints once per process, names the variable, the config key, which is in effect and both fixes, and no key bytes', () => {
    _setKeyWarningSinkForTests(line => lines.push(line));
    warnShadowedProviderKeys(cfg(), { OPENAI_API_KEY: ENV_KEY });
    warnShadowedProviderKeys(cfg(), { OPENAI_API_KEY: ENV_KEY });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('OPENAI_API_KEY in this process\'s environment differs from openai_api_key in');
    expect(lines[0]).toContain('the environment value is in effect');
    expect(lines[0]).toContain('remove OPENAI_API_KEY from the environment of the process that reported this');
    expect(lines[0]).toContain('for a daemon its service definition) and restart that process');
    expect(lines[0]).toContain('run `gbrain config unset openai_api_key`, which also stops this warning');
    expect(leaks(lines[0])).toEqual([]);
  });

  test('a matching or absent env key prints nothing', () => {
    _setKeyWarningSinkForTests(line => lines.push(line));
    warnShadowedProviderKeys(cfg(), { OPENAI_API_KEY: CONFIG_KEY });
    expect(lines).toEqual([]);
  });
});

describe('doctor embedding_key_source', () => {
  test('warns on a shadowed key, names the embedding key source, scopes itself to doctor\'s environment, and leaks no key', () => {
    const check = embeddingKeySource(cfg({ embedding_model: 'openai:text-embedding-3-small' }), { OPENAI_API_KEY: ENV_KEY }, '/home/example/.gbrain/config.json');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('The embedding key in effect is OPENAI_API_KEY from this environment.');
    expect(check.message).toContain('differs from openai_api_key in /home/example/.gbrain/config.json');
    expect(check.message).toContain('This check sees only the environment `gbrain doctor` runs in');
    expect(check.details).toMatchObject({ shadows: [{ variable: 'OPENAI_API_KEY', config_key: 'openai_api_key', in_effect: 'env' }],
      embedding_key: { kind: 'env', variable: 'OPENAI_API_KEY', config_key: 'openai_api_key' }, docs: 'docs/guides/repair.md#embedding-key-source' });
    expect(leaks(JSON.stringify(check))).toEqual([]);
  });

  test('names the real credential for Azure and LiteLLM, and follows GBRAIN_EMBEDDING_MODEL over the file model', () => {
    expect(credentialEnvName(getRecipe('azure-openai')?.auth_env)).toBe('AZURE_OPENAI_API_KEY');
    expect(credentialEnvName(getRecipe('litellm')?.auth_env)).toBe('LITELLM_API_KEY');
    const check = embeddingKeySource(cfg({ embedding_model: 'openai:text-embedding-3-small' }),
      { GBRAIN_EMBEDDING_MODEL: 'voyage:voyage-4', VOYAGE_API_KEY: ENV_KEY }, '/home/example/.gbrain/config.json');
    expect(check.message).toContain('The embedding key in effect is VOYAGE_API_KEY from this environment.');
    expect(check.details).toMatchObject({ embedding_model: 'voyage:voyage-4' });
    const azure = embeddingAuthFailedError(getRecipe('azure-openai')!, 401, cfg({ azure_openai_api_key: CONFIG_KEY } as Partial<GBrainConfig>), {}, '/home/example/.gbrain/config.json');
    expect(azure.message).toContain('the key in effect is azure_openai_api_key in /home/example/.gbrain/config.json (AZURE_OPENAI_API_KEY is not set)');
    expect(azure.message).not.toContain('AZURE_OPENAI_ENDPOINT');
    const entra = embeddingAuthFailedError(getRecipe('azure-openai')!, 403, cfg({ azure_openai_api_key: CONFIG_KEY } as Partial<GBrainConfig>), { AZURE_OPENAI_USE_ENTRA: '1' }, '/home/example/.gbrain/config.json');
    expect(entra.message).toContain('Azure Entra mode is on (AZURE_OPENAI_USE_ENTRA)');
    expect(entra.suggestion).toContain('az login');
    expect(entra.suggestion).not.toContain('azure_openai_api_key');
  });

  test('is ok without a shadow and reports a config-plane embedding key', () => {
    const check = embeddingKeySource(cfg({ embedding_model: 'openai:text-embedding-3-small' }), {}, '/home/example/.gbrain/config.json');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('The embedding key in effect is openai_api_key in /home/example/.gbrain/config.json.');
    expect(leaks(JSON.stringify(check))).toEqual([]);
  });
});

test('redactProviderKeys removes a key in effect, a masked echo and a key fragment, and keeps ordinary text', () => {
  const text = `Incorrect API key provided: ${ENV_KEY}. Also seen: sk-test-****************WXYZ and ${ENV_KEY.slice(4, 20)} for model text-embedding-3-small.`;
  const redacted = redactProviderKeys(text, { OPENAI_API_KEY: ENV_KEY, OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' });
  expect(leaks(redacted)).toEqual([]);
  expect(redacted).not.toContain('****');
  expect(redacted).toContain('<REDACTED:OPENAI_API_KEY>');
  expect(redacted).toContain('for model text-embedding-3-small.');
});

describe('embedding_auth_failed against a provider that rejects the env key', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-key-source-'));
  let server: ReturnType<typeof Bun.serve>;
  const requests: string[] = [];
  beforeAll(() => {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', openai_api_key: CONFIG_KEY }));
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const key = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      requests.push(key === CONFIG_KEY ? 'config' : key === ENV_KEY ? 'env' : 'other');
      if (key !== CONFIG_KEY) {
        return Response.json({ error: { message: `Incorrect API key provided: ${key}. You passed ${key.slice(0, 16)}...${key.slice(-12)} (sk-test-****${key.slice(-4)}).`, type: 'invalid_request_error', code: 'invalid_api_key' } }, { status: 401 });
      }
      const body = await req.json() as { input: string[] };
      return Response.json({ object: 'list', model: 'text-embedding-3-small', usage: { prompt_tokens: 1, total_tokens: 1 },
        data: body.input.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 1536 }, (_, i) => (i % 7) + 1) })) });
    } });
  });
  afterAll(() => { server.stop(true); rmSync(home, { recursive: true, force: true }); });

  const configureFromEnv = async () => {
    const { loadConfigFileOnly } = await import('../src/core/config.ts');
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
      env: { ...mergedProviderEnv(loadConfigFileOnly(), process.env), OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` } });
  };

  test('the first 401 prints one error naming the env key source and its fixes; following the fix makes the embedding succeed', async () => {
    _setKeyWarningSinkForTests(line => lines.push(line));
    let failure: unknown;
    await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: ENV_KEY }, async () => {
      await configureFromEnv();
      failure = await embed(['example text'], { maxRetries: 0 }).then(() => null, error => error);
      expect(await embed(['second example'], { maxRetries: 0 }).then(() => null, error => error)).toBeInstanceOf(Error);
    });
    expect(failure).toBeInstanceOf(Error);
    expect(requests).toContain('env');
    expect(leaks(String((failure as Error).message))).toEqual([]);
    expect(leaks(JSON.stringify({ error: (failure as Error).message, ...(failure as object) }))).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('[gbrain] Error [embedding_auth_failed]: The OpenAI embedding provider rejected its key (HTTP 401); the key in effect is OPENAI_API_KEY from this process\'s environment, which differs from openai_api_key in');
    expect(lines[0]).toContain('Fix: To use the config key, remove OPENAI_API_KEY from the environment of the process that reported this');
    expect(lines[0]).toContain('run `gbrain config unset openai_api_key`');
    expect(lines[0]).toContain('Docs: docs/guides/write-refusals.md#embedding_auth_failed');
    expect(leaks(lines.join('\n'))).toEqual([]);

    await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined }, async () => {
      await configureFromEnv();
      const [vector] = await embed(['example text'], { maxRetries: 0 });
      expect(vector).toHaveLength(1536);
    });
    expect(requests.at(-1)).toBe('config');
  }, 60_000);

  test('a rejected config key names the config key and its fix', () => {
    const error = embeddingAuthFailedError({ id: 'openai', name: 'OpenAI', auth_env: { required: ['OPENAI_API_KEY'] } }, 403, cfg(), {}, '/home/example/.gbrain/config.json');
    expect(error.toJSON()).toMatchObject({ error: 'embedding_auth_failed', docs: 'docs/guides/write-refusals.md#embedding_auth_failed',
      message: 'The OpenAI embedding provider rejected its key (HTTP 403); the key in effect is openai_api_key in /home/example/.gbrain/config.json (OPENAI_API_KEY is not set).',
      suggestion: 'Run `gbrain config set openai_api_key <valid key>` and restart any daemon that uses it. Then run `gbrain embed --stale` to embed what was saved while the key was rejected.' });
  });
});
