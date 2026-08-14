import { describe, expect, test } from 'bun:test';
import { resolveJobPull } from '../src/commands/jobs.ts';
import { sourceConfigHasRemoteUrl } from '../src/core/sources-load.ts';

describe('job pull policy', () => {
  test('canonical pull takes precedence over the legacy noPull key', () => {
    expect(resolveJobPull({ pull: false })).toBe(false);
    expect(resolveJobPull({ pull: true })).toBe(true);
    expect(resolveJobPull({ pull: false, noPull: false })).toBe(false);
    expect(resolveJobPull({ pull: true, noPull: true })).toBe(true);
  });

  test('legacy noPull remains backward compatible', () => {
    expect(resolveJobPull({ noPull: true })).toBe(false);
    expect(resolveJobPull({ noPull: false })).toBe(true);
    expect(resolveJobPull({})).toBe(true);
  });

  test('remote_url detection handles object and PGLite string configs', () => {
    expect(sourceConfigHasRemoteUrl({ remote_url: 'https://example.invalid/brain.git' })).toBe(true);
    expect(sourceConfigHasRemoteUrl('{"remote_url":"https://example.invalid/brain.git"}')).toBe(true);
    expect(sourceConfigHasRemoteUrl({ remote_url: '   ' })).toBe(false);
    expect(sourceConfigHasRemoteUrl('{}')).toBe(false);
  });
});
