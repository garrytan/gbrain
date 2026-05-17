import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { companySkillProfile, filterOperationsForBrainRole } from '../src/core/company-skill-policy.ts';
import { setCompanyShareRole } from '../src/core/company-share.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('company skill profile', () => {
  test('keeps only company-necessary skills enabled by default', () => {
    const profile = companySkillProfile();

    expect(profile.enabled).toContain('query');
    expect(profile.enabled).toContain('data-research');
    expect(profile.enabled).toContain('concept-synthesis');
    expect(profile.admin_only).toContain('setup');
    expect(profile.admin_only).toContain('skillify');
    expect(profile.disabled).toContain('daily-task-manager');
    expect(profile.disabled).toContain('meeting-ingestion');
  });

  test('filters remote MCP tools for company mode', () => {
    const defs = buildToolDefs(filterOperationsForBrainRole(operations, 'company'));
    const names = new Set(defs.map(d => d.name));

    expect(names.has('query')).toBe(true);
    expect(names.has('search')).toBe(true);
    expect(names.has('get_brain_identity')).toBe(true);
    expect(names.has('put_page')).toBe(false);
    expect(names.has('delete_page')).toBe(false);
    expect(names.has('file_upload')).toBe(false);
    expect(names.has('company_share_export')).toBe(false);
  });

  test('remote dispatch denies non-company tools when brain role is company', async () => {
    await setCompanyShareRole(engine, 'company');

    const result = await dispatchToolCall(engine, 'put_page', {
      slug: 'wiki/agents/1/nope',
      content: 'Nope',
    }, { remote: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('permission_denied');
  });

  test('company identity advertises reduced skill profile', async () => {
    await setCompanyShareRole(engine, 'company');

    const result = await operationsByName.get_brain_identity.handler({
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
      sourceId: 'default',
    }, {});

    expect((result as any).brain_role).toBe('company');
    expect((result as any).skill_profile.enabled).toContain('query');
    expect((result as any).skill_profile.admin_only).toContain('skillify');
  });
});
