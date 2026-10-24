import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('unit census counts passing files in agent environments and retains failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'unit-agent-output-'));
  try {
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    mkdirSync(join(root, 'test'));
    for (const file of ['run-unit-shard.sh', 'lib/test-env.sh']) {
      copyFileSync(resolve(import.meta.dir, '../../scripts', file), join(root, 'scripts', file));
    }
    writeFileSync(join(root, 'test/pass.test.ts'),
      "import { test, expect } from 'bun:test'; test('passes', () => expect(1).toBe(1));\n");
    writeFileSync(join(root, 'test/fail.test.ts'),
      "import { test, expect } from 'bun:test'; test('fails', () => expect(1).toBe(2));\n");

    for (const agent of [{ CLAUDECODE: '1' }, { REPL_ID: 'test' }, { AGENT: '1' }]) {
      const env = { ...process.env };
      for (const key of ['AGENT', 'CLAUDECODE', 'REPL_ID', 'SHARD',
        'GBRAIN_TEST_RECEIPT_DIR', 'GBRAIN_TEST_RECEIPT_LANE']) delete env[key];
      Object.assign(env, agent);
      for (const verdict of ['pass', 'fail']) {
        const result = spawnSync('bash', ['scripts/run-unit-shard.sh', `test/${verdict}.test.ts`], {
          cwd: root, env, encoding: 'utf8', timeout: 15_000,
        });
        const output = result.stdout + result.stderr;
        expect(result.error).toBeUndefined();
        expect(output).toContain(`complete=1 pass=${verdict === 'pass' ? 1 : 0} fail=${verdict === 'fail' ? 1 : 0}`);
        expect(result.status).toBe(verdict === 'pass' ? 0 : 1);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
