import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function runResolveApiKey(homeDir: string, env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--eval',
      `import { resolveApiKey } from './src/core/embedding.ts'; console.log(resolveApiKey() ?? '');`,
    ],
    cwd: '/Users/basitmustafa/Documents/GitHub/upstream/gbrain',
    env: {
      ...process.env,
      HOME: homeDir,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
  };
}

describe('embedding config', () => {
  test('uses config openai_api_key when env var is absent', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'gbrain-config-test-'));
    try {
      mkdirSync(join(homeDir, '.gbrain'), { recursive: true });
      writeFileSync(
        join(homeDir, '.gbrain', 'config.json'),
        JSON.stringify({ engine: 'postgres', openai_api_key: 'config-key' }),
      );

      const result = runResolveApiKey(homeDir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('config-key');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('prefers OPENAI_API_KEY env var over config openai_api_key', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'gbrain-config-test-'));
    try {
      mkdirSync(join(homeDir, '.gbrain'), { recursive: true });
      writeFileSync(
        join(homeDir, '.gbrain', 'config.json'),
        JSON.stringify({ engine: 'postgres', openai_api_key: 'config-key' }),
      );

      const result = runResolveApiKey(homeDir, { OPENAI_API_KEY: 'env-key' });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('env-key');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
