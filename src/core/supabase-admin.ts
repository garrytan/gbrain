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

  // Direct connection: postgresql://postgres:[pw]@db.[ref].supabase.co:5432/postgres
  const directMatch = input.match(/db\.([a-z]+)\.supabase\.co/);
  if (directMatch) return directMatch[1];

  // Pooler: postgresql://postgres.[ref]:[pw]@aws-0-[region].pooler.supabase.com:6543/postgres
  const poolerMatch = input.match(/postgres\.([a-z]+):/);
  if (poolerMatch) return poolerMatch[1];

  // Project URL: https://[ref].supabase.co
  const projectMatch = input.match(/^https?:\/\/([a-z]+)\.supabase\.co/);
  if (projectMatch) return projectMatch[1];

  return null;
}

/**
 * Discover the pooler connection string via the Management API.
 * Returns the Session pooler URI.
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

  const data = await res.json() as { host: string; db_port: number; db_name: string; pool_mode?: string };

  // Construct the pooler URL
  // The API returns the direct host, we need to derive the pooler host
  // Direct: db.[ref].supabase.co
  // Pooler: aws-0-[region].pooler.supabase.com
  // We need to discover the region from the API response
  const settingsRes = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!settingsRes.ok) throw new Error(`Could not fetch project settings: ${settingsRes.status}`);
  const settings = await settingsRes.json() as { region: string; database: { host: string } };

  // The pooler host follows the pattern: aws-0-[region].pooler.supabase.com
  // But the exact prefix (aws-0, aws-1) varies. Use the Management API to get the DB config.
  const configRes = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/config/database`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (configRes.ok) {
    const config = await configRes.json() as { pool_mode?: string; connection_string?: string };
    if (config.connection_string) return config.connection_string;
  }

  // Fallback: construct from region
  const region = settings.region;
  return `postgresql://postgres.${projectRef}:[YOUR-PASSWORD]@aws-0-${region}.pooler.supabase.com:6543/postgres`;
}

