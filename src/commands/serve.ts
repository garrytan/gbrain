import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';
import { startMcpHttpServer } from '../mcp/http-server.ts';
import { loadConfig } from '../core/config.ts';
import { DEFAULT_RUNTIME_CONFIG } from '../core/engine-factory.ts';

export async function runServe(engine: BrainEngine | Promise<BrainEngine>, args: string[] = []) {
  const http = args.includes('--http');
  const host = parseStringFlag(args, '--host') ?? process.env.MBRAIN_HTTP_HOST ?? '127.0.0.1';
  const port = parseNumberFlag(args, '--port') ?? parseEnvPort() ?? 8787;
  const oauth = args.includes('--oauth') || process.env.MBRAIN_HTTP_OAUTH === '1';
  const publicBaseUrl = parseStringFlag(args, '--public-url') ?? process.env.MBRAIN_HTTP_PUBLIC_URL;
  const oauthApprovalToken = process.env.MBRAIN_OAUTH_APPROVAL_TOKEN ?? process.env.MBRAIN_HTTP_OAUTH_PIN;
  const oauthSigningSecret = process.env.MBRAIN_OAUTH_SIGNING_SECRET;

  if (http) {
    const oauthStartupErrors = getHttpOAuthServeStartupErrors({
      oauth,
      publicBaseUrl,
      oauthApprovalToken,
      oauthSigningSecret,
    });
    if (oauthStartupErrors.length > 0) {
      for (const error of oauthStartupErrors) {
        console.error(error);
      }
      process.exit(1);
    }
    const config = loadConfig() ?? DEFAULT_RUNTIME_CONFIG;
    const httpEngine = await prepareHttpServeEngine(engine, oauth);
    const allowedOrigins = resolveAllowedOrigins(publicBaseUrl);
    const server = startMcpHttpServer({
      engine: httpEngine,
      config,
      host,
      port,
      allowedOrigins,
      oauth: oauth ? {
        enabled: true,
        publicBaseUrl,
        approvalToken: oauthApprovalToken,
        signingSecret: oauthSigningSecret,
      } : undefined,
    });
    console.error(`Starting MBrain MCP server (HTTP) on http://${server.hostname}:${server.port}`);
    console.error(allowedOrigins.length > 0
      ? `Browser CORS allowed origins: ${allowedOrigins.join(', ')}`
      : 'Browser CORS disabled (no allowed origins). Set MBRAIN_HTTP_ALLOWED_ORIGINS or --public-url if a browser client needs access.');
    if (oauth) {
      console.error('OAuth routes enabled. Token/authorize/register endpoints are rate limited per client address.');
    }
    await new Promise(() => undefined);
    return;
  }

  console.error('Starting MBrain MCP server (stdio)...');
  await startMcpServer(engine);
}

export interface HttpOAuthServeStartupOptions {
  oauth: boolean;
  publicBaseUrl?: string;
  oauthApprovalToken?: string;
  oauthSigningSecret?: string;
}

export function getHttpOAuthServeStartupErrors(options: HttpOAuthServeStartupOptions): string[] {
  if (!options.oauth) return [];

  const errors: string[] = [];
  if (!options.oauthApprovalToken || !options.oauthSigningSecret) {
    errors.push('OAuth requires both MBRAIN_OAUTH_APPROVAL_TOKEN and MBRAIN_OAUTH_SIGNING_SECRET to be set.');
    errors.push('The previous fallback (signing refresh tokens with the approval token) was removed for security.');
    errors.push('Generate a dedicated secret, e.g.: openssl rand -hex 32');
  }
  if (!options.publicBaseUrl?.trim()) {
    errors.push('OAuth requires --public-url or MBRAIN_HTTP_PUBLIC_URL when OAuth is enabled.');
  }
  return errors;
}

export async function prepareHttpServeEngine(
  engine: BrainEngine | Promise<BrainEngine>,
  oauthEnabled: boolean,
): Promise<BrainEngine> {
  const resolved = await engine;
  if (oauthEnabled) {
    await resolved.initSchema();
  }
  return resolved;
}

export function resolveAllowedOrigins(publicBaseUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = new Set<string>();
  for (const entry of (env.MBRAIN_HTTP_ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = entry.trim().replace(/\/+$/, '');
    if (trimmed.length === 0) continue;
    // Browsers send `Origin: null` from sandboxed contexts; never allow the
    // literal string to be allowlisted by accident.
    if (trimmed.toLowerCase() === 'null') {
      console.error(`Ignoring MBRAIN_HTTP_ALLOWED_ORIGINS entry "${entry.trim()}": the null origin cannot be allowlisted.`);
      continue;
    }
    try {
      // Normalize to a real origin so entries with paths or uppercase schemes
      // still match the browser's Origin header.
      origins.add(new URL(trimmed).origin);
    } catch {
      console.error(`Ignoring MBRAIN_HTTP_ALLOWED_ORIGINS entry "${entry.trim()}": not a valid origin URL.`);
    }
  }
  if (publicBaseUrl) {
    try {
      origins.add(new URL(publicBaseUrl).origin);
    } catch {
      // Ignore malformed public URLs; the server reports CORS state at startup.
    }
  }
  return [...origins];
}

function parseStringFlag(args: string[], flag: string): string | undefined {
  const equalsArg = args.find(arg => arg.startsWith(`${flag}=`));
  if (equalsArg) return equalsArg.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function parseNumberFlag(args: string[], flag: string): number | undefined {
  const raw = parseStringFlag(args, flag);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function parseEnvPort(): number | undefined {
  const raw = process.env.MBRAIN_HTTP_PORT;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
