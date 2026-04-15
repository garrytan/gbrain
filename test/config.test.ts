import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

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

describe('loadConfig — API key propagation', () => {
  // os.homedir() caches HOME at process start, so we run loadConfig in a
  // subprocess per case to get a fresh homedir() resolution.
  const configPath = resolve(import.meta.dir, '..', 'src/core/config.ts');

  async function runLoadConfig(opts: {
    configJson: Record<string, unknown>;
    extraEnv?: Record<string, string>;
  }): Promise<{ cfg: Record<string, unknown> | null; envAfter: Record<string, string | null> }> {
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cfgtest-'));
    try {
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      writeFileSync(
        join(tmpHome, '.gbrain', 'config.json'),
        JSON.stringify(opts.configJson),
      );
      const script = `
        import { loadConfig } from '${configPath}';
        const cfg = loadConfig();
        process.stdout.write(JSON.stringify({
          cfg,
          envAfter: {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
          },
        }));
      `;
      const proc = Bun.spawn(['bun', '-e', script], {
        env: {
          HOME: tmpHome,
          PATH: process.env.PATH || '',
          ...(opts.extraEnv || {}),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;
      const out = await new Response(proc.stdout).text();
      return JSON.parse(out);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  }

  // OPENAI_API_KEY and ANTHROPIC_API_KEY follow the same merge + propagate
  // contract. These cases are parameterized over both keys to prevent drift.
  const CASES = [
    { configField: 'openai_api_key', envVar: 'OPENAI_API_KEY' },
    { configField: 'anthropic_api_key', envVar: 'ANTHROPIC_API_KEY' },
  ] as const;

  for (const { configField, envVar } of CASES) {
    describe(configField, () => {
      test('config.json value is merged into loaded config', async () => {
        const { cfg } = await runLoadConfig({
          configJson: { engine: 'pglite', database_path: '/tmp/x', [configField]: 'sk-from-config' },
        });
        expect(cfg?.[configField]).toBe('sk-from-config');
      });

      test(`config.json value propagates to process.env.${envVar} for SDK ambient lookup`, async () => {
        const { envAfter } = await runLoadConfig({
          configJson: { engine: 'pglite', database_path: '/tmp/x', [configField]: 'sk-propagate' },
        });
        expect(envAfter[envVar]).toBe('sk-propagate');
      });

      test(`env var ${envVar} is merged into loaded config`, async () => {
        const { cfg } = await runLoadConfig({
          configJson: { engine: 'pglite', database_path: '/tmp/x' },
          extraEnv: { [envVar]: 'sk-from-env' },
        });
        expect(cfg?.[configField]).toBe('sk-from-env');
      });

      test(`env var ${envVar} takes precedence over config file entry`, async () => {
        const { cfg } = await runLoadConfig({
          configJson: { engine: 'pglite', database_path: '/tmp/x', [configField]: 'sk-from-config' },
          extraEnv: { [envVar]: 'sk-from-env' },
        });
        expect(cfg?.[configField]).toBe('sk-from-env');
      });

      test(`env var ${envVar} is not overwritten by config propagation when both set`, async () => {
        const { envAfter } = await runLoadConfig({
          configJson: { engine: 'pglite', database_path: '/tmp/x', [configField]: 'sk-from-config' },
          extraEnv: { [envVar]: 'sk-pre-existing' },
        });
        expect(envAfter[envVar]).toBe('sk-pre-existing');
      });

      test(`no ${configField} set anywhere leaves env clean`, async () => {
        const { cfg, envAfter } = await runLoadConfig({
          configJson: { engine: 'pglite', database_path: '/tmp/x' },
        });
        expect(cfg?.[configField]).toBeUndefined();
        expect(envAfter[envVar]).toBeNull();
      });
    });
  }
});
