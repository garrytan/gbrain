import { describe, test, expect } from 'bun:test';

// We can't easily mock process.execPath in bun, so we test the upgrade
// command's --help output and the detection logic via subprocess

describe('upgrade command', () => {
  test('--help prints usage and exits 0', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'upgrade', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain upgrade');
    expect(stdout).toContain('Detects install method');
    expect(exitCode).toBe(0);
  });

  test('-h also prints usage', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'upgrade', '-h'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(stdout).toContain('Usage: gbrain upgrade');
    expect(exitCode).toBe(0);
  });
});

describe('detectInstallMethod heuristic (source analysis)', () => {
  // Read the source and verify the detection order is correct
  const { readFileSync } = require('fs');
  const source = readFileSync(
    new URL('../src/commands/upgrade.ts', import.meta.url),
    'utf-8',
  );

  test('checks node_modules before binary', () => {
    const nodeModulesIdx = source.indexOf('node_modules');
    const binaryIdx = source.indexOf("endsWith('/gbrain')");
    expect(nodeModulesIdx).toBeLessThan(binaryIdx);
  });

  test('checks binary before clawhub', () => {
    const binaryIdx = source.indexOf("endsWith('/gbrain')");
    const clawhubIdx = source.indexOf("clawhub --version");
    expect(binaryIdx).toBeLessThan(clawhubIdx);
  });

  test('uses clawhub --version, not which clawhub', () => {
    expect(source).toContain("clawhub --version");
    expect(source).not.toContain('which clawhub');
  });

  test('has timeout on upgrade execSync calls', () => {
    // Count timeout occurrences in execSync calls
    const timeoutMatches = source.match(/timeout:\s*\d+/g) || [];
    expect(timeoutMatches.length).toBeGreaterThanOrEqual(2); // bun + clawhub detection at minimum
  });

  test('return type is bun | binary | clawhub | unknown', () => {
    expect(source).toContain("'bun' | 'binary' | 'clawhub' | 'unknown'");
  });

  test('does not reference npm in case labels or messages', () => {
    // Should not have case 'npm' or 'Upgrading via npm'
    expect(source).not.toContain("case 'npm'");
    expect(source).not.toContain('via npm');
    expect(source).not.toContain('npm upgrade');
  });

  test('refreshes agent rules after a successful upgrade', () => {
    expect(source).toContain('gbrain setup-agent --skip-mcp');
    expect(source).not.toContain("execSync('gbrain setup-agent',");
  });
});
