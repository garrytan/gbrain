import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { buildSkillCatalog, getSkillDetail } from '../src/core/skill-catalog.ts';

describe('published skill optional tool metadata', () => {
  test.each([
    ['omitted', 'name: portable\ndescription: A portable skill', true],
    ['explicit empty', 'name: portable\ntools: []', false],
    ['invalid type', 'name: portable\ntools: search', false],
    ['malformed YAML', 'name: portable\ndescription: [unfinished', false],
    ['no frontmatter', '', false],
  ] as const)('%s tool metadata agrees across list and detail', (_label, raw, inherits) => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-skill-tools-'));
    try {
      mkdirSync(join(dir, 'portable'));
      writeFileSync(join(dir, 'portable', 'SKILL.md'), raw ? `---\n${raw}\n---\n\nRead the brain.\n` : 'Read the brain.\n');
      const ctx = {
        remote: true,
        auth: { token: 'test-token', clientId: 'test-client', scopes: ['read'] },
      } as OperationContext;
      const catalog = buildSkillCatalog(ctx, dir, 'config');
      const skill = catalog.skills.find(s => s.name === 'portable')!;
      const detail = getSkillDetail(ctx, dir, 'portable');
      expect(skill).toBeDefined();
      expect(skill.tools).toEqual([]);
      expect(skill.usable_tools).toEqual(inherits ? catalog.instructions.available_brain_tools : []);
      expect(detail.usable_tools).toEqual(skill.usable_tools);
      expect(skill.unavailable_tools).toEqual([]);
      expect(detail.unavailable_tools).toEqual([]);
      expect(detail.usable_tools).not.toContain('put_page');
      if (inherits) {
        expect(detail.usable_tools).toContain('search');
        expect(detail.usable_tools).toContain('query');
        expect(detail.frontmatter.tools).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    { remote: true, transport: 'stdio' },
    { remote: false },
    { remote: true, auth: { token: 'test-token', clientId: 'test-client', scopes: ['admin'] } },
    { remote: true, auth: { token: 'test-token', clientId: 'test-client', scopes: [] } },
  ] as const)('omitted tools inherit only the effective caller inventory: %j', context => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-skill-tools-'));
    try {
      mkdirSync(join(dir, 'portable'));
      writeFileSync(join(dir, 'portable', 'SKILL.md'), '---\nname: portable\n---\nRead the brain.\n');
      const ctx = context as OperationContext;
      const catalog = buildSkillCatalog(ctx, dir, 'config');
      const detail = getSkillDetail(ctx, dir, 'portable');
      expect(detail.usable_tools).toEqual(catalog.instructions.available_brain_tools);
      expect(catalog.skills[0].usable_tools).toEqual(detail.usable_tools);
      expect(detail.usable_tools.includes('purge_deleted_pages')).toBe(context.remote === false);
      if (context.remote === false || 'transport' in context || context.auth.scopes.length > 0) {
        expect(detail.usable_tools).toContain('put_page');
      } else {
        expect(detail.usable_tools).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
