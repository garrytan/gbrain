import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import type { HarnessTarget } from '../src/core/bootstrap/format.ts';
import { VERSION } from '../src/version.ts';

// #7771: one gbrain install (one GBRAIN_HOME) can serve two Claude Code or
// Codex configurations under different HOMEs. The bootstrap harness lane is
// an owner conflict for `gbrain setup` only when it wired the configuration
// setup is about to wire (or a project, which every configuration loads).

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function box() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-lane-7771-'));
  roots.push(root);
  const home = join(root, 'home-b'); const other = join(root, 'home-a');
  mkdirSync(home, { recursive: true }); mkdirSync(other, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  mkdirSync(join(root, 'bin'));
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, other, gbrainHome: join(root, 'gbrain-home'), bin };
}
type Box = ReturnType<typeof box>;

function writeHarnessReceipt(b: Box, targets: Array<Omit<HarnessTarget, 'state'>>) {
  const dir = join(b.gbrainHome, '.gbrain', 'bootstrap');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({
    harness_receipt_version: 1, created_at: new Date().toISOString(), created_by: `gbrain@${VERSION}`,
    url: 'http://192.0.2.1:9/mcp', source_id: 'default', token: { name: 'bootstrap-harness', minted: false },
    targets: targets.map((t) => ({ state: 'confirmed', ...t })),
  }));
}

const claudeTargets = (home: string, hooksScope = 'user', hooksPath = join(home, '.claude', 'settings.json')): Array<Omit<HarnessTarget, 'state'>> => [
  { host: 'claude-code', kind: 'mcp', scope: 'user', name: 'gbrain', mechanism: 'claude-cli' },
  { host: 'claude-code', kind: 'permission', scope: 'user', path: join(home, '.claude', 'settings.json'), entry: 'mcp__gbrain' },
  { host: 'claude-code', kind: 'hooks', scope: hooksScope, path: hooksPath, marker: 'bootstrap-v1' },
];
const codexTargets = (home: string): Array<Omit<HarnessTarget, 'state'>> => [
  { host: 'codex', kind: 'mcp', scope: 'user', path: join(home, '.codex', 'config.toml'), name: 'gbrain', mechanism: 'toml-block' },
];

async function setup(b: Box, args: string[]) {
  const r = await runCli(['setup', ...args, '--dry-run', '--json', '--gbrain-bin', b.bin], {
    env: { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, HOME: b.home, GBRAIN_HOME: b.gbrainHome },
  });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}

describe('setup: bootstrap harness lane scoped to the configuration it wired (#7771)', () => {
  test('claude-code: a harness lane wired under another HOME does not block setup', async () => {
    const b = box();
    writeHarnessReceipt(b, claudeTargets(b.other));
    const r = await setup(b, ['claude-code']);
    expect(r.doc?.reason).not.toBe('harness_lane');
    expect(r.exitCode).toBe(0);
  });

  test('claude-code: a harness lane wired in this HOME still refuses', async () => {
    const b = box();
    writeHarnessReceipt(b, claudeTargets(b.home));
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(1);
    expect(r.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'harness_lane' });
  });

  test('claude-code: project-scoped harness hooks refuse from any HOME (every configuration loads a project)', async () => {
    const b = box();
    writeHarnessReceipt(b, claudeTargets(b.other, join(b.root, 'project'), join(b.root, 'project', '.claude', 'settings.json')));
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(1);
    expect(r.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'harness_lane' });
  });

  test('claude-code: a receipt whose targets record no paths still refuses', async () => {
    const b = box();
    writeHarnessReceipt(b, [{ host: 'claude-code', kind: 'mcp', scope: 'user', name: 'gbrain', mechanism: 'claude-cli' }]);
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(1);
    expect(r.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'harness_lane' });
  });

  test('codex: a harness lane wired under another CODEX_HOME does not block setup; the same one refuses', async () => {
    const elsewhere = box();
    writeHarnessReceipt(elsewhere, codexTargets(elsewhere.other));
    const ok = await setup(elsewhere, ['codex']);
    expect(ok.doc?.reason).not.toBe('harness_lane');
    expect(ok.exitCode).toBe(0);
    const same = box();
    writeHarnessReceipt(same, codexTargets(same.home));
    const refused = await setup(same, ['codex']);
    expect(refused.exitCode).toBe(1);
    expect(refused.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'harness_lane' });
  });
});
