import { describe, expect, test } from 'bun:test';
import { describeAuthCapabilities } from '../src/core/harness/capabilities.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';

const auth = (patch: Partial<AuthInfo> = {}): AuthInfo => ({
  token: 'fixture', clientId: 'fixture-client', scopes: ['agent'],
  sourceId: 'default', sourceActive: true, allowedSources: ['default'],
  boundSourceId: 'default', boundBrainId: null, boundTools: ['search', 'put_page'],
  delegatedNamespace: 'job', delegatedSlugPrefixes: null, boundMaxConcurrent: 1,
  allowedOperations: ['submit_agent', 'search', 'put_page'], ...patch,
});
const catalog = { delegatedTools: new Set(['search', 'put_page']), visibleOperations: ['submit_agent'] };
const reasons = (value: AuthInfo) => describeAuthCapabilities(value, catalog).remediation.map(r => r.reason);

describe('authenticated delegation readiness', () => {
  test('agent-only bindings remain ready without direct read/write scope', () => {
    const result = describeAuthCapabilities(auth(), catalog);
    expect(result.agent_ready).toBe(true);
    expect(result.scopes).toEqual(['agent']);
    expect(result.delegation.effective_tools).toEqual(['search', 'put_page']);
    expect(result.delegation_repair).toBeNull();
    expect(describeAuthCapabilities(auth({ boundBrainId: 'current' }), catalog).agent_ready).toBe(true);
  });

  test('read-source removal and an operation ceiling with no usable tool cannot claim ready', () => {
    expect(reasons(auth({ allowedSources: ['other'] }))).toContain('delegated_read_source_missing');
    expect(reasons(auth({ allowedSources: [] }))).toContain('delegated_read_source_missing');
    expect(reasons(auth({ allowedOperations: ['submit_agent'] }))).toContain('delegated_tools_not_granted');
    const narrowed = describeAuthCapabilities(auth({ allowedOperations: ['submit_agent', 'search'] }), catalog);
    expect(narrowed.agent_ready).toBe(true);
    expect(narrowed.delegation.effective_tools).toEqual(['search']);
    expect(describeAuthCapabilities(auth({ allowedOperations: null }), catalog).agent_ready).toBe(true);
    expect(reasons(auth({ allowedOperations: [] }))).toContain('submit_agent_not_granted');
  });

  test('ambiguous paths, degraded projection and surface exclusion stay unready', () => {
    expect(reasons(auth({ delegatedSlugPrefixes: [] }))).toContain('delegated_namespace_ambiguous');
    expect(reasons(auth({ delegatedNamespace: 'prefixes', delegatedSlugPrefixes: ['../'] }))).toContain('delegated_path_policy_missing');
    expect(reasons(auth({ grantProjectionDegraded: true }))).toContain('grant_projection_unavailable');
    expect(reasons(auth({ scopes: ['read', 'write'] }))).toContain('agent_scope_missing');
    expect(describeAuthCapabilities(auth(), { ...catalog, visibleOperations: [] }).agent_ready).toBe(false);
    expect(describeAuthCapabilities(auth({ boundTools: ['future_tool'] }), catalog).agent_ready).toBe(false);
  });

  test('repair guidance previews only missing bindings and leaves populated ceilings untouched', () => {
    const result = describeAuthCapabilities(auth({ grantRevision: 4, boundSourceId: undefined,
      budgetUsdPerDay: '0.30', boundMaxConcurrent: 2, boundSlugPrefixes: ['agents/kept/'] }), catalog);
    expect(result.delegation_repair).toMatchObject({ command_kind: 'preview', missing_choices: [],
      preview_command: 'gbrain auth rescope-client fixture-client --dry-run --json --if-version 4 --bound-source default' });
    expect(result.delegation_repair?.preview_command).not.toMatch(/--(?:budget|scopes|bound-tools|allowed-operations|bound-slug|bound-max|token-ttl)/);
  });

  test('missing delegation authority produces explicit choices, never permissive binding defaults', () => {
    const result = describeAuthCapabilities(auth({ grantRevision: 8, scopes: ['read'], boundTools: [],
      delegatedNamespace: 'prefixes', delegatedSlugPrefixes: [], allowedOperations: [] }), catalog);
    expect(result.delegation_repair?.command_kind).toBe('template');
    expect(result.delegation_repair?.missing_choices.map(choice => choice.placeholder)).toEqual([
      '<APPROVED_SCOPES_INCLUDING_AGENT>', '<REVIEWED_DELEGATED_TOOLS>',
      '<CHOOSE_job_OR_prefixes>', '<APPROVED_PREFIXES_OR_none>', '<APPROVED_OPERATION_SNAPSHOT>',
    ]);
    expect(result.delegation_repair?.preview_command).toContain("--bound-tools '<REVIEWED_DELEGATED_TOOLS>'");
    expect(result.delegation_repair?.preview_command).not.toContain('--profile');
    expect(result.delegation_repair?.instructions).toContain('only previews');
  });

  test('server surface and gate problems do not invent a client regrant', () => {
    const result = describeAuthCapabilities(auth({ grantRevision: 1 }), { ...catalog, visibleOperations: [] });
    expect(result.delegation_repair).toMatchObject({ preview_command: null, command_kind: 'host_check', missing_choices: [] });
    expect(result.delegation_repair?.operator_checks).toContain('Inspect the selected surface and host publish gates; a client repair cannot override a server gate.');
  });
});
