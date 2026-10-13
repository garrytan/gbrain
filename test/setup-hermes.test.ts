/**
 * `gbrain setup hermes`: the CLI-only command row's behavior test for the
 * Hermes harness, spawning `bun src/cli.ts setup hermes` against a temp HOME /
 * HERMES_HOME / GBRAIN_HOME. Mirrors the claude-code and codex lifecycle
 * blocks in test/setup.test.ts for the Hermes surfaces: `mcp_servers.<name>`
 * and `hooks.<event>` in config.yaml, and the (event, command) approvals in
 * shell-hooks-allowlist.json.
 *
 * Authoring gate:
 *  1. Protects: setup resolves its target before writing, owns each Hermes
 *     entry (MCP entry, hook item, approval) by the fingerprint of its parsed
 *     value, never touches a byte of config.yaml or an approval it did not
 *     write, never sets hooks_auto_accept or memory.provider, records the three
 *     consent decisions with memory-only defaults, and never falls back from a
 *     hosted connection or starts a second PGLite owner.
 *  2. Fails on: a YAML round-trip that drops comments, a resume that appends a
 *     second hook item, an approval written for a hook setup did not write, an
 *     edited item removed, a capture hook installed without acceptance or over
 *     an opt-out, a registration written beside a live foreign serve.
 *  3. New command; test/setup.test.ts covers claude-code and codex.
 *  4. One seam: GBRAIN_SETUP_ABORT_AFTER (crash injection between files).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';
import { sortedJson } from '../src/core/bootstrap/hermes-hooks.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; gbrainHome: string; bin: string }

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-hermes-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  mkdirSync(join(root, 'bin'));
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, gbrainHome: home, bin };
}

const CLEAN = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, HERMES_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };

async function setup(b: Box, args: string[], env: Record<string, string | undefined> = {}): Promise<CliResult & { doc: any }> {
  const r = await runCli(['setup', ...args, '--gbrain-bin', b.bin], { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.gbrainHome, ...env } });
  let doc: any = null;
  if (args.includes('--json')) { try { doc = JSON.parse(r.stdout); } catch { doc = null; } }
  return { ...r, doc };
}

const hermesDir = (b: Box) => join(b.home, '.hermes');
const cfgPath = (b: Box) => join(hermesDir(b), 'config.yaml');
const allowPath = (b: Box) => join(hermesDir(b), 'shell-hooks-allowlist.json');
const receiptPath = (b: Box, name = 'gbrain') => join(hermesDir(b), `.gbrain-connection-hermes-${name}.json`);
const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const yaml = (b: Box): any => (existsSync(cfgPath(b)) ? load(readFileSync(cfgPath(b), 'utf8')) ?? {} : {});
const approvals = (b: Box): any[] => (existsSync(allowPath(b)) ? readJson(allowPath(b)).approvals : []);
const items = (b: Box, event: string): any[] => yaml(b).hooks?.[event] ?? [];
const setupItems = (b: Box, event: string) => items(b, event).filter((i) => String(i.command).includes('GBRAIN_HOOK_LANE=setup'));
const writeCfg = (b: Box, text: string) => { mkdirSync(hermesDir(b), { recursive: true }); writeFileSync(cfgPath(b), text); };
const userPromptCommand = (b: Box, extra = '') => `env GBRAIN_HOOK_LANE=setup GBRAIN_HOME=${b.gbrainHome}${extra} ${b.bin} hook user-prompt --harness hermes`;

const FOREIGN_YAML = [
  '# my hermes profile', 'model:', '  default: some-model  # keep this', '',
  'mcp_servers:', '  other:', '    command: /bin/true', '    args: [a, b]', '',
  'hooks:', '  pre_llm_call:', '    - command: /usr/local/bin/my-hook', '      timeout: 5', '  on_session_finalize:', '    - command: /usr/local/bin/my-finalize', '',
  'hooks_auto_accept: false', '',
].join('\n');
const FOREIGN_APPROVALS = sortedJson({ approvals: [{ approved_at: '2026-09-01T00:00:00.000000Z', command: '/usr/local/bin/my-hook', event: 'pre_llm_call', script_mtime_at_approval: null }] });

describe('gbrain setup hermes: install lifecycle', () => {
  test('fresh install: keyless brain, MCP entry, the read-context hook and its approval only, verified; a second run changes nothing', async () => {
    const b = box();
    const first = await setup(b, ['hermes', '--json']);
    expect(first.exitCode).toBe(0);
    expect(first.doc.harness).toBe('hermes');
    expect(Object.keys(first.doc)).toEqual(['harness', 'dry_run', 'remove', 'target', 'consent', 'steps', 'preserved', 'states', 'state', 'verify', 'capability', 'capability_table_version', 'notes', 'notices']);
    expect(first.doc.target).toMatchObject({ brain: { kind: 'new-local-pglite' }, launcher: b.bin, scope: 'user', config_path: cfgPath(b), hermes_home: hermesDir(b), allowlist_path: allowPath(b), registration_owner: 'setup' });
    expect(first.doc.verify.reason).toBe('smoke_passed');
    expect(first.doc.states).toEqual(['configured', 'connection-verified', 'native-pending']);
    expect(first.doc.capability).toMatchObject({ harness: 'hermes', setup: 'supported', pull: 'connection-verified', push: 'native-pending', read_events: ['pre_llm_call'], capture_events: ['on_session_finalize'] });
    expect(first.doc.capability_table_version).toBe(3);
    expect(first.doc.consent.capture).toMatchObject({ value: 'declined', source: 'default' });
    expect(first.doc.consent.providers).toMatchObject({ value: 'declined', source: 'default' });
    expect(readJson(join(b.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);

    const cfg = yaml(b);
    expect(cfg.mcp_servers.gbrain).toEqual({ command: b.bin, args: ['serve', '--surface', 'full'], env: { GBRAIN_HOME: b.gbrainHome } });
    expect(Object.keys(cfg.hooks)).toEqual(['pre_llm_call']);
    expect(cfg.hooks.pre_llm_call).toEqual([{ command: userPromptCommand(b), timeout: 10 }]);
    expect(cfg.memory).toBeUndefined();
    expect(cfg.hooks_auto_accept).toBeUndefined();
    expect(approvals(b)).toEqual([{ approved_at: expect.any(String), command: userPromptCommand(b), event: 'pre_llm_call', script_mtime_at_approval: null }]);
    expect(statSync(allowPath(b)).mode & 0o777).toBe(0o600);
    const r = readJson(receiptPath(b));
    expect(r).toMatchObject({ harness: 'hermes', connection: 'local-stdio', setup_receipt_version: 3, status: 'installed', native_harness_verified: false, hermes_home: hermesDir(b) });
    expect(Object.keys(r.hooks.owned)).toEqual(['pre_llm_call']);
    expect(Object.keys(r.trust.owned)).toEqual(['pre_llm_call']);
    expect(statSync(receiptPath(b)).mode & 0o777).toBe(0o600);

    const before = [cfgPath(b), allowPath(b), receiptPath(b)].map((p) => readFileSync(p, 'utf8'));
    const second = await setup(b, ['hermes', '--json']);
    expect(second.exitCode).toBe(0);
    expect(second.doc.steps.map((s: any) => [s.step, s.action])).toEqual([['receipt', 'keep'], ['mcp', 'keep'], ['hooks', 'keep'], ['trust', 'keep']]);
    expect([cfgPath(b), allowPath(b), receiptPath(b)].map((p) => readFileSync(p, 'utf8'))).toEqual(before);
  });

  test('--remove restores comments, unrelated servers, hooks and approvals byte for byte; the brain stays', async () => {
    const b = box();
    writeCfg(b, FOREIGN_YAML);
    writeFileSync(allowPath(b), FOREIGN_APPROVALS);
    const installed = await setup(b, ['hermes', '--capture', '--json']);
    expect(installed.exitCode).toBe(0);
    expect(items(b, 'pre_llm_call')).toHaveLength(2);
    expect(items(b, 'on_session_finalize')).toHaveLength(2);
    expect(approvals(b)).toHaveLength(3);
    expect(readFileSync(cfgPath(b), 'utf8')).toContain('# my hermes profile');
    expect(readFileSync(cfgPath(b), 'utf8')).toContain('some-model  # keep this');

    const preview = await setup(b, ['hermes', '--remove', '--dry-run', '--json']);
    expect(preview.exitCode).toBe(0);
    expect(yaml(b).mcp_servers.gbrain).toBeDefined();
    expect(existsSync(receiptPath(b))).toBe(true);

    const removed = await setup(b, ['hermes', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toEqual([]);
    expect(readFileSync(cfgPath(b), 'utf8')).toBe(FOREIGN_YAML);
    expect(readFileSync(allowPath(b), 'utf8')).toBe(FOREIGN_APPROVALS);
    expect(existsSync(receiptPath(b))).toBe(false);
    expect(existsSync(join(b.gbrainHome, '.gbrain', 'brain.pglite'))).toBe(true);
  });

  test('--remove on a profile setup created deletes the files it created', async () => {
    const b = box();
    expect((await setup(b, ['hermes'])).exitCode).toBe(0);
    expect((await setup(b, ['hermes', '--remove'])).exitCode).toBe(0);
    expect(readFileSync(cfgPath(b), 'utf8')).toBe('');
    expect(existsSync(allowPath(b))).toBe(false);
    expect(existsSync(receiptPath(b))).toBe(false);
  });

  for (const seam of ['receipt', 'mcp', 'hooks', 'trust'] as const) {
    test(`a crash after ${seam} resumes without duplicating anything`, async () => {
      const b = box();
      const crashed = await setup(b, ['hermes'], { GBRAIN_SETUP_ABORT_AFTER: seam });
      expect(crashed.exitCode).toBe(1);
      expect(crashed.stderr).toContain(`aborted after ${seam}`);
      const mid = readJson(receiptPath(b));
      expect(mid.status).toBe('prepared');
      expect(mid.consent.capture.value).toBe('declined');
      const order = ['receipt', 'mcp', 'hooks', 'trust'];
      const wrote = (s: string) => order.indexOf(s) <= order.indexOf(seam);
      expect(Boolean(yaml(b).mcp_servers?.gbrain)).toBe(wrote('mcp'));
      expect(items(b, 'pre_llm_call')).toHaveLength(wrote('hooks') ? 1 : 0);
      expect(approvals(b)).toHaveLength(wrote('trust') ? 1 : 0);
      if (seam === 'mcp') expect(Object.keys(mid.hooks.pending)).toEqual(['pre_llm_call']);
      if (seam === 'hooks') expect(Object.keys(mid.trust.pending)).toEqual(['pre_llm_call']);

      const resumed = await setup(b, ['hermes', '--json']);
      expect(resumed.exitCode).toBe(0);
      // The brain is created after the receipt, so a crash at the receipt seam resumes onto a still-new brain.
      expect(resumed.doc.target.brain.kind).toBe(seam === 'receipt' ? 'new-local-pglite' : 'local-pglite');
      expect(Object.keys(yaml(b).mcp_servers)).toEqual(['gbrain']);
      expect(readFileSync(cfgPath(b), 'utf8').match(/^ {2}gbrain:$/gm)).toHaveLength(1);
      expect(items(b, 'pre_llm_call')).toHaveLength(1);
      expect(approvals(b)).toHaveLength(1);
      expect(readJson(receiptPath(b))).toMatchObject({ status: 'installed', brain_created_by_setup: true });
    });
  }

  test('a user-edited owned hook survives --remove, is reported, and a later setup neither rewrites nor approves it', async () => {
    const b = box();
    expect((await setup(b, ['hermes'])).exitCode).toBe(0);
    writeFileSync(cfgPath(b), readFileSync(cfgPath(b), 'utf8').replace('--harness hermes', '--harness hermes --verbose'));
    const edited = items(b, 'pre_llm_call')[0];
    expect(edited.command).toContain('--verbose');

    const removed = await setup(b, ['hermes', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toEqual([{ kind: 'hook', event: 'pre_llm_call', reason: 'edited' }]);
    expect(items(b, 'pre_llm_call')).toEqual([edited]);
    expect(yaml(b).mcp_servers?.gbrain).toBeUndefined();
    expect(readJson(receiptPath(b)).status).toBe('removed');

    const again = await setup(b, ['hermes', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.preserved).toEqual([{ kind: 'hook', event: 'pre_llm_call', reason: 'edited' }]);
    expect(items(b, 'pre_llm_call')).toEqual([edited]);
    expect(approvals(b).filter((a) => a.command === edited.command)).toEqual([]);
  });

  test('an MCP entry setup did not write is refused; an identical one is adopted and kept on --remove; a url entry is a hosted connection', async () => {
    const b = box();
    const foreign = 'mcp_servers:\n  gbrain:\n    command: /opt/other/gbrain\n    args: [serve]\n';
    writeCfg(b, foreign);
    const refused = await setup(b, ['hermes', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'unowned_entry' });
    expect(readFileSync(cfgPath(b), 'utf8')).toBe(foreign);
    expect(existsSync(receiptPath(b))).toBe(false);

    const same = `mcp_servers:\n  gbrain:\n    command: ${b.bin}\n    args: [serve, --surface, full]\n    env:\n      GBRAIN_HOME: ${b.gbrainHome}\n`;
    writeCfg(b, same);
    expect((await setup(b, ['hermes'])).exitCode).toBe(0);
    expect(readJson(receiptPath(b)).mcp_adopted).toBe(true);
    const removed = await setup(b, ['hermes', '--remove', '--json']);
    expect(removed.doc.preserved).toEqual([{ kind: 'mcp', reason: 'adopted' }]);
    expect(yaml(b).mcp_servers.gbrain.command).toBe(b.bin);

    const hosted = box();
    const remote = 'mcp_servers:\n  gbrain:\n    url: https://brain.example.test/mcp\n    headers:\n      Authorization: Bearer ${GBRAIN_MCP_TOKEN}\n';
    writeCfg(hosted, remote);
    const h = await setup(hosted, ['hermes', '--json']);
    expect(h.exitCode).toBe(1);
    expect(h.doc.code).toBe('setup_hosted_connection');
    expect(h.doc.fix.argv.slice(0, 3)).toEqual(['gbrain', 'doctor', '--only']);
    expect(readFileSync(cfgPath(hosted), 'utf8')).toBe(remote);
    expect(existsSync(join(hosted.gbrainHome, '.gbrain'))).toBe(false);
  });

  test('two installs on one profile each own their own entries; removing one leaves the other', async () => {
    const a = box();
    const b: Box = { ...a, gbrainHome: join(a.root, 'second') };
    mkdirSync(b.gbrainHome);
    expect((await setup(a, ['hermes'])).exitCode).toBe(0);
    const clash = await setup(b, ['hermes', '--json']);
    expect(clash.exitCode).toBe(1);
    expect(clash.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'other_install' });

    expect((await setup(b, ['hermes', '--name', 'gbrain-b'])).exitCode).toBe(0);
    expect(Object.keys(yaml(a).mcp_servers).sort()).toEqual(['gbrain', 'gbrain-b']);
    expect(setupItems(a, 'pre_llm_call')).toHaveLength(2);
    const aItem = setupItems(a, 'pre_llm_call').find((i) => String(i.command).includes(`GBRAIN_HOME=${a.gbrainHome} `));
    expect(approvals(a)).toHaveLength(2);

    expect((await setup(b, ['hermes', '--name', 'gbrain-b', '--remove'])).exitCode).toBe(0);
    expect(Object.keys(yaml(a).mcp_servers)).toEqual(['gbrain']);
    expect(items(a, 'pre_llm_call')).toEqual([aItem]);
    expect(approvals(a).map((x) => x.command)).toEqual([aItem.command]);
    expect(existsSync(receiptPath(a))).toBe(true);
    expect(existsSync(receiptPath(a, 'gbrain-b'))).toBe(false);
  });
});

describe('gbrain setup hermes: hook approval ownership', () => {
  test('merges with existing approvals, leaves hooks_auto_accept and foreign approvals alone, and keeps the file private', async () => {
    const b = box();
    writeCfg(b, FOREIGN_YAML);
    writeFileSync(allowPath(b), FOREIGN_APPROVALS);
    chmodSync(allowPath(b), 0o644);
    expect((await setup(b, ['hermes'])).exitCode).toBe(0);
    expect(approvals(b).map((a) => a.command)).toEqual(['/usr/local/bin/my-hook', userPromptCommand(b)]);
    expect(statSync(allowPath(b)).mode & 0o777).toBe(0o600);
    expect(yaml(b).hooks_auto_accept).toBe(false);
    expect(yaml(b).memory).toBeUndefined();
  });

  test('a customized approval for a command setup would have approved is preserved and reported, not replaced', async () => {
    const b = box();
    mkdirSync(hermesDir(b), { recursive: true });
    const mine = sortedJson({ approvals: [{ approved_at: '2026-09-01T00:00:00.000000Z', command: userPromptCommand(b), event: 'pre_llm_call', note: 'reviewed by me', script_mtime_at_approval: null }] });
    writeFileSync(allowPath(b), mine);
    const r = await setup(b, ['hermes', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.preserved).toEqual([{ kind: 'trust', event: 'pre_llm_call', reason: 'conflict' }]);
    expect(readFileSync(allowPath(b), 'utf8')).toBe(mine);
    const removed = await setup(b, ['hermes', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(readFileSync(allowPath(b), 'utf8')).toBe(mine);
  });

  test('an unparseable allowlist or config is refused with the never-rewrites error, nothing written', async () => {
    const b = box();
    mkdirSync(hermesDir(b), { recursive: true });
    writeFileSync(allowPath(b), '{ not json');
    const a = await setup(b, ['hermes']);
    expect(a.exitCode).toBe(1);
    expect(a.stderr).toContain('never rewrites a file it cannot parse');
    expect(readFileSync(allowPath(b), 'utf8')).toBe('{ not json');
    expect(items(b, 'pre_llm_call')).toEqual([]);

    const c = box();
    writeCfg(c, 'mcp_servers: [unclosed\n');
    const r = await setup(c, ['hermes']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('never rewrites a file it cannot parse');
    expect(readFileSync(cfgPath(c), 'utf8')).toBe('mcp_servers: [unclosed\n');
    expect(existsSync(receiptPath(c))).toBe(false);
  });

  test('a non-empty flow `mcp_servers: {...}` is refused as a shape setup cannot edit, file untouched', async () => {
    const b = box();
    const flow = 'mcp_servers: {other: {command: /bin/true}}\n';
    writeCfg(b, flow);
    const r = await setup(b, ['hermes']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('cannot edit safely');
    expect(readFileSync(cfgPath(b), 'utf8')).toBe(flow);
  });
});

describe('gbrain setup hermes: target first', () => {
  test('--dry-run prints the target and writes nothing; GBRAIN_SURFACE is honoured; --scope project is refused', async () => {
    const b = box();
    const r = await setup(b, ['hermes', '--dry-run', '--json'], { GBRAIN_SURFACE: 'starter' });
    expect(r.exitCode).toBe(0);
    expect(r.doc.target).toMatchObject({ transport: 'local-stdio', surface: 'starter', registration_owner: 'none', scope: 'user', launcher: b.bin });
    expect(r.doc.steps.map((s: any) => s.step)).toEqual(['receipt', 'brain', 'mcp', 'hooks', 'trust']);
    expect(r.doc.steps.find((s: any) => s.step === 'brain').detail).toContain('--no-embedding');
    expect(r.doc.states).toEqual([]);
    expect(existsSync(hermesDir(b))).toBe(false);
    expect(existsSync(join(b.gbrainHome, '.gbrain'))).toBe(false);
    const p = await setup(b, ['hermes', '--scope', 'project']);
    expect(p.exitCode).toBe(2);
    expect(p.stderr).toContain('per profile');
  });

  test('--hermes-home and HERMES_HOME pick the profile; the explicit flag wins; a relative path is a flag error', async () => {
    const b = box();
    const other = join(b.root, 'profiles', 'research');
    const viaEnv = await setup(b, ['hermes', '--dry-run', '--json'], { HERMES_HOME: other });
    expect(viaEnv.doc.target.hermes_home).toBe(other);
    const flagged = join(b.root, 'profiles', 'flagged');
    const viaFlag = await setup(b, ['hermes', '--hermes-home', flagged, '--dry-run', '--json'], { HERMES_HOME: other });
    expect(viaFlag.doc.target.hermes_home).toBe(flagged);
    expect(viaFlag.doc.target.receipt_path).toBe(join(flagged, '.gbrain-connection-hermes-gbrain.json'));
    const rel = await setup(b, ['hermes', '--hermes-home', 'relative/dir', '--json']);
    expect(rel.exitCode).toBe(2);
    expect(rel.stderr).toContain("invalid --hermes-home 'relative/dir'");
    expect(existsSync(other)).toBe(false);
  });

  test('a hosted brain, a hosted receipt, or the hosted provider lane in this profile never falls back to a new local brain', async () => {
    const thin = box();
    mkdirSync(join(thin.gbrainHome, '.gbrain'));
    writeFileSync(join(thin.gbrainHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', remote_mcp: {
      issuer_url: 'https://brain.example.test', mcp_url: 'https://brain.example.test/mcp', oauth_client_id: 'client-a', oauth_client_secret: 'secret-a' } }));
    const r = await setup(thin, ['hermes', '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.doc.code).toBe('setup_hosted_connection');
    expect(r.doc.message).toContain('https://brain.example.test/mcp');
    expect(r.doc.fix.argv).toEqual(['gbrain', 'hermes', 'setup', '--hermes-home', hermesDir(thin), '--url', 'https://brain.example.test/mcp']);
    expect(existsSync(join(thin.gbrainHome, '.gbrain', 'brain.pglite'))).toBe(false);
    expect(existsSync(hermesDir(thin))).toBe(false);

    const wired = box();
    mkdirSync(hermesDir(wired), { recursive: true });
    writeFileSync(receiptPath(wired), JSON.stringify({ client_id: 'client-a', mcp_url: 'https://brain.example.test/mcp', status: 'installed', harness: 'hermes' }));
    const w = await setup(wired, ['hermes', '--json']);
    expect(w.exitCode).toBe(1);
    expect(w.doc.code).toBe('setup_hosted_connection');
    expect(existsSync(join(wired.gbrainHome, '.gbrain'))).toBe(false);

    const provider = box();
    mkdirSync(join(hermesDir(provider), '.gbrain-hermes'), { recursive: true });
    writeFileSync(join(hermesDir(provider), '.gbrain-hermes', 'receipt.json'), JSON.stringify({ version: 1, home: hermesDir(provider), state: 'installed', connection_url: 'https://brain.example.test/mcp', leaves: {}, files: {} }));
    const p = await setup(provider, ['hermes', '--json']);
    expect(p.exitCode).toBe(1);
    expect(p.doc.code).toBe('setup_hosted_connection');
    expect(p.doc.message).toContain('https://brain.example.test/mcp');
    expect(existsSync(join(provider.gbrainHome, '.gbrain'))).toBe(false);
  });

  test('a hand-written gbrain hermes hook is a harness_lane conflict (two lanes would fire every hook twice)', async () => {
    const b = box();
    writeCfg(b, `hooks:\n  pre_llm_call:\n    - command: ${b.bin} hook user-prompt --harness hermes\n`);
    const r = await setup(b, ['hermes', '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'harness_lane' });
    expect(r.doc.fix.argv).toEqual(['gbrain', 'setup', 'hermes', '--no-hooks', '--dry-run', '--json']);
    expect(existsSync(receiptPath(b))).toBe(false);
    const noHooks = await setup(b, ['hermes', '--no-hooks', '--json']);
    expect(noHooks.exitCode).toBe(0);
    expect(items(b, 'pre_llm_call')).toHaveLength(1);
  });

  test('a live PGLite owner that this setup did not register is an owner conflict; setup writes nothing', async () => {
    const b = box();
    expect((await runCli(['init', '--pglite', '--no-embedding'], { home: b.home })).exitCode).toBe(0);
    const serve = Bun.spawn([process.execPath, '--no-env-file', CLI, 'serve'], {
      env: { ...process.env, HOME: b.home, GBRAIN_HOME: b.gbrainHome, GBRAIN_SKIP_STARTUP_HOOKS: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const lockFile = join(b.gbrainHome, '.gbrain', 'brain.pglite', '.gbrain-lock', 'lock');
      for (let i = 0; i < 300 && !existsSync(lockFile); i++) await Bun.sleep(50);
      expect(existsSync(lockFile)).toBe(true);
      const r = await setup(b, ['hermes', '--json']);
      expect(r.exitCode).toBe(1);
      expect(r.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'live_serve' });
      expect(r.doc.fix.argv).toEqual(['kill', String(serve.pid)]);
      expect(existsSync(hermesDir(b))).toBe(false);
    } finally {
      serve.kill();
      await serve.exited;
    }
  });

  test('a live HTTP serve owner points at the hosted/HTTP lane, not at bootstrap harness (which does not wire Hermes)', async () => {
    const b = box();
    expect((await runCli(['init', '--pglite', '--no-embedding'], { home: b.home })).exitCode).toBe(0);
    const serve = Bun.spawn([process.execPath, '--no-env-file', CLI, 'serve', '--http', '--port', '0'], {
      env: { ...process.env, HOME: b.home, GBRAIN_HOME: b.gbrainHome, GBRAIN_SKIP_STARTUP_HOOKS: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const lockFile = join(b.gbrainHome, '.gbrain', 'brain.pglite', '.gbrain-lock', 'lock');
      for (let i = 0; i < 300 && !existsSync(lockFile); i++) await Bun.sleep(50);
      expect(existsSync(lockFile)).toBe(true);
      const r = await setup(b, ['hermes', '--json']);
      expect(r.exitCode).toBe(1);
      expect(r.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'live_serve' });
      expect(r.doc.fix.argv.slice(0, 5)).toEqual(['gbrain', 'hermes', 'setup', '--hermes-home', hermesDir(b)]);
      expect(r.doc.fix.argv).not.toContain('bootstrap');
      expect(existsSync(hermesDir(b))).toBe(false);
    } finally {
      serve.kill();
      await serve.exited;
    }
  });

  test('a live stdio serve started by this setup\'s own registration is reused, not a conflict', async () => {
    const b = box();
    expect((await setup(b, ['hermes'])).exitCode).toBe(0);
    const entry = yaml(b).mcp_servers.gbrain;
    const serve = Bun.spawn([entry.command, ...entry.args], {
      env: { ...process.env, ...entry.env, HOME: b.home, GBRAIN_SKIP_STARTUP_HOOKS: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const lockFile = join(b.gbrainHome, '.gbrain', 'brain.pglite', '.gbrain-lock', 'lock');
      for (let i = 0; i < 300 && !existsSync(lockFile); i++) await Bun.sleep(50);
      const r = await setup(b, ['hermes', '--json']);
      expect(r.exitCode).toBe(0);
      expect(r.doc.target.live_owner).toMatchObject({ pid: serve.pid, transport: 'stdio', ours: true });
      expect(r.doc.verify.reason).toBe('wired_running');
    } finally {
      serve.kill();
      await serve.exited;
    }
  });
});

describe('gbrain setup hermes: consent and flags', () => {
  test('provider keys present + capture declined + existing opt-outs: no capture hook, no provider traffic, keyless brain', async () => {
    const seen: string[] = [];
    const recorder: Server = createServer((sock) => {
      sock.once('data', (d) => { seen.push(d.toString('utf8').split('\r\n')[0] ?? ''); sock.destroy(); });
    });
    await new Promise<void>((ok) => recorder.listen(0, '127.0.0.1', ok));
    const port = (recorder.address() as { port: number }).port;
    const providerEnv = {
      OPENAI_API_KEY: 'sk-test-hermes-setup', ANTHROPIC_API_KEY: 'sk-ant-test-hermes-setup', VOYAGE_API_KEY: 'pa-test-setup', GEMINI_API_KEY: 'gm-test-setup',
      HTTPS_PROXY: `http://127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}`, http_proxy: `http://127.0.0.1:${port}`,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    };
    try {
      const fresh = box();
      const r = await setup(fresh, ['hermes', '--no-capture', '--json'], providerEnv);
      expect(r.exitCode).toBe(0);
      expect(r.doc.consent.capture).toMatchObject({ value: 'declined', source: 'flag' });
      expect(r.doc.consent.providers).toMatchObject({ value: 'declined', source: 'default' });
      expect(readJson(join(fresh.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);
      expect(items(fresh, 'on_session_finalize')).toEqual([]);

      const optedOut = box();
      expect((await runCli(['init', '--pglite', '--no-embedding'], { home: optedOut.home })).exitCode).toBe(0);
      const gbrainCfg = join(optedOut.gbrainHome, '.gbrain', 'config.json');
      writeFileSync(gbrainCfg, JSON.stringify({ ...readJson(gbrainCfg), memory: { auto_writeback: 'off' } }));
      const o = await setup(optedOut, ['hermes', '--capture', '--json'], providerEnv);
      expect(o.exitCode).toBe(0);
      expect(o.doc.consent.capture).toMatchObject({ value: 'declined', source: 'opt_out' });
      expect(o.doc.notes.join(' ')).toContain('--capture ignored');
      expect(Object.keys(yaml(optedOut).hooks)).toEqual(['pre_llm_call']);

      const hooksOff = box();
      const k = await setup(hooksOff, ['hermes', '--capture', '--json'], { ...providerEnv, GBRAIN_HOOKS: '0' });
      expect(k.exitCode).toBe(0);
      expect(k.doc.consent.wiring_scope).toMatchObject({ value: { hooks: 'none' }, source: 'opt_out' });
      expect(yaml(hooksOff).hooks).toBeUndefined();
      expect(approvals(hooksOff)).toEqual([]);
      expect(yaml(hooksOff).mcp_servers.gbrain).toBeDefined();
      expect(k.doc.states).toEqual(['configured', 'connection-verified', 'native-pending']);

      expect(seen.filter((l) => /openai|anthropic|voyage|googleapis|\/v1\//i.test(l))).toEqual([]);
      for (const b of [fresh, optedOut, hooksOff]) expect(existsSync(join(b.gbrainHome, '.gbrain', 'corpus'))).toBe(false);
    } finally {
      recorder.close();
    }
  });

  test('--capture adds the on_session_finalize capture hook (detached, pinned to the profile) and its approval; --no-hooks then removes every owned hook and approval', async () => {
    const b = box();
    const r = await setup(b, ['hermes', '--capture', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.consent.capture).toMatchObject({ value: 'accepted', source: 'flag' });
    expect(Object.keys(yaml(b).hooks).sort()).toEqual(['on_session_finalize', 'pre_llm_call']);
    const end = items(b, 'on_session_finalize')[0];
    expect(end.timeout).toBe(5);
    expect(end.command).toMatch(/^env GBRAIN_HOOK_LANE=setup GBRAIN_HOME=\S+ HERMES_HOME=\S+ sh -c '.*hook session-end --harness hermes/);
    expect(end.command).toContain(`HERMES_HOME=${hermesDir(b)} `);
    expect(approvals(b).map((a) => a.event).sort()).toEqual(['on_session_finalize', 'pre_llm_call']);
    const off = await setup(b, ['hermes', '--no-hooks', '--json']);
    expect(off.exitCode).toBe(0);
    expect(yaml(b).hooks ?? {}).toEqual({});
    expect(approvals(b)).toEqual([]);
    expect(yaml(b).mcp_servers.gbrain).toBeDefined();
  });

  test('--capture is sticky across runs, and an existing gbrain-session-corpus plugin is named in a note', async () => {
    const b = box();
    mkdirSync(join(hermesDir(b), 'plugins', 'gbrain-session-corpus'), { recursive: true });
    const first = await setup(b, ['hermes', '--capture', '--json']);
    expect(first.doc.notes.join(' ')).toContain('gbrain-session-corpus');
    const again = await setup(b, ['hermes', '--dry-run', '--json']);
    expect(again.doc.consent.capture).toMatchObject({ value: 'accepted', source: 'prior' });
    expect(Object.keys(yaml(b).hooks).sort()).toEqual(['on_session_finalize', 'pre_llm_call']);
  });

  test('a declined provider decision is recorded in the receipt and survives a rerun', async () => {
    const b = box();
    const r = await setup(b, ['hermes', '--no-providers', '--json']);
    expect(r.doc.consent.providers).toMatchObject({ value: 'declined', source: 'flag' });
    expect(readJson(receiptPath(b)).consent.providers.value).toBe('declined');
    const again = await setup(b, ['hermes', '--dry-run', '--json']);
    expect(again.doc.consent.providers).toMatchObject({ value: 'declined', source: 'prior' });
  });

  test('openclaw stays a coded refusal that names its guide; hermes no longer is one', async () => {
    const b = box();
    const r = await setup(b, ['openclaw', '--json']);
    expect(r.exitCode).toBe(2);
    expect(r.doc.code).toBe('setup_harness_unsupported');
    expect(r.doc.message).toContain('docs/mcp/OPENCLAW.md');
    expect(existsSync(hermesDir(b))).toBe(false);
    const h = await setup(b, ['hermes', '--dry-run', '--json']);
    expect(h.exitCode).toBe(0);
  });
});
