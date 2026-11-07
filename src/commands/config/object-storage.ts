/**
 * File-plane leaves of the object-storage config (`~/.gbrain/config.json`
 * `storage` object). `gbrain files` and `file_url` read that object.
 * `storage.git_lfs` is a different key and stays on the DB plane.
 */
import { loadConfigFileOnly, saveConfig, type GBrainConfig } from '../../core/config.ts';
import { httpEndpointProblem, normalizeHttpEndpoint, signedUrlExpiresProblem } from '../../core/storage-url.ts';

const SECRET_LEAVES = new Set(['accessKeyId', 'secretAccessKey', 'serviceRoleKey']);

const LEAVES = new Set([
  'backend', 'bucket', 'region', 'endpoint', 'publicEndpoint',
  'accessKeyId', 'secretAccessKey', 'projectUrl', 'serviceRoleKey',
  'localPath', 'signedUrlExpiresIn',
]);

export function isObjectStorageConfigKey(key: string): boolean {
  const dot = key.indexOf('.');
  return dot > 0 && key.slice(0, dot) === 'storage' && LEAVES.has(key.slice(dot + 1));
}

function leafOf(key: string): string {
  return key.slice(key.indexOf('.') + 1);
}

function refuse(message: string): never {
  console.error(`[config] ${message} Nothing was written.`);
  process.exit(1);
}

/** Write one leaf onto the file-plane `storage` object. Sibling leaves stay. */
export function setObjectStorageConfig(key: string, value: string): void {
  const leaf = leafOf(key);
  let stored: string | number = value;
  if (leaf === 'publicEndpoint' || leaf === 'endpoint') {
    const problem = httpEndpointProblem(value);
    if (problem) refuse(`storage.${leaf} is invalid. ${problem}`);
    stored = normalizeHttpEndpoint(value);
  } else if (leaf === 'signedUrlExpiresIn') {
    const problem = signedUrlExpiresProblem(value);
    if (problem) refuse(`storage.signedUrlExpiresIn is invalid. ${problem}`);
    stored = Number(value.trim());
  } else if (leaf === 'backend') {
    if (value !== 's3' && value !== 'supabase' && value !== 'local') refuse('storage.backend is s3, supabase, or local.');
  } else if (value.trim() === '') {
    refuse(`storage.${leaf} is empty.`);
  }
  const cfg = (loadConfigFileOnly() ?? { engine: 'pglite' }) as GBrainConfig;
  const storage = (cfg.storage && typeof cfg.storage === 'object' ? { ...(cfg.storage as Record<string, unknown>) } : {});
  storage[leaf] = stored;
  cfg.storage = storage;
  saveConfig(cfg);
  const shown = SECRET_LEAVES.has(leaf) ? '***' : typeof stored === 'number' ? String(stored) : stored;
  console.log(`Set ${key} = ${shown} (file plane: ~/.gbrain/config.json)`);
}

/** Remove one leaf. False when the file has no such leaf. */
export function unsetObjectStorageConfig(key: string): boolean {
  const cfg = loadConfigFileOnly();
  const storage = cfg?.storage;
  if (!cfg || !storage || typeof storage !== 'object') return false;
  const record = storage as Record<string, unknown>;
  const leaf = leafOf(key);
  if (!(leaf in record)) return false;
  delete record[leaf];
  saveConfig(cfg);
  return true;
}
