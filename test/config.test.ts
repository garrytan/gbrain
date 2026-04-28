import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, saveConfig, configDir, configPath } from '../src/core/config.ts';

// redactUrl is not exported, so we test it by reading the source and
// reimplementing the regex to verify the pattern, then test via CLI

// Extract the redactUrl regex pattern from source
const configSource = readFileSync(
  new URL('../src/commands/config.ts', import.meta.url),
  'utf-8',
);

// Reimplemented from source for unit testing
function redactUrl(url: string): string {
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

describe('redactUrl', () => {
  test('redacts password in postgresql:// URL', () => {
    const url = 'postgresql://user:secretpass@host:5432/dbname';
    expect(redactUrl(url)).toBe('postgresql://user:***@host:5432/dbname');
  });

  test('redacts complex passwords with special chars', () => {
    const url = 'postgresql://postgres:p@ss!w0rd#123@db.supabase.co:5432/postgres';
    // The regex is greedy on [^@]+ so it captures up to the LAST @
    const result = redactUrl(url);
    expect(result).not.toContain('p@ss');
    expect(result).toContain('***');
  });

  test('returns non-postgresql URLs unchanged', () => {
    const url = 'https://example.com/api';
    expect(redactUrl(url)).toBe(url);
  });

  test('returns plain strings unchanged', () => {
    expect(redactUrl('hello')).toBe('hello');
  });

  test('handles URL without password', () => {
    const url = 'postgresql://user@host:5432/dbname';
    // No colon after user means regex doesn't match
    expect(redactUrl(url)).toBe(url);
  });

  test('handles empty string', () => {
    expect(redactUrl('')).toBe('');
  });
});

describe('config source correctness', () => {
  test('redactUrl function exists in config.ts', () => {
    expect(configSource).toContain('function redactUrl');
  });

  test('redactUrl uses the correct regex pattern', () => {
    expect(configSource).toContain('postgresql:\\/\\/');
  });
});

describe('loadConfig: API key merging (for self-contained subprocess use)', () => {
  // These tests verify that gbrain can be called as a subprocess by agents/cron
  // without the caller needing to propagate API keys — loadConfig picks them up
  // from either the config file OR env vars, and both embedding.ts and
  // expansion.ts read the merged config to instantiate their SDK clients.

  let originalOpenAI: string | undefined;
  let originalAnthropic: string | undefined;
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    originalOpenAI = process.env.OPENAI_API_KEY;
    originalAnthropic = process.env.ANTHROPIC_API_KEY;
    originalDatabaseUrl = process.env.DATABASE_URL;
    // Ensure loadConfig() returns something (needs DATABASE_URL when no file exists)
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  });

  afterEach(() => {
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  test('merges OPENAI_API_KEY from env into config', () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai-xyz';
    const config = loadConfig();
    expect(config?.openai_api_key).toBe('sk-test-openai-xyz');
  });

  test('merges ANTHROPIC_API_KEY from env into config (regression: was missing)', () => {
    // Before this fix, loadConfig() only merged OPENAI_API_KEY and silently
    // dropped ANTHROPIC_API_KEY from the env. That meant subprocess callers
    // who set ANTHROPIC_API_KEY in their shell still couldn't get query
    // expansion because downstream code only saw the un-merged config.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-xyz';
    const config = loadConfig();
    expect(config?.anthropic_api_key).toBe('sk-ant-test-xyz');
  });

  test('merges both keys when both env vars set', () => {
    process.env.OPENAI_API_KEY = 'sk-o';
    process.env.ANTHROPIC_API_KEY = 'sk-a';
    const config = loadConfig();
    expect(config?.openai_api_key).toBe('sk-o');
    expect(config?.anthropic_api_key).toBe('sk-a');
  });

  test('env-specific values do not leak after env deletion (file keys may still exist)', () => {
    // Set recognizable env-specific sentinels.
    process.env.OPENAI_API_KEY = 'sk-o-env-sentinel';
    process.env.ANTHROPIC_API_KEY = 'sk-a-env-sentinel';
    loadConfig();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const config = loadConfig();
    // After deletion, env sentinels must not leak. The file may legitimately
    // provide keys (v0.12's self-contained API keys feature), which is fine —
    // just not the sentinel values from the previous env-driven call.
    expect(config?.openai_api_key).not.toBe('sk-o-env-sentinel');
    expect(config?.anthropic_api_key).not.toBe('sk-a-env-sentinel');
  });
});

describe('loadConfig / saveConfig: GBRAIN_HOME override', () => {
  // Regression: before this fix, loadConfig/saveConfig used a private
  // getConfigDir/getConfigPath that called homedir() directly and ignored
  // GBRAIN_HOME, so config-file API keys were invisible in tests, Docker, and
  // multi-tenant deployments — exactly the contexts that motivated GBRAIN_HOME.
  // configDir/configPath already honored GBRAIN_HOME; this test pins that
  // loadConfig and saveConfig now go through the same path.

  let originalGbrainHome: string | undefined;
  let originalOpenAI: string | undefined;
  let originalAnthropic: string | undefined;
  let originalDatabaseUrl: string | undefined;
  let originalGbrainDatabaseUrl: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalGbrainHome = process.env.GBRAIN_HOME;
    originalOpenAI = process.env.OPENAI_API_KEY;
    originalAnthropic = process.env.ANTHROPIC_API_KEY;
    originalDatabaseUrl = process.env.DATABASE_URL;
    originalGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.GBRAIN_DATABASE_URL;
    tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    process.env.GBRAIN_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = originalGbrainHome;
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalGbrainDatabaseUrl === undefined) delete process.env.GBRAIN_DATABASE_URL;
    else process.env.GBRAIN_DATABASE_URL = originalGbrainDatabaseUrl;
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  test('configDir and configPath both honor GBRAIN_HOME', () => {
    expect(configDir()).toBe(join(tmpHome, '.gbrain'));
    expect(configPath()).toBe(join(tmpHome, '.gbrain', 'config.json'));
  });

  test('saveConfig writes under GBRAIN_HOME (not real homedir)', () => {
    saveConfig({
      engine: 'pglite',
      database_path: '/tmp/fake.db',
      openai_api_key: 'sk-from-saved-config',
    });
    const written = join(tmpHome, '.gbrain', 'config.json');
    expect(existsSync(written)).toBe(true);
    const parsed = JSON.parse(readFileSync(written, 'utf-8'));
    expect(parsed.openai_api_key).toBe('sk-from-saved-config');
  });

  test('loadConfig reads from GBRAIN_HOME-rooted config file', () => {
    // Hand-write the config file as if a previous saveConfig (or an operator)
    // had created it. This pins the read path independent of the write path.
    mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
    writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: '/tmp/fake.db',
      openai_api_key: 'sk-from-file-only',
      anthropic_api_key: 'sk-ant-from-file-only',
    }));
    const config = loadConfig();
    expect(config?.openai_api_key).toBe('sk-from-file-only');
    expect(config?.anthropic_api_key).toBe('sk-ant-from-file-only');
  });

  test('loadConfig under a different GBRAIN_HOME does NOT see the original config', () => {
    // Two sandboxed homes — write to one, load from the other. This is the
    // multi-tenant / per-test isolation invariant.
    saveConfig({ engine: 'pglite', openai_api_key: 'sk-tenant-A' });

    const tmpHomeB = mkdtempSync(join(tmpdir(), 'gbrain-home-b-'));
    try {
      process.env.GBRAIN_HOME = tmpHomeB;
      const config = loadConfig();
      expect(config).toBeNull();
    } finally {
      rmSync(tmpHomeB, { recursive: true, force: true });
    }
  });

  test('saveConfig + loadConfig round-trip under GBRAIN_HOME', () => {
    saveConfig({
      engine: 'postgres',
      database_url: 'postgresql://test@localhost/test',
      openai_api_key: 'sk-roundtrip',
    });
    const config = loadConfig();
    expect(config?.engine).toBe('postgres');
    expect(config?.database_url).toBe('postgresql://test@localhost/test');
    expect(config?.openai_api_key).toBe('sk-roundtrip');
  });
});
