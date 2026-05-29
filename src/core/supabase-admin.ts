/**
 * Supabase Management API helpers.
 * Used during setup to discover the pooler URL and verify configuration.
 * The access token is NOT persisted — used once and discarded.
 */

/**
 * Extract project ref from any Supabase URL format.
 * Supports: dashboard URL, direct connection, pooler, project URL.
 */
export function extractProjectRef(input: string): string | null {
  // Dashboard URL: https://supabase.com/dashboard/project/[ref]/...
  const dashMatch = input.match(/supabase\.com\/dashboard\/project\/([a-z]+)/);
  if (dashMatch) return dashMatch[1];

  // Direct connection example URL  /* allow-pg-url-literal */
  const directMatch = input.match(/db\.([a-z]+)\.supabase\.co/);
  if (directMatch) return directMatch[1];

  // Pooler example URL  /* allow-pg-url-literal */
  const poolerMatch = input.match(/postgres\.([a-z]+):/);
  if (poolerMatch) return poolerMatch[1];

  // Project URL: https://[ref].supabase.co
  const projectMatch = input.match(/^https?:\/\/([a-z]+)\.supabase\.co/);
  if (projectMatch) return projectMatch[1];

  return null;
}

/**
 * Discover the pooler connection string via the Management API.
 * Returns the exact URI when Supabase exposes it. The pooler shard prefix
 * varies (for example aws-0 vs aws-1), so callers should not fabricate it.
 */
export async function discoverPoolerUrl(
  token: string,
  projectRef: string,
): Promise<string> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid Supabase access token. Generate one at supabase.com/dashboard/account/tokens');
    if (res.status === 404) throw new Error(`Project not found: ${projectRef}. Check the project URL.`);
    throw new Error(`Supabase API error: ${res.status} ${res.statusText}`);
  }

  await res.json() as { host: string; db_port: number; db_name: string; pool_mode?: string };

  // Prefer the Management API's exact connection string. The exact pooler
  // host varies by project/region; guessing from region is unsafe.
  const configRes = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/config/database`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (configRes.ok) {
    const config = await configRes.json() as { pool_mode?: string; connection_string?: string };
    if (config.connection_string) return config.connection_string;
  }

  throw new Error(
    'Could not discover the exact Supabase pooler connection string. ' +
    'Copy it from Supabase Dashboard > Connect > Session pooler.',
  );
}
