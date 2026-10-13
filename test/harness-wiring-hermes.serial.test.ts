/**
 * Hermes registrations in the doctor `harness_wiring` reader and the local
 * setup-receipt scan that provider consent and the first-turn serve wait use.
 *
 * Authoring gate:
 *  1. Protects: `gbrain doctor` reads the stdio (and HTTP) `mcp_servers.<name>`
 *     entry a Hermes profile carries, so a setup-wired Hermes is smoke-tested
 *     instead of reported "installed but no registration"; a Hermes setup
 *     receipt is visible to provider-consent enforcement and to the hook's
 *     serve wait; a profile's receipt is found only when HERMES_HOME names it.
 *  2. Fails on: a Hermes profile ignored by the reader, a Hermes receipt that
 *     cannot decline provider use, a foreign install's receipt honored.
 *  3. Serial: sets HERMES_HOME / GBRAIN_HOME / HOME in process.env.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessWiringCheck, readHarnessRegistrations } from '../src/commands/doctor/checks/harness-wiring.ts';
import { hermesSpawnsServe, localSetupRecords, providerDeclineRecord } from '../src/core/setup/local-receipts.ts';
import { withEnv } from './helpers/with-env.ts';
import { sessionStartAwaitsServe } from '../src/core/context/session-start-pack.ts';
import { harnessWiringEntry } from '../src/core/readiness.ts';
import { configDir } from '../src/core/config.ts';

const KEYS = ['HERMES_HOME', 'GBRAIN_HOME', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const;
let tmp: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-hw-'));
  saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.HOME = tmp;
  process.env.GBRAIN_HOME = tmp;
  process.env.HERMES_HOME = join(tmp, 'profile');
  mkdirSync(process.env.HERMES_HOME, { recursive: true });
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

const profile = () => process.env.HERMES_HOME!;
const writeConfig = (text: string) => writeFileSync(join(profile(), 'config.yaml'), text);
function writeReceipt(over: Record<string, unknown> = {}, home = profile()): void {
  writeFileSync(join(home, '.gbrain-connection-hermes-gbrain.json'), JSON.stringify({
    harness: 'hermes', connection: 'local-stdio', setup_receipt_version: 3, status: 'installed', name: 'gbrain',
    gbrain_home: configDir(), consent: { providers: { value: 'declined', source: 'default' } }, ...over }));
}

describe('readHarnessRegistrations: Hermes', () => {
  test('reads a stdio mcp_servers entry (command, args, env) from the active profile config.yaml', () => {
    writeConfig('model: x\nmcp_servers:\n  gbrain:\n    command: /abs/gbrain\n    args: [serve, --surface, full]\n    env:\n      GBRAIN_HOME: /h\n');
    const r = readHarnessRegistrations().filter((x) => x.harness === 'hermes');
    expect(r).toEqual([{ harness: 'hermes', source: join(profile(), 'config.yaml'), kind: 'stdio', command: '/abs/gbrain', args: ['serve', '--surface', 'full'], env: { GBRAIN_HOME: '/h' } }]);
  });
  test('an HTTP entry is kind http; a missing, unparseable or entry-less config is no registration', () => {
    writeConfig('mcp_servers:\n  gbrain:\n    url: http://127.0.0.1:3131/mcp\n');
    expect(readHarnessRegistrations().find((x) => x.harness === 'hermes')).toMatchObject({ kind: 'http', url: 'http://127.0.0.1:3131/mcp' });
    writeConfig('mcp_servers: [unclosed\n');
    expect(readHarnessRegistrations().some((x) => x.harness === 'hermes')).toBe(false);
    writeConfig('mcp_servers:\n  other:\n    command: /bin/true\n');
    expect(readHarnessRegistrations().some((x) => x.harness === 'hermes')).toBe(false);
    rmSync(join(profile(), 'config.yaml'));
    expect(readHarnessRegistrations().some((x) => x.harness === 'hermes')).toBe(false);
  });
  test('the rewire fix for an unregistered Hermes is `gbrain setup hermes`, and the shared-HTTP fix is the hosted lane, not bootstrap harness', () => {
    const missing = harnessWiringEntry({ transport: 'cli', harnesses: ['hermes'], lockOwner: null, gbrainBin: '/abs/gbrain' });
    expect(missing.fix?.argv).toEqual(['gbrain', 'setup', 'hermes']);
    const shared = harnessWiringEntry({ transport: 'cli', harnesses: ['hermes'], lockOwner: { pid: 1, transport: 'http', is_self: false }, gbrainBin: '/abs/gbrain' });
    expect(shared.fix?.argv?.slice(0, 3)).toEqual(['gbrain', 'hermes', 'setup']);
    expect(shared.fix?.argv).not.toContain('bootstrap');
  });
});

describe('local setup receipts: Hermes', () => {
  test('a Hermes receipt in HERMES_HOME is a local record and can decline provider use', () => {
    writeReceipt();
    const records = localSetupRecords();
    expect(records.map((r) => r.harness)).toEqual(['hermes']);
    expect(providerDeclineRecord()).toMatchObject({ harness: 'hermes', providers: 'declined', status: 'installed' });
  });
  test('a receipt of another install, a removed or unreadable one is ignored', () => {
    writeReceipt({ gbrain_home: '/somewhere/else/.gbrain' });
    expect(providerDeclineRecord()).toBeNull();
    writeReceipt({ status: 'removed' });
    expect(providerDeclineRecord()).toBeNull();
    writeFileSync(join(profile(), '.gbrain-connection-hermes-gbrain.json'), '{nope');
    expect(providerDeclineRecord()).toBeNull();
  });
  test('an accepted decision does not decline; hermesSpawnsServe needs an installed Hermes receipt', () => {
    writeReceipt({ consent: { providers: { value: 'accepted', source: 'flag' } } });
    expect(providerDeclineRecord()).toBeNull();
    expect(hermesSpawnsServe()).toBe(true);
    writeReceipt({ status: 'prepared' });
    expect(hermesSpawnsServe()).toBe(false);
  });
  test('sessionStartAwaitsServe waits for a setup-wired Hermes first turn only (startup/resume), never for another harness', () => {
    writeReceipt();
    expect(sessionStartAwaitsServe('startup', 'hermes', tmp)).toBe(true);
    expect(sessionStartAwaitsServe('resume', 'hermes', tmp)).toBe(true);
    expect(sessionStartAwaitsServe('clear', 'hermes', tmp)).toBe(false);
    expect(sessionStartAwaitsServe('startup', 'codex', tmp)).toBe(false);
    rmSync(join(profile(), '.gbrain-connection-hermes-gbrain.json'));
    expect(sessionStartAwaitsServe('startup', 'hermes', tmp)).toBe(false);
  });
});

describe('review finding 12: a bare Hermes install does not count as a gbrain harness', () => {
  const clean = { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, CODEX_CI: undefined, OPENCODE: undefined, OPENCODE_PID: undefined, XDG_CONFIG_HOME: undefined };

  test('Claude Code + a bare ~/.hermes/config.yaml (no gbrain entry, no receipt) keeps the single-harness verdict', async () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    mkdirSync(join(tmp, '.hermes'), { recursive: true });
    writeFileSync(join(tmp, '.hermes', 'config.yaml'), 'model: x\nmcp_servers:\n  other:\n    command: /bin/true\n');
    await withEnv({ ...clean, HERMES_HOME: join(tmp, '.hermes'), CLAUDE_CONFIG_DIR: join(tmp, '.claude'), CODEX_HOME: join(tmp, 'no-codex') }, async () => {
      const check = await harnessWiringCheck({ smoke: false });
      expect(check.status).toBe('warn');
      expect(check.message).toMatch(/^Claude Code is installed but has no gbrain MCP registration/);
      expect(check.message).not.toContain('Hermes');
      expect(check.message).not.toContain('Several');
    });
  });

  test('...while a Hermes profile that has a gbrain entry, or a gbrain receipt, does count', async () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    mkdirSync(join(tmp, '.hermes'), { recursive: true });
    const env = { ...clean, HERMES_HOME: join(tmp, '.hermes'), CLAUDE_CONFIG_DIR: join(tmp, '.claude'), CODEX_HOME: join(tmp, 'no-codex') };
    writeFileSync(join(tmp, '.hermes', 'config.yaml'), 'model: x\n');
    writeReceipt({}, join(tmp, '.hermes'));
    await withEnv(env, async () => {
      const check = await harnessWiringCheck({ smoke: false });
      expect(check.message).toMatch(/Claude Code, Hermes are installed but have no gbrain MCP registration/);
    });
    rmSync(join(tmp, '.hermes', '.gbrain-connection-hermes-gbrain.json'));
    writeFileSync(join(tmp, '.hermes', 'config.yaml'), 'mcp_servers:\n  gbrain:\n    url: http://127.0.0.1:3131/mcp\n');
    await withEnv(env, async () => {
      const check = await harnessWiringCheck({ smoke: false });
      expect(check.status).toBe('ok');
      expect(JSON.stringify(check.details)).toContain('hermes');
    });
  });

  test('Hermes alone with a bare config.yaml is not "installed with no registration" either (nothing of ours to wire into)', async () => {
    mkdirSync(join(tmp, '.hermes'), { recursive: true });
    writeFileSync(join(tmp, '.hermes', 'config.yaml'), 'model: x\n');
    await withEnv({ ...clean, HERMES_HOME: join(tmp, '.hermes'), CLAUDE_CONFIG_DIR: join(tmp, 'no-claude'), CODEX_HOME: join(tmp, 'no-codex') }, async () => {
      const check = await harnessWiringCheck({ smoke: false });
      expect(check.message).not.toMatch(/Hermes is installed but has no gbrain/);
    });
  });
});

describe('review finding 2: receipts of every Hermes profile are visible without HERMES_HOME', () => {
  test('a decline recorded in ~/.hermes/profiles/<name> is found by a process whose HERMES_HOME is unset (Hermes strips it from stdio children)', () => {
    const named = join(tmp, '.hermes', 'profiles', 'research');
    mkdirSync(named, { recursive: true });
    writeReceipt({}, named);
    delete process.env.HERMES_HOME;
    expect(localSetupRecords().map((r) => [r.harness, r.providers])).toEqual([['hermes', 'declined']]);
    expect(providerDeclineRecord()).toMatchObject({ harness: 'hermes', providers: 'declined' });
    expect(hermesSpawnsServe()).toBe(true);
  });
  test('the default profile and an unrelated profile\'s foreign-install receipt: only this install\'s receipts count; an accepted decision declines nothing', () => {
    const dflt = join(tmp, '.hermes');
    const other = join(dflt, 'profiles', 'other');
    mkdirSync(other, { recursive: true });
    writeReceipt({ gbrain_home: '/somewhere/else/.gbrain' }, other);
    delete process.env.HERMES_HOME;
    expect(providerDeclineRecord()).toBeNull();
    writeReceipt({ consent: { providers: { value: 'accepted', source: 'flag' } } }, dflt);
    expect(providerDeclineRecord()).toBeNull();
    expect(localSetupRecords().map((r) => r.providers)).toEqual(['accepted']);
  });
  test('no ~/.hermes at all is no records and no throw', () => {
    delete process.env.HERMES_HOME;
    expect(localSetupRecords()).toEqual([]);
  });
});
