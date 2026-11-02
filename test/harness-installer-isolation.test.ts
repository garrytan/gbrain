import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('installer suites preserve the caller brain-first ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-installer-isolation-')); roots.push(root);
  mkdirSync(join(root, '.gbrain'));
  const ledger = join(root, '.gbrain', 'agent-instructions.json');
  const before = JSON.stringify({ version: 1, entries: [] }) + '\n';
  writeFileSync(ledger, before);
  const child = spawnSync(process.execPath, ['test', '--timeout=60000',
    'test/harness-install-ownership.test.ts',
    'test/shared-skills-adapter.test.ts',
    'test/shared-skills-native-router.test.ts'], {
    cwd: resolve(import.meta.dir, '..'),
    env: { ...process.env, HOME: root, GBRAIN_HOME: root, CODEX_HOME: join(root, '.codex'),
      XDG_CONFIG_HOME: join(root, '.config'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
    encoding: 'utf8', timeout: 60_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stdout + child.stderr).toBe(0);
  expect(readFileSync(ledger, 'utf8')).toBe(before);
}, 65_000);
