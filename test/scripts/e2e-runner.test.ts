import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = join(import.meta.dir, '../..');
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-e2e-runner-'));
  for (const dir of ['scripts/lib', 'test/e2e', 'bin']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['run-e2e.sh', 'sharding.ts', 'lib/test-env.sh']) copyFileSync(join(repo, 'scripts', file), join(root, 'scripts', file));
  for (const name of ['a', 'b']) writeFileSync(join(root, `test/e2e/${name}.test.ts`), `import {test,expect} from 'bun:test'; test('isolated routing',()=>{ expect(process.env.SHARD).toBeUndefined(); expect(process.env.COVERAGE_DIR ?? '').toBe(''); });`);
  return root;
}
const env = { ...process.env, GBRAIN_NO_SNAPSHOT: '1', DATABASE_URL: '', GBRAIN_DATABASE_URL: '', SHARD: '', COVERAGE_DIR: '' };
function run(root: string, args: string[], shard = '') {
  return spawnSync('bash', ['scripts/run-e2e.sh', ...args], { cwd: root, encoding: 'utf8', env: { ...env, SHARD: shard } });
}
describe('sequential E2E runner', () => {
  test('weighted shards cover exactly the explicit input; empty shards launch nothing', () => {
    const root = setup();
    try {
      const files = ['test/e2e/a.test.ts', 'test/e2e/b.test.ts'];
      const selected = [1, 2, 3].flatMap(n => {
        const r = run(root, ['--dry-run-list', ...files], `${n}/3`);
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim().split('\n').filter(Boolean);
      });
      expect(selected.sort()).toEqual(files);
      expect(run(root, files, '3/3').stdout).toContain('No files for shard 3/3');
      for (const bad of ['2', '0/2', '3/2', '1/0', '1/2x', '1/2/3']) expect(run(root, files, bad).status).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('runs each file and preserves an assertion failure in the final status', () => {
    const root = setup();
    try {
      const files = ['test/e2e/a.test.ts', 'test/e2e/b.test.ts'];
      const good = run(root, files, '1/1');
      expect(good.status, good.stderr + good.stdout).toBe(0);
      expect(good.stdout).toContain('Files: 2 total, 2 passed, 0 failed');
      writeFileSync(join(root, files[0]), "import {test,expect} from 'bun:test';test('failure',()=>expect(1).toBe(2));");
      const bad = run(root, files);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain('Files: 2 total, 1 passed, 1 failed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('cancellation terminates its owned interrupt-resistant child', async () => {
    const root = setup();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let pid: number | undefined;
    try {
      const fake = join(root, 'bin/bun');
      writeFileSync(fake, `#!/usr/bin/env bash\necho $$ > '${join(root, 'child.pid')}'\ntrap '' INT TERM\nwhile true; do sleep 1; done\n`);
      chmodSync(fake, 0o755);
      child = Bun.spawn(['bash', 'scripts/run-e2e.sh', 'test/e2e/a.test.ts'], { cwd: root, env: { ...env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, stdout: 'ignore', stderr: 'ignore' });
      const deadline = Date.now() + 5000;
      while (!existsSync(join(root, 'child.pid')) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(join(root, 'child.pid'))).toBe(true);
      pid = Number(readFileSync(join(root, 'child.pid'), 'utf8').trim());
      child.kill('SIGTERM');
      expect(await child.exited).toBe(143);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      child?.kill();
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
});
