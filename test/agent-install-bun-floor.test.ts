/**
 * An in-agent helper written before Bun 1.4.4 became the floor stages Bun 1.4.3
 * for --upgrade. Setup must refuse the bundle's own runtime (the binary the
 * launcher is pinned to) before it writes anything, and say exactly how to
 * rerun (#7674).
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentSetupCli } from '../src/core/agent-install/entry.ts';
import { MINIMUM_BUN_VERSION } from '../src/core/runtime-version.ts';

const HELPER_URL = 'https://raw.githubusercontent.com/garrytan/gbrain/latest-stable/scripts/setup-in-agent.sh';
const temporaries: string[] = [];
afterEach(() => { for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(stagedBunVersion: string) {
  const temporary = mkdtempSync(join(tmpdir(), 'gbrain-agent-floor-'));
  temporaries.push(temporary);
  const bundle = join(temporary, 'bundle');
  const pkg = join(bundle, 'app', 'node_modules', 'gbrain');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  mkdirSync(join(pkg, 'scripts'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'gbrain', version: '0.0.0-floor-test' }));
  writeFileSync(join(pkg, 'src', 'cli.ts'), '');
  writeFileSync(join(pkg, 'scripts', 'setup-in-agent.sh'), '');
  writeFileSync(join(bundle, 'bun'), `#!/bin/sh\nif [ "$1" = --version ]; then echo '${stagedBunVersion}'; exit 0; fi\nexit 7\n`);
  chmodSync(join(bundle, 'bun'), 0o700);
  return { root: join(temporary, 'brain dir'), bundle };
}

async function run(args: string[]): Promise<{ exit: number; result: Record<string, unknown> }> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const exit = await runAgentSetupCli(args);
    return { exit, result: JSON.parse(lines.pop() ?? '{}') };
  } finally { log.mockRestore(); error.mockRestore(); stderr.mockRestore(); }
}

const setupArgs = (root: string, bundle: string, extra: string[] = []) =>
  ['--root', root, '--harness', 'grok-bot', '--bundle', bundle, '--source-ref', 'a'.repeat(40), ...extra, '--json'];

test('setup refuses a bundle carrying Bun below the floor before writing anything', async () => {
  const { root, bundle } = fixture('1.4.3');
  const { exit, result } = await run(setupArgs(root, bundle, ['--upgrade', '--skills', 'memory-only']));
  expect(exit).toBe(1);
  expect(result).toMatchObject({ ok: false, reason: 'runtime_below_floor' });
  expect(result.message).toContain(`needs Bun ${MINIMUM_BUN_VERSION} or newer, but the setup bundle carries Bun 1.4.3`);
  expect(result.message).toContain('Make a verified backup first');
  expect(result.message).toContain(`curl --fail --silent --show-error --location ${HELPER_URL} --output /tmp/gbrain-setup.sh && bash /tmp/gbrain-setup.sh --root '${root}' --harness grok-bot --upgrade --skills memory-only --json`);
  expect(existsSync(root)).toBe(false);
});

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    files[path.slice(dir.length)] = entry.isFile() ? readFileSync(path, 'utf8') : '<dir>';
  }
  return files;
}

for (const [label, extra, seed] of [
  ['an upgrade of an installed root', ['--upgrade'], 'receipt'],
  ['a repair of an installed root', [], 'receipt'],
  ['an adoption of an unowned brain', ['--adopt'], 'unowned'],
] as const) {
  test(`${label} below the floor leaves the root exactly as it was`, async () => {
    const { root, bundle } = fixture('1.4.3');
    mkdirSync(join(root, '.gbrain', 'brain.pglite'), { recursive: true });
    writeFileSync(join(root, '.gbrain', 'config.json'), '{"engine":"pglite"}');
    writeFileSync(join(root, 'memory.md'), 'existing memory');
    if (seed === 'receipt') {
      mkdirSync(join(root, '.gbrain', 'agent-install'), { recursive: true });
      writeFileSync(join(root, '.gbrain', 'agent-install', 'receipt.json'), JSON.stringify({ format_version: 1, root, harness: 'grok-bot', state: 'ready', artifact: { source_ref: 'b'.repeat(40), bun_version: '1.4.3' } }));
    }
    const before = snapshot(root);
    const { exit, result } = await run(setupArgs(root, bundle, [...extra]));
    expect(exit).toBe(1);
    expect(result.reason).toBe('runtime_below_floor');
    expect(result.message).toContain(`bash /tmp/gbrain-setup.sh --root '${root}' --harness grok-bot${extra.length ? ` ${extra.join(' ')}` : ''}`);
    expect(snapshot(root)).toEqual(before);
  });
}

test('a prerelease of the floor and an unparseable version are refused too', async () => {
  for (const staged of [`${MINIMUM_BUN_VERSION}-canary.1`, '']) {
    const { root, bundle } = fixture(staged);
    const { exit, result } = await run(setupArgs(root, bundle));
    expect(exit).toBe(1);
    expect(result.reason).toBe('runtime_below_floor');
    expect(result.message).not.toContain('backup');
    expect(existsSync(root)).toBe(false);
  }
});

test('a bundle carrying the floor itself passes the gate', async () => {
  const { root, bundle } = fixture(MINIMUM_BUN_VERSION);
  const { exit, result } = await run(setupArgs(root, bundle));
  expect(exit).toBe(1);
  expect(result.reason).not.toBe('runtime_below_floor');
  expect(existsSync(root)).toBe(true);
});

test('a human-mode refusal reruns without --json', async () => {
  const { root, bundle } = fixture('1.4.3');
  const lines: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((line: string) => { lines.push(line); });
  try { expect(await runAgentSetupCli(setupArgs(root, bundle).filter(arg => arg !== '--json'))).toBe(1); } finally { error.mockRestore(); }
  expect(lines.join('\n')).toEndWith(`bash /tmp/gbrain-setup.sh --root '${root}' --harness grok-bot`);
});

test('an unreadable bundle is still journaled on the install receipt', async () => {
  const { root, bundle } = fixture(MINIMUM_BUN_VERSION);
  rmSync(join(bundle, 'app', 'node_modules', 'gbrain', 'src', 'cli.ts'));
  const { exit, result } = await run(setupArgs(root, bundle));
  expect(exit).toBe(1);
  expect(result.reason).toBe('invalid_artifact');
  const receipt = JSON.parse(readFileSync(join(root, '.gbrain', 'agent-install', 'receipt.json'), 'utf8'));
  expect(receipt.last_failure?.code).toBe('invalid_artifact');
});

test('a bundle whose first runtime probe fails is still checked against the floor before install', async () => {
  const { root, bundle } = fixture('1.4.3');
  const probed = join(bundle, '.probed');
  writeFileSync(join(bundle, 'bun'), `#!/bin/sh\nif [ ! -e '${probed}' ]; then : > '${probed}'; exit 9; fi\nif [ "$1" = --version ]; then echo 1.4.3; exit 0; fi\nexit 7\n`);
  const { exit, result } = await run(setupArgs(root, bundle));
  expect(exit).toBe(1);
  expect(result.reason).toBe('runtime_below_floor');
  expect(existsSync(join(root, 'runtime'))).toBe(false);
  const receipt = JSON.parse(readFileSync(join(root, '.gbrain', 'agent-install', 'receipt.json'), 'utf8'));
  expect(receipt.last_failure?.code).toBe('runtime_below_floor');
});

test('missing arguments still answer usage (exit 2) before the floor check', async () => {
  const { bundle } = fixture('1.4.3');
  const { exit, result } = await run(['--harness', 'grok-bot', '--bundle', bundle, '--source-ref', 'a'.repeat(40), '--json']);
  expect(exit).toBe(2);
  expect(result.reason).toBe('usage');
});

test('the documented helper URL matches the one the refusal names', () => {
  expect(readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'in-agent-setup.md'), 'utf8')).toContain(HELPER_URL);
});
