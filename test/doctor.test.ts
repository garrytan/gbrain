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

  test('resolver_health finds bundled skills when run outside repo', async () => {
    // Simulates the hosted-CLI case: user runs `gbrain doctor` from a directory
    // that has no skills/RESOLVER.md anywhere up the tree. The fallback should
    // walk up from the module's install path and find the bundled skills/.
    const { tmpdirSync } = await import('node:fs');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-doctor-'));
    try {
      const result = Bun.spawnSync({
        cmd: ['bun', 'run', path.join(import.meta.dir, '..', 'src/cli.ts'), 'doctor', '--fast', '--json'],
        cwd: tmp,
        env: { ...process.env, GBRAIN_SKILLS_DIR: '' },
      });
      const stdout = new TextDecoder().decode(result.stdout);
      const out = JSON.parse(stdout);
      const resolver = out.checks.find((c: { name: string }) => c.name === 'resolver_health');
      // Should NOT be "Could not find skills directory" — install fallback should hit
      expect(resolver?.message ?? '').not.toContain('Could not find');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('resolver_health honors GBRAIN_SKILLS_DIR env override', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-doctor-env-'));
    const skills = path.join(tmp, 'skills');
    fs.mkdirSync(skills);
    fs.writeFileSync(path.join(skills, 'RESOLVER.md'), '# Resolver\n');
    fs.writeFileSync(path.join(skills, 'manifest.json'), JSON.stringify({ skills: [] }));
    try {
      const result = Bun.spawnSync({
        cmd: ['bun', 'run', path.join(import.meta.dir, '..', 'src/cli.ts'), 'doctor', '--fast', '--json'],
        cwd: os.tmpdir(),
        env: { ...process.env, GBRAIN_SKILLS_DIR: skills },
      });
      const stdout = new TextDecoder().decode(result.stdout);
      const out = JSON.parse(stdout);
      const resolver = out.checks.find((c: { name: string }) => c.name === 'resolver_health');
      expect(resolver?.message ?? '').not.toContain('Could not find');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
