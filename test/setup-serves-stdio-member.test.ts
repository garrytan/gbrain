/**
 * GST-363: gbrain setup --stdio-member, spawned against a temp HOME / GBRAIN_HOME (PGLite). Split from
 * test/setup-serves-several.test.ts; the box and readers are in test/helpers/setup-serves-box.ts.
 *
 * 1. Protects: --stdio-member refuses an unknown member, a harness other than claude-code and codex, --instructions-only,
 *    --no-stdio-member beside it, and a host with OpenClaw or Hermes, writing nothing; codex keeps an entry member on a
 *    bare re-run and --no-stdio-member removes it; a plugin-served harness and serve on a shared host refuse the flag.
 * 2. Fails when: a refused run writes an entry or mcp.stdio_member, or a re-run drops or adds --stdio-member.
 * 3. Existing coverage: test/setup-serves-several.test.ts (labelling), test/setup-serves-upgrade.test.ts (upgrade paths).
 * 4. Real seams: `bun src/cli.ts setup` and `serve` spawned against a temp HOME / GBRAIN_HOME.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brainWithPages, box, fakeOpenclaw, gbrain, removeTempDirs, ROSTER, setup, stdioKey } from './helpers/setup-serves-box.ts';

afterAll(removeTempDirs);

describe('gbrain setup --serves (spawned, PGLite)', () => {
  test('--stdio-member refuses an unknown member, off claude-code and codex, with --instructions-only or --no-stdio-member, and on a host with OpenClaw or Hermes; nothing is written', async () => {
    const b = box();
    await brainWithPages(b);
    for (const m of ROSTER) expect((await gbrain(b, ['access', 'member', 'add', m])).exitCode).toBe(0);
    expect((await gbrain(b, ['access', 'owner', 'set', 'alice-example'])).exitCode).toBe(0);
    const workspace = join(b.root, 'oc-workspace');
    mkdirSync(workspace);
    expect(existsSync(join(b.root, 'openclaw-state'))).toBe(false);
    const refusals: Array<[string[], string, Record<string, string>]> = [
      [['openclaw', '--serves', 'several', '--members', ROSTER.join(','), '--workspace', workspace, '--stdio-member', 'alice-example'], 'claude-code or codex', {}],
      [['claude-code', '--instructions-only', '--serves', 'several', '--stdio-member', 'alice-example'], 'claude-code or codex', {}],
      [['claude-code', '--stdio-member', 'alice-example', '--no-stdio-member'], 'not both', {}],
      [['claude-code', '--stdio-member', 'Alice Example'], 'needs a member id', {}],
      [['claude-code', '--stdio-member', 'alice-example'], 'OpenClaw is installed on this host', { PATH: `${fakeOpenclaw(b)}:${process.env.PATH}` }],
      [['codex', '--serves', 'several', '--members', ROSTER.join(','), '--stdio-member', 'alice-example'], 'Hermes is installed on this host', { HERMES_HOME: b.root }],
    ];
    for (const [args, says, env] of refusals) {
      const r = await gbrain(b, ['setup', ...args, '--gbrain-bin', b.bin], env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(says);
      if (says.endsWith('on this host')) expect(r.stderr).toContain('gbrain auth create <name> --member <id>');
      expect(await stdioKey(b)).toBe('');
      expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    }
    const unknown = await setup(b, ['claude-code', '--stdio-member', 'carol-example', '--json']);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stdout).toContain('not an enabled member of this brain');
    expect(unknown.stdout).toContain('alice-example, bob-example');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
    const labelled = await setup(b, ['openclaw', '--serves', 'several', '--members', ROSTER.join(','), '--workspace', workspace]);
    expect(labelled.stdout + labelled.stderr).not.toContain('reads as alice-example');
    expect(await stdioKey(b)).toBe('');
  }, 360_000);

  test('codex keeps an entry member on a bare re-run and --no-stdio-member removes it on a several-person brain; a plugin-served harness and serve on a shared host refuse the flag', async () => {
    const b = box();
    await brainWithPages(b);
    for (const m of ROSTER) expect((await gbrain(b, ['access', 'member', 'add', m])).exitCode).toBe(0);
    const codexArgs = () => (Bun.TOML.parse(readFileSync(join(b.home, '.codex', 'config.toml'), 'utf8')) as any).mcp_servers.gbrain.args as string[];
    expect((await setup(b, ['codex', '--stdio-member', 'alice-example'])).exitCode).toBe(0);
    expect(codexArgs().slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    const rerun = await setup(b, ['codex', '--json']);
    expect(rerun.exitCode).toBe(0);
    expect(rerun.doc.serves.stdio).toMatchObject({ member: 'alice-example', action: 'keep' });
    expect(codexArgs().slice(-2)).toEqual(['--stdio-member', 'alice-example']);
    const removed = await setup(b, ['codex', '--no-stdio-member', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.serves.stdio).toMatchObject({ member: null, action: 'remove' });
    expect(codexArgs()).not.toContain('--stdio-member');
    expect(await stdioKey(b)).toBe('');

    mkdirSync(join(b.home, '.claude'), { recursive: true });
    writeFileSync(join(b.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'gbrain@gbrain': true } }));
    const plugin = await gbrain(b, ['setup', 'claude-code', '--stdio-member', 'alice-example', '--gbrain-bin', b.bin]);
    expect(plugin.exitCode).toBe(2);
    expect(plugin.stderr).toContain("plugin serves this claude-code gbrain MCP server");
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);

    const serveRefusals: Array<[string[], string, Record<string, string>]> = [
      [['--stdio-member', 'alice-example', '--http'], 'binds a stdio serve only', {}],
      [['--stdio-member', 'Alice Example'], 'needs a member id', {}],
      [['--stdio-member', 'alice-example', '--stdio-member=bob-example'], 'was given 2 times', {}],
      [['--stdio-member', 'alice-example'], 'OpenClaw is installed on this host', { PATH: `${fakeOpenclaw(b)}:${process.env.PATH}` }],
      [['--stdio-member', 'alice-example'], 'Hermes is installed on this host', { HERMES_HOME: b.root }],
    ];
    for (const [args, says, env] of serveRefusals) {
      const r = await gbrain(b, ['serve', ...args], env);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain(says);
    }
  }, 360_000);
});
