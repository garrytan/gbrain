/**
 * #8017: launchd's spawn helper opens the job's Program and its StandardOut/StandardError paths before the job runs.
 * When those sit on a volume other than the user's home (a brain on an external GBRAIN_HOME), launchd ends the job
 * with EX_CONFIG (78) and no pid, while the same wrapper runs fine by hand. The launchd-facing paths now stay on the
 * home volume (/bin/bash starts the wrapper; logs under ~/Library/Logs/gbrain) while the wrapper and the brain stay
 * under GBRAIN_HOME. A brain on the home volume keeps the plist it always had.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { generateLaunchdPlist, plistWrapperPath } from '../src/commands/autopilot.ts';
import { autopilotLaunchdHostPaths, type AutopilotJob } from '../src/core/autopilot-paths.ts';

const HOST = '/Users/alice-example';
const EXTERNAL = '/Volumes/brain-disk/gbrain/.gbrain';
const LOCAL = `${HOST}/.gbrain`;
const LABEL = 'com.gbrain.autopilot.0a1b2c3d';
const devOf = (p: string) => (p.startsWith('/Volumes/') ? 2 : 1);

describe('autopilotLaunchdHostPaths (#8017)', () => {
  test('a brain on another volume gets launchd paths on the home volume', () => {
    expect(autopilotLaunchdHostPaths(EXTERNAL, LABEL, HOST, devOf)).toEqual({
      viaBash: true,
      logPath: join(HOST, 'Library', 'Logs', 'gbrain', `${LABEL}.log`),
      errPath: join(HOST, 'Library', 'Logs', 'gbrain', `${LABEL}.err`),
    });
  });

  test('a brain on the home volume keeps its logs in the brain home', () => {
    expect(autopilotLaunchdHostPaths(LOCAL, LABEL, HOST, devOf)).toEqual({
      viaBash: false, logPath: join(LOCAL, 'autopilot.log'), errPath: join(LOCAL, 'autopilot.err'),
    });
  });

  test('an unreadable volume keeps the existing layout', () => {
    const throwing = () => { throw new Error('ENOENT'); };
    expect(autopilotLaunchdHostPaths(EXTERNAL, LABEL, HOST, throwing).viaBash).toBe(false);
  });
});

describe('generateLaunchdPlist for an external brain (#8017)', () => {
  const job = (home: string): AutopilotJob => {
    const host = autopilotLaunchdHostPaths(home, LABEL, HOST, devOf);
    return {
      kind: 'suffixed', suffix: '0a1b2c3d', launchdLabel: LABEL, systemdUnit: 'gbrain-autopilot-0a1b2c3d.service',
      startScriptPath: join(home, 'start-autopilot-0a1b2c3d.sh'), cronMarker: '# gbrain-autopilot:0a1b2c3d',
      wrapperPath: join(home, 'autopilot-run.sh'), logPath: host.logPath, errPath: host.errPath,
      launchdViaBash: host.viaBash, installIdPath: join(home, 'autopilot-install-id'), homeDir: home,
    };
  };

  test('launchd starts /bin/bash with the wrapper, and logs on the home volume', () => {
    const plist = generateLaunchdPlist(join(EXTERNAL, 'autopilot-run.sh'), HOST, job(EXTERNAL));
    expect(plist).toMatch(/<key>ProgramArguments<\/key><array>\s*<string>\/bin\/bash<\/string>\s*<string>\/Volumes\/brain-disk\/gbrain\/\.gbrain\/autopilot-run\.sh<\/string>\s*<\/array>/);
    expect(plist).toContain(`<key>StandardOutPath</key><string>${HOST}/Library/Logs/gbrain/${LABEL}.log</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key><string>${HOST}/Library/Logs/gbrain/${LABEL}.err</string>`);
    expect(plist).not.toContain('<string>/Volumes/brain-disk/gbrain/.gbrain/autopilot.log</string>');
  });

  test('the wrapper it runs is still read back as this brain\'s, so status and uninstall keep working', () => {
    expect(plistWrapperPath(generateLaunchdPlist(join(EXTERNAL, 'autopilot-run.sh'), HOST, job(EXTERNAL)))).toBe(join(EXTERNAL, 'autopilot-run.sh'));
  });

  test('a brain on the home volume keeps the wrapper as the program', () => {
    const plist = generateLaunchdPlist(join(LOCAL, 'autopilot-run.sh'), HOST, job(LOCAL));
    expect(plist).not.toContain('<string>/bin/bash</string>');
    expect(plistWrapperPath(plist)).toBe(join(LOCAL, 'autopilot-run.sh'));
    expect(plist).toContain(`<key>StandardOutPath</key><string>${LOCAL}/autopilot.log</string>`);
  });
});
