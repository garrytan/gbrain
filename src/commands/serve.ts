import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';

export async function runServe(engine: BrainEngine, args: string[] = []) {
  // v0.26+: --http dispatches to the full OAuth 2.1 server (serve-http.ts)
  // with admin dashboard, scope enforcement, SSE feed, and the requireBearerAuth
  // middleware. Master's simpler startHttpTransport from v0.22.7 is superseded
  // — the OAuth provider in serve-http.ts handles bearer auth via
  // verifyAccessToken with legacy access_tokens fallback (so v0.22.7 callers
  // that used `gbrain auth create` keep working unchanged).
  const isHttp = args.includes('--http');

  if (isHttp) {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) || 3131 : 3131;

    const ttlIdx = args.indexOf('--token-ttl');
    const tokenTtl = ttlIdx >= 0 ? parseInt(args[ttlIdx + 1]) || 3600 : 3600;

    const enableDcr = args.includes('--enable-dcr');

    const publicUrlIdx = args.indexOf('--public-url');
    const publicUrl = publicUrlIdx >= 0 ? args[publicUrlIdx + 1] : undefined;

    // F8 escape hatch: --log-full-params writes raw payloads to mcp_request_log
    // and the admin SSE feed instead of redacted summaries. Off by default
    // (privacy-first); operators running gbrain on their own laptop can flip
    // it on for debug visibility. Loud startup warning fires in serve-http.ts
    // when set so the posture change is visible in stderr.
    const logFullParams = args.includes('--log-full-params');

    // Runtime MCP access control. Default on: legacy clients and old
    // rows resolve to Full, so existing grants keep working while
    // lower-tier clients get a real boundary. Operators can use
    // --audit-access-tiers / --no-enforce-access-tiers as an explicit
    // dry-run escape hatch during rollout.
    const auditAccessTiers = args.includes('--audit-access-tiers') || args.includes('--no-enforce-access-tiers');
    const enforceAccessTiers = !auditAccessTiers || args.includes('--enforce-access-tiers');

    // v47 OIDC end-user identity. All three flags must be set together to
    // enable the federation path; missing flags leave gbrain on the legacy
    // operator-trusted client_credentials posture. The OIDC client secret
    // can also be sourced from GBRAIN_OIDC_CLIENT_SECRET so operators do
    // not have to put it on argv where ps(1) sees it.
    const oidcIssuerIdx = args.indexOf('--oidc-issuer');
    const oidcIssuer = oidcIssuerIdx >= 0 ? args[oidcIssuerIdx + 1] : process.env.GBRAIN_OIDC_ISSUER;
    const oidcClientIdIdx = args.indexOf('--oidc-client-id');
    const oidcClientId = oidcClientIdIdx >= 0 ? args[oidcClientIdIdx + 1] : process.env.GBRAIN_OIDC_CLIENT_ID;
    const oidcClientSecretIdx = args.indexOf('--oidc-client-secret');
    const oidcClientSecret = oidcClientSecretIdx >= 0 ? args[oidcClientSecretIdx + 1] : process.env.GBRAIN_OIDC_CLIENT_SECRET;

    const { runServeHttp } = await import('./serve-http.ts');
    await runServeHttp(engine, {
      port, tokenTtl, enableDcr, publicUrl, logFullParams, enforceAccessTiers,
      oidcIssuer, oidcClientId, oidcClientSecret,
    });
  } else {
    console.error('Starting GBrain MCP server (stdio)...');
    await startMcpServer(engine);
  }
}
