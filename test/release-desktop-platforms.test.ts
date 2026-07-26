import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const testWorkflow = readFileSync(join(process.cwd(), '.github/workflows/test.yml'), 'utf8');
const heavyWorkflow = readFileSync(join(process.cwd(), '.github/workflows/heavy-tests.yml'), 'utf8');
const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };

describe('cross-platform desktop release gates', () => {
  test('Release builds and publishes Windows, macOS, and Linux desktop packages', () => {
    for (const platform of ['windows', 'macos', 'linux']) {
      expect(releaseWorkflow).toContain(`platform: ${platform}`);
      expect(releaseWorkflow).toContain(`pmbrain-desktop-${platform}`);
    }
    expect(releaseWorkflow).toContain('PMBrain-macOS-arm64-*.dmg');
    expect(releaseWorkflow).toContain('PMBrain-macOS-arm64-*.zip');
    expect(releaseWorkflow).toContain('PMBrain-Linux-x64-*.AppImage');
    expect(releaseWorkflow).toContain('latest-mac.yml');
    expect(releaseWorkflow).toContain('latest-linux.yml');
  });

  test('normal Test CI runs the runtime smoke on all desktop platforms', () => {
    expect(testWorkflow).toContain('desktop-runtime');
    expect(testWorkflow).toContain('windows-latest');
    expect(testWorkflow).toContain('macos-latest');
    expect(testWorkflow).toContain('ubuntu-latest');
    expect(testWorkflow).toContain('bun run verify:runtime');
  });

  test('heavy operational tests run automatically for every master change and pull request', () => {
    expect(heavyWorkflow).toContain('push:');
    expect(heavyWorkflow).toContain('branches: [master]');
    expect(heavyWorkflow).not.toContain("contains(github.event.pull_request.labels.*.name, 'heavy-tests')");
  });

  test('one complete local test command includes static, unit, slow, heavy, and database E2E tiers', () => {
    const command = rootPackage.scripts['test:complete'];
    expect(command).toContain('bun run verify');
    expect(command).toContain('run-unit-parallel.sh');
    expect(command).toContain('bun run test:slow');
    expect(command).toContain('bun run test:heavy');
    expect(command).toContain('run-e2e.sh');
  });
});
