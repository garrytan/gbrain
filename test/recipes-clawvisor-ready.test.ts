/**
 * #1098 — ClawVisor health checks must hit /ready (surfaces db/vault
 * degradation), never /health (bare liveness, masks those failure modes).
 * #1099 — the credential-gateway recipe tells users to activate Google
 * Contacts; the canonical consumer recipe must actually ship.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const RECIPES = join(import.meta.dir, '../recipes');

describe('#1098 — ClawVisor health checks use /ready', () => {
  for (const f of ['email-to-brain.md', 'calendar-to-brain.md', 'credential-gateway.md', 'contacts-to-brain.md']) {
    test(`${f} references $CLAWVISOR_URL/ready, never /health`, () => {
      const text = readFileSync(join(RECIPES, f), 'utf-8');
      expect(text).not.toContain('$CLAWVISOR_URL/health');
      expect(text).toContain('$CLAWVISOR_URL/ready');
    });
  }
});

describe('#1099 — canonical contacts-to-brain recipe ships', () => {
  test('recipes/contacts-to-brain.md exists with the sibling frontmatter shape', () => {
    const p = join(RECIPES, 'contacts-to-brain.md');
    expect(existsSync(p)).toBe(true);
    const text = readFileSync(p, 'utf-8');
    expect(text).toContain('id: contacts-to-brain');
    expect(text).toContain('requires: [credential-gateway]');
    expect(text).toContain('health_checks:');
    expect(text).toContain('contacts.readonly');
  });
});
