/**
 * #5401 x #5195: the projection drain's stop/drain/restart steps name the
 * autopilot job that runs THIS brain, not the shared default job, so following
 * them never stops another brain's autopilot and leaves this owner running.
 */

import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const REPO = resolve(import.meta.dir, '..');

/** Bun fixes os.homedir() at process start, so each case runs in a child with the HOME under test. */
function stepsIn(env: Record<string, string>, mint: boolean): { steps: string; suffix: string | null } {
  const script = `import { ensureAutopilotInstallId, resolveAutopilotJob } from ${JSON.stringify(join(REPO, 'src/core/autopilot-paths.ts'))};\n`
    + `import { residentDrainSteps } from ${JSON.stringify(join(REPO, 'src/commands/projections.ts'))};\n`
    + `if (${mint}) ensureAutopilotInstallId();\n`
    + `process.stdout.write(JSON.stringify({ steps: residentDrainSteps(4242), suffix: resolveAutopilotJob().suffix }));\n`;
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) childEnv[k] = v;
  delete childEnv.GBRAIN_AUTOPILOT_LABEL;
  const r = spawnSync(process.execPath, ['-e', script], { env: childEnv, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('projection drain steps name this brain\'s autopilot job', () => {
  test('a non-default GBRAIN_HOME brain gets its own suffixed launchd label and systemd unit', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-drain-names-')));
    try {
      mkdirSync(join(root, 'home'), { recursive: true });
      mkdirSync(join(root, 'brain-b'), { recursive: true });
      const { steps, suffix } = stepsIn({ HOME: join(root, 'home'), GBRAIN_HOME: join(root, 'brain-b') }, true);
      expect(suffix).toMatch(/^[0-9a-f]{8}$/);
      expect(steps).toContain(`systemctl --user stop gbrain-autopilot-${suffix}.service`);
      expect(steps).toContain(`launchctl bootout gui/$(id -u)/com.gbrain.autopilot.${suffix}`);
      expect(steps).not.toContain('systemctl --user stop gbrain-autopilot.service');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the default brain keeps the shared names', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-drain-names-')));
    try {
      mkdirSync(join(root, 'home'), { recursive: true });
      const { steps } = stepsIn({ HOME: join(root, 'home'), GBRAIN_HOME: '' }, false);
      expect(steps).toContain('systemctl --user stop gbrain-autopilot.service');
      expect(steps).toContain('launchctl bootout gui/$(id -u)/com.gbrain.autopilot ');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
