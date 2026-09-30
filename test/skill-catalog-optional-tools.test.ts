import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildSkillCatalog, crossReferenceTools, getSkillDetail } from '../src/core/skill-catalog.ts';

describe('published skill optional tool metadata', () => {
  describe('registered stdio', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    });
    beforeEach(async () => { await resetPgliteState(engine); });
    afterAll(async () => { await engine.disconnect(); });

    test.each([
      { scopes: ['read'], operations: null, expected: ['search'] },
      { scopes: ['read', 'write'], operations: null, expected: ['search', 'put_page'] },
      { scopes: ['read', 'write', 'skill_editor'], operations: null, expected: ['search', 'put_page', 'put_skill'] },
      { scopes: ['read', 'write', 'skill_editor'], operations: ['search'], expected: ['search'] },
    ])('registered stdio inventories honor the verified grant: %j', async ({ scopes, operations, expected }) => {
      const expectedTools: string[] = [...expected];
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-registered-skill-tools-'));
      try {
        const registration = { id: '00000000-0000-4000-8000-000000000123', credential: 'synthetic-test-credential', lane: 'stdio' as const };
        await engine.executeRaw('INSERT INTO persistence_local_writers (id, lane, credential_hash, grant_ceiling) VALUES ($1, $2, $3, $4::jsonb)', [
          registration.id, registration.lane, sha256(registration.credential),
          { sourceIds: ['*'], operations, scopes, slugPrefixes: null },
        ]);
        mkdirSync(join(dir, 'portable'));
        writeFileSync(join(dir, 'portable', 'SKILL.md'), '---\nname: portable\ndescription: A portable skill\n---\n\nRead the brain.\n');
        await withVerifiedLocalRegistration(engine, registration, async () => {
          const ctx = { remote: true, transport: 'stdio' } as OperationContext;
          const catalog = buildSkillCatalog(ctx, dir, 'config', { gateDisabled: new Set() });
          const detail = getSkillDetail(ctx, dir, 'portable', { gateDisabled: new Set() });
          const probes = ['search', 'put_page', 'put_skill'];
          for (const inventory of [catalog.skills[0].usable_tools, catalog.instructions.available_brain_tools, detail.usable_tools, detail.client_guidance.available_brain_tools]) {
            expect(probes.filter(name => inventory.includes(name))).toEqual(expectedTools);
          }
          expect(crossReferenceTools(probes, ctx, new Set())).toEqual({
            usable_tools: expectedTools,
            unavailable_tools: probes.filter(name => !expectedTools.includes(name)),
          });
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  test.each([
    { scopes: ['admin'], allowed: false },
    { scopes: ['write'], allowed: false },
    { scopes: ['write', 'skill_editor'], allowed: true },
  ])('shared-skill writes require the explicit editor grant: %j', ({ scopes, allowed }) => {
    for (const transport of [undefined, 'stdio'] as const) {
      const ctx = { remote: true, transport, auth: { token: 'test-token', clientId: 'test-client', scopes: [...scopes] } } as OperationContext;
      const tools = crossReferenceTools(['put_skill'], ctx, new Set());
      expect(tools.usable_tools).toEqual(allowed ? ['put_skill'] : []);
      expect(tools.unavailable_tools).toEqual(allowed ? [] : ['put_skill']);
    }
  });

  test('unregistered stdio cannot inherit explicitly granted shared-skill operations', () => {
    const tools = crossReferenceTools(['put_skill', 'search'], { remote: true, transport: 'stdio' } as OperationContext, new Set());
    expect(tools.usable_tools).toEqual(['search']);
    expect(tools.unavailable_tools).toEqual(['put_skill']);
  });

  test.each([
    { auth: { token: 'test-token', clientId: 'test-client', scopes: ['admin'], effectiveSurface: 'verbs' as const } },
    { transport: 'stdio' as const, surfaceCeiling: 'verbs' as const },
  ])('tool inventories respect the effective surface: %j', context => {
    const tools = crossReferenceTools(['remember', 'search'], { remote: true, ...context } as OperationContext, new Set());
    expect(tools.usable_tools).toEqual(['remember']);
    expect(tools.unavailable_tools).toEqual(['search']);
  });

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
