/**
 * \`gbrain setup openclaw --wakeshift\` (Wakeshift plan D11) with an injected command runner: no test runs openclaw.
 * After consent (persistent install, egress) it runs exactly OpenClaw's pinned npm install and enable, then
 * inspects; a gateway that listens beyond this computer gets Wakeshift's allowNetworkHooks question printed and
 * never answered; no openclaw on PATH refuses with a fix line. Doctor's wakeshift_openclaw check compares the
 * installed version with the pinned constant, as a warning only.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup } from '../src/commands/setup.ts';
import { WAKESHIFT_OPENCLAW_VERSION, wakeshiftOpenclawInstallArgv } from '../src/commands/setup-openclaw-wakeshift.ts';
import { runWakeshiftOpenclawCheck } from '../src/commands/doctor/checks/wakeshift-openclaw.ts';
import { withEnv } from './helpers/with-env.ts';

const sandbox = mkdtempSync(join(tmpdir(), 'gbrain-openclaw-wakeshift-'));
const stateDir = join(sandbox, 'openclaw');
const BIN = '/opt/example/bin/openclaw';
const INSTALL = [BIN, 'plugins', 'install', 'npm:@wakeshift/openclaw@1.4.31', '--force', '--accept-capabilities'];
const ENABLE = [BIN, 'plugins', 'enable', 'wakeshift', '--accept-capabilities'];
const INSPECT = [BIN, 'plugins', 'inspect', 'wakeshift', '--runtime', '--json'];
const LOADED = JSON.stringify({ id: 'wakeshift', version: '1.4.31', status: 'loaded', enabled: true });

let out = '';
let err = '';
let ran: string[][] = [];
const orig = { log: console.log, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
const env = { HOME: join(sandbox, 'home'), GBRAIN_HOME: join(sandbox, 'home'), CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_PROFILE: undefined, GBRAIN_CONSENT_PREAPPROVE: undefined };

function runner(answers: Record<string, { ok: boolean; output: string }> = {}) {
  return (argv: string[]) => { ran.push(argv); return answers[argv.slice(1, 3).join(' ')] ?? { ok: true, output: argv[2] === 'inspect' ? LOADED : '' }; };
}
const setup = (args: string[], deps: Parameters<typeof runSetup>[1]) => withEnv(env, () => runSetup(['openclaw', '--wakeshift', ...args], deps));

beforeAll(() => { mkdirSync(join(sandbox, 'home'), { recursive: true }); mkdirSync(stateDir, { recursive: true }); });
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
beforeEach(() => {
  out = ''; err = ''; ran = [];
  rmSync(join(stateDir, 'openclaw.json'), { force: true });
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
});
afterEach(() => { console.log = orig.log; console.error = orig.error; process.stdout.write = orig.out; process.stderr.write = orig.err; });

describe('gbrain setup openclaw --wakeshift', () => {
  test('the pinned version lives in one constant and the commands are exactly OpenClaw\'s documented install', () => {
    expect(WAKESHIFT_OPENCLAW_VERSION).toBe('1.4.31');
    expect(wakeshiftOpenclawInstallArgv(BIN)).toEqual([INSTALL, ENABLE]);
  });

  test('with consent it runs install then enable, then verifies, and reports the connected note as pending', async () => {
    const code = await setup(['--yes', '--json'], { openclaw: { bin: BIN, run: runner() } });
    expect(code).toBe(0);
    expect(ran).toEqual([INSTALL, ENABLE, INSPECT]);
    const doc = JSON.parse(out);
    expect(doc.wakeshift).toMatchObject({ action: 'installed', version: '1.4.31', network_hooks_question: null, verify: { loaded: true, connected: 'pending' } });
    expect(doc.wakeshift.verify.message).toContain('Wakeshift: connected');
  });

  test('without consent nothing runs (exit 3, confirmation_required)', async () => {
    const code = await setup(['--json'], { openclaw: { bin: BIN, run: runner() } });
    expect(code).toBe(3);
    expect(ran).toEqual([]);
    expect(out + err).toContain('confirmation_required');
  });

  test('a gateway that listens beyond this computer gets Wakeshift\'s question, and gbrain never sets allowNetworkHooks', async () => {
    writeFileSync(join(stateDir, 'openclaw.json'), '{ gateway: { bind: "lan" } }');
    const code = await setup(['--yes'], { openclaw: { bin: BIN, run: runner() } });
    expect(code).toBe(0);
    expect(out).toContain('Question from Wakeshift');
    expect(out).toContain('openclaw config set plugins.entries.wakeshift.config.allowNetworkHooks true --strict-json');
    expect(ran.some(argv => argv.join(' ').includes('allowNetworkHooks'))).toBe(false);
    writeFileSync(join(stateDir, 'openclaw.json'), '{ gateway: { bind: "loopback" } }');
    out = '';
    await setup(['--yes'], { openclaw: { bin: BIN, run: runner() } });
    expect(out).not.toContain('Question from Wakeshift');
  });

  test('no openclaw on PATH refuses with a fix line and runs nothing', async () => {
    const code = await setup(['--yes'], { openclaw: { bin: null, run: runner() } });
    expect(code).not.toBe(0);
    expect(ran).toEqual([]);
    expect(err).toContain('openclaw_not_found');
    expect(err).toContain('Fix: gbrain setup openclaw --wakeshift');
  });

  test('--dry-run lists the commands and runs nothing; a failed install exits 1 and stops before enable', async () => {
    expect(await setup(['--dry-run'], { openclaw: { bin: BIN, run: runner() } })).toBe(0);
    expect(ran).toEqual([]);
    expect(out).toContain('would run');
    expect(out).toContain('npm:@wakeshift/openclaw@1.4.31');
    const code = await setup(['--yes', '--json'], { openclaw: { bin: BIN, run: runner({ 'plugins install': { ok: false, output: 'npm error 404' } }) } });
    expect(code).toBe(1);
    expect(ran).toEqual([INSTALL]);
    expect(JSON.parse(out.slice(out.indexOf('{'))).wakeshift).toMatchObject({ action: 'failed', output: 'npm error 404' });
  });

  test('--wakeshift on another harness is refused', async () => {
    const code = await withEnv(env, () => runSetup(['claude-code', '--wakeshift', '--yes'], { openclaw: { bin: BIN, run: runner() } }));
    expect(code).not.toBe(0);
    expect(ran).toEqual([]);
    expect(err).toContain('applies to gbrain setup openclaw only');
  });
});

describe('doctor wakeshift_openclaw', () => {
  const inspect = (version: string | null) => (argv: string[]) => (version === null ? { ok: false, output: 'plugin not found' } : { ok: argv[2] === 'inspect', output: JSON.stringify({ id: 'wakeshift', version }) });

  test('warns on drift from the pinned version, ok when it matches, info when not installed, silent without openclaw', async () => {
    const [drift] = await runWakeshiftOpenclawCheck(null, { bin: BIN, run: inspect('1.4.30') });
    expect(drift).toMatchObject({ name: 'wakeshift_openclaw', status: 'warn' });
    expect(drift!.message).toContain('gbrain setup openclaw --wakeshift');
    expect((await runWakeshiftOpenclawCheck(null, { bin: BIN, run: inspect('1.4.31') }))[0]).toMatchObject({ status: 'ok' });
    expect((await runWakeshiftOpenclawCheck(null, { bin: BIN, run: inspect(null) }))[0]).toMatchObject({ status: 'ok', severity: 'info' });
    expect(await runWakeshiftOpenclawCheck(null, { bin: null, run: inspect('1.4.30') })).toEqual([]);
  });
});
