import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  describeWindowsExitCode,
  formatCliFailure,
  isWindowsReleaseAtLeast,
} from '../src/main/cli-runner.js';
import {
  DESKTOP_RUNTIME_CONTRACTS,
  LINUX_DESKTOP_RUNTIME_CONTRACT,
  MACOS_DESKTOP_RUNTIME_CONTRACT,
  WINDOWS_DESKTOP_RUNTIME_CONTRACT,
  getDesktopRuntimeContract,
} from '../src/main/runtime-contract.js';

const buildSource = readFileSync(resolve(import.meta.dir, '../scripts/build-sidecar.ts'), 'utf8');
const cliRunnerSource = readFileSync(resolve(import.meta.dir, '../src/main/cli-runner.ts'), 'utf8');
const verifierSource = readFileSync(resolve(import.meta.dir, '../scripts/verify-package.ts'), 'utf8');
const builderConfig = readFileSync(resolve(import.meta.dir, '../electron-builder.yml'), 'utf8');
const installerSource = readFileSync(resolve(import.meta.dir, '../build/installer.nsh'), 'utf8');
const desktopPackage = JSON.parse(readFileSync(resolve(import.meta.dir, '../package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('desktop Windows runtime compatibility', () => {
  test('decodes the reported decimal crash as STATUS_ILLEGAL_INSTRUCTION', () => {
    expect(describeWindowsExitCode(3_221_225_501)).toEqual(expect.objectContaining({
      code: 0xC000001D,
      hex: '0xC000001D',
      name: 'STATUS_ILLEGAL_INSTRUCTION',
    }));
    expect(describeWindowsExitCode(0xC000001D | 0)?.hex).toBe('0xC000001D');
  });

  test('turns a silent native crash into an actionable message', () => {
    const message = formatCliFailure({
      code: 3_221_225_501,
      signal: null,
      stdout: '',
      stderr: '',
    });
    expect(message).toContain('CPU');
    expect(message).toContain('SSE4.2');
    expect(message).toContain('0xC000001D');
    expect(message).not.toContain('0xC000007B');
    expect(cliRunnerSource).toContain("child.once('close'");
    expect(cliRunnerSource).toContain('PREFLIGHT_TERMINATION_GRACE_MS');
  });

  test('enforces the Bun Windows 10 1809 minimum release', () => {
    expect(isWindowsReleaseAtLeast('10.0.17762', WINDOWS_DESKTOP_RUNTIME_CONTRACT.minimumWindowsRelease)).toBe(false);
    expect(isWindowsReleaseAtLeast('10.0.17763', WINDOWS_DESKTOP_RUNTIME_CONTRACT.minimumWindowsRelease)).toBe(true);
    expect(isWindowsReleaseAtLeast('10.0.26100', WINDOWS_DESKTOP_RUNTIME_CONTRACT.minimumWindowsRelease)).toBe(true);
    expect(isWindowsReleaseAtLeast('invalid', WINDOWS_DESKTOP_RUNTIME_CONTRACT.minimumWindowsRelease)).toBe(false);
  });

  test('pins checksum-verified runtimes for every desktop platform', () => {
    expect(getDesktopRuntimeContract('win32', 'x64')).toBe(WINDOWS_DESKTOP_RUNTIME_CONTRACT);
    expect(getDesktopRuntimeContract('darwin', 'arm64')).toBe(MACOS_DESKTOP_RUNTIME_CONTRACT);
    expect(getDesktopRuntimeContract('linux', 'x64')).toBe(LINUX_DESKTOP_RUNTIME_CONTRACT);
    expect(() => getDesktopRuntimeContract('darwin', 'x64')).toThrow('Unsupported PMBrain Desktop platform');
    for (const contract of DESKTOP_RUNTIME_CONTRACTS) {
      expect(contract.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(contract.executableSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(contract.bunRevision).toBe('1.3.14+0d9b296af');
    }
    expect(buildSource).toContain('ensureRuntimeArchive');
    expect(buildSource).toContain('extractRuntimeExecutable');
    expect(buildSource).toContain('RUNTIME_DOWNLOAD_ATTEMPTS');
    expect(buildSource).toContain('RUNTIME_DOWNLOAD_TIMEOUT_MS');
    expect(buildSource).not.toContain('cp(process.execPath');
  });

  test('verifies manifest, native architecture, Bun revision, Canvas and PGLite before release', () => {
    expect(verifierSource).toContain("join(shape.runtimeRoot, 'runtime-manifest.json')");
    expect(verifierSource).toContain('binaryArchitecture');
    expect(verifierSource).toContain('executableSha256');
    expect(verifierSource).toContain("spawnSync(bunPath, ['--revision']");
    expect(verifierSource).toContain("await import('@napi-rs/canvas')");
    expect(verifierSource).toContain("await import('@electric-sql/pglite')");
    expect(verifierSource).toContain('runtime-smoke-ok');
  });

  test('builds only x64 and blocks unsupported Windows before installation', () => {
    expect(desktopPackage.scripts['build:win']).toContain('--x64');
    expect(builderConfig).toMatch(/arch:\s*\n\s*- x64/);
    expect(builderConfig).toContain('include: build/installer.nsh');
    expect(installerSource).toContain('${AtLeastWin10}');
    expect(installerSource).toContain('$0 < 17763');
  });

  test('defines native macOS and Linux desktop artifacts with their updater metadata', () => {
    expect(desktopPackage.scripts['build:mac']).toContain('--arm64');
    expect(desktopPackage.scripts['build:linux']).toContain('--x64');
    expect(builderConfig).toContain('PMBrain-macOS-${arch}-${version}.${ext}');
    expect(builderConfig).toContain('PMBrain-Linux-${arch}-${version}.${ext}');
    expect(builderConfig).toContain('canvas-darwin-arm64');
    expect(builderConfig).toContain('canvas-linux-x64-gnu');
  });
});
