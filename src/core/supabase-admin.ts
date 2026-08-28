/**
 * Supabase Management API helpers.
 * Used during setup (the `init --prefer-postgres` ladder, rung 2) to discover
 * the pooler URL and verify configuration. DISCOVERY ONLY — project creation
 * stays printed guidance. The access token is NOT persisted, logged, or
 * written to receipts/config — used once and discarded.
 *
 * Every call carries a bounded timeout: the DB driver's connect_timeout does
 * not cover these HTTP fetches, and an unresponsive api.supabase.com must
 * fall through to the next ladder rung, never hang a headless init.
 *
 * Discovery output is a CANDIDATE, never trusted: callers connect-probe the
 * returned URL before persisting it. There is deliberately NO constructed
 * fallback URL — the old `aws-0-<region>.pooler.supabase.com` guess had a
 * variable prefix (NXDOMAIN on miss) and a transaction-mode port where a
 * session URI was promised; when the API doesn't return a connection string,
 * the honest answer is "get it from the dashboard".
 */

const SUPABASE_API_TIMEOUT_MS = 10_000;

function apiFetch(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(SUPABASE_API_TIMEOUT_MS),
  });
}

/**
 * Extract project ref from any Supabase URL format.
 * Supports: dashboard URL, direct connection, pooler, project URL.
 */
export function extractProjectRef(input: string): string | null {
  // Refs are lowercase ALPHANUMERIC — a ref containing a digit used to
  // silently fail every branch here ([a-z]+ only).

  // Dashboard URL: https://supabase.com/dashboard/project/[ref]/...
  const dashMatch = input.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/);
  if (dashMatch) return dashMatch[1];

  // Direct connection example URL  /* allow-pg-url-literal */
  const directMatch = input.match(/db\.([a-z0-9]+)\.supabase\.co/);
  if (directMatch) return directMatch[1];

  // Pooler example URL  /* allow-pg-url-literal */
  const poolerMatch = input.match(/postgres\.([a-z0-9]+):/);
  if (poolerMatch) return poolerMatch[1];

  // Project URL: https://[ref].supabase.co
  const projectMatch = input.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/);
  if (projectMatch) return projectMatch[1];

  return null;
}

export interface SupabaseProject {
  id: string;
  name: string;
  region?: string;
}

/**
 * List the account's projects — lets the ladder auto-select on
 * single-project accounts (multi-project accounts require
 * SUPABASE_PROJECT_REF; guessing a brain's home is never OK).
 */
export async function listProjects(token: string): Promise<SupabaseProject[]> {
  const res = await apiFetch('https://api.supabase.com/v1/projects', token);
  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid Supabase access token. Generate one at supabase.com/dashboard/account/tokens');
    throw new Error(`Supabase API error listing projects: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as Array<{ id?: string; name?: string; region?: string }>;
  return (Array.isArray(data) ? data : [])
    .filter((p) => typeof p?.id === 'string')
    .map((p) => ({ id: p.id as string, name: typeof p.name === 'string' ? p.name : (p.id as string), region: p.region }));
}

/**
 * Discover the pooler connection string via the Management API.
 * Returns the connection string AS REPORTED BY THE API (it may contain a
 * `[YOUR-PASSWORD]` placeholder — the API cannot return the DB password;
 * callers substitute SUPABASE_DB_PASSWORD). Throws when the API doesn't
 * report one — there is no constructed fallback (see module header).
 */
export async function discoverPoolerUrl(
  token: string,
  projectRef: string,
): Promise<string> {
  const res = await apiFetch(`https://api.supabase.com/v1/projects/${projectRef}/database`, token);

  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid Supabase access token. Generate one at supabase.com/dashboard/account/tokens');
    if (res.status === 404) throw new Error(`Project not found: ${projectRef}. Check the project URL.`);
    throw new Error(`Supabase API error: ${res.status} ${res.statusText}`);
  }

  const configRes = await apiFetch(`https://api.supabase.com/v1/projects/${projectRef}/config/database`, token);
  if (configRes.ok) {
    const config = (await configRes.json()) as { connection_string?: string };
    if (config.connection_string) return config.connection_string;
  }

  throw new Error(
    `The Supabase Management API did not return a connection string for ${projectRef}. ` +
    'Get it from the dashboard (Connect > Connection String > Transaction pooler) and run: gbrain init --url <conn>',
  );
}
