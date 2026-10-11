export function leaseRenewal(method: string, args: unknown[]): { table: string; id: unknown; key: string } | undefined {
  if (method !== 'executeRaw' || typeof args[0] !== 'string' || !Array.isArray(args[1])) return;
  const sql = args[0], params = args[1];
  const table = (/^\s*UPDATE\s+(minion_jobs)\s+SET\s+lock_until\b/i.exec(sql)?.[1]
    ?? /^\s*UPDATE\s+(gbrain_cycle_locks)\s+SET\s+ttl_expires_at\b/i.exec(sql)?.[1])?.toLowerCase();
  if (!table) return;
  const id = /\bWHERE\s+id\s*=\s*\$(\d+)/i.exec(sql);
  const holder = new RegExp(`\\b${table === 'minion_jobs' ? 'lock_token' : 'holder_pid'}\\s*=\\s*\\$(\\d+)`, 'i').exec(sql);
  if (!id || !holder) return;
  const value = params[Number(id[1]) - 1];
  return { table, id: value, key: JSON.stringify([table, value, params[Number(holder[1]) - 1]]) };
}
