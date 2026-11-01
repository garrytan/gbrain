import { describe, test, expect } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSide, loadReceiptDir } from '../../scripts/ci-executed-counts.ts';

const REPO = join(import.meta.dir, '../..');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-with-receipt-'));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, 'test'));
  copyFileSync(join(REPO, 'scripts/run-with-receipt.sh'), join(root, 'scripts/run-with-receipt.sh'));
  copyFileSync(join(REPO, 'scripts/lib/test-env.sh'), join(root, 'scripts/lib/test-env.sh'));
  // Receipt variables are consumed by the wrapper; the test process must never see them.
  writeFileSync(join(root, 'test/a.test.ts'), `import { describe, test, expect } from 'bun:test';
describe('wrapped', () => {
  test('hides receipt routing', () => {
    expect(process.env.GBRAIN_TEST_RECEIPT_DIR).toBeUndefined();
    expect(process.env.GBRAIN_TEST_RECEIPT_LANE).toBeUndefined();
  });
  test.skip('optional', () => {});
});`);
  return root;
}
const run = (root: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', ['scripts/run-with-receipt.sh', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GBRAIN_NO_SNAPSHOT: '1', ...env } });

describe('run-with-receipt.sh', () => {
  test('records lane, files, exit and the native JUnit report for one bun invocation', () => {
    const root = sandbox();
    try {
      const receipts = join(root, 'receipts');
      const r = run(root, ['slow', 'perf-a', '--', 'bun', 'test', 'test/a.test.ts', '--timeout=60000'], { GBRAIN_TEST_RECEIPT_DIR: receipts });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(readdirSync(receipts).sort()).toEqual(['slow--perf-a--primary.files', 'slow--perf-a--primary.junit.xml', 'slow--perf-a--primary.receipt']);
      const meta = readFileSync(join(receipts, 'slow--perf-a--primary.receipt'), 'utf8');
      expect(meta).toContain('lane=slow\n');
      expect(meta).toContain('exit=0\n');
      const side = buildSide('local', loadReceiptDir(receipts));
      expect(side.issues).toEqual([]);
      expect([...side.identities.values()].map(i => [i.test, i.status])).toEqual([['wrapped > hides receipt routing', 'pass'], ['wrapped > optional', 'skip']]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('runs the command unchanged without a receipt directory and refuses a missing --timeout', () => {
    const root = sandbox();
    try {
      const plain = run(root, ['slow', 'perf-a', '--', 'bun', 'test', '--timeout=60000', 'test/a.test.ts']);
      expect(plain.status, plain.stdout + plain.stderr).toBe(0);
      expect(readdirSync(root).includes('receipts')).toBe(false);
      const bare = run(root, ['slow', 'perf-a', '--', 'bun', 'test', 'test/a.test.ts']);
      expect(bare.status).toBe(2);
      expect(bare.stderr).toContain('pass an explicit --timeout');
      expect(run(root, ['slow', '--', 'bun', 'test']).status).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('passes the bun flag --no-env-file through and still records the receipt', () => {
    const root = sandbox();
    try {
      const receipts = join(root, 'receipts');
      const r = run(root, ['reconciliation', 'pglite', '--', 'bun', '--no-env-file', 'test', '--timeout=60000', 'test/a.test.ts'], { GBRAIN_TEST_RECEIPT_DIR: receipts });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const side = buildSide('local', loadReceiptDir(receipts));
      expect(side.issues).toEqual([]);
      expect([...side.identities.values()].map(i => [i.lane, i.file, i.status])).toEqual([['reconciliation', 'test/a.test.ts', 'pass'], ['reconciliation', 'test/a.test.ts', 'skip']]);
      expect(run(root, ['slow', 'perf-a', '--', 'bun', '--no-env-file', 'test']).status).toBe(2);
      expect(run(root, ['slow', 'perf-a', '--', 'bun', '--no-env-file', 'x', '--timeout=60000', 'test/a.test.ts']).status).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
