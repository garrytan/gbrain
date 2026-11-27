/**
 * `gbrain setup claude-code` (D8): the CLI-only command row's behavior test,
 * spawning `bun src/cli.ts setup` against a temp HOME / GBRAIN_HOME.
 *
 * Authoring gate:
 *  1. Protects: setup resolves its target before writing, owns harness
 *     entries by exact hash (resume never duplicates, --remove deletes only
 *     unchanged owned entries, another install's entries survive), records
 *     three consent decisions with memory-only defaults, and never falls back
 *     from a hosted connection or starts a second PGLite owner.
 *  2. Fails on: marker-only ownership (an edited hook removed), a resume that
 *     appends a second hook, a capture hook installed without acceptance or
 *     over an opt-out, a local brain created next to a hosted one, a
 *     registration written while a foreign live serve holds the lock.
 *  3. New command; bootstrap's tests cover its own lanes, and the
 *     hook ownership suite pins that their marker-only behavior is
 *     unchanged.
 *  4. One seam: GBRAIN_SETUP_ABORT_AFTER (crash injection between files).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Box, claudeJson, createSetupFixture, entries, launcher, readJson, receipt, settings, setup } from './helpers/setup-fixture.ts';

const { box, cleanup } = createSetupFixture();
afterAll(cleanup);

describe('gbrain setup claude-code: install lifecycle', () => {
  test('fresh install creates a keyless brain, wires MCP + read-context hooks only, verifies; a second run changes nothing', async () => {
    const b = box();
    const first = await setup(b, ['claude-code', '--json']);
    expect(first.exitCode).toBe(0);
    expect(first.doc.target.brain.kind).toBe('new-local-pglite');
    expect(first.doc.target.launcher).toBe(b.bin);
    expect(first.doc.states).toEqual(['configured', 'connection-verified', 'native-pending']);
    expect(first.doc.verify.reason).toBe('smoke_passed');
    expect(first.doc.consent.capture).toMatchObject({ value: 'declined', source: 'default' });
    expect(first.doc.consent.providers).toMatchObject({ value: 'declined', source: 'default' });
    expect(readJson(join(b.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);
    const entry = readJson(claudeJson(b)).mcpServers.gbrain;
    expect(entry).toEqual({ type: 'stdio', command: launcher(b), args: [b.bin, 'serve', '--surface', 'starter', '--advertise', 'verbs'], env: { GBRAIN_HOME: b.gbrainHome } });
    expect(Object.keys(readJson(settings(b)).hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(readJson(receipt(b)).status).toBe('installed');
    const [bundle] = first.doc.notices;
    expect(bundle).toMatchObject({ code: 'first_run_decisions', kind: 'ask' });
    expect(bundle.decisions.map((d: any) => d.id)).not.toContain('harness_wiring');
    expect(bundle.user_message).not.toContain("Reply 'defaults'");
    expect(bundle.user_message).toContain('Report back (Wakeshift): off. gbrain wakeshift enable turns it on.');

    const before = [readFileSync(claudeJson(b), 'utf8'), readFileSync(settings(b), 'utf8'), readFileSync(receipt(b), 'utf8')];
    const second = await setup(b, ['claude-code', '--json']);
    expect(second.exitCode).toBe(0);
    expect(second.doc.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep']);
    expect([readFileSync(claudeJson(b), 'utf8'), readFileSync(settings(b), 'utf8'), readFileSync(receipt(b), 'utf8')]).toEqual(before);
    expect(existsSync(`${settings(b)}.bak`)).toBe(false);
  });

  test('starter is the default surface; --surface full is the opt-in, and a re-run keeps the surface already registered', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--surface', 'full', '--json'])).exitCode).toBe(0);
    expect(readJson(claudeJson(b)).mcpServers.gbrain.args).toEqual([b.bin, 'serve', '--surface', 'full']);
    const rerun = await setup(b, ['claude-code', '--json']);
    expect(rerun.exitCode).toBe(0);
    expect(readJson(claudeJson(b)).mcpServers.gbrain.args).toEqual([b.bin, 'serve', '--surface', 'full']);
    expect(rerun.doc.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep']);
  });

  test('human output ends with one non-blocking settings block after Next, and none of init\'s standalone steps', async () => {
    const b = box();
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(0);
    for (const stale of ['Do this next', 'claude mcp add', "Reply 'defaults'", 'Before continuing', 'gbrain install check', '(id: harness_wiring)']) expect(r.stdout).not.toContain(stale);
    expect(r.stdout).toContain('Brain ready at ');
    const next = r.stdout.indexOf('Next: open a new Claude Code session');
    const block = r.stdout.indexOf('[AGENT]');
    expect(next).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(next);
    expect(r.stdout.match(/\[AGENT\]/g)).toHaveLength(2);
    const optIns = r.stdout.indexOf('Opt-ins (nothing is on until you turn it on)');
    expect(optIns).toBeGreaterThan(next);
    expect(optIns).toBeLessThan(block);
    expect(r.stdout.match(/INSTALL_FOR_AGENTS\.md#opt-ins/g)).toHaveLength(1);
    const hosted = r.stdout.indexOf('[hosted_option]');
    expect(r.stdout.indexOf('[first_run_decisions]')).toBeGreaterThan(next);
    expect(hosted).toBeGreaterThan(r.stdout.indexOf('[first_run_decisions]'));
    expect(r.stdout.slice(block, hosted)).toContain('in the reply that reports this install');
    expect(r.stdout.slice(block, hosted)).toContain('(id: search_mode)');
    expect(r.stdout.slice(block, hosted)).toContain('Report back (Wakeshift): off. gbrain wakeshift enable turns it on.');
    expect(r.stdout.slice(hosted)).toContain('https://gbrain.io/?ref=cli-setup');
    expect(r.stdout.trimEnd().endsWith('[/AGENT]')).toBe(true);
  });

  test('hosted_option rides only the run that created the brain', async () => {
    const b = box();
    const first = await setup(b, ['claude-code', '--json']);
    expect(first.doc.notices.map((n: any) => n.code)).toEqual(['first_run_decisions', 'hosted_option']);
    expect(first.doc.notices[1].user_message).toContain('https://gbrain.io/?ref=cli-setup');
    const second = await setup(b, ['claude-code', '--json']);
    expect(second.doc.notices.map((n: any) => n.code)).not.toContain('hosted_option');
  });

  test('#6606: after Next, setup names remember as the way to save a fact and what reaches new sessions', async () => {
    const b = box();
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(0);
    const next = r.stdout.indexOf('Next: open a new Claude Code session');
    const memory = r.stdout.indexOf('Memory: save what the user asks you to remember as a fact with gbrain remember "<fact>", naming its entity and provenance');
    expect(next).toBeGreaterThan(-1);
    expect(memory).toBeGreaterThan(next);
    expect(r.stdout.indexOf('[AGENT]')).toBeGreaterThan(memory);
    const line = r.stdout.slice(memory).split('\n')[0];
    expect(line).toContain('pushed into new sessions');
    expect(line).toContain('a private fact is not (local CLI recall only)');
    expect(line).toContain('capture writes a page, not a fact');
  });

  test('--remove deletes exactly the owned entries; foreign hooks, other MCP servers and the brain stay', async () => {
    const b = box();
    mkdirSync(join(b.home, '.claude'), { recursive: true });
    const foreign = { type: 'command', command: 'echo user-hook', timeout: 2 };
    writeFileSync(settings(b), JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ hooks: [foreign] }] } }));
    writeFileSync(claudeJson(b), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: '/bin/true', args: [] } }, numStartups: 3 }));
    expect((await setup(b, ['claude-code'])).exitCode).toBe(0);
    expect(entries(b, 'SessionStart')).toHaveLength(2);

    const preview = await setup(b, ['claude-code', '--remove', '--dry-run', '--json']);
    expect(preview.exitCode).toBe(0);
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toBeDefined();

    const removed = await setup(b, ['claude-code', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toEqual([]);
    const cfg = readJson(claudeJson(b));
    expect(cfg.mcpServers).toEqual({ other: { type: 'stdio', command: '/bin/true', args: [] } });
    expect(cfg.numStartups).toBe(3);
    const s = readJson(settings(b));
    expect(s.theme).toBe('dark');
    expect(s.hooks).toEqual({ SessionStart: [{ hooks: [foreign] }] });
    expect(existsSync(receipt(b))).toBe(false);
    expect(existsSync(join(b.gbrainHome, '.gbrain', 'brain.pglite'))).toBe(true);
  });

  test('a crash after the MCP write and before the hook write resumes without duplicating anything', async () => {
    const b = box();
    const crashed = await setup(b, ['claude-code'], { GBRAIN_SETUP_ABORT_AFTER: 'mcp' });
    expect(crashed.exitCode).toBe(1);
    expect(crashed.stderr).toContain('aborted after mcp');
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toBeDefined();
    expect(existsSync(settings(b))).toBe(false);
    const mid = readJson(receipt(b));
    expect(mid.status).toBe('prepared');
    expect(Object.keys(mid.hooks.pending).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);

    const resumed = await setup(b, ['claude-code', '--json']);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.doc.target.brain.kind).toBe('local-pglite');
    expect(resumed.doc.steps.find((s: any) => s.step === 'mcp').action).toBe('keep');
    expect(Object.keys(readJson(claudeJson(b)).mcpServers)).toEqual(['gbrain']);
    expect(entries(b, 'SessionStart')).toHaveLength(1);
    expect(entries(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(readJson(receipt(b)).status).toBe('installed');
    expect(readJson(receipt(b)).brain_created_by_setup).toBe(true);
  });

  test('a user-edited owned hook survives --remove, is reported, and a later setup leaves it alone', async () => {
    const b = box();
    expect((await setup(b, ['claude-code'])).exitCode).toBe(0);
    const s = readJson(settings(b));
    const edited = s.hooks.SessionStart[0].hooks[0];
    edited.command = `${edited.command} --verbose`;
    expect(edited._gbrain).toBe('setup-v1');
    writeFileSync(settings(b), JSON.stringify(s, null, 2));

    const removed = await setup(b, ['claude-code', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toEqual([{ kind: 'hook', event: 'SessionStart', reason: 'edited' }]);
    expect(entries(b, 'SessionStart')).toEqual([edited]);
    expect(entries(b, 'UserPromptSubmit')).toEqual([]);
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toBeUndefined();

    const again = await setup(b, ['claude-code', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.preserved).toEqual([{ kind: 'hook', event: 'SessionStart', reason: 'edited' }]);
    expect(entries(b, 'SessionStart')).toEqual([edited]);
    expect(entries(b, 'UserPromptSubmit')).toHaveLength(1);
  });

  test('an MCP entry setup did not write is refused (setup_owner_conflict), an identical one is adopted and kept on --remove', async () => {
    const b = box();
    const foreignCfg = JSON.stringify({ mcpServers: { gbrain: { type: 'stdio', command: '/opt/other/gbrain', args: ['serve'] } } });
    writeFileSync(claudeJson(b), foreignCfg);
    const refused = await setup(b, ['claude-code', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'unowned_entry' });
    expect(readFileSync(claudeJson(b), 'utf8')).toBe(foreignCfg);
    expect(existsSync(settings(b))).toBe(false);

    const same = { type: 'stdio', command: launcher(b), args: [b.bin, 'serve', '--surface', 'starter'], env: { GBRAIN_HOME: b.gbrainHome } };
    writeFileSync(claudeJson(b), JSON.stringify({ mcpServers: { gbrain: same } }));
    const adopted = await setup(b, ['claude-code', '--json']);
    expect(adopted.exitCode).toBe(0);
    expect(readJson(receipt(b)).mcp_adopted).toBe(true);
    const removed = await setup(b, ['claude-code', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toEqual(same);
  });

  test('two installs on one machine each own their own entries; removing one leaves the other', async () => {
    const a = box();
    const b: Box = { ...a, gbrainHome: join(a.root, 'second') };
    mkdirSync(b.gbrainHome);
    expect((await setup(a, ['claude-code'])).exitCode).toBe(0);
    const clash = await setup(b, ['claude-code', '--json']);
    expect(clash.exitCode).toBe(1);
    expect(clash.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'other_install' });

    expect((await setup(b, ['claude-code', '--name', 'gbrain-b'])).exitCode).toBe(0);
    expect(Object.keys(readJson(claudeJson(a)).mcpServers).sort()).toEqual(['gbrain', 'gbrain-b']);
    expect(entries(a, 'SessionStart')).toHaveLength(2);
    const aOnly = entries(a, 'SessionStart').filter((e) => e.command.includes(`GBRAIN_HOME=${a.gbrainHome} `));

    expect((await setup(b, ['claude-code', '--name', 'gbrain-b', '--remove'])).exitCode).toBe(0);
    expect(Object.keys(readJson(claudeJson(a)).mcpServers)).toEqual(['gbrain']);
    expect(entries(a, 'SessionStart')).toEqual(aOnly);
    expect(existsSync(receipt(a))).toBe(true);
    expect(existsSync(receipt(a, 'gbrain-b'))).toBe(false);
  });
});
