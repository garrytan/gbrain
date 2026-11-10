/**
 * GST-363 (PR 2): doctor shared_stdio_binding. config mcp.stdio_member binds every stdio session on the host to one
 * member, so on a host where a harness several people talk to (OpenClaw, Hermes; sharedStdioHarness) is installed,
 * that harness reads as that member, private pages included. The check fails there with the unset command as its
 * fix, passes when no shared harness is installed, and is not applicable while the key is unset. Repo-less PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sharedStdioBindingEntry } from '../src/commands/doctor/checks/shared-stdio-binding.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { withEnv } from './helpers/with-env.ts';

describe('doctor shared_stdio_binding (pglite, repo-less)', () => {
  let engine: BrainEngine;
  let home: string;
  const doctor = (env: Record<string, string | undefined> = {}) => withEnv({ HOME: home, GBRAIN_HOME: home, PATH: '', OPENCLAW_STATE_DIR: undefined, OPENCLAW_PROFILE: undefined, HERMES_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: join(home, '.codex'), ...env },
    async () => (await sharedStdioBindingEntry.run({ engine } as unknown as DoctorContext) as Array<Record<string, any>>)[0]!);
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-shared-stdio-'));
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);

  test('not applicable while mcp.stdio_member is unset, even with a shared harness installed', async () => {
    const hermes = join(home, 'hermes-unset'); mkdirSync(hermes);
    expect(await doctor({ HERMES_HOME: hermes })).toMatchObject({ name: 'shared_stdio_binding', status: 'ok', readiness_state: 'not_applicable' });
  });

  test('set with no shared harness on the host: ok', async () => {
    await engine.setConfig('mcp.stdio_member', 'alice-example');
    const c = await doctor();
    expect(c).toMatchObject({ name: 'shared_stdio_binding', status: 'ok' });
    expect(c.fix).toBeUndefined();
    await engine.unsetConfig('mcp.stdio_member');
  });

  test('set with Hermes or OpenClaw installed: fails, naming the harness and the member, with the unset command as the fix', async () => {
    await engine.setConfig('mcp.stdio_member', 'alice-example');
    const hermes = join(home, 'hermes'); mkdirSync(hermes);
    const viaHermes = await doctor({ HERMES_HOME: hermes });
    expect(viaHermes).toMatchObject({ name: 'shared_stdio_binding', status: 'fail', fix: { argv: ['gbrain', 'config', 'unset', 'mcp.stdio_member'], ask_user: true } });
    expect(viaHermes.message).toContain('Hermes');
    expect(viaHermes.message).toContain('alice-example');
    const openclaw = join(home, 'openclaw-state'); mkdirSync(openclaw);
    const viaOpenClaw = await doctor({ OPENCLAW_STATE_DIR: openclaw });
    expect(viaOpenClaw).toMatchObject({ status: 'fail', fix: { argv: ['gbrain', 'config', 'unset', 'mcp.stdio_member'] } });
    expect(viaOpenClaw.message).toContain('OpenClaw');
    expect(JSON.stringify([viaHermes, viaOpenClaw])).not.toContain('config set mcp.stdio_member');
    await engine.unsetConfig('mcp.stdio_member');
  });

  test('GST-363: a claude-code or codex entry that starts serve --stdio-member is ok alone and fails beside OpenClaw or Hermes, with --no-stdio-member as the fix', async () => {
    const serve = (member?: string) => ({ command: '/x/gbrain-launcher', args: ['/x/gbrain', 'serve', '--surface', 'starter', ...(member ? ['--stdio-member', member] : [])] });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: serve() } }));
    expect(await doctor()).toMatchObject({ status: 'ok', readiness_state: 'not_applicable' });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: serve('alice-example') } }));
    const alone = await doctor();
    expect(alone).toMatchObject({ status: 'ok', details: { stdio_member: null, bound_entries: [{ harness: 'claude-code', name: 'gbrain', member: 'alice-example' }] } });
    expect(alone.fix).toBeUndefined();
    const hermes = join(home, 'hermes-entry'); mkdirSync(hermes);
    const shared = await doctor({ HERMES_HOME: hermes });
    expect(shared).toMatchObject({ status: 'fail', fix: { argv: ['gbrain', 'setup', 'claude-code', '--no-stdio-member'], ask_user: true } });
    expect(shared.message).toContain('starts serve --stdio-member alice-example');
    expect(shared.message).toContain('Hermes');
    rmSync(join(home, '.claude.json'));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.gbrain]\ncommand = "/x/gbrain-launcher"\nargs = ["/x/gbrain", "serve", "--stdio-member", "bob-example"]\n');
    const openclaw = join(home, 'openclaw-entry'); mkdirSync(openclaw);
    const codex = await doctor({ OPENCLAW_STATE_DIR: openclaw });
    expect(codex).toMatchObject({ status: 'fail', fix: { argv: ['gbrain', 'setup', 'codex', '--no-stdio-member'] } });
    expect(codex.message).toContain('bob-example');
    await engine.setConfig('mcp.stdio_member', 'alice-example');
    expect((await doctor({ OPENCLAW_STATE_DIR: openclaw })).fix.argv).toEqual(['gbrain', 'config', 'unset', 'mcp.stdio_member']);
    await engine.unsetConfig('mcp.stdio_member');
    rmSync(join(home, '.codex'), { recursive: true, force: true });
  });
});
