/**
 * `gbrain autopilot --install` consent (agent-first operator wave E9).
 *
 * The install is a persistent_install: a non-TTY caller without `--yes` (or
 * the user's consent.preapprove.persistent_install) gets exit 3 with the
 * confirmation_required payload and nothing is written; `--dry-run` prints the
 * plan and writes nothing; `--yes` installs; the preapproval installs and says
 * so on stderr.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyHome, withEnv } from './helpers/with-env.ts';
import { runAutopilot } from '../src/commands/autopilot.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

async function install(extra: string[], opts: { preapprove?: boolean } = {}) {
  const gbrainHome = emptyHome();
  const home = mkdtempSync(join(tmpdir(), 'gbrain-ap-consent-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-ap-consent-repo-'));
  const bin = mkdtempSync(join(tmpdir(), 'gbrain-ap-consent-bin-'));
  writeFileSync(join(bin, 'gbrain'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (opts.preapprove) {
    mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
    writeFileSync(join(gbrainHome, '.gbrain', 'config.json'), JSON.stringify({ consent: { preapprove: { persistent_install: true } } }));
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  await withEnv({ GBRAIN_HOME: gbrainHome, HOME: home, PATH: `${bin}:${process.env.PATH}`, GBRAIN_NON_INTERACTIVE: '1', ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined }, async () => {
    const log = console.log;
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    console.log = (...p: unknown[]) => { stdout.push(p.map(String).join(' ')); };
    process.stdout.write = ((c: string | Uint8Array) => { stdout.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
    _resetCliExitVerdictForTests();
    try {
      const engine = { kind: 'postgres', getConfig: async () => null } as never;
      await runAutopilot(engine, ['--install', '--target', 'ephemeral-container', '--repo', repo, '--no-inject', ...extra]);
    } finally {
      console.log = log;
      process.stdout.write = outWrite;
      process.stderr.write = errWrite;
    }
  });
  const wrapper = join(gbrainHome, '.gbrain', 'autopilot-run.sh');
  return { stdout: stdout.join('\n'), stderr: stderr.join(''), verdict: currentExitCode(), wrapperWritten: existsSync(wrapper) };
}

afterAll(() => {
  // The refusal case sets exit verdict 3, which mirrors into process.exitCode.
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
});

describe('autopilot --install consent', () => {
  test('non-TTY without --yes: exit 3, confirmation_required payload, nothing written', async () => {
    const r = await install(['--json']);
    expect(r.verdict).toBe(3);
    expect(r.wrapperWritten).toBe(false);
    const payload = JSON.parse(r.stdout);
    expect(payload).toMatchObject({ status: 'confirmation_required', code: 'confirmation_required', effects: ['persistent_install'] });
    expect(payload.fix.argv).toContain('--yes');
    expect(payload.user_message).toContain('gbrain autopilot --uninstall');
  });

  test('--dry-run prints the plan and writes nothing', async () => {
    const r = await install(['--dry-run']);
    expect(r.wrapperWritten).toBe(false);
    expect(r.stdout).toContain('nothing was written');
    expect(r.stdout).toContain('autopilot-run.sh');
    expect(r.stdout).toContain('ephemeral-container');
  });

  test('--yes installs', async () => {
    const r = await install(['--yes']);
    expect(r.wrapperWritten).toBe(true);
    expect(r.verdict).toBe(0);
  });

  test("the user's persistent_install preapproval installs and is announced", async () => {
    const r = await install([], { preapprove: true });
    expect(r.wrapperWritten).toBe(true);
    expect(r.stderr).toContain('consent.preapprove.persistent_install');
  });
});
