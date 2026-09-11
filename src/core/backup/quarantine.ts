/** Detach restored execution configuration without deleting memory or history. */
import type { BrainEngine } from '../engine.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { AgentInstallError, confinedPath } from '../agent-install/state.ts';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface RestoredSource { id: string; local_path: string | null; managed_relative_path: string | null }
export interface RestoreQuarantine {
  sources: Array<{ id: string; local_path: string | null; config: unknown }>;
  settings: Array<{ key: string; value: string }>;
  reconnect: string[];
}

export function rebaseRestorePath(value: string, originalRoot: string, root: string, managedPaths: readonly string[]): string | null {
  if (!isAbsolute(value)) return null;
  const rel = relative(originalRoot, resolve(value));
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || !managedPaths.some(p => rel === p || rel.startsWith(p + '/'))) return null;
  return confinedPath(root, rel);
}

/** Called inside the single restore transaction. Original settings are also
 * retained under an inert DB key, so another full backup preserves the record. */
export async function quarantineRestoredExecution(tx: BrainEngine, options: {
  sources: readonly RestoredSource[]; originalRoot: string; root: string;
  managedPaths: readonly string[]; restoreId: string;
}): Promise<RestoreQuarantine> {
  const inventory: RestoreQuarantine = { sources: [], settings: [], reconnect: [] };
  const rows = await tx.executeRaw<{ id: string; local_path: string | null; config: unknown }>('SELECT id, local_path, config FROM sources ORDER BY id');
  const declared = new Map(options.sources.map(s => [s.id, s]));
  if (declared.size !== options.sources.length || rows.length !== declared.size || rows.some(row => !declared.has(row.id) || declared.get(row.id)!.local_path !== row.local_path)) {
    throw new AgentInstallError('invalid_backup', 'Source inventory does not match the archived database.');
  }
  for (const row of rows) {
    const source = declared.get(row.id)!;
    const config = parseSourceConfig(row.config);
    const rebased = source.managed_relative_path ? confinedPath(options.root, source.managed_relative_path) : null;
    // API materializers and managed git clones can recreate missing paths or
    // invoke credential commands. Clearing only local_path is insufficient.
    const external = (row.local_path !== null && rebased === null)
      || typeof config.kind === 'string' || typeof config.remote_url === 'string';
    if (external) {
      inventory.sources.push(row);
      const detached = {
        ...(typeof config.federated === 'boolean' ? { federated: config.federated } : {}),
        ...(typeof config.strategy === 'string' ? { strategy: config.strategy } : {}),
        syncEnabled: false, restore_detached: options.restoreId,
      };
      await tx.executeRaw('UPDATE sources SET local_path = NULL, config = $1::text::jsonb WHERE id = $2', [JSON.stringify(detached), row.id]);
      inventory.reconnect.push(`Source ${row.id}: external connector/checkout detached; review its private restore inventory and explicitly reconnect before enabling sync.`);
    } else {
      await tx.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [rebased, row.id]);
    }
    if (rebased && source.local_path) {
      await tx.executeRaw(`UPDATE pages SET source_path = $1 || substring(source_path from $2::integer) WHERE source_id = $3 AND (source_path = $4 OR source_path LIKE $5 ESCAPE '!')`,
        [rebased, source.local_path.length + 1, row.id, source.local_path, source.local_path.replace(/[!%_]/g, '!$&') + '/%']);
    }
  }

  const settings = await tx.executeRaw<{ key: string; value: string }>('SELECT key, value FROM config');
  const paths = new Set(['sync.repo_path', 'mcp.skills_dir', 'dream.synthesize.session_corpus_dir', 'dream.synthesize.meeting_transcripts_dir']);
  for (const setting of settings) {
    let next: string | null | undefined;
    if (/^connectors\.[^.]+\.auto_sync$/.test(setting.key)
      || /^autopilot\..+\.enabled$/.test(setting.key)) next = 'false';
    if (paths.has(setting.key)) next = rebaseRestorePath(setting.value, options.originalRoot, options.root, options.managedPaths);
    if (setting.key === 'storage') next = null; // file-plane managed local storage is restored separately
    if (next === undefined || next === setting.value) continue;
    inventory.settings.push(setting);
    if (next === null) await tx.executeRaw('DELETE FROM config WHERE key = $1', [setting.key]);
    else await tx.executeRaw('UPDATE config SET value = $1 WHERE key = $2', [next, setting.key]);
    inventory.reconnect.push(`Database setting ${setting.key}: ${next === null ? 'detached' : paths.has(setting.key) ? 'rebased to restored managed files' : 'disabled'}; prior value retained in the private restore inventory.`);
  }
  await tx.executeRaw('INSERT INTO config (key, value) VALUES ($1, $2)', [`restore.${options.restoreId}.detached_execution`, JSON.stringify(inventory)]);
  return inventory;
}
