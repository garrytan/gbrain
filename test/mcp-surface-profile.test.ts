import { describe, expect, test } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import { MCP_SURFACE_PROFILE_NAMES, assertToolCallableInSurfaceProfile, buildOperationSurfaceProfileExposure, findMcpSurfaceProfileClassificationFailures, getMcpSurfaceDecision, isToolVisibleInSurfaceProfile, resolveMcpSurfaceProfile, surfaceTokenCapabilitiesFromScopes } from '../src/mcp/surface-profile.ts';

const operationsByName = new Map(operations.map((operation) => [operation.name, operation]));

function operation(name: string) {
  const op = operationsByName.get(name);
  expect(op).toBeDefined();
  return op!;
}

describe('MCP surface profiles', () => {
  test('remote HTTP hides and denies exact-name admin repair writes', () => {
    const profile = resolveMcpSurfaceProfile('http_remote', {
      toolTierSelection: 'all',
    });
    const adminPutPage = operation('admin_put_page');

    expect(isToolVisibleInSurfaceProfile(adminPutPage, profile)).toBe(false);
    const decision = getMcpSurfaceDecision(adminPutPage, profile);
    expect(decision).toMatchObject({
      profile: 'http_remote',
      visible: false,
      callable: false,
    });
    expect(decision.denial_reasons).toContain('forbidden_operation');
    expect(() => assertToolCallableInSurfaceProfile(adminPutPage, profile)).toThrow(OperationError);
  });

  test('protected write tools require token capabilities on HTTP surfaces', () => {
    const profile = resolveMcpSurfaceProfile('http_remote');
    const putPage = operation('put_page');

    expect(isToolVisibleInSurfaceProfile(putPage, profile)).toBe(true);
    expect(() =>
      assertToolCallableInSurfaceProfile(putPage, profile, {
        tokenCapabilities: surfaceTokenCapabilitiesFromScopes(['mcp']),
      }),
    ).toThrow(/token_missing_canonical_write/);
    expect(() =>
      assertToolCallableInSurfaceProfile(putPage, profile, {
        tokenCapabilities: surfaceTokenCapabilitiesFromScopes(['mcp', 'canonical_write']),
      }),
    ).not.toThrow();
  });

  test('remote-callable mutating tools require an explicit surface capability', () => {
    expect(findMcpSurfaceProfileClassificationFailures(operations)).toEqual([]);

    const profile = resolveMcpSurfaceProfile('http_remote');
    const deletePage = operation('delete_page');
    expect(isToolVisibleInSurfaceProfile(deletePage, profile)).toBe(true);
    expect(() =>
      assertToolCallableInSurfaceProfile(deletePage, profile, {
        tokenCapabilities: surfaceTokenCapabilitiesFromScopes(['mcp']),
      }),
    ).toThrow(/token_missing_canonical_write/);
    expect(() =>
      assertToolCallableInSurfaceProfile(deletePage, profile, {
        tokenCapabilities: surfaceTokenCapabilitiesFromScopes(['mcp', 'canonical_write']),
      }),
    ).not.toThrow();
  });

  test('new mutating operations must be explicitly classified', () => {
    expect(findMcpSurfaceProfileClassificationFailures([
      {
        name: 'new_mutating_tool',
        description: 'Synthetic mutating operation.',
        params: {},
        mutating: true,
        handler: async () => ({}),
      },
    ])).toEqual([
      'surface_capability_missing_remote_mutation:new_mutating_tool',
      'surface_capability_unclassified_mutating:new_mutating_tool',
    ]);
  });

  test('raw source tools require all-tier visibility and raw_source token capability', () => {
    const defaultProfile = resolveMcpSurfaceProfile('http_local');
    const allProfile = resolveMcpSurfaceProfile('http_local', {
      toolTierSelection: 'all',
    });
    const rawChunks = operation('request_raw_source_chunks');

    expect(isToolVisibleInSurfaceProfile(rawChunks, defaultProfile)).toBe(false);
    expect(getMcpSurfaceDecision(rawChunks, defaultProfile).denial_reasons).toContain('tier_not_callable');
    expect(isToolVisibleInSurfaceProfile(rawChunks, allProfile)).toBe(true);
    expect(() =>
      assertToolCallableInSurfaceProfile(rawChunks, allProfile, {
        tokenCapabilities: surfaceTokenCapabilitiesFromScopes(['mcp']),
      }),
    ).toThrow(/token_missing_raw_source/);
    expect(() =>
      assertToolCallableInSurfaceProfile(rawChunks, allProfile, {
        tokenCapabilities: surfaceTokenCapabilitiesFromScopes(['mcp', 'mbrain:raw_source']),
      }),
    ).not.toThrow();
  });

  test('legacy raw data reads stay local-only because they bypass raw access ledgers', () => {
    const httpRemote = resolveMcpSurfaceProfile('http_remote', {
      toolTierSelection: 'all',
    });
    const getRawData = operation('get_raw_data');

    expect(isToolVisibleInSurfaceProfile(getRawData, httpRemote)).toBe(false);
    expect(() =>
      assertToolCallableInSurfaceProfile(getRawData, httpRemote, {
        tokenCapabilities: surfaceTokenCapabilitiesFromScopes(['mcp', 'raw_source']),
      }),
    ).toThrow(/forbidden_operation/);
  });

  test('edge remote keeps extra local-only tools off the listed and callable surface', () => {
    const profile = resolveMcpSurfaceProfile('edge_remote', {
      toolTierSelection: 'all',
    });

    for (const name of ['admin_put_page', 'sync_brain', 'file_upload', 'get_skillpack']) {
      const op = operation(name);
      expect(isToolVisibleInSurfaceProfile(op, profile)).toBe(false);
      const decision = getMcpSurfaceDecision(op, profile);
      expect(decision.callable).toBe(false);
      expect(decision.denial_reasons).toContain('forbidden_operation');
    }
  });

  test('file_upload is stdio-only even with canonical_write capability', () => {
    const httpRemote = resolveMcpSurfaceProfile('http_remote', {
      toolTierSelection: 'all',
    });
    const fileUpload = operation('file_upload');

    expect(isToolVisibleInSurfaceProfile(fileUpload, httpRemote)).toBe(false);
    expect(() =>
      assertToolCallableInSurfaceProfile(fileUpload, httpRemote, {
        tokenCapabilities: surfaceTokenCapabilitiesFromScopes(['mcp', 'canonical_write']),
      }),
    ).toThrow(/forbidden_operation/);
  });

  test('manifest exposure records every surface decision for every operation', () => {
    for (const op of operations) {
      const exposure = buildOperationSurfaceProfileExposure(op);
      expect(exposure.effective_tier).toEqual(expect.any(String));
      expect(Object.keys(exposure.decisions).sort()).toEqual([...MCP_SURFACE_PROFILE_NAMES].sort());
      for (const decision of Object.values(exposure.decisions)) {
        expect(decision.denial_reasons).toEqual([...decision.denial_reasons].sort());
      }
    }
  });
});
