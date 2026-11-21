import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-fixture-privacy.sh');

function runGuard(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-privacy-skills-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return spawnSync('bash', [SCRIPT], { env: { ...process.env, GBRAIN_GUARD_ROOT: root }, encoding: 'utf-8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('check-fixture-privacy covers skills/', () => {
  it('fails when a bundled skill names a real private agent', () => {
    const res = runGuard({ 'skills/harvest/SKILL.md': 'Lift a skill from your Wintermute fork.\n' });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('skills/harvest/SKILL.md');
  });

  it('allows the product name in skills/ (real-entity tokens only)', () => {
    const res = runGuard({ 'skills/harvest/SKILL.md': 'Lift a skill from your OpenClaw fork.\n' });
    expect(res.status).toBe(0);
  });

  it('passes on the repository as committed', () => {
    const res = spawnSync('bash', [SCRIPT], { cwd: join(import.meta.dir, ".."), env: { ...process.env, GBRAIN_GUARD_ROOT: join(import.meta.dir, "..") }, encoding: 'utf-8' });
    expect(res.stdout).toContain('OK');
    expect(res.status).toBe(0);
  });
});
