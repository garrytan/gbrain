import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CODEX_FORWARDED_PROVIDER_ENV } from '../src/core/setup/codex.ts';
import { type Box, codexDir, codexReceipt, codexToml, createSetupFixture, groups, hooksJson, launcher, readJson, setup, setupGroups, toml, trustKey, trustKeys } from './helpers/setup-fixture.ts';

const { box, cleanup } = createSetupFixture();
afterAll(cleanup);

describe('gbrain setup codex: install lifecycle', () => {
  test('fresh install: keyless brain, MCP table, read-context hooks and their trust entries only, verified; a second run changes nothing', async () => {
    const b = box();
    const first = await setup(b, ['codex', '--json']);
    expect(first.exitCode).toBe(0);
    expect(first.doc.harness).toBe('codex');
    expect(first.doc.target).toMatchObject({ brain: { kind: 'new-local-pglite' }, launcher: b.bin, config_path: codexToml(b), hooks_path: hooksJson(b) });
    expect(first.doc.verify.reason).toBe('smoke_passed');
    expect(first.doc.states).toEqual(['configured', 'connection-verified', 'native-verified']);
    expect(first.doc.capability).toMatchObject({ harness: 'codex', setup: 'supported', push: 'native-verified', read_events: ['SessionStart', 'UserPromptSubmit'] });
    expect(first.doc.consent.capture).toMatchObject({ value: 'declined', source: 'default' });
    expect(first.doc.notices.find((n: any) => n.code === 'first_run_decisions').user_message).toContain('Report back (Wakeshift): off. gbrain wakeshift enable turns it on.');
    expect(readJson(join(b.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);
    expect(toml(b).mcp_servers.gbrain).toEqual({ command: launcher(b), args: [b.bin, 'serve', '--surface', 'full'], env: { GBRAIN_HOME: b.gbrainHome },
      env_vars: [...CODEX_FORWARDED_PROVIDER_ENV] });
    expect(Object.keys(readJson(hooksJson(b)).hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(groups(b, 'UserPromptSubmit')).toEqual([{ hooks: [{ type: 'command', timeout: 15,
      command: `env GBRAIN_HOOK_LANE=setup GBRAIN_HOME=${b.gbrainHome} ${b.gbrainHome}/.gbrain/hook-launcher/gbrain-hook ${b.bin} hook user-prompt --harness codex` }] }]);
    expect(trustKeys(b)).toEqual([trustKey(b, 'session_start', 0), trustKey(b, 'user_prompt_submit', 0)]);
    const r = readJson(codexReceipt(b));
    expect(r).toMatchObject({ harness: 'codex', connection: 'local-stdio', setup_receipt_version: 2, status: 'installed' });
    expect(Object.keys(r.hooks.owned).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(Object.keys(r.trust.owned).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);

    const before = [codexToml(b), hooksJson(b), codexReceipt(b)].map((p) => readFileSync(p, 'utf8'));
    const second = await setup(b, ['codex', '--json']);
    expect(second.exitCode).toBe(0);
    expect(second.doc.steps.map((s: any) => [s.step, s.action])).toEqual([['receipt', 'keep'], ['mcp', 'keep'], ['hooks', 'keep'], ['trust', 'keep']]);
    expect([codexToml(b), hooksJson(b), codexReceipt(b)].map((p) => readFileSync(p, 'utf8'))).toEqual(before);
  });

  test('an install that changes an existing config.toml or hooks.json keeps a timestamped .bak of each and names it', async () => {
    const b = box();
    mkdirSync(codexDir(b), { recursive: true });
    const foreignToml = 'model = "o5"\n';
    const foreignHooks = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook', timeout: 2 }] }] } }, null, 2);
    writeFileSync(codexToml(b), foreignToml);
    writeFileSync(hooksJson(b), foreignHooks);
    const installed = await setup(b, ['codex', '--json']);
    expect(installed.exitCode, installed.stderr).toBe(0);
    for (const [file, original] of [[codexToml(b), foreignToml], [hooksJson(b), foreignHooks]] as const) {
      const backups = readdirSync(codexDir(b)).filter((n) => n.startsWith(`${basename(file)}.bak.`));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(codexDir(b), backups[0]!), 'utf8')).toBe(original);
      expect(installed.doc.notes.join('\n')).toContain(join(codexDir(b), backups[0]!));
    }
  });

  test('--remove deletes exactly the owned entries; foreign config, hooks, trust entries and the brain stay byte-for-byte', async () => {
    const b = box();
    mkdirSync(codexDir(b), { recursive: true });
    const foreignToml = [
      'model = "o5"', '',
      '[mcp_servers.other]', 'command = "/bin/true"', '',
      '# my own hook trust', `[hooks.state.${JSON.stringify(trustKey(b, 'session_start', 0))}]`, 'trusted_hash = "sha256:mine"', '',
    ].join('\n');
    writeFileSync(codexToml(b), foreignToml);
    const foreignHooks = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook', timeout: 2 }] }] } }, null, 2);
    writeFileSync(hooksJson(b), foreignHooks);
    const installed = await setup(b, ['codex', '--json']);
    expect(installed.exitCode).toBe(0);
    expect(groups(b, 'SessionStart')).toHaveLength(2);
    expect(trustKeys(b)).toEqual([trustKey(b, 'session_start', 0), trustKey(b, 'session_start', 1), trustKey(b, 'user_prompt_submit', 0)]);
    expect(toml(b).hooks.state[trustKey(b, 'session_start', 0)]).toEqual({ trusted_hash: 'sha256:mine' });

    const preview = await setup(b, ['codex', '--remove', '--dry-run', '--json']);
    expect(preview.exitCode).toBe(0);
    expect(toml(b).mcp_servers.gbrain).toBeDefined();
    expect(existsSync(codexReceipt(b))).toBe(true);

    const removed = await setup(b, ['codex', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toEqual([]);
    expect(readFileSync(codexToml(b), 'utf8')).toBe(foreignToml);
    expect(readJson(hooksJson(b))).toEqual(JSON.parse(foreignHooks));
    expect(existsSync(codexReceipt(b))).toBe(false);
    expect(existsSync(join(b.gbrainHome, '.gbrain', 'brain.pglite'))).toBe(true);
  });

  test('a crash after the MCP write and before the hook write resumes without duplicating anything', async () => {
    const b = box();
    const crashed = await setup(b, ['codex'], { GBRAIN_SETUP_ABORT_AFTER: 'mcp' });
    expect(crashed.exitCode).toBe(1);
    expect(crashed.stderr).toContain('aborted after mcp');
    expect(toml(b).mcp_servers.gbrain).toBeDefined();
    expect(existsSync(hooksJson(b))).toBe(false);
    const mid = readJson(codexReceipt(b));
    expect(mid.status).toBe('prepared');
    expect(mid.consent.capture.value).toBe('declined');
    expect(Object.keys(mid.hooks.pending).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);

    const resumed = await setup(b, ['codex', '--json']);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.doc.target.brain.kind).toBe('local-pglite');
    expect(resumed.doc.steps.find((s: any) => s.step === 'mcp').action).toBe('keep');
    expect(readFileSync(codexToml(b), 'utf8').match(/^\[mcp_servers\.gbrain\]$/gm)).toHaveLength(1);
    expect(groups(b, 'SessionStart')).toHaveLength(1);
    expect(groups(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(trustKeys(b)).toEqual([trustKey(b, 'session_start', 0), trustKey(b, 'user_prompt_submit', 0)]);
    expect(readJson(codexReceipt(b))).toMatchObject({ status: 'installed', brain_created_by_setup: true });
  });

  test('a crash after the hook write and before the trust write leaves untrusted (inert) hooks; resume trusts them once', async () => {
    const b = box();
    expect((await setup(b, ['codex'], { GBRAIN_SETUP_ABORT_AFTER: 'hooks' })).exitCode).toBe(1);
    expect(groups(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(trustKeys(b)).toEqual([]);
    expect(Object.keys(readJson(codexReceipt(b)).trust.pending).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect((await setup(b, ['codex'])).exitCode).toBe(0);
    expect(groups(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(trustKeys(b)).toEqual([trustKey(b, 'session_start', 0), trustKey(b, 'user_prompt_submit', 0)]);
  });

  test('a user-edited owned hook survives --remove, is reported, and a later setup neither rewrites nor trusts it', async () => {
    const b = box();
    expect((await setup(b, ['codex'])).exitCode).toBe(0);
    const doc = readJson(hooksJson(b));
    doc.hooks.SessionStart[0].hooks[0].command += ' --verbose';
    const edited = doc.hooks.SessionStart[0];
    writeFileSync(hooksJson(b), JSON.stringify(doc, null, 2));

    const removed = await setup(b, ['codex', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toEqual([{ kind: 'hook', event: 'SessionStart', reason: 'edited' }]);
    expect(groups(b, 'SessionStart')).toEqual([edited]);
    expect(groups(b, 'UserPromptSubmit')).toEqual([]);
    expect(toml(b).mcp_servers?.gbrain).toBeUndefined();
    expect(trustKeys(b)).toEqual([]);
    expect(readJson(codexReceipt(b)).status).toBe('removed');

    const again = await setup(b, ['codex', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.preserved).toEqual([{ kind: 'hook', event: 'SessionStart', reason: 'edited' }]);
    expect(groups(b, 'SessionStart')).toEqual([edited]);
    expect(setupGroups(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(trustKeys(b)).toEqual([trustKey(b, 'user_prompt_submit', 0)]);
  });

  test('a changed hook index (a group inserted before setup\'s) re-trusts only what setup owns', async () => {
    const b = box();
    expect((await setup(b, ['codex'])).exitCode).toBe(0);
    const doc = readJson(hooksJson(b));
    const userGroup = { hooks: [{ type: 'command', command: 'echo mine', timeout: 5 }] };
    doc.hooks.UserPromptSubmit.unshift(userGroup);
    writeFileSync(hooksJson(b), JSON.stringify(doc, null, 2));
    const userTrust = `\n[hooks.state.${JSON.stringify(`${hooksJson(b)}:stop:0:0`)}]\ntrusted_hash = "sha256:user-owned"\n`;
    writeFileSync(codexToml(b), readFileSync(codexToml(b), 'utf8') + userTrust);

    const dry = await setup(b, ['codex', '--dry-run', '--json']);
    expect(dry.doc.steps.find((s: any) => s.step === 'trust').action).toBe('write');
    const r = await setup(b, ['codex', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.steps.filter((s: any) => s.step === 'trust').map((s: any) => s.action)).toEqual(['remove', 'keep', 'write']);
    expect(groups(b, 'UserPromptSubmit')[0]).toEqual(userGroup);
    expect(setupGroups(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(trustKeys(b)).toEqual([trustKey(b, 'session_start', 0), `${hooksJson(b)}:stop:0:0`, trustKey(b, 'user_prompt_submit', 1)].sort());
    expect(toml(b).hooks.state[`${hooksJson(b)}:stop:0:0`]).toEqual({ trusted_hash: 'sha256:user-owned' });
    expect(readJson(codexReceipt(b)).trust.owned.UserPromptSubmit.key).toBe(trustKey(b, 'user_prompt_submit', 1));
  });

  test('two installs on one machine each own their own entries; removing one leaves the other', async () => {
    const a = box();
    const b: Box = { ...a, gbrainHome: join(a.root, 'second') };
    mkdirSync(b.gbrainHome);
    expect((await setup(a, ['codex'])).exitCode).toBe(0);
    const clash = await setup(b, ['codex', '--json']);
    expect(clash.exitCode).toBe(1);
    expect(clash.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'other_install' });

    expect((await setup(b, ['codex', '--name', 'gbrain-b'])).exitCode).toBe(0);
    expect(Object.keys(toml(a).mcp_servers).sort()).toEqual(['gbrain', 'gbrain-b']);
    expect(setupGroups(a, 'UserPromptSubmit')).toHaveLength(2);
    const aGroups = { ss: groups(a, 'SessionStart')[0], ups: groups(a, 'UserPromptSubmit')[0] };
    expect(aGroups.ups.hooks[0].command).toContain(`GBRAIN_HOME=${a.gbrainHome} `);
    const aTrust = { ss: toml(a).hooks.state[trustKey(a, 'session_start', 0)], ups: toml(a).hooks.state[trustKey(a, 'user_prompt_submit', 0)] };

    expect((await setup(b, ['codex', '--name', 'gbrain-b', '--remove'])).exitCode).toBe(0);
    expect(Object.keys(toml(a).mcp_servers)).toEqual(['gbrain']);
    expect(groups(a, 'SessionStart')).toEqual([aGroups.ss]);
    expect(groups(a, 'UserPromptSubmit')).toEqual([aGroups.ups]);
    expect(trustKeys(a)).toEqual([trustKey(a, 'session_start', 0), trustKey(a, 'user_prompt_submit', 0)]);
    expect(toml(a).hooks.state[trustKey(a, 'session_start', 0)]).toEqual(aTrust.ss);
    expect(toml(a).hooks.state[trustKey(a, 'user_prompt_submit', 0)]).toEqual(aTrust.ups);
    expect(existsSync(codexReceipt(a))).toBe(true);
    expect(existsSync(codexReceipt(a, 'gbrain-b'))).toBe(false);
  });

  test('an MCP table setup did not write is refused; an identical one is adopted and kept on --remove; a remote one is a hosted connection', async () => {
    const b = box();
    mkdirSync(codexDir(b), { recursive: true });
    const foreign = '[mcp_servers.gbrain]\ncommand = "/opt/other/gbrain"\nargs = ["serve"]\n';
    writeFileSync(codexToml(b), foreign);
    const refused = await setup(b, ['codex', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'unowned_entry' });
    expect(readFileSync(codexToml(b), 'utf8')).toBe(foreign);
    expect(existsSync(hooksJson(b))).toBe(false);

    const same = `[mcp_servers.gbrain]\ncommand = ${JSON.stringify(launcher(b))}\nargs = [${JSON.stringify(b.bin)}, "serve", "--surface", "starter"]\nenv = { GBRAIN_HOME = ${JSON.stringify(b.gbrainHome)} }\nenv_vars = [${CODEX_FORWARDED_PROVIDER_ENV.map(n => JSON.stringify(n)).join(', ')}]\n`;
    writeFileSync(codexToml(b), same);
    expect((await setup(b, ['codex'])).exitCode).toBe(0);
    expect(readJson(codexReceipt(b)).mcp_adopted).toBe(true);
    const removed = await setup(b, ['codex', '--remove', '--json']);
    expect(removed.doc.preserved).toEqual([{ kind: 'mcp', reason: 'adopted' }]);
    expect(readFileSync(codexToml(b), 'utf8')).toBe(same);

    const hosted = box();
    mkdirSync(codexDir(hosted), { recursive: true });
    const remote = '[mcp_servers.gbrain]\nurl = "https://brain.example.test/mcp"\nhttp_headers = { Authorization = "Bearer x" }\n';
    writeFileSync(codexToml(hosted), remote);
    const h = await setup(hosted, ['codex', '--json']);
    expect(h.exitCode).toBe(1);
    expect(h.doc.code).toBe('setup_hosted_connection');
    expect(readFileSync(codexToml(hosted), 'utf8')).toBe(remote);
    expect(existsSync(join(hosted.gbrainHome, '.gbrain'))).toBe(false);
  });
});
