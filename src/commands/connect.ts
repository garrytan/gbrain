import { initRemoteMcp } from './init.ts';

type OnboardingPayload = Record<string, unknown>;

interface ResolvedRemoteConfig {
  issuerUrl: string;
  mcpUrl: string;
  clientId: string;
  clientSecret?: string;
  secretFromEnv: boolean;
}

class ConnectCommandError extends Error {
  reason: string;
  extra: Record<string, unknown>;

  constructor(reason: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.reason = reason;
    this.extra = extra;
  }
}

const VALUE_FLAGS = new Set([
  '--client-secret',
  '--oauth-client-secret',
  '--secret',
  '--issuer-url',
  '--mcp-url',
  '--server-url',
]);

export async function runConnect(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    printConnectHelp();
    return;
  }

  const jsonOutput = args.includes('--json');
  const isForce = args.includes('--force');
  const isNonInteractive = args.includes('--non-interactive');
  const skipSmoke = args.includes('--no-smoke');
  const onboardingUrl = firstPositional(args);

  function fail(reason: string, message: string, extra: Record<string, unknown> = {}): never {
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'error', reason, message, ...extra }));
    } else {
      console.error(message);
    }
    process.exit(1);
  }

  if (!onboardingUrl) {
    fail(
      'missing_onboarding_url',
      'Usage: cortex connect <onboarding-url> --client-secret <secret>',
    );
  }

  let remote: ResolvedRemoteConfig;
  try {
    const payload = parseOnboardingInvite(onboardingUrl);
    remote = resolveOnboardingRemoteConfig(payload, {
      clientSecret: flagValue(args, '--client-secret', '--oauth-client-secret', '--secret'),
      issuerUrl: flagValue(args, '--issuer-url'),
      mcpUrl: flagValue(args, '--mcp-url', '--server-url'),
    });
  } catch (e) {
    if (e instanceof ConnectCommandError) {
      fail(e.reason, e.message, e.extra);
    }
    fail('invalid_onboarding_url', e instanceof Error ? e.message : 'Could not parse onboarding URL.');
  }

  const setupArgs = [
    '--issuer-url', remote.issuerUrl,
    '--mcp-url', remote.mcpUrl,
    '--oauth-client-id', remote.clientId,
  ];
  if (remote.clientSecret && !remote.secretFromEnv) {
    setupArgs.push('--oauth-client-secret', remote.clientSecret);
  }
  if (jsonOutput) setupArgs.push('--json');
  if (isForce) setupArgs.push('--force');
  if (isNonInteractive) setupArgs.push('--non-interactive');
  if (skipSmoke) setupArgs.push('--no-smoke');

  return initRemoteMcp({
    args: setupArgs,
    jsonOutput,
    isForce,
    isNonInteractive,
  });
}

export function parseOnboardingInvite(input: string): OnboardingPayload {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Empty onboarding URL.');
  if (trimmed.startsWith('{')) return parseJsonPayload(trimmed);

  const embedded = extractInviteParam(trimmed);
  const encoded = embedded || trimmed;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch (e) {
    throw new Error(`Invite payload is not valid base64url: ${(e as Error).message}`);
  }
  return parseJsonPayload(decoded);
}

export function resolveOnboardingRemoteConfig(
  payload: OnboardingPayload,
  opts: { clientSecret?: string | null; issuerUrl?: string | null; mcpUrl?: string | null } = {},
): ResolvedRemoteConfig {
  const status = stringField(payload, 'status')?.toLowerCase();
  const isProvisioning = status === 'provisioning' || status === 'pending_provisioning';
  const mcpUrl = cleanUrl(
    opts.mcpUrl ||
    stringField(payload, 'server_url') ||
    stringField(payload, 'mcp_url') ||
    stringField(payload, 'serverUrl'),
    'server_url',
  );
  const tokenUrl = stringField(payload, 'token_url') || stringField(payload, 'tokenUrl');
  const issuerUrl = cleanUrl(
    opts.issuerUrl ||
    stringField(payload, 'issuer_url') ||
    stringField(payload, 'issuerUrl') ||
    issuerFromTokenUrl(tokenUrl) ||
    originFromUrl(mcpUrl),
    'issuer_url',
  );
  const clientId = stringField(payload, 'client_id') || stringField(payload, 'oauth_client_id');
  const clientSecret = opts.clientSecret?.trim()
    || process.env.CORTEX_REMOTE_CLIENT_SECRET?.trim()
    || process.env.GBRAIN_REMOTE_CLIENT_SECRET?.trim()
    || '';

  if (!mcpUrl) {
    throw new ConnectCommandError(
      isProvisioning ? 'provisioning_pending' : 'missing_server_url',
      isProvisioning
        ? 'This onboarding URL is a signup receipt. The tenant brain is still provisioning and does not include a server URL yet.'
        : 'The onboarding payload is missing server_url. Ask the console or inviting agent for a fresh invite URL.',
      { status },
    );
  }
  if (!issuerUrl) {
    throw new ConnectCommandError(
      'missing_issuer_url',
      'The onboarding payload is missing token_url/issuer_url, and an issuer could not be derived from server_url.',
    );
  }
  if (!clientId) {
    throw new ConnectCommandError(
      isProvisioning ? 'provisioning_pending' : 'missing_client_id',
      isProvisioning
        ? 'This onboarding URL is a signup receipt. Provision the tenant, create an agent/teammate invite, then run cortex connect with that invite URL.'
        : 'The onboarding payload is missing client_id. Create a teammate or agent invite from the console first.',
      { status, server_url: mcpUrl },
    );
  }
  if (!clientSecret) {
    throw new ConnectCommandError(
      'missing_client_secret',
      'The onboarding URL intentionally does not contain the client secret. Pass --client-secret <secret> or set CORTEX_REMOTE_CLIENT_SECRET.',
      { client_id: clientId },
    );
  }

  return {
    issuerUrl,
    mcpUrl,
    clientId,
    clientSecret,
    secretFromEnv: !opts.clientSecret && Boolean(
      process.env.CORTEX_REMOTE_CLIENT_SECRET?.trim() || process.env.GBRAIN_REMOTE_CLIENT_SECRET?.trim(),
    ),
  };
}

function extractInviteParam(input: string): string | null {
  try {
    const url = new URL(input);
    const fromQuery = url.searchParams.get('invite');
    if (fromQuery) return fromQuery;
    return inviteFromHash(url.hash);
  } catch {
    const fromHash = input.startsWith('#') ? inviteFromHash(input) : null;
    if (fromHash) return fromHash;
    const directParams = new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
    return directParams.get('invite');
  }
}

function inviteFromHash(hash: string): string | null {
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  const query = clean.includes('?') ? clean.slice(clean.indexOf('?') + 1) : clean;
  if (!query) return null;
  return new URLSearchParams(query).get('invite');
}

function parseJsonPayload(raw: string): OnboardingPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invite payload is not JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invite payload must be a JSON object.');
  }
  return parsed as OnboardingPayload;
}

function stringField(payload: OnboardingPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanUrl(input: string | null | undefined, label: string): string | null {
  const value = input?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`${label} must start with http:// or https://`);
    }
    return value.replace(/\/+$/, '');
  } catch (e) {
    throw new ConnectCommandError('invalid_url', `${label} is not a valid URL: ${value}`, { detail: (e as Error).message });
  }
}

function issuerFromTokenUrl(input: string | null): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    url.search = '';
    url.hash = '';
    if (url.pathname === '/token' || url.pathname.endsWith('/token')) {
      url.pathname = url.pathname.replace(/\/token\/?$/, '') || '/';
    } else {
      url.pathname = '/';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function originFromUrl(input: string | null): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function firstPositional(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (VALUE_FLAGS.has(value)) {
      i += 1;
      continue;
    }
    if (!value.startsWith('-')) return value;
  }
  return null;
}

function flagValue(args: string[], ...names: string[]): string | null {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  }
  return null;
}

function printConnectHelp() {
  console.log(`cortex connect - attach this runtime to a hosted Cortex brain

USAGE
  cortex connect <onboarding-url> [options]

OPTIONS
  --client-secret <secret>   One-time OAuth client secret from the console/inviter
  --force                    Overwrite an existing thin-client profile
  --no-smoke                 Write config without OAuth/MCP pre-flight probes
  --json                     Print machine-readable output

EXAMPLES
  cortex connect 'https://brain.example.com/admin/onboarding?invite=...' --client-secret '...'
  CORTEX_REMOTE_CLIENT_SECRET='...' cortex connect 'https://brain.example.com/admin/onboarding?invite=...'

Signup receipt URLs may only contain org/provisioning details. Create an agent or teammate invite first, then connect with that invite URL.`);
}
