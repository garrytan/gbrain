import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BOOTSTRAP_TEMPLATES } from '../src/core/bootstrap/assets.ts';

describe('ACCESS_POLICY template (#8777)', () => {
  const t = BOOTSTRAP_TEMPLATES.find((x) => x.dest === 'ACCESS_POLICY.md')!;
  const body = readFileSync(t.assetPath, 'utf8');

  test('names the governing managed block when AGENTS.md disagrees', () => {
    expect(body).toContain('gbrain:managed:access-policy');
  });

  test('visibility instruction is a runnable command', () => {
    expect(body).toContain('gbrain config set facts.default_visibility private');
  });
});
