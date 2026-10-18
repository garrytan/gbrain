/**
 * #6748: skills/maintain declared only the admin-scoped `get_health`, so an
 * agent with a read token had no declared way to run the manual path. It now
 * declares the read-scoped `get_brain_health` as the fallback (bands only)
 * and names the dimensions that fallback cannot answer.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operationsByName } from '../src/core/operations.ts';

const skill = readFileSync(join(import.meta.dir, '..', 'skills', 'maintain', 'SKILL.md'), 'utf8');
const frontmatterTools = (skill.match(/^tools:\n((?:  - .+\n)+)/m)?.[1] ?? '').split('\n').map(l => l.replace(/^  - /, '').trim()).filter(Boolean);

describe('#6748 maintain health tools', () => {
  test('declares the admin get_health and the read-scoped get_brain_health fallback', () => {
    expect(operationsByName.get_health?.scope).toBe('admin');
    expect(operationsByName.get_brain_health?.scope).toBe('read');
    expect(frontmatterTools).toContain('get_health');
    expect(frontmatterTools).toContain('get_brain_health');
    expect(skill).toContain('(get_brain_health)');
  });

  test('the manual path says when to fall back and names the dimensions the bands skip', () => {
    const step = skill.match(/^1\. \*\*Run health check\.\*\*.*$/m)?.[0] ?? '';
    expect(step).toContain('get_health');
    expect(step).toContain('get_brain_health');
    for (const dimension of ['stale pages', 'orphan pages', 'dead links', 'embed coverage']) expect(step).toContain(dimension);
  });
});
