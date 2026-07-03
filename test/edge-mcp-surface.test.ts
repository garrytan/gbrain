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

    expect(source).toContain("resolveMcpSurfaceProfile('edge_remote'");
    expect(source).toContain('isToolVisibleInSurfaceProfile(op, surfaceProfile)');
    expect(source).toContain('assertToolCallableInSurfaceProfile(op, surfaceProfile');
    expect(source).toContain('surfaceTokenCapabilitiesFromScopes(tokenScopes)');
    expect(source).toContain('tools: listedRemoteOps.map(operationToMcpTool)');
    expect(source).toContain('const op = operations.find((o: any) => o.name === name)');
  });

  test('remote auth carries token scopes into dispatch and logs JSON-RPC errors', () => {
    const source = readFileSync(new URL('../supabase/functions/mbrain-mcp/index.ts', import.meta.url), 'utf-8');

    expect(source).toContain('SELECT id, name, revoked_at, scopes FROM access_tokens');
    expect(source).toContain('parseAccessTokenScopes(rows[0].scopes)');
    expect(source).toContain('accessTokenExpired(scopes)');
    expect(source).toContain("error: 'token_expired'");
    expect(source).toContain('createTokenAuthPrincipal');
    expect(source).toContain('auth_principal: authPrincipal');
    expect(source).toContain('const operationRequest = request.clone()');
    expect(source).toContain('const classificationRequest = request.clone()');
    expect(source).toContain('const operation = await inferMcpOperation(operationRequest)');
    expect(source).toContain('const responseClassification = await classifyMcpResponse(classificationRequest, response)');
    expect(source).toContain('error_code, error_reason, surface_profile, auth_principal_json');
    expect(source).toContain('ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS auth_principal_json TEXT');
    expect(source).toContain("surfaceProfile: 'edge_remote'");
  });

  test('edge transport mirrors HTTP CORS allowlist and body-size cap', () => {
    const source = readFileSync(new URL('../supabase/functions/mbrain-mcp/index.ts', import.meta.url), 'utf-8');

    expect(source).toContain('MAX_MCP_EDGE_BODY_BYTES = 1_048_576');
    expect(source).toContain("Deno.env.get('MBRAIN_HTTP_ALLOWED_ORIGINS')");
    expect(source).toContain('edgeCorsHeadersFor(c.req.raw)');
    expect(source).toContain("Access-Control-Allow-Origin': origin");
    expect(source).not.toContain("origin: '*'");
    expect(source).toContain('boundEdgeMcpRequestBody(c.req.raw)');
    expect(source).toContain("error: 'request_too_large'");
    expect(source).toContain('return c.json(boundedRequest.body, 413)');
  });

  test('committed edge bundle contains the current source-registry/governance surface', () => {
    const bundle = readFileSync(new URL('../supabase/functions/mbrain-mcp/mbrain-core.js', import.meta.url), 'utf-8');

    expect(bundle).toContain('request_raw_source_chunks');
    expect(bundle).toContain('admin_put_page');
    expect(bundle).toContain('resolveMcpSurfaceProfile');
    expect(bundle).toContain('surfaceTokenCapabilitiesFromScopes');
    expect(bundle).toContain('createTokenAuthPrincipal');
    expect(bundle).not.toContain('preview_assertion_claim_extraction');
    expect(bundle).not.toContain('explain_assertion');
  });

  test('committed edge bundle enforces put_page route-first at operation layer', async () => {
    const bundleUrl = new URL('../supabase/functions/mbrain-mcp/mbrain-core.js', import.meta.url).href;
    const bundle = await import(bundleUrl) as any;
    const putPage = bundle.operationsByName.put_page;
    const adminPutPage = bundle.operationsByName.admin_put_page;

    expect(putPage.handler).not.toBe(adminPutPage.handler);
    expect(typeof bundle.resolveMcpSurfaceProfile).toBe('function');
    expect(typeof bundle.assertToolCallableInSurfaceProfile).toBe('function');
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
