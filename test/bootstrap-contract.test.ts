import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  auditWritebackContract,
  repairWritebackContract,
  WRITEBACK_CONTRACT_BEGIN,
} from '../src/core/bootstrap/contract.ts';
import { checkWritebackContract } from '../src/core/bootstrap/verify.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function workspace(agents = '# AGENTS\n\n## Per-message gates\n\n**Gate 3 — Entity lookup (brain first).**\n'): string {
  const ws = mkdtempSync(join(tmpdir(), 'gbrain-writeback-contract-'));
  created.push(ws);
  writeFileSync(join(ws, 'AGENTS.md'), agents);
  return ws;
}

describe('bootstrap same-turn write-back contract', () => {
  test('the default skill bundle carries the memory loop contract', () => {
    const root = join(import.meta.dir, '..');
    const plugin = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8')) as {
      shared_deps: string[];
    };
    expect(plugin.shared_deps).toContain('skills/_AGENT_README.md');
    const onboarding = readFileSync(join(root, 'skills', '_AGENT_README.md'), 'utf8');
    expect(onboarding).toContain('## The always-on memory loop');
    expect(onboarding).toContain("GBrain's `remember` verb");
    expect(onboarding).toContain('Context injection is read-side automation');
  });

  test('audits a legacy one-way contract as missing', () => {
    const ws = workspace();
    expect(auditWritebackContract(ws).ok).toBe(false);
    const check = checkWritebackContract(ws);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('bootstrap contract --repair');
  });

  test('repair is additive, backed up, and idempotent', () => {
    const ws = workspace('# custom agent rules\n');
    const first = repairWritebackContract(ws);
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.backupPath).not.toBeNull();
    expect(existsSync(first.backupPath!)).toBe(true);
    expect(readFileSync(first.backupPath!, 'utf8')).toBe('# custom agent rules\n');

    const repaired = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
    expect(repaired).toContain('# custom agent rules');
    expect(repaired).toContain(WRITEBACK_CONTRACT_BEGIN);

    const second = repairWritebackContract(ws);
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe(repaired);
  });

  test('repair refuses to replace a symlinked AGENTS.md', () => {
    const ws = mkdtempSync(join(tmpdir(), 'gbrain-writeback-contract-'));
    created.push(ws);
    const target = join(ws, 'custom-rules.md');
    writeFileSync(target, '# custom agent rules\n');
    symlinkSync(target, join(ws, 'AGENTS.md'));
    expect(() => repairWritebackContract(ws)).toThrow('refusing to replace symlinked AGENTS.md');
    expect(readFileSync(target, 'utf8')).toBe('# custom agent rules\n');
  });

  test('accepts the integrated fresh-bootstrap gate', () => {
    const ws = workspace(
      '⛔ **WRITE IT DOWN — SAME TURN, THROUGH THE BRAIN.**\n\n' +
        '**Gate 7 — Write-back.** Before ending the turn, persist durable learning.\n',
    );
    expect(auditWritebackContract(ws)).toMatchObject({ ok: true, mode: 'integrated' });
  });

  test('accepts a semantically equivalent custom workspace gate', () => {
    const ws = workspace(
      '## Durable write-back\n\n' +
        'Use same-turn GBrain write-back for durable learning. Run `gbrain remember` with provenance, then verify it.\n',
    );
    expect(auditWritebackContract(ws)).toMatchObject({ ok: true, mode: 'integrated' });
  });
});
