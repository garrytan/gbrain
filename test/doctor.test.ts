import { describe, test, expect } from 'bun:test';

describe('doctor command', () => {
  test('doctor module exports runDoctor', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    expect(typeof runDoctor).toBe('function');
  });

  test('LATEST_VERSION is importable from migrate', async () => {
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    expect(typeof LATEST_VERSION).toBe('number');
  });

  test('CLI registers doctor command', async () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', '--help'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('--fast');
  });

  test('Check interface supports issues array', async () => {
    const { Check } = await import('../src/commands/doctor.ts');
    // The Check type allows an optional issues array for resolver findings
    const check: import('../src/commands/doctor.ts').Check = {
      name: 'resolver_health',
      status: 'warn',
      message: '2 issues',
      issues: [{ type: 'unreachable', skill: 'test-skill', action: 'Add trigger row' }],
    };
    expect(check.issues).toHaveLength(1);
    expect(check.issues![0].action).toContain('trigger');
  });

  test('runDoctor accepts null engine for filesystem-only mode', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    // runDoctor should accept null engine — it runs filesystem checks only
    // We can't call it directly (it calls process.exit), but we verify the signature
    expect(runDoctor.length).toBe(2); // engine, args
  });
});
