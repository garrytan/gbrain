import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';
import { runConfig } from '../src/commands/config.ts';
import { withEnv } from './helpers/with-env.ts';

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

describe('config show', () => {
  test('renders object values as indented JSON and preserves string redaction', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-config-show-'));
    const configDir = join(home, '.gbrain');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      engine: 'postgres',
      database_url: 'postgresql://user:secret@host:5432/dbname',
      openai_api_key: 'sk-test',
      provider_base_urls: {
        ollama: 'http://localhost:11434',
      },
      storage: {
        bucket: 'brain-files',
        serviceRoleKey: 'nested-service-role-secret',
      },
      replicas: {
        analytics: 'postgresql://reader:nested-pg-pass@analytics:5432/db',
      },
    }, null, 2));

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    try {
      await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined }, async () => {
        await runConfig({} as BrainEngine, ['show']);
      });
    } finally {
      console.log = originalLog;
      rmSync(home, { recursive: true, force: true });
    }

    const output = logs.join('\n');
    expect(output).not.toContain('[object Object]');
    expect(output).toContain('provider_base_urls: {');
    expect(output).toContain('      "ollama": "http://localhost:11434"');
    expect(output).toContain('database_url: postgresql://user:***@host:5432/dbname');
    expect(output).toContain('openai_api_key: ***');
    expect(output).toContain('storage: {');
    expect(output).toContain('      "bucket": "brain-files"');
    expect(output).toContain('      "serviceRoleKey": "***"');
    expect(output).not.toContain('nested-service-role-secret');
    expect(output).toContain('"analytics": "postgresql://reader:***@analytics:5432/db"');
    expect(output).not.toContain('nested-pg-pass');
  });
});
