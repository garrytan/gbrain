/** Composio-backed Google read transport. Provider tokens never leave Composio. */
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { FetchImpl } from './google-clients.ts';

const COMPOSIO_BASE = 'https://backend.composio.dev';
const GMAIL_PREFIX = 'https://gmail.googleapis.com/gmail/v1/';
const CALENDAR_PREFIX = 'https://www.googleapis.com/calendar/v3/';
type Toolkit = 'gmail' | 'googlecalendar';

interface RegistryAccount {
  id: string;
  status?: string;
  projectId?: string;
  userId?: string;
  projectApiKeySecretPath?: string;
  toolkits?: Partial<Record<Toolkit, { connectedAccountId?: string; profile?: { email?: string } }>>;
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function loadAccount(account: string, ref: string, toolkit: Toolkit, overridePath?: string): { key: string; projectId: string; userId: string; connectedId: string } {
  const registryPath = expandHome(overridePath ?? process.env.OPENCLAW_COMPOSIO_REGISTRY ?? join(homedir(), '.openclaw/composio/accounts.json'));
  const registry = readJson(registryPath);
  const entries = registry.accounts;
  if (!Array.isArray(entries)) throw new Error('Composio registry has no accounts array');
  const entry = entries.find((candidate): candidate is RegistryAccount =>
    typeof candidate === 'object' && candidate !== null && (candidate as RegistryAccount).id === ref);
  if (!entry || entry.status === 'disabled') throw new Error(`Composio account ref ${ref} is absent or disabled`);
  const connection = entry.toolkits?.[toolkit];
  const label = toolkit === 'gmail' ? 'Gmail' : 'Calendar';
  if (connection?.profile?.email?.trim().toLowerCase() !== account.trim().toLowerCase()) {
    throw new Error(`Composio ${label} identity does not match source account for ${ref}`);
  }
  if (!entry.projectId || !entry.userId || !connection.connectedAccountId || !entry.projectApiKeySecretPath) {
    throw new Error(`Composio ${label} registry entry ${ref} is incomplete`);
  }
  const secretPath = expandHome(entry.projectApiKeySecretPath);
  const mode = lstatSync(secretPath);
  if (!mode.isFile() || (mode.mode & 0o077) !== 0) {
    throw new Error(`Composio project secret for ${ref} must be a private regular file`);
  }
  const secret = readJson(secretPath);
  if (secret.project_id !== entry.projectId || typeof secret.project_api_key !== 'string' || !secret.project_api_key) {
    throw new Error(`Composio project secret does not match registry entry ${ref}`);
  }
  return { key: secret.project_api_key, projectId: entry.projectId, userId: entry.userId, connectedId: connection.connectedAccountId };
}

/** Only GETs to the chosen API are allowed; each source has one service. */
function createComposioGoogleFetch(
  account: string,
  ref: string,
  toolkit: Toolkit,
  options: { registryPath?: string; transport?: FetchImpl } = {},
): FetchImpl {
  const { key, projectId, userId, connectedId } = loadAccount(account, ref, toolkit, options.registryPath);
  const prefix = toolkit === 'gmail' ? GMAIL_PREFIX : CALENDAR_PREFIX;
  const permitted = new URL(prefix);
  const label = toolkit === 'gmail' ? 'Gmail' : 'Calendar';
  const transport = options.transport ?? fetch;
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'x-project-id': projectId };
  let session: Promise<string> | null = null;
  const boundedSignal = (signal?: AbortSignal): AbortSignal =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  const createSession = async (signal?: AbortSignal): Promise<string> => {
    const response = await transport(`${COMPOSIO_BASE}/api/v3/tool_router/session`, {
      method: 'POST', headers, signal: boundedSignal(signal),
      body: JSON.stringify({
        user_id: userId,
        toolkits: { enable: [toolkit] },
        connectedAccounts: { [toolkit]: [connectedId] },
        manageConnections: { enable: false },
        multiAccount: { enable: true, requireExplicitSelection: true },
      }),
    });
    if (!response.ok) throw new Error(`Composio ${label} session failed: HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    const id = body.id ?? body.session_id ?? body.sessionId;
    if (typeof id !== 'string' || !id) throw new Error(`Composio ${label} session returned no id`);
    return id;
  };
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.origin !== permitted.origin || !parsed.pathname.startsWith(permitted.pathname) ||
        parsed.username || parsed.password || parsed.hash || /%2f|%5c/i.test(parsed.pathname) ||
        (init.method && init.method.toUpperCase() !== 'GET') || init.body != null) {
      throw new Error(`Composio ${label} transport accepts read-only ${label} API GET requests only`);
    }
    if (!session) session = createSession(init.signal ?? undefined).catch(error => { session = null; throw error; });
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const sessionId = await session;
      response = await transport(`${COMPOSIO_BASE}/api/v3/tool_router/session/${encodeURIComponent(sessionId)}/proxy_execute`, {
        method: 'POST', headers, signal: boundedSignal(init.signal ?? undefined),
        body: JSON.stringify({ toolkit_slug: toolkit, endpoint: parsed.toString(), method: 'GET' }),
      });
      if (response.status !== 404 || attempt === 1) break;
      // A vanished Composio session is not a missing Google item. Recreate it
      // once, then fail as a gateway error rather than advancing a cursor.
      session = createSession(init.signal ?? undefined).catch(error => { session = null; throw error; });
    }
    if (!response) throw new Error(`Composio ${label} proxy returned no response`);
    if (!response.ok) {
      const status = response.status === 404 ? 502 : response.status;
      return new Response(JSON.stringify({ error: { message: 'Composio proxy request failed' } }), { status });
    }
    const envelope = await response.json() as Record<string, unknown>;
    const result = (envelope.result ?? envelope) as Record<string, unknown>;
    const status = typeof result.status === 'number' ? result.status : 200;
    const data = result.data ?? result;
    const retryAfter = result.headers && typeof result.headers === 'object'
      ? (result.headers as Record<string, unknown>)['retry-after'] : undefined;
    return new Response(JSON.stringify(data), {
      status,
      headers: typeof retryAfter === 'string' ? { 'retry-after': retryAfter } : undefined,
    });
  };
}

export function createComposioGmailFetch(
  account: string, ref: string, options: { registryPath?: string; transport?: FetchImpl } = {},
): FetchImpl {
  return createComposioGoogleFetch(account, ref, 'gmail', options);
}

export function createComposioCalendarFetch(
  account: string, ref: string, options: { registryPath?: string; transport?: FetchImpl } = {},
): FetchImpl {
  return createComposioGoogleFetch(account, ref, 'googlecalendar', options);
}
