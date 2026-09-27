import { OperationError } from '../ops/contract.ts';
import { REMOTE_PRIVATE_PAGES_KEY } from '../search/private-visibility.ts';
import type { SqlEngine, WriteAuthority } from './model.ts';

/** Publication uses fresh policy, independent of the read-side telemetry cache. */
export async function excludesPrivateWrites(engine: SqlEngine, remote: boolean): Promise<boolean> {
  if (!remote || process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return false;
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [REMOTE_PRIVATE_PAGES_KEY]);
  return !['visible', 'true', '1'].includes(row?.value ?? '');
}

/** Recheck after page guards at publication; also hide inaccessible receipt targets. */
export async function authorizePageVisibility(engine: SqlEngine, authority: WriteAuthority, slug: string): Promise<void> {
  if (!authority.remote) return;
  if (!(authority.excludePrivate ?? true) && !await excludesPrivateWrites(engine, true)) return;
  const rows = await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2
    AND frontmatter->>'visibility'='private' LIMIT 1`, [authority.sourceId, slug]);
  if (rows.length) throw new OperationError('page_not_found', 'Page not found.');
}
