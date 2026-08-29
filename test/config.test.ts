import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { isSensitiveConfigKey, redactConfigValue } from '../src/commands/config.ts';

// URL redaction is single-homed in src/core/url-redact.ts (redactPgUrl —
// drops the whole userinfo, handles BOTH postgres:// and postgresql://);
// config.ts routes through it via redactConfigValue. The old local redactUrl
// duplicate (postgresql://-only) is gone by design.

const configSource = readFileSync(
  new URL('../src/commands/config.ts', import.meta.url),
  'utf-8',
);

describe('redactConfigValue URL redaction (single-homed via redactPgUrl)', () => {
  test('redacts password in postgresql:// URL (whole userinfo collapses)', () => {
    const out = redactConfigValue('database_url', 'postgresql://user:secretpass@host:5432/dbname');
    expect(out).not.toContain('secretpass');
    expect(out).toContain('***@host:5432/dbname');
  });

  test('redacts postgres:// scheme too (the old local regex missed it)', () => {
    const out = redactConfigValue('database_url', 'postgres://user:secretpass@host:5432/dbname');
    expect(out).not.toContain('secretpass');
    expect(out).toContain('***@');
  });

  test('redacts complex passwords with special chars', () => {
    const out = redactConfigValue('database_url', 'postgresql://postgres:p@ss!w0rd#123@db.supabase.co:5432/postgres');
    expect(out).not.toContain('p@ss');
    expect(out).toContain('***');
  });

  test('non-URL, non-sensitive values pass through unchanged', () => {
    expect(redactConfigValue('search.mode', 'hello')).toBe('hello');
    expect(redactConfigValue('search.mode', '')).toBe('');
    expect(redactConfigValue('some_url', 'https://example.com/api')).toBe('https://example.com/api');
  });
});

describe('config source correctness', () => {
  test('the local redactUrl duplicate stays deleted (redaction is single-homed)', () => {
    expect(configSource).not.toContain('function redactUrl');
    expect(configSource).toContain("from '../core/url-redact.ts'");
    expect(configSource).toContain('redactPgUrl');
  });
});

describe('isSensitiveConfigKey (v0.36.x #892 regression)', () => {
  test('matches common sensitive key shapes', () => {
    expect(isSensitiveConfigKey('openai_api_key')).toBe(true);
    expect(isSensitiveConfigKey('anthropic_api_key')).toBe(true);
    expect(isSensitiveConfigKey('openrouter_api_key')).toBe(true);
    expect(isSensitiveConfigKey('voyage_api_key')).toBe(true);
    expect(isSensitiveConfigKey('admin_token')).toBe(true);
    expect(isSensitiveConfigKey('database.password')).toBe(true);
    expect(isSensitiveConfigKey('CLIENT_SECRET')).toBe(true);
    expect(isSensitiveConfigKey('auth')).toBe(true);
    expect(isSensitiveConfigKey('passwd')).toBe(true);
  });

  test('does NOT false-positive on lookalike substrings', () => {
    // Pre-fix `.includes('key')` would have matched 'monkey' and 'parsekey'.
    expect(isSensitiveConfigKey('monkey_id')).toBe(false);
    expect(isSensitiveConfigKey('parsekeyword')).toBe(false);
    expect(isSensitiveConfigKey('tokenize')).toBe(false);
    expect(isSensitiveConfigKey('autocomplete')).toBe(false);
  });

  test('non-sensitive keys pass through', () => {
    expect(isSensitiveConfigKey('search.mode')).toBe(false);
    expect(isSensitiveConfigKey('sync.repo_path')).toBe(false);
    expect(isSensitiveConfigKey('embedding_model')).toBe(false);
  });
});

describe('redactConfigValue (v0.36.x #892 — set output regression)', () => {
  test('redacts sensitive keys to ***', () => {
    expect(redactConfigValue('openai_api_key', 'sk-test-123')).toBe('***');
    expect(redactConfigValue('openrouter_api_key', 'sk-or-test-123')).toBe('***');
    expect(redactConfigValue('admin_token', 'eyJhbGciOiJIUzI1NiJ9')).toBe('***');
  });

  test('redacts postgresql URL passwords regardless of key', () => {
    const out = redactConfigValue('database_url', 'postgresql://u:secret@h:5432/d');
    expect(out).not.toContain('secret');
    expect(out).toBe('postgresql://***@h:5432/d');
  });

  test('non-sensitive values pass through unchanged', () => {
    expect(redactConfigValue('search.mode', 'balanced')).toBe('balanced');
    expect(redactConfigValue('embedding_model', 'voyage:voyage-3-large'))
      .toBe('voyage:voyage-3-large');
  });
});

// v0.36.1.x #1086: loadConfig translates legacy `provider` + `model` to the
// canonical `embedding_model`. Without this, Voyage/Cohere/Mistral configs
// silently fell through to OpenAI.
describe('loadConfig — legacy provider+model migration (v0.36.1.x #1086)', () => {
  test('translates {provider, model} to embedding_model', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { withEnv } = await import('./helpers/with-env.ts');
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cfg-test-'));
    try {
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      writeFileSync(
        join(tmpHome, '.gbrain', 'config.json'),
        JSON.stringify({ engine: 'pglite', database_path: '/tmp/x', provider: 'voyage', model: 'voyage-4-large' }),
      );
      await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
        const { loadConfig } = await import('../src/core/config.ts');
        const cfg = loadConfig();
        expect(cfg).not.toBeNull();
        expect(cfg!.embedding_model).toBe('voyage:voyage-4-large');
        expect((cfg as unknown as Record<string, unknown>).provider).toBeUndefined();
        expect((cfg as unknown as Record<string, unknown>).model).toBeUndefined();
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('canonical embedding_model wins over legacy provider+model when both present', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { withEnv } = await import('./helpers/with-env.ts');
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cfg-test-'));
    try {
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      writeFileSync(
        join(tmpHome, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          database_path: '/tmp/x',
          embedding_model: 'openai:text-embedding-3-large',
          provider: 'voyage',
          model: 'voyage-4-large',
        }),
      );
      await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
        const { loadConfig } = await import('../src/core/config.ts');
        const cfg = loadConfig();
        expect(cfg!.embedding_model).toBe('openai:text-embedding-3-large');
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('config without provider+model is untouched', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { withEnv } = await import('./helpers/with-env.ts');
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cfg-test-'));
    try {
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      writeFileSync(
        join(tmpHome, '.gbrain', 'config.json'),
        JSON.stringify({ engine: 'pglite', database_path: '/tmp/x', embedding_model: 'voyage:voyage-3-large' }),
      );
      await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
        const { loadConfig } = await import('../src/core/config.ts');
        const cfg = loadConfig();
        expect(cfg!.embedding_model).toBe('voyage:voyage-3-large');
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// v0.36.1.x #1019 (cherry-pick #1083): configDir uses path.isAbsolute and
// dual-separator '..' rejection so Windows paths are accepted.
describe('configDir — GBRAIN_HOME Windows path acceptance (v0.36.1.x #1019)', () => {
  test('relative paths are rejected with an absolute-path error', async () => {
    const { withEnv } = await import('./helpers/with-env.ts');
    await withEnv({ GBRAIN_HOME: 'relative/path' }, async () => {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/absolute/);
    });
  });

  test("'..' segments rejected on POSIX-style absolute paths", async () => {
    const { withEnv } = await import('./helpers/with-env.ts');
    await withEnv({ GBRAIN_HOME: '/tmp/foo/../bar' }, async () => {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/'..' segments/);
    });
  });

  test("'..' segments rejected via backslash separator (Windows path shape)", async () => {
    // The dual-separator split is the regression we lock in. On a POSIX
    // host, `path.isAbsolute('C:\\foo')` returns false (no drive letters),
    // so we use a forward-slash-prefixed path that also contains a
    // backslash '..' segment — that's the case where the pre-fix
    // single-separator split would have let it through.
    const { withEnv } = await import('./helpers/with-env.ts');
    await withEnv({ GBRAIN_HOME: '/tmp/foo\\..\\bar' }, async () => {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/'..' segments/);
    });
  });
});

// v0.42 (#1699): content_sanity.max_markup_ratio env parsing.
describe('loadConfig — GBRAIN_MAX_MARKUP_RATIO env (v0.42 #1699)', () => {
  async function withHomeAndEnv(env: Record<string, string | undefined>, fn: (cfg: unknown) => void) {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { withEnv } = await import('./helpers/with-env.ts');
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cfg-mk-'));
    try {
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: '/tmp/x' }));
      await withEnv({ GBRAIN_HOME: tmpHome, ...env }, async () => {
        const { loadConfig } = await import('../src/core/config.ts');
        fn(loadConfig());
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }

  test('valid ratio in (0,1] is parsed onto content_sanity', async () => {
    await withHomeAndEnv({ GBRAIN_MAX_MARKUP_RATIO: '0.7' }, (cfg) => {
      expect((cfg as { content_sanity?: { max_markup_ratio?: number } }).content_sanity?.max_markup_ratio).toBe(0.7);
    });
  });

  test('out-of-range value (>1) is ignored', async () => {
    await withHomeAndEnv({ GBRAIN_MAX_MARKUP_RATIO: '1.5' }, (cfg) => {
      expect((cfg as { content_sanity?: { max_markup_ratio?: number } }).content_sanity?.max_markup_ratio).toBeUndefined();
    });
  });
});

describe('KNOWN_CONFIG_KEYS — documented enable commands must be registered', () => {
  test('Life Chronicle keys are registered (v0.42.56.0 release notes say `config set auto_chronicle true`)', async () => {
    const { KNOWN_CONFIG_KEYS, KNOWN_CONFIG_KEY_PREFIXES } = await import('../src/core/config.ts');
    // The flag the chronicle backstop reads (isAutoChronicleEnabled).
    expect(KNOWN_CONFIG_KEYS).toContain('auto_chronicle');
    // The takes bootstrap two-gate consent flag (v0.41.18.0 A12).
    expect(KNOWN_CONFIG_KEYS).toContain('takes.bootstrap_enabled');
    // chronicle.tz (chronicleTz) + future chronicle.* knobs.
    expect(KNOWN_CONFIG_KEY_PREFIXES.some(p => 'chronicle.tz'.startsWith(p))).toBe(true);
  });
});
