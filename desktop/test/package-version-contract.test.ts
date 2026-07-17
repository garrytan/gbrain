import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const verifierSource = readFileSync(resolve(import.meta.dir, '../scripts/verify-package.ts'), 'utf8');

describe('desktop package version contract', () => {
  test('compares the root VERSION, root package and packaged runtime versions', () => {
    expect(verifierSource).toContain("join(desktopRoot, '..', 'VERSION')");
    expect(verifierSource).toContain("join(desktopRoot, '..', 'package.json')");
    expect(verifierSource).toContain("join(runtimeRoot, 'package.json')");
    expect(verifierSource).toContain('rootPackageVersion');
    expect(verifierSource).toContain('runtimePackageVersion');
  });

  test('runs the packaged sidecar version command without a shell', () => {
    expect(verifierSource).toContain("import { spawnSync } from 'node:child_process'");
    expect(verifierSource).toMatch(/spawnSync\(bunPath, \[sidecarPath, '--version'\]/);
    expect(verifierSource).toContain('shell: false');
    expect(verifierSource).toContain('windowsHide: true');
    expect(verifierSource).toContain('sidecarReportedVersion');
  });

  test('requires the packaged runtime manifest and pinned Bun revision', () => {
    expect(verifierSource).toContain("join(runtimeRoot, 'runtime-manifest.json')");
    expect(verifierSource).toContain('DESKTOP_RUNTIME_CONTRACT.bunRevision');
    expect(verifierSource).toContain('Packaged Bun checksum mismatch');
  });
});
