import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('Supabase Edge MCP surface', () => {
  test('remote put_page uses the route_first guard and excludes admin repair writes', () => {
    const source = readFileSync(new URL('../supabase/functions/mbrain-mcp/index.ts', import.meta.url), 'utf-8');

    expect(source).toContain('admin_put_page');
    expect(source).toContain('assertRemotePutPagePrecondition');
    expect(source).toContain('route_first');
    expect(source).toContain('hasMemorySessionId(params)');
    expect(source).toContain('&& !hasMemorySessionId(params)');
  });

  test('remote list tools uses the same tier catalog filter while named dispatch stays available', () => {
    const source = readFileSync(new URL('../supabase/functions/mbrain-mcp/index.ts', import.meta.url), 'utf-8');

    expect(source).toContain('resolveAllowedTiers(getRemoteToolTierSelection())');
    expect(source).toContain('isToolVisibleAtTier(op, allowedTiers)');
    expect(source).toContain('tools: listedRemoteOps.map(operationToMcpTool)');
    expect(source).toContain('const op = remoteOps.find((o: any) => o.name === name)');
  });

  test('committed edge bundle contains the current source-registry/governance surface', () => {
    const bundle = readFileSync(new URL('../supabase/functions/mbrain-mcp/mbrain-core.js', import.meta.url), 'utf-8');

    expect(bundle).toContain('request_raw_source_chunks');
    expect(bundle).toContain('admin_put_page');
    expect(bundle).not.toContain('preview_assertion_claim_extraction');
    expect(bundle).not.toContain('explain_assertion');
  });
});
