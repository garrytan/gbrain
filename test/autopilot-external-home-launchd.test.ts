/** Launchd must enter through the host volume when the brain home is external. */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLaunchdPlist } from '../src/commands/autopilot.ts';
import { plistWrapperPath } from '../src/commands/autopilot/jobs.ts';
import { resolveAutopilotJob } from '../src/core/autopilot-paths.ts';
import { withEnv } from './helpers/with-env.ts';

describe('autopilot LaunchAgent with an external brain home', () => {
  test('starts the local shell and writes launchd logs under the host home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-external-launchd-'));
    const home = join(root, 'host');
    const externalHome = join(root, 'external-volume', 'brain');
    mkdirSync(home, { recursive: true });
    mkdirSync(externalHome, { recursive: true });
    try {
      await withEnv({ HOME: home, GBRAIN_HOME: externalHome }, () => {
        const job = resolveAutopilotJob();
        const plist = generateLaunchdPlist(job.wrapperPath, home, job);

        expect(plist).toContain('<key>Program</key><string>/bin/bash</string>');
        expect(plist).toContain(`<string>/bin/bash</string>\n    <string>${job.wrapperPath}</string>`);
        expect(plistWrapperPath(plist)).toBe(job.wrapperPath);
        expect(plist).toContain(`<key>StandardOutPath</key><string>${join(home, 'Library', 'Logs', 'GBrain', `${job.launchdLabel}.log`)}</string>`);
        expect(plist).toContain(`<key>StandardErrorPath</key><string>${join(home, 'Library', 'Logs', 'GBrain', `${job.launchdLabel}.err`)}</string>`);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
