import { afterAll, afterEach, beforeEach } from 'bun:test';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const home = homedir();
if (!home?.trim()) throw new Error('[real-home-guard-preload] Cannot determine the home to guard.');
const paths = [
  '.gbrain/autopilot-run.sh',
  '.gbrain/env',
  '.gbrain/start-autopilot.sh',
  'Library/LaunchAgents/com.gbrain.autopilot.plist',
  '.config/systemd/user/gbrain-autopilot.service',
].map(path => ({ label: `~/${path}`, path: join(resolve(home), path) }));

function fingerprint(path: string): string {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? `${stat.size}:${stat.mtimeMs}:${stat.ino}:${stat.mode}` : 'absent';
  } catch (error) {
    return `unreadable:${(error as NodeJS.ErrnoException).code}`;
  }
}

if (process.env.GBRAIN_TEST_ALLOW_REAL_HOME_WRITES === '1') {
  console.error('[real-home-guard-preload] DISARMED by GBRAIN_TEST_ALLOW_REAL_HOME_WRITES=1. Use only for a deliberate one-shot install test.');
} else {
  const baseline = new Map(paths.map(({ path }) => [path, fingerprint(path)]));
  const check = (when: string): void => {
    const changes: string[] = [];
    for (const { label, path } of paths) {
      const now = fingerprint(path);
      const before = baseline.get(path);
      if (now === before) continue;
      baseline.set(path, now);
      changes.push(`${label} (${before} -> ${now})`);
    }
    if (!changes.length) return;
    throw new Error(
      `[real-home-guard-preload] Install files changed ${when}: ${changes.join('; ')}. ` +
      'Set GBRAIN_HOME and HOME to scratch directories; never delete the isolation override. ' +
      'Another test process or an operator command can also cause this warning. ' +
      'Reinstall autopilot to regenerate service files. Reinstall never rewrites an existing env file; restore that file from a backup or re-enter its configuration.',
    );
  };
  beforeEach(() => check('BEFORE this test started (a hook or another process)'));
  afterEach(() => check('during this test'));
  afterAll(() => check('after the last test'));
}
