import { expect, test } from 'bun:test';
import { containerPathPreflight } from '../src/core/persistence/onboarding.ts';

test('a container bind-mounted checkout does not hide its ephemeral reservation parent or locks', () => {
  const mounts = '1 0 0:1 / / rw - overlay overlay rw\n2 1 8:1 /data /brain/root rw - ext4 /dev/example rw\n3 1 0:3 / /run rw - tmpfs tmpfs rw';
  const report = containerPathPreflight({ canonical_root: '/brain/root', reservation_parent: '/brain', persistence_home: '/run/gbrain' }, mounts, true);
  expect(report.durability_verified).toBe(false);
  expect(report.paths).toEqual([
    expect.objectContaining({ role: 'canonical_root', backing: 'mounted_unverified' }),
    expect.objectContaining({ role: 'reservation_parent', backing: 'ephemeral' }),
    expect.objectContaining({ role: 'persistence_home', backing: 'ephemeral' }),
  ]);
  expect(report.next_action).toContain('parent');
});

test('mount decoding preserves path boundaries and unknown backing never promises durability', () => {
  const mounts = '1 0 0:1 / / rw - overlay overlay rw\n2 1 8:1 /data /brain\\040root rw - ext4 /dev/example rw';
  const report = containerPathPreflight({ root: '/brain root/notes', sibling: '/brain roots/notes' }, mounts, true);
  expect(report.paths[0].backing).toBe('mounted_unverified');
  expect(report.paths[1].backing).toBe('ephemeral');
  expect(containerPathPreflight({ root: '/unknown' }, '', false)).toMatchObject({ durability_verified: false, paths: [{ backing: 'unknown' }] });
});
