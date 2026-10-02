/** #5794: the backup probe's git env is an allowlist, never the whole process env. */
import { describe, expect, test } from 'bun:test';
import { backupGitEnv } from '../src/core/backup/repository.ts';
import { buildGitEnv } from '../src/core/git-remote.ts';

const source = {
  HOME: '/home/example', PATH: '/usr/bin', XDG_CONFIG_HOME: '/home/example/.config', SSH_AUTH_SOCK: '/tmp/agent.sock',
  GIT_CONFIG_GLOBAL: '/home/example/.gitconfig-work', HTTPS_PROXY: 'http://proxy.example:8080', https_proxy: 'http://proxy.example:8080',
  HTTP_PROXY: 'http://proxy.example:8080', http_proxy: 'http://proxy.example:8080', NO_PROXY: 'localhost', no_proxy: 'localhost',
  USERPROFILE: 'C:\\Users\\example', APPDATA: 'C:\\Users\\example\\AppData\\Roaming', SystemRoot: 'C:\\Windows',
  GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_ASKPASS: '/usr/bin/askpass', GIT_TERMINAL_PROMPT: '1', OPENAI_API_KEY: 'example-key',
};

describe('backup probe git env (#5794)', () => {
  test('passes the user config, credential and proxy variables on POSIX', () => {
    const env = backupGitEnv(source, 'linux');
    expect(Object.keys(env).sort()).toEqual(['GCM_INTERACTIVE', 'GIT_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY',
      'NO_PROXY', 'PATH', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'http_proxy', 'https_proxy', 'no_proxy'].sort());
    expect(env).toMatchObject({ HOME: '/home/example', PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/agent.sock', ...buildGitEnv('linux') });
  });

  test('adds the Windows profile variables only on Windows', () => {
    expect(backupGitEnv(source, 'win32')).toMatchObject({ USERPROFILE: source.USERPROFILE, APPDATA: source.APPDATA, SystemRoot: source.SystemRoot, ...buildGitEnv('win32') });
    expect(backupGitEnv(source, 'linux').USERPROFILE).toBeUndefined();
  });

  test('never passes repository-redirecting variables or secrets, and the no-prompt overrides win', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const env = backupGitEnv(source, platform);
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_WORK_TREE).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    }
    expect(backupGitEnv(source, 'linux').GIT_ASKPASS).toBe('/bin/false');
  });
});
