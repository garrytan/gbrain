import { describe, expect, it } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SKILL_DIR = join(import.meta.dir, '..', 'skills', 'skill-vault-capture-policy');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const RESOLVER = join(import.meta.dir, '..', 'skills', 'RESOLVER.md');

function parseFrontmatter(raw: string): Record<string, unknown> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error('no frontmatter');
  const out: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2].trim();
  }
  return out;
}

describe('skill-vault-capture-policy skill', () => {
  it('has a SKILL.md with required frontmatter', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const fm = parseFrontmatter(readFileSync(SKILL_MD, 'utf-8'));
    expect(fm['name']).toBe('skill-vault-capture-policy');
    expect(fm['description']).toBeTruthy();
  });

  it('has the required conformance sections', () => {
    const body = readFileSync(SKILL_MD, 'utf-8');
    for (const section of ['## Contract', '## Phases', '## Output Format', '## Anti-Patterns']) {
      expect(body.includes(section), `missing ${section}`).toBe(true);
    }
  });

  it('is registered in RESOLVER.md', () => {
    expect(existsSync(RESOLVER)).toBe(true);
    expect(readFileSync(RESOLVER, 'utf-8').includes('skill-vault-capture-policy/SKILL.md')).toBe(true);
  });

  it('has routing-eval fixtures', () => {
    const evalPath = join(SKILL_DIR, 'routing-eval.jsonl');
    expect(existsSync(evalPath)).toBe(true);
    const positives = readFileSync(evalPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('//'))
      .map((l) => JSON.parse(l))
      .filter((l) => l.expected_skill === 'skill-vault-capture-policy');
    expect(positives.length).toBeGreaterThanOrEqual(4);
  });
});
