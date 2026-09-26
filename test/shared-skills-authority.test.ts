import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dcrScopeViolation, hasScope, operationScopesAllowed } from '../src/core/scope.ts';
import { resolveGrantProfile, intersectGrantedScopes } from '../src/core/grants/service.ts';
import { submissionAuthority, authorizeWrite } from '../src/core/persistence/authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { provisionHarnessGrant } from '../src/commands/mcp-provision.ts';
import { operations } from '../src/core/operations.ts';
import { opAllowedForBoundClient } from '../src/core/ops/context.ts';

const capabilities = ['skill_editor', 'skill_publisher', 'skills_member_self'];
let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;
let incarnation: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', ['default']);
  incarnation = source.incarnation;
}, 60_000);

afterAll(async () => { await engine?.disconnect(); });

describe('explicit shared-skills authority', () => {
  test('membership refresh never shadows the existing local repository sync operation', () => {
    expect(new Set(operations.map(operation => operation.name)).size).toBe(operations.length);
    expect(operations.find(operation => operation.name === 'sync_brain')).toMatchObject({ scope: 'admin', localOnly: true });
    expect(operations.find(operation => operation.name === 'sync_brain_skills')).toMatchObject({ scope: 'read', requiredScopes: ['skills_member_self'], mutating: true });
  });
  test('ordinary and administrator scopes never imply skill capabilities', () => {
    for (const capability of capabilities) {
      for (const scopes of [['read'], ['write'], ['admin'], ['agent'], ['admin', 'agent']]) {
        expect(hasScope(scopes, capability)).toBe(false);
      }
      expect(hasScope([capability], capability)).toBe(true);
      expect(hasScope([capability], 'write')).toBe(false);
      expect(dcrScopeViolation(['read', capability], ['authorization_code'])).not.toBeNull();
      expect(dcrScopeViolation(['read', capability], ['client_credentials'])).not.toBeNull();
    }
  });

  test('base scope and every explicit capability are required together', () => {
    const editor = { scope: 'write', requiredScopes: ['skill_editor'] };
    expect(operationScopesAllowed(['admin'], editor)).toBe(false);
    expect(operationScopesAllowed(['skill_editor'], editor)).toBe(false);
    expect(operationScopesAllowed(['read', 'skill_editor'], editor)).toBe(false);
    expect(operationScopesAllowed(['write', 'skill_editor'], editor)).toBe(true);
    expect(operationScopesAllowed(['admin', 'skill_editor'], editor)).toBe(true);
    expect(operationScopesAllowed(['agent'], { ...editor, agentCallable: true })).toBe(false);
    expect(operationScopesAllowed(['read', 'skills_member_self'], { scope: 'read', requiredScopes: ['skills_member_self'] })).toBe(true);
  });

  test('an incomplete source fence never advertises self-membership operations', () => {
    for (const name of ['join_brain', 'sync_brain_skills', 'leave_brain']) {
      const op = operations.find(candidate => candidate.name === name)!;
      expect(opAllowedForBoundClient({ fenceProjectionDegraded: true }, op)).toBe(false);
      expect(opAllowedForBoundClient({ boundSlugPrefixes: ['work/'] }, op)).toBe(true);
    }
    expect(opAllowedForBoundClient({ fenceProjectionDegraded: true }, operations.find(op => op.name === 'request_tools')!)).toBe(true);
  });

  test('new ordinary profiles do not inherit editor or member authority', () => {
    for (const profile of ['memory-reader', 'memory-writer', 'coding-agent', 'operator'] as const) {
      const grant = resolveGrantProfile({ profile, sourceId: 'default', boundSlugPrefixes: ['work-example/'] });
      for (const capability of capabilities) expect(grant.scopes).not.toContain(capability);
      for (const operation of ['put_skill', 'delete_skill', 'join_brain', 'sync_brain_skills', 'leave_brain']) {
        expect(grant.allowedOperations).not.toContain(operation);
      }
    }
  });

  test('scope intersection cannot add editor authority to an old issued token', () => {
    expect(intersectGrantedScopes(['admin'], ['admin', 'skill_editor'])).not.toContain('skill_editor');
    expect(intersectGrantedScopes(['write', 'skill_editor'], ['write'])).not.toContain('skill_editor');
    expect(intersectGrantedScopes(['write', 'skill_editor'], ['write', 'skill_editor'])).toContain('skill_editor');
  });

  test('host provisioning follows by default but preserves explicit operation ceilings', async () => {
    const base = { name: 'shared-follow-example', harness: 'codex', profile: 'memory-writer' as const,
      url: 'https://brain.example.com/mcp', dryRun: true };
    const followed = await provisionHarnessGrant(engine, base, 'test');
    expect(followed.grant.scopes).toContain('skills_member_self');
    expect(followed.grant.scopes).not.toContain('skill_editor');
    expect(followed.grant.allowedOperations).toContain('join_brain');
    const constrained = await provisionHarnessGrant(engine, { ...base, patch: { allowedOperations: [] } }, 'test');
    expect(constrained.grant.allowedOperations).toEqual([]);
    expect(constrained.grant.scopes).not.toContain('skills_member_self');
    const memoryOnly = await provisionHarnessGrant(engine, { ...base, sharedSkills: 'memory-only' }, 'test');
    expect(memoryOnly.grant.scopes).not.toContain('skills_member_self');
    await expect(provisionHarnessGrant(engine, { ...base, sharedSkills: 'follow', patch: { allowedOperations: [] } }, 'test'))
      .rejects.toThrow('explicit operation snapshot');
  });

  test('an explicit profile regrant preserves prior follow consent unless changed separately', async () => {
    const created = await provider.registerClientManual(`follow-regrant-example-${crypto.randomUUID()}`, ['client_credentials'], 'read write skills_member_self', [], 'default');
    await engine.executeRaw('UPDATE oauth_clients SET allowed_operations=$1::text[] WHERE client_id=$2',
      [['list_skills', 'get_skill', 'join_brain', 'sync_brain_skills', 'leave_brain'], created.clientId]);
    const input = { name: 'follow-regrant-example', clientId: created.clientId, harness: 'codex', profile: 'memory-reader' as const,
      url: 'https://brain.example.com/mcp', dryRun: true };
    const preserved = await provisionHarnessGrant(engine, input, 'test');
    expect(preserved.grant.scopes).toContain('skills_member_self');
    expect(preserved.grant.scopes).not.toContain('write');
    expect(preserved.grant.allowedOperations).toContain('join_brain');
    const optedOut = await provisionHarnessGrant(engine, { ...input, sharedSkills: 'memory-only' }, 'test');
    expect(optedOut.grant.scopes).not.toContain('skills_member_self');
    expect(optedOut.grant.allowedOperations).not.toContain('join_brain');
  });

  async function context(scopes: string[]): Promise<OperationContext> {
    const created = await provider.registerClientManual(`skill-editor-example-${crypto.randomUUID()}`, ['client_credentials'], scopes.join(' '), [], 'default');
    await engine.executeRaw('UPDATE oauth_clients SET allowed_operations=$1::text[] WHERE client_id=$2', [['put_skill'], created.clientId]);
    return {
      engine, config: { engine: 'pglite' }, remote: true, sourceId: 'default', dryRun: false,
      logger: { info() {}, warn() {}, error() {} },
      auth: { token: '', clientId: created.clientId, principal: { kind: 'oauth_client', id: created.clientId },
        scopes, sourceId: 'default', allowedSources: ['default'], allowedOperations: ['put_skill'] },
    };
  }

  test('a real memory writer cannot acquire durable skill write authority', async () => {
    for (const scopes of [['read', 'write'], ['admin']]) {
      await expect(submissionAuthority(await context(scopes), 'put_skill', 'default', incarnation, 'skills/fixture-review'))
        .rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  test('publication and replay check current editor permission after original admission', async () => {
    const ctx = await context(['read', 'write', 'skill_editor']);
    const authority = await submissionAuthority(ctx, 'put_skill', 'default', incarnation, 'skills/fixture-review');
    await authorizeWrite(engine, authority, 'put_skill', 'skills/fixture-review');
    await engine.executeRaw('UPDATE oauth_clients SET scope=$1 WHERE client_id=$2', ['read write', ctx.auth!.clientId]);
    await expect(authorizeWrite(engine, authority, 'put_skill', 'skills/fixture-review'))
      .rejects.toMatchObject({ code: 'permission_denied' });
    await engine.executeRaw('UPDATE oauth_clients SET scope=$1 WHERE client_id=$2', ['read write skill_editor', ctx.auth!.clientId]);
    await authorizeWrite(engine, authority, 'put_skill', 'skills/fixture-review');
    await expect(authorizeWrite(engine, { ...authority, scopes: ['read', 'write'] }, 'put_skill', 'skills/fixture-review'))
      .rejects.toMatchObject({ code: 'permission_denied' });
  });
});
