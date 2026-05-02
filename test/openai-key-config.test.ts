import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readOpenAIApiKeyFile, resolveOpenAIApiKey } from '../src/core/config.ts';

const savedEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_KEY_FILE: process.env.OPENAI_API_KEY_FILE,
  GBRAIN_HOME: process.env.GBRAIN_HOME,
};

let tmp: string | null = null;

function restoreEnv(key: keyof typeof savedEnv) {
  const value = savedEnv[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tmp = null;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY_FILE;
  delete process.env.GBRAIN_HOME;
});

afterEach(() => {
  restoreEnv('OPENAI_API_KEY');
  restoreEnv('OPENAI_API_KEY_FILE');
  restoreEnv('GBRAIN_HOME');
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeTmpDir(): string {
  tmp = tmp || mkdtempSync(join(tmpdir(), 'gbrain-openai-key-'));
  return tmp;
}

describe('OpenAI API key file support', () => {
  test('reads raw key files', () => {
    const dir = makeTmpDir();
    const keyFile = join(dir, 'openai-key');
    writeFileSync(keyFile, 'sk-test-raw\n');

    expect(readOpenAIApiKeyFile(keyFile)).toBe('sk-test-raw');
  });

  test('reads env-style key files without mutating process.env', () => {
    const dir = makeTmpDir();
    const keyFile = join(dir, 'openai-key.env');
    writeFileSync(keyFile, '# local key\nexport OPENAI_API_KEY="sk-test-env-file"\n');

    process.env.OPENAI_API_KEY_FILE = keyFile;

    expect(resolveOpenAIApiKey()).toBe('sk-test-env-file');
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  test('uses OPENAI_API_KEY before OPENAI_API_KEY_FILE for compatibility', () => {
    const dir = makeTmpDir();
    const keyFile = join(dir, 'openai-key.env');
    writeFileSync(keyFile, 'OPENAI_API_KEY=sk-test-file\n');

    process.env.OPENAI_API_KEY = 'sk-test-env';
    process.env.OPENAI_API_KEY_FILE = keyFile;

    expect(resolveOpenAIApiKey()).toBe('sk-test-env');
  });

  test('uses config openai_api_key_file when env vars are absent', () => {
    const dir = makeTmpDir();
    const gbrainDir = join(dir, '.gbrain');
    const keyFile = join(dir, 'openai-key.env');
    mkdirSync(gbrainDir, { recursive: true });
    writeFileSync(keyFile, "OPENAI_API_KEY='sk-test-config-file'\n");
    writeFileSync(join(gbrainDir, 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: join(dir, 'brain.pglite'),
      openai_api_key_file: keyFile,
    }));

    process.env.GBRAIN_HOME = dir;

    expect(resolveOpenAIApiKey()).toBe('sk-test-config-file');
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});
