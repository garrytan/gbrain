/** Startup display only; callers retain bootstrap-token disclosure decisions. */
import { VERSION } from '../version.ts';

interface ServeHttpBannerOptions {
  port: number;
  bind: string;
  engine: string;
  issuerOrigin: string;
  clientCount: unknown;
  enableDcr: boolean;
  enableDcrInsecure?: boolean;
  skillBanner: string;
  tokenTtl: number;
  bootstrapToken: string;
  bootstrapFromEnv: boolean;
  suppressBootstrapPrint: boolean;
}

export function formatServeHttpBanner(options: ServeHttpBannerOptions): string {
  const {
    port, bind, engine, issuerOrigin, clientCount, enableDcr, enableDcrInsecure,
    skillBanner, tokenTtl, bootstrapToken, bootstrapFromEnv, suppressBootstrapPrint,
  } = options;
  return `
╔══════════════════════════════════════════════════════╗
║  GBrain MCP Server v${VERSION.padEnd(37)}║
╠══════════════════════════════════════════════════════╣
║  Port:      ${String(port).padEnd(40)}║
║  Bind:      ${bind.padEnd(40)}║
║  Engine:    ${engine.padEnd(40)}║
║  Issuer:    ${issuerOrigin.padEnd(40)}║
║  Clients:   ${String(clientCount).padEnd(40)}║
║  DCR:       ${(enableDcr ? (enableDcrInsecure ? 'enabled (INSECURE: read-only M2M)' : 'enabled (consent; DCR max read write)') : 'disabled').padEnd(40)}║
║  Skills:    ${skillBanner.padEnd(40)}║
║  Token TTL: ${(tokenTtl + 's').padEnd(40)}║
╠══════════════════════════════════════════════════════╣
║  Admin:     http://localhost:${port}/admin${' '.repeat(Math.max(0, 19 - String(port).length))}║
║  MCP:       http://localhost:${port}/mcp${' '.repeat(Math.max(0, 21 - String(port).length))}║
║  Health:    http://localhost:${port}/health${' '.repeat(Math.max(0, 18 - String(port).length))}║
╠══════════════════════════════════════════════════════╣
${bootstrapFromEnv
  ? '║  Admin Token: from $GBRAIN_ADMIN_BOOTSTRAP_TOKEN     ║\n╚══════════════════════════════════════════════════════╝'
  : suppressBootstrapPrint
    ? '║  Admin Token: hidden (non-TTY log-leak guard)        ║\n║  set $GBRAIN_ADMIN_BOOTSTRAP_TOKEN, or pass          ║\n║  --print-admin-token on a trusted terminal.          ║\n╚══════════════════════════════════════════════════════╝'
    : `║  Admin Token (paste into /admin login):              ║\n║  ${bootstrapToken.substring(0, 50)}  ║\n║  ${bootstrapToken.substring(50).padEnd(50)}  ║\n╚══════════════════════════════════════════════════════╝`}
`;
}
