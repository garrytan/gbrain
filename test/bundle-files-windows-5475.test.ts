/**
 * #5475 parts 2-3: shared-skill publication on Windows.
 *
 * 2. `flushBundleDirectory` fsynced a directory handle with no platform
 *    guard; Windows has no directory flush (EPERM), so every bundle stage
 *    and publication failed.
 * 3. Bundle recovery compared POSIX permission bits exactly, but Windows
 *    stat only reports a read-only attribute (0444 or 0666), so a file
 *    published 0644 never matched and publication refused it as unsafe.
 *
 * Simulated cases run on every OS; the native case runs the real stage and
 * publish unmodified, including on the windows-latest row of the
 * security-regressions job. The packaged-pack `foresights init` path is covered
 * end to end by test/init-packaged-skills-native.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleFileHash, prepareBundleRecovery, publishStagedBundleFile, stageBundleFile, type MutationFile } from '../src/core/persistence/bundle-files.ts';
import type { FileRecoveryRecord, WriteRequest } from '../src/core/persistence/model.ts';
import type { WorktreeBinding } from '../src/core/persistence/ownership.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { sameFileMode } from '../src/core/fs-durable.ts';
import { simulateReadOnlyFsyncEperm, withPlatform } from './helpers/win32-flush-semantics.ts';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-5475-'))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function plan(relative: string[], content: string, before?: { bytes: string; mode: number }): { file: MutationFile; record: FileRecoveryRecord } {
  const path = join(root, ...relative);
  if (before) {
    mkdirSync(join(root, ...relative.slice(0, -1)), { recursive: true });
    writeFileSync(path, before.bytes);
    chmodSync(path, before.mode);
  }
  const file: MutationFile = { path, root, content, expectedBeforeHash: before ? sha256(before.bytes) : null };
  const binding = { local_path: root, relative_path: '', owner_epoch: '1' } as WorktreeBinding;
  const { record } = prepareBundleRecovery([file], binding, { execution_token: 'attempt-5475' } as WriteRequest);
  return { file, record: record.files[0] };
}

describe('#5475 part 2: bundle directory flushes', () => {
  test('a nested skill stages and publishes when directory handles cannot be fsynced (Windows semantics)', () => {
    const { file, record } = plan(['skills', 'capture', 'SKILL.md'], '# capture\n');
    const simulation = simulateReadOnlyFsyncEperm({ directories: true });
    try {
      withPlatform('win32', () => {
        stageBundleFile(file, record);
        publishStagedBundleFile(record);
      });
    } finally { simulation.restore(); }
    expect(simulation.readOnlyFsyncs).toBeGreaterThan(0);
    expect(readFileSync(file.path, 'utf8')).toBe('# capture\n');
  });

  test.skipIf(process.platform === 'win32')('the same directory flush failure still fails publication off Windows', () => {
    const { file, record } = plan(['skills', 'capture', 'SKILL.md'], '# capture\n');
    const simulation = simulateReadOnlyFsyncEperm({ directories: true });
    try {
      expect(() => stageBundleFile(file, record)).toThrow(expect.objectContaining({ code: 'EPERM' }));
    } finally { simulation.restore(); }
  });
});

describe('#5475 part 3: Windows reports only a read-only attribute', () => {
  test('a canonical file published 0644 and reported 0666 still matches its recovery record', () => {
    const { record } = plan(['skills', 'capture', 'SKILL.md'], '# new\n', { bytes: '# old\n', mode: 0o644 });
    chmodSync(record.path, 0o666);
    expect(withPlatform('win32', () => bundleFileHash(record))).toBe(sha256('# old\n'));
  });

  test('a staged file chmod-ed 0644 and reported 0666 publishes', () => {
    const { file, record } = plan(['skills', 'capture', 'SKILL.md'], '# new\n', { bytes: '# old\n', mode: 0o644 });
    stageBundleFile(file, record);
    chmodSync(record.staging!.publication!.path, 0o666);
    chmodSync(record.path, 0o666);
    withPlatform('win32', () => publishStagedBundleFile(record));
    expect(readFileSync(record.path, 'utf8')).toBe('# new\n');
  });

  test('a read-only flip outside publication is still refused on Windows', () => {
    const { record } = plan(['skills', 'capture', 'SKILL.md'], '# new\n', { bytes: '# old\n', mode: 0o644 });
    chmodSync(record.path, 0o444);
    try {
      expect(() => withPlatform('win32', () => bundleFileHash(record))).toThrow(expect.objectContaining({ code: 'unexpected_file_bytes' }));
    } finally { chmodSync(record.path, 0o644); }
  });

  test.skipIf(process.platform === 'win32')('POSIX still refuses any permission change', () => {
    const { record } = plan(['skills', 'capture', 'SKILL.md'], '# new\n', { bytes: '# old\n', mode: 0o644 });
    chmodSync(record.path, 0o664);
    expect(() => bundleFileHash(record)).toThrow(expect.objectContaining({ code: 'unexpected_file_bytes' }));
  });
});

test('native: a nested skill stages, publishes and keeps the recorded mode on this platform', () => {
  const { file, record } = plan(['skills', 'capture', 'SKILL.md'], '# new\n', { bytes: '# old\n', mode: 0o644 });
  stageBundleFile(file, record);
  publishStagedBundleFile(record);
  expect(readFileSync(record.path, 'utf8')).toBe('# new\n');
  expect(sameFileMode(statSync(record.path).mode, 0o644)).toBe(true);
  const created = plan(['skills', 'fresh', 'nested', 'SKILL.md'], '# fresh\n');
  stageBundleFile(created.file, created.record);
  publishStagedBundleFile(created.record);
  expect(readFileSync(created.file.path, 'utf8')).toBe('# fresh\n');
});
