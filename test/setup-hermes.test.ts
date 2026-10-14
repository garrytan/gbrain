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
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import { shlexSplit } from '../src/core/bootstrap/hermes-hooks.ts';
import { applyHermesSetup, type HermesSetupPlan } from '../src/core/setup/hermes.ts';
import { HermesConfigConflict } from '../src/core/bootstrap/hermes-yaml.ts';
import { installHermesPlugin } from '../src/core/harness/hermes.ts';
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
const ENV = existsSync('/usr/bin/env') ? '/usr/bin/env' : 'env';
const userPromptCommand = (b: Box, extra = '') => `${ENV} GBRAIN_HOOK_LANE=setup GBRAIN_HOME=${b.gbrainHome}${extra} ${b.bin} hook user-prompt --harness hermes`;

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
    expect(first.doc.states).toEqual(['configured', 'connection-verified', 'native-verified']);
    expect(first.doc.capability).toMatchObject({ harness: 'hermes', setup: 'supported', pull: 'connection-verified', push: 'native-verified', read_events: ['pre_llm_call'], capture_events: ['on_session_finalize'] });
    expect(first.doc.capability_table_version).toBe(4);
    expect(first.doc.consent.capture).toMatchObject({ value: 'declined', source: 'default' });
    expect(first.doc.consent.providers).toMatchObject({ value: 'declined', source: 'default' });
    expect(readJson(join(b.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);

    const cfg = yaml(b);
    expect(cfg.mcp_servers.gbrain).toEqual({ command: b.bin, args: ['serve', '--surface', 'full'], env: { GBRAIN_HOME: b.gbrainHome } });
    expect(Object.keys(cfg.hooks)).toEqual(['pre_llm_call']);
    expect(cfg.hooks.pre_llm_call).toEqual([{ command: userPromptCommand(b), timeout: 10 }]);
    expect(cfg.memory).toBeUndefined();
    expect(cfg.hooks_auto_accept).toBeUndefined();
    expect(approvals(b)).toEqual([{ approved_at: expect.any(String), command: userPromptCommand(b), event: 'pre_llm_call', script_mtime_at_approval: expect.any(String) }]);
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
    expect(end.command).toMatch(/^\S*env GBRAIN_HOOK_LANE=setup GBRAIN_HOME=\S+ HERMES_HOME=\S+ sh -c '.*hook session-end --harness hermes/);
    expect(end.command).toContain(`HERMES_HOME=${hermesDir(b)} `);
    expect(approvals(b).map((a) => a.event).sort()).toEqual(['on_session_finalize', 'pre_llm_call']);
    const off = await setup(b, ['hermes', '--no-hooks', '--json']);
    expect(off.exitCode).toBe(0);
    expect(yaml(b).hooks ?? {}).toEqual({});
    expect(approvals(b)).toEqual([]);
    expect(yaml(b).mcp_servers.gbrain).toBeDefined();
  });

  test('the written hooks run the way Hermes runs them: shlex argv, no shell; the detached capture command spools the session from the profile state.db', async () => {
    const b = box();
    mkdirSync(hermesDir(b), { recursive: true });
    buildHermesFixture(hermesDir(b));
    expect((await setup(b, ['hermes', '--capture'])).exitCode).toBe(0);
    const prompt = shlexSplit(items(b, 'pre_llm_call')[0].command)!;
    expect(prompt.slice(0, 3)).toEqual([ENV, 'GBRAIN_HOOK_LANE=setup', `GBRAIN_HOME=${b.gbrainHome}`]);
    expect(prompt.slice(3)).toEqual([b.bin, 'hook', 'user-prompt', '--harness', 'hermes']);
    const argv = shlexSplit(items(b, 'on_session_finalize')[0].command)!;
    const proc = Bun.spawn(argv, { env: { ...process.env, HOME: b.home, GBRAIN_SKIP_STARTUP_HOOKS: '1' }, stdin: new Blob([JSON.stringify({ hook_event_name: 'on_session_finalize', session_id: 'hermes-fixture-1', cwd: b.home, extra: { platform: 'cli' } })]), stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe('');
    const spooled = join(b.gbrainHome, '.gbrain', 'transcripts', 'corpus', 'sourced', 'hermes-fixture-1.src-_unresolved.txt');
    for (let i = 0; i < 200 && !existsSync(spooled); i++) await Bun.sleep(100);
    expect(readFileSync(spooled, 'utf8')).toContain('Draft the widget-co launch checklist.');
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

// ── review-driven regressions (independent review of the first implementation) ──────────────────────────────

const noBrain = (b: Box) => expect(existsSync(join(b.gbrainHome, '.gbrain'))).toBe(false);

describe('review finding 1: unsupported config shapes are refused before ANY write; null headers are supported', () => {
  for (const [label, text] of [['mcp_servers: null', 'model: x\nmcp_servers: null\n'], ['mcp_servers: ~', 'mcp_servers: ~\n'], ['hooks: null and hooks.pre_llm_call: null', 'hooks:\n  pre_llm_call: null\n']] as const) {
    test(`${label}: setup --capture succeeds and --remove restores the original bytes`, async () => {
      const b = box();
      writeCfg(b, text);
      const r = await setup(b, ['hermes', '--capture', '--json']);
      expect(r.exitCode).toBe(0);
      expect(yaml(b).mcp_servers.gbrain).toBeDefined();
      expect(items(b, 'pre_llm_call')).toHaveLength(1);
      expect(items(b, 'on_session_finalize')).toHaveLength(1);
      expect((await setup(b, ['hermes', '--remove', '--json'])).exitCode).toBe(0);
      expect(readFileSync(cfgPath(b), 'utf8')).toBe(text);
    });
  }
  for (const [label, text, args] of [
    ['hooks as a list', 'hooks:\n  - a\n  - b\n', ['--capture']],
    ['a non-empty flow hooks.pre_llm_call', 'hooks:\n  pre_llm_call: [{command: /bin/x}]\n', []],
    ['a non-empty flow mcp_servers', 'mcp_servers: {other: {command: /bin/true}}\n', ['--capture']],
    ['an anchored mcp_servers header', 'mcp_servers: &m\n  other:\n    command: /bin/true\n', []],
  ] as const) {
    test(`${label}: exit 1 with a clear message, no brain, no receipt, config byte-identical`, async () => {
      const b = box();
      writeCfg(b, text);
      const r = await setup(b, ['hermes', ...args, '--json']);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/cannot edit safely|would change other settings|is not a mapping|is not a list|cannot be located|cannot rewrite/);
      expect(existsSync(receiptPath(b))).toBe(false);
      expect(existsSync(allowPath(b))).toBe(false);
      expect(readFileSync(cfgPath(b), 'utf8')).toBe(text);
      noBrain(b);
    });
  }
});

describe('review finding 2: a non-default profile is pinned and its receipt is found without HERMES_HOME', () => {
  const profile = (b: Box) => join(b.home, '.hermes', 'profiles', 'research');

  test('a named profile pins HERMES_HOME in the MCP env and the read hook; the default profile keeps the plain entry', async () => {
    const b = box();
    const named = await setup(b, ['hermes', '--hermes-home', profile(b), '--capture', '--json']);
    expect(named.exitCode).toBe(0);
    const cfg: any = load(readFileSync(join(profile(b), 'config.yaml'), 'utf8'));
    expect(cfg.mcp_servers.gbrain.env).toEqual({ GBRAIN_HOME: b.gbrainHome, HERMES_HOME: profile(b) });
    expect(cfg.hooks.pre_llm_call[0].command).toContain(`HERMES_HOME=${profile(b)} `);
    expect(cfg.hooks.on_session_finalize[0].command).toContain(`HERMES_HOME=${profile(b)} `);
    const d = box();
    expect((await setup(d, ['hermes', '--json'])).exitCode).toBe(0);
    expect(yaml(d).mcp_servers.gbrain.env).toEqual({ GBRAIN_HOME: d.gbrainHome });
    expect(yaml(d).hooks.pre_llm_call[0].command).not.toContain('HERMES_HOME');
    // An explicit --hermes-home that IS the default profile is the default entry, not a pinned one.
    const e = box();
    expect((await setup(e, ['hermes', '--hermes-home', hermesDir(e), '--json'])).exitCode).toBe(0);
    expect(yaml(e).mcp_servers.gbrain.env).toEqual({ GBRAIN_HOME: e.gbrainHome });
  });

  test('provider-recorder proxy: a gbrain process started with ONLY the named profile\'s entry env honors the recorded decline (and does not without the receipt)', async () => {
    const seen: string[] = [];
    const recorder = Bun.serve({ port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(`${req.method} ${path}`);
      if (path.endsWith('/embeddings')) return Response.json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: Array(1536).fill(0) }], model: 'text-embedding-3-large', usage: { prompt_tokens: 1, total_tokens: 1 } });
      return Response.json({ object: 'list', data: [{ id: 'text-embedding-3-large', object: 'model' }] });
    } });
    try {
      const b = box();
      expect((await setup(b, ['hermes', '--hermes-home', profile(b), '--json'])).exitCode).toBe(0);
      const entry = (load(readFileSync(join(profile(b), 'config.yaml'), 'utf8')) as any).mcp_servers.gbrain;
      // Since #6607 discovery runs only before an OpenAI-routed call, so measure the decline on one: the opt-in embedding probe.
      const cfgFile = join(b.gbrainHome, '.gbrain', 'config.json');
      const cfg = readJson(cfgFile) as Record<string, unknown>;
      delete cfg.embedding_disabled;
      writeFileSync(cfgFile, JSON.stringify({ ...cfg, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 }));
      const probeOnce = async (): Promise<void> => {
        // What Hermes hands a stdio child: a safe baseline plus the entry's own env. Nothing else (no HERMES_HOME of the launcher).
        const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: b.home, ...entry.env, GBRAIN_SKIP_STARTUP_HOOKS: '1',
          OPENAI_API_KEY: 'sk-rec...-key', OPENAI_BASE_URL: `http://127.0.0.1:${recorder.port}/v1` };
        const proc = Bun.spawn([entry.command, 'doctor', '--only', 'embedding_provider', '--probe', '--yes', '--json'], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
      };
      seen.length = 0;
      await probeOnce();
      expect(seen).toEqual([]);
      // Control: the same process with the profile's receipt moved aside does contact the provider, so the recorder sees what a decline suppresses.
      const aside = `${receiptPathIn(profile(b))}.aside`;
      const { renameSync } = await import('node:fs');
      renameSync(receiptPathIn(profile(b)), aside);
      await probeOnce();
      expect(seen.join(' ')).toMatch(/\/v1\/(models|embeddings)/);
    } finally {
      recorder.stop(true);
    }
  }, 180_000);
});
const receiptPathIn = (home: string, name = 'gbrain') => join(home, `.gbrain-connection-hermes-${name}.json`);

describe('review finding 5: --source is pinned on the capture hook too', () => {
  test('--source X --capture puts GBRAIN_SOURCE=X on the user-prompt AND the session-end command, and the MCP env', async () => {
    const b = box();
    expect((await runCli(['init', '--pglite', '--no-embedding'], { home: b.home })).exitCode).toBe(0);
    const dir = join(b.root, 'acme-notes');
    mkdirSync(dir);
    expect((await runCli(['sources', 'add', 'acme-notes', '--path', dir, '--force'], { home: b.home })).exitCode).toBe(0);
    const r = await setup(b, ['hermes', '--source', 'acme-notes', '--capture', '--json']);
    expect(r.exitCode).toBe(0);
    expect(yaml(b).mcp_servers.gbrain.env).toEqual({ GBRAIN_HOME: b.gbrainHome, GBRAIN_SOURCE: 'acme-notes' });
    for (const event of ['pre_llm_call', 'on_session_finalize']) {
      const argv = shlexSplit(items(b, event)[0].command)!;
      expect(argv).toContain('GBRAIN_SOURCE=acme-notes');
      expect(argv.indexOf('GBRAIN_SOURCE=acme-notes')).toBeLessThan(argv.findIndex((t) => t === 'sh' || t === b.bin));
    }
  });
});

describe('review finding 6: --remove with an unlocatable entry keeps a receipt; a UTF-8 BOM is locatable', () => {
  test('a BOM config installs, is removed byte for byte, and the receipt goes', async () => {
    const b = box();
    const text = '\uFEFFmodel: x\nmcp_servers:\n  other:\n    command: /bin/true\n';
    writeCfg(b, text);
    expect((await setup(b, ['hermes', '--capture', '--json'])).exitCode).toBe(0);
    const removed = await setup(b, ['hermes', '--remove', '--json']);
    expect(removed.doc.preserved).toEqual([]);
    expect(readFileSync(cfgPath(b), 'utf8')).toBe(text);
    expect(existsSync(receiptPath(b))).toBe(false);
  });

  test('an entry re-rendered in a shape setup cannot locate is preserved AND remembered: the receipt stays (removed), a later setup does not adopt it', async () => {
    const b = box();
    expect((await setup(b, ['hermes', '--json'])).exitCode).toBe(0);
    const entry = yaml(b).mcp_servers.gbrain;
    // Same parsed value, different layout: a flow mapping under the block header (what a hand edit or a dumper can produce).
    writeCfg(b, `mcp_servers:\n  gbrain: ${JSON.stringify(entry)}\n`);
    const removed = await setup(b, ['hermes', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toContainEqual({ kind: 'mcp', reason: 'unlocatable' });
    expect(yaml(b).mcp_servers.gbrain).toEqual(entry);
    const kept = readJson(receiptPath(b));
    expect(kept.status).toBe('removed');
    expect(kept.entry_hash).toEqual(expect.any(String));
    const again = await setup(b, ['hermes', '--json']);
    expect(again.exitCode).toBe(0);
    expect(readJson(receiptPath(b)).mcp_adopted).toBeUndefined();
    const second = await setup(b, ['hermes', '--remove', '--json']);
    expect(second.doc.preserved).toContainEqual({ kind: 'mcp', reason: 'unlocatable' });
    expect(existsSync(receiptPath(b))).toBe(true);
  });
});

describe('review finding 8: the written hooks pass real Hermes\' own executable and mtime checks', () => {
  const hermesRepo = join(homedir(), '.hermes', 'hermes-agent');
  const py = join(hermesRepo, 'venv', 'bin', 'python');
  test.skipIf(!existsSync(py) || !existsSync(join(hermesRepo, 'agent', 'shell_hooks.py')))('script_is_executable, script_mtime_iso and allowlist_entry_for (read-only Hermes source, throwaway HERMES_HOME, no model call)', async () => {
    const b = box();
    expect((await setup(b, ['hermes', '--capture'])).exitCode).toBe(0);
    const cmds = ['pre_llm_call', 'on_session_finalize'].map((e) => [e, items(b, e)[0].command]);
    const code = `import sys, json\nsys.path.insert(0, ${JSON.stringify(hermesRepo)})\nfrom agent import shell_hooks as sh\nout = {}\nfor e, c in json.loads(sys.argv[1]):\n    ent = sh.allowlist_entry_for(e, c)\n    out[e] = {'exec': sh.script_is_executable(c), 'mtime': sh.script_mtime_iso(c), 'approved': ent is not None, 'approved_mtime': (ent or {}).get('script_mtime_at_approval')}\nprint(json.dumps(out))`;
    const proc = Bun.spawn([py, '-I', '-c', code, JSON.stringify(cmds)], { env: { PATH: process.env.PATH ?? '', HERMES_HOME: hermesDir(b), HOME: b.home }, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited, err).toBe(0);
    const got = JSON.parse(out.trim().split('\n').pop()!);
    for (const e of ['pre_llm_call', 'on_session_finalize']) {
      expect(got[e].exec).toBe(true);
      expect(got[e].mtime).toEqual(expect.any(String));
      expect(got[e].approved).toBe(true);
      expect(got[e].approved_mtime).toEqual(expect.any(String));
    }
  }, 60_000);

  test('every hook command starts with an absolute launcher, so its first path-like token is a real executable (not GBRAIN_HOME=/…)', async () => {
    const b = box();
    expect((await setup(b, ['hermes', '--capture'])).exitCode).toBe(0);
    for (const e of ['pre_llm_call', 'on_session_finalize']) {
      const first = shlexSplit(items(b, e)[0].command)![0]!;
      expect(first.startsWith('/') || first === 'env').toBe(true);
      if (first.startsWith('/')) expect(statSync(first).mode & 0o111).not.toBe(0);
    }
  });
});

describe('review finding 9: a config.yaml write during setup aborts it instead of being overwritten', () => {
  test('Hermes writing between inspect and the MCP write: configuration_conflict, the foreign write is intact, the receipt stays prepared and a rerun converges', async () => {
    const b = box();
    const home = hermesDir(b);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.yaml'), 'model: x\n');
    const consent: any = { wiring_scope: { value: { scope: 'user', hooks: 'read-context' }, source: 'default' }, capture: { value: 'declined', source: 'default' }, providers: { value: 'declined', source: 'default' } };
    const plan: HermesSetupPlan = { name: 'gbrain', launcher: b.bin, brainHome: join(b.gbrainHome, '.gbrain'), gbrainHomeEnv: b.gbrainHome, hermesHome: home, sourceId: null, surface: 'full', events: ['pre_llm_call'] };
    const midWrite = 'model: x\nhermes_wrote: this-during-setup\n';
    await expect(applyHermesSetup(plan, consent, { brainCreated: false, beforeMcp: async () => { writeFileSync(join(home, 'config.yaml'), midWrite); } })).rejects.toBeInstanceOf(HermesConfigConflict);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(midWrite);
    expect(readJson(receiptPath(b)).status).toBe('prepared');
    const done = await applyHermesSetup(plan, consent, { brainCreated: false });
    expect(done.receipt.status).toBe('installed');
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('hermes_wrote: this-during-setup');
    expect(yaml(b).mcp_servers.gbrain).toBeDefined();
  });
});

describe('review finding 11: --providers lets the Hermes-spawned serve see the keys it needs, by reference only', () => {
  const secret = ['sk', 'proj', 'review', 'finding', '11', 'not', 'real'].join('-');
  async function brainFirst(b: Box): Promise<void> { expect((await runCli(['init', '--pglite', '--no-embedding'], { home: b.home })).exitCode).toBe(0); }

  test('accepted + OPENAI_API_KEY in the env: the entry references ${OPENAI_API_KEY}; the value is written nowhere; a rerun keeps it', async () => {
    const b = box();
    await brainFirst(b);
    const r = await setup(b, ['hermes', '--providers', '--json'], { OPENAI_API_KEY: secret });
    expect(r.exitCode).toBe(0);
    expect(yaml(b).mcp_servers.gbrain.env).toEqual({ GBRAIN_HOME: b.gbrainHome, OPENAI_API_KEY: '${OPENAI_API_KEY}' });
    expect(r.doc.notes.join(' ')).toContain('.env');
    for (const p of [cfgPath(b), receiptPath(b), allowPath(b)]) if (existsSync(p)) expect(readFileSync(p, 'utf8')).not.toContain(secret);
    expect(r.stdout).not.toContain(secret);
    const again = await setup(b, ['hermes', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.steps.map((s: any) => [s.step, s.action])).toEqual([['receipt', 'keep'], ['mcp', 'keep'], ['hooks', 'keep'], ['trust', 'keep']]);
    expect(yaml(b).mcp_servers.gbrain.env.OPENAI_API_KEY).toBe('${OPENAI_API_KEY}');
  });

  test('declined (the default), or no key set, or the key already in config.json: no placeholder', async () => {
    const declined = box();
    expect((await setup(declined, ['hermes', '--json'], { OPENAI_API_KEY: secret })).exitCode).toBe(0);
    expect(yaml(declined).mcp_servers.gbrain.env).toEqual({ GBRAIN_HOME: declined.gbrainHome });
    const keyless = box();
    await brainFirst(keyless);
    expect((await setup(keyless, ['hermes', '--providers', '--json'], { OPENAI_API_KEY: undefined })).exitCode).toBe(0);
    expect(yaml(keyless).mcp_servers.gbrain.env).toEqual({ GBRAIN_HOME: keyless.gbrainHome });
    const inFile = box();
    await brainFirst(inFile);
    const cfgFile = join(inFile.gbrainHome, '.gbrain', 'config.json');
    writeFileSync(cfgFile, JSON.stringify({ ...readJson(cfgFile), openai_api_key: secret }));
    expect((await setup(inFile, ['hermes', '--providers', '--json'], { OPENAI_API_KEY: secret })).exitCode).toBe(0);
    expect(yaml(inFile).mcp_servers.gbrain.env).toEqual({ GBRAIN_HOME: inFile.gbrainHome });
  });
});

describe('review finding 13: provider-lane interaction', () => {
  test('memory.provider: gbrain in config.yaml is refused with a pointer to removing the hosted lane; nothing is written', async () => {
    const b = box();
    const text = 'memory:\n  provider: gbrain\n  gbrain:\n    url: https://brain.example.test/mcp\n';
    writeCfg(b, text);
    const r = await setup(b, ['hermes', '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'harness_lane' });
    expect(r.doc.fix.argv.slice(0, 6)).toEqual(['gbrain', 'hermes', 'setup', '--hermes-home', hermesDir(b), '--remove']);
    expect(readFileSync(cfgPath(b), 'utf8')).toBe(text);
    expect(existsSync(receiptPath(b))).toBe(false);
    noBrain(b);
  });

  test('the hosted provider lane refuses a setup-owned mcp_servers.gbrain and names `gbrain setup hermes --remove`', async () => {
    const b = box();
    expect((await setup(b, ['hermes', '--json'])).exitCode).toBe(0);
    await expect(installHermesPlugin({ home: hermesDir(b), url: 'https://brain.example/mcp', token: 'synthetic-token', assets: { 'plugin.yaml': 'name: gbrain\n' } }))
      .rejects.toThrow(/gbrain setup hermes --remove/);
  });
});
