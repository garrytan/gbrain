import { describe, expect, test } from 'bun:test';
import { resolveAutopilotRepo } from '../src/commands/autopilot.ts';

const exists = (paths: string[]) => (path: string) => paths.includes(path);

describe('resolveAutopilotRepo', () => {
  test('explicit repo wins when it exists', () => {
    expect(resolveAutopilotRepo('postgres', '/srv/brain', '/other', exists(['/srv/brain']))).toEqual({
      repoPath: '/srv/brain',
      ignoredConfiguredPath: null,
    });
  });

  test('explicit missing repo fails closed', () => {
    expect(() => resolveAutopilotRepo('postgres', '/missing', null, exists([])))
      .toThrow('Explicit --repo path does not exist');
  });

  test('Postgres ignores a configured path from another host and runs checkoutless', () => {
    expect(resolveAutopilotRepo('postgres', undefined, '/Users/example/brain', exists([]))).toEqual({
      repoPath: null,
      ignoredConfiguredPath: '/Users/example/brain',
    });
  });

  test('Postgres with no configured checkout runs checkoutless', () => {
    expect(resolveAutopilotRepo('postgres', undefined, null, exists([]))).toEqual({
      repoPath: null,
      ignoredConfiguredPath: null,
    });
  });

  test('PGLite still requires a local checkout', () => {
    expect(() => resolveAutopilotRepo('pglite', undefined, null, exists([])))
      .toThrow('No repo path');
    expect(() => resolveAutopilotRepo('pglite', undefined, '/missing', exists([])))
      .toThrow('Configured sync.repo_path does not exist');
  });
});
