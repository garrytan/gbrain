/** Per-test HOME isolation, independent of shell overrides and suite preloads. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export function createSkillTestSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'skill-test-sandbox-'));
  const home = join(root, 'home');
  const config = join(root, 'config');
  const temp = join(root, 'tmp');
  for (const path of [home, config, temp]) mkdirSync(path, { mode: 0o700 });
  // No ambient config, provider/DB credentials, preload flags or workspace roots.
  const env: Record<string, string> = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, TMPDIR: temp,
    CI: '1', NODE_ENV: 'test',
  };
  return {
    root, home, env,
    enter() {
      const previous = { ...process.env };
      const cwd = process.cwd();
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, env);
      return () => {
        process.chdir(cwd);
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, previous);
      };
    },
    dispose() { rmSync(root, { recursive: true, force: true }); },
  };
}
