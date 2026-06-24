import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('Supabase Edge MCP surface', () => {
  test('remote put_page uses the route_first guard and excludes admin repair writes', () => {
    const source = readFileSync(new URL('../supabase/functions/mbrain-mcp/index.ts', import.meta.url), 'utf-8');

    expect(source).toContain('admin_put_page');
    expect(source).toContain('assertRemotePutPagePrecondition');
    expect(source).toContain('route_first');
    expect(source).toContain('memory_session_id alone is not a route-first write grant');
    expect(source).not.toContain('hasMemorySessionId(params)');
  });

  test('remote list and named dispatch both use the same tier catalog filter', () => {
    const source = readFileSync(new URL('../supabase/functions/mbrain-mcp/index.ts', import.meta.url), 'utf-8');

    expect(source).toContain('resolveAllowedTiers(getRemoteToolTierSelection())');
    expect(source).toContain('isToolVisibleAtTier(op, allowedTiers)');
    expect(source).toContain('tools: listedRemoteOps.map(operationToMcpTool)');
    expect(source).toContain('const op = remoteOps.find((o: any) => o.name === name && isToolVisibleAtTier(o, allowedTiers))');
  });

  test('committed edge bundle contains the current source-registry/governance surface', () => {
    const bundle = readFileSync(new URL('../supabase/functions/mbrain-mcp/mbrain-core.js', import.meta.url), 'utf-8');

    expect(bundle).toContain('request_raw_source_chunks');
    expect(bundle).toContain('admin_put_page');
    expect(bundle).not.toContain('preview_assertion_claim_extraction');
    expect(bundle).not.toContain('explain_assertion');
  });

  test('committed edge bundle enforces put_page route-first at operation layer', async () => {
    const bundleUrl = new URL('../supabase/functions/mbrain-mcp/mbrain-core.js', import.meta.url).href;
    const bundle = await import(bundleUrl) as any;
    const putPage = bundle.operationsByName.put_page;
    const adminPutPage = bundle.operationsByName.admin_put_page;

    expect(putPage.handler).not.toBe(adminPutPage.handler);
    await expect(putPage.handler({ dryRun: false }, {
      slug: 'concepts/edge-bundle-route-first',
      content: [
        '---',
        'type: concept',
        'title: Edge Bundle Route First',
        '---',
        '',
        'Bundle route-first check. [Source: edge bundle route-first test]',
      ].join('\n'),
    })).rejects.toMatchObject({
      name: 'OperationError',
      code: 'invalid_params',
      message: expect.stringContaining('route_first'),
    });
  });
});
