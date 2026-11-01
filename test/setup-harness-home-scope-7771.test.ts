import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test('Claude Code setup permits a bootstrap hook target under another HOME', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-scope-'));
  roots.push(root);
  const homeA = join(root, 'home-a');
  const homeB = join(root, 'home-b');
  const brainHome = join(root, 'brain');
  const bin = join(root, 'bin', 'gbrain');
  mkdirSync(homeA, { recursive: true });
  mkdirSync(homeB, { recursive: true });
  mkdirSync(join(brainHome, '.gbrain', 'bootstrap'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  const cli = resolve(import.meta.dir, '..', 'src', 'cli.ts');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${cli}' "$@"\n`);
  chmodSync(bin, 0o755);

  const settingsA = join(homeA, '.claude', 'settings.json');
  const settingsB = join(homeB, '.claude', 'settings.json');
  writeFileSync(join(brainHome, '.gbrain', 'bootstrap', 'harness.json'), JSON.stringify({
    harness_receipt_version: 1,
    created_at: '2026-10-27T00:00:00Z',
    created_by: 'test',
    url: 'http://127.0.0.1:1/mcp',
    source_id: 'default',
    token: { name: 'test', minted: false },
    targets: [{ host: 'claude-code', kind: 'hooks', state: 'confirmed', scope: 'user', path: settingsA, marker: 'bootstrap-harness-v1' }],
  }));

  const result = await runCli(['setup', 'claude-code', '--dry-run', '--json', '--gbrain-bin', bin], {
    env: {
      HOME: homeB,
      GBRAIN_HOME: brainHome,
      CLAUDE_CONFIG_DIR: undefined,
      GBRAIN_SOURCE: undefined,
      GBRAIN_SURFACE: undefined,
      GBRAIN_HOOKS: undefined,
    },
  });
  expect(result.exitCode).toBe(0);
  const doc = JSON.parse(result.stdout);
  expect(doc.target.settings_path).toBe(settingsB);
  expect(doc.steps.find((step: { step: string }) => step.step === 'hooks').action).toBe('write');
}, 15_000);
