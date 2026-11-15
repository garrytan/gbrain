import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-hosted-resolver-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, 'home');
const bin = join(root, 'bin', 'gbrain');
mkdirSync(home, { recursive: true });
mkdirSync(join(root, 'bin'));
writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
chmodSync(bin, 0o755);
mkdirSync(join(home, '.claude', 'skills', 'demo'), { recursive: true });
writeFileSync(join(home, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: a demo skill\n---\nbody\n');
writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: { type: 'http', url: 'https://brain.example.test/mcp', headers: { Authorization: 'Bearer x' } } } }));
writeFileSync(join(home, '.gbrain-connection-claude-code-gbrain.json'), JSON.stringify({ client_id: 'client-a', mcp_url: 'https://brain.example.test/mcp', status: 'installed', harness: 'claude-code' }));

const setup = (args: string[]) => runCli(['setup', 'claude-code', ...args, '--gbrain-bin', bin, '--json'], {
  env: { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, HOME: home, GBRAIN_HOME: home },
});

describe('#9245: a hosted install asking for the skill resolver is told the setup path that works', () => {
  test('the refusal names --skills-index-only --skill-loading resolve, and that command runs', async () => {
    const refused = await setup(['--skill-loading', 'resolve', '--dry-run']);
    expect(refused.exitCode).toBe(1);
    const doc = JSON.parse(refused.stdout);
    expect(doc.code).toBe('setup_hosted_connection');
    expect(JSON.stringify(doc)).toContain('gbrain setup claude-code --skills-index-only --skill-loading resolve');
    const named = await setup(['--skills-index-only', '--skill-loading', 'resolve', '--dry-run']);
    expect(named.exitCode).toBe(0);
    expect(JSON.parse(named.stdout).skill_resolver.steps.map((s: { step: string }) => s.step)).toContain('catalog');
  }, 60_000);
});
