/**
 * #6755: a Phase F the v0.11.0 migration skipped for want of a repo path stays
 * visible. Its pending host-work item surfaces as a `minions_migration` doctor
 * line whose fix is the exact install argv (persistent_install, so the agent
 * asks first). Fixture journey through the real doctor CLI on a keyless PGLite
 * brain: render the envelope, run its argv (the installer in-process against a
 * stub Postgres engine on the ephemeral-container target, since the CLI refuses
 * a daemon on PGLite), run its verify, and the line is gone.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gb, oneDocument } from './helpers/agent-journey.ts';
import { withEnv } from './helpers/with-env.ts';
import { recordSkippedAutopilotInstall } from '../src/commands/migrations/v0_11_0-install.ts';
import { runAutopilot } from '../src/commands/autopilot.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

let home: string;
let userHome: string;
let repo: string;
/** HOME apart from the brain home, so the brain is a non-default one in this process and in the CLI children alike. */
const cli = (args: string[]) => gb(home, args, { env: { HOME: userHome } });
const installLine = (doc: Record<string, any>) =>
  (doc.checks as Array<Record<string, any>>).find(c => c.name === 'minions_migration' && String(c.message).includes('autopilot'));

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-6755-doctor-')));
  userHome = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-6755-doctor-user-')));
  repo = join(home, 'brain-repo');
  mkdirSync(repo);
  expect((await cli(['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
  await withEnv({ HOME: userHome, GBRAIN_HOME: home }, async () => { recordSkippedAutopilotInstall(repo); });
}, 180_000);
afterAll(() => {
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
  for (const dir of [home, userHome]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('skipped Phase F: doctor line to verified clear', () => {
  test('warn with the install argv → run it → verify shows no install line', async () => {
    const warned = installLine(oneDocument(await cli(['doctor', '--only', 'minions_migration', '--json']), 'doctor warn'));
    expect(warned).toBeDefined();
    expect(warned!.status).toBe('warn');
    expect(warned!.fix).toMatchObject({ consent: ['persistent_install'], actor: 'agent', next: 'ask_user' });
    expect(warned!.fix.argv.slice(0, 6)).toEqual(['gbrain', 'autopilot', '--install', '--yes', '--repo', repo]);
    expect(warned!.fix.verify.argv.slice(0, 4)).toEqual(['gbrain', 'doctor', '--only', 'minions_migration']);

    // The user agreed: run the argv. cli.ts consumes the routing flag (--brain) before dispatch.
    const argv = warned!.fix.argv.slice(2) as string[];
    const brainAt = argv.indexOf('--brain');
    if (brainAt >= 0) argv.splice(brainAt, 2);
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gbrain'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await withEnv({ HOME: userHome, GBRAIN_HOME: home, RENDER: '1', GBRAIN_NON_INTERACTIVE: '1', PATH: `${bin}:${process.env.PATH}` }, async () => {
      const log = console.log;
      console.log = () => {};
      try {
        await runAutopilot({ kind: 'postgres', getConfig: async () => null, executeRaw: async () => [] } as never, [...argv, '--no-inject']);
      } finally { console.log = log; }
    });

    const verified = oneDocument(await cli(warned!.fix.verify.argv.slice(1)), 'doctor verify');
    expect(installLine(verified)).toBeUndefined();
  }, 300_000);
});
