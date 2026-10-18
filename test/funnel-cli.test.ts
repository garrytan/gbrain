/**
 * D8 adoption funnel from the real CLI: `gbrain status --funnel` runs before
 * any brain exists, `gbrain init` on a fresh home counts one clean install once
 * recording is on, and a home that never turned it on gets no funnel file.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '..');
const root = mkdtempSync(join(tmpdir(), 'gbrain-funnel-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function gbrain(home: string, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, '--no-env-file', join(repo, 'src', 'cli.ts'), ...args], {
    env: { ...process.env, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '', OPENAI_API_KEY: '', VOYAGE_API_KEY: '' },
    stdout: 'pipe', stderr: 'pipe',
  });
  return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
}
const INIT = ['init', '--pglite', '--no-embedding', '--non-interactive'];

test('enabled before init: status --funnel works with no brain, and init counts one clean install', () => {
  const home = join(root, 'on');
  const off = gbrain(home, 'status', '--funnel', '--json');
  expect(off.code).toBe(0);
  expect(JSON.parse(off.out).enabled).toBe(false);
  expect(existsSync(join(home, '.gbrain', 'funnel.jsonl'))).toBe(false);
  expect(gbrain(home, 'status', '--funnel', '--enable').code).toBe(0);
  const init = gbrain(home, ...INIT);
  expect(init.code).toBe(0);
  expect(gbrain(home, ...INIT).code).toBe(0);
  const report = JSON.parse(gbrain(home, 'status', '--funnel', '--json').out);
  expect(report.enabled).toBe(true);
  expect(report.stages[0]).toMatchObject({ stage: 'clean_install', count: 1 });
}, 120_000);

test('never enabled: init writes no funnel file', () => {
  const home = join(root, 'off');
  expect(gbrain(home, ...INIT).code).toBe(0);
  expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(true);
  expect(existsSync(join(home, '.gbrain', 'funnel.jsonl'))).toBe(false);
}, 120_000);
