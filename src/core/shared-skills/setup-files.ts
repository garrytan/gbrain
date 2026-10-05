import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { opError, OperationError } from '../ops/contract.ts';
import { DEFAULT_INVENTORY_LIMITS, inventoryLimitKey, type InventoryLimits } from './inventory-limits.ts';

export const setupHash = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');

export function checkedContentRoot(path: string): string {
  const root = resolve(path);
  let current = root;
  while (true) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw opError('local_conflict', 'A content-root component is not a real directory.',
          `${current} is a symlink or a file, so ${root} cannot be a content root. Choose a path whose every parent is a real directory.`);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return root;
}

export interface PackInventory {
  hashes: Record<string, string>;
  names: string[];
  excluded_from_install: string[];
}

/** The pack exceeds a configured inventory bound; `detail` names the config key. The migration parks the source instead of retrying. */
function inventoryOverflow(root: string, limit: keyof InventoryLimits, value: number, what: string) {
  const key = inventoryLimitKey(limit);
  return opError('payload_too_large', `The skillpack in ${root} exceeds the migration inventory bound ${key}=${value}: ${what}.`,
    `Raise ${key} with gbrain config set, opt the source out with gbrain sources shared-skills followed by its source id and off, or move large assets out of the declared skills and shared_deps; then run gbrain apply-migrations --migration 0.53.0 --yes.`,
    { detail: key, docs: 'docs/guides/shared-brain-skills.md#oversized-skill-packs' });
}

export function inventorySkillpack(root: string, limits: InventoryLimits = DEFAULT_INVENTORY_LIMITS): PackInventory | null {
  checkedContentRoot(root);
  const manifestPath = join(root, 'skillpack.json');
  if (!existsSync(manifestPath)) return null;
  const hashes: Record<string, string> = {};
  let bytes = 0;
  let entries = 0;
  const read = (path: string): string => {
    const absolute = join(root, path);
    const rel = relative(realpathSync(root), realpathSync(absolute));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) {
      throw opError('local_conflict', 'A skillpack path escapes its source root.',
        `${path} resolves outside ${root}. Replace the link with the real files inside the pack (or drop the entry from skillpack.json), then run the migration again.`);
    }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw opError('local_conflict', 'A skillpack file is unsafe.',
        `${path} in ${root} must be a regular, singly linked file; replace it with a real file or remove it, then run the migration again.`);
    }
    if (stat.size > limits.max_file_bytes) throw inventoryOverflow(root, 'max_file_bytes', limits.max_file_bytes, `${path} is ${stat.size} bytes`);
    if (Object.keys(hashes).length >= limits.max_files) throw inventoryOverflow(root, 'max_files', limits.max_files, `it declares more than ${limits.max_files} files`);
    const data = readFileSync(absolute);
    bytes += data.length;
    if (bytes > limits.max_total_bytes) throw inventoryOverflow(root, 'max_total_bytes', limits.max_total_bytes, `its declared files exceed ${limits.max_total_bytes} bytes`);
    hashes[path] = setupHash(data);
    return data.toString('utf8');
  };
  let manifest: { skills?: unknown; shared_deps?: unknown; excluded_from_install?: unknown };
  try { manifest = JSON.parse(read('skillpack.json')); }
  catch (error) {
    if (error instanceof OperationError) throw error;
    throw opError('local_conflict', 'The existing skillpack manifest is malformed.',
      `${manifestPath} is not valid JSON. Fix or restore it from Git, then run the migration again.`);
  }
  if (!Array.isArray(manifest.skills) || manifest.skills.some(path => typeof path !== 'string' || !/^skills\/[a-z0-9][a-z0-9-]*$/.test(path))) {
    throw opError('local_conflict', 'The existing skillpack has ambiguous skill paths.',
      `Make "skills" in ${manifestPath} a list of top-level skill directories with lowercase names (for example "skills/meeting-notes"), then run the migration again.`);
  }
  const names = (manifest.skills as string[]).map(path => path.slice(7));
  if (new Set(names).size !== names.length) {
    throw opError('local_conflict', 'The existing skillpack has duplicate skill names.',
      `List each skill once in "skills" of ${manifestPath}, then run the migration again.`);
  }
  const visit = (path: string, depth: number): void => {
    if (depth > 8 || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(path)) {
      throw opError('local_conflict', 'The skillpack contains an unsafe dependency path.',
        `Declared skill and shared_deps paths in ${manifestPath} must be relative forward-slash paths without empty, . or .. segments and at most 8 directories deep; fix the manifest, then run the migration again.`);
    }
    if (++entries > limits.max_entries) throw inventoryOverflow(root, 'max_entries', limits.max_entries, `its declared paths hold more than ${limits.max_entries} entries`);
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) {
      throw opError('local_conflict', 'Skillpack migration does not follow symlinks.',
        `${path} in ${root} is a symlink; replace it with the real file or directory, then run the migration again.`);
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, path)).sort()) visit(`${path}/${name}`, depth + 1);
    } else if (!hashes[path]) read(path);
  };
  for (const path of manifest.skills as string[]) visit(path, 0);
  if (manifest.shared_deps !== undefined && (!Array.isArray(manifest.shared_deps) || manifest.shared_deps.some(path => typeof path !== 'string'))) {
    throw opError('local_conflict', 'The skillpack dependency declaration is malformed.',
      `Make "shared_deps" in ${manifestPath} a list of relative paths (or remove it), then run the migration again.`);
  }
  for (const path of (manifest.shared_deps ?? []) as string[]) visit(path, 0);
  if (manifest.excluded_from_install !== undefined && (!Array.isArray(manifest.excluded_from_install) || manifest.excluded_from_install.some(name => typeof name !== 'string'))) {
    throw opError('local_conflict', 'The skillpack exclusions are malformed.',
      `Make "excluded_from_install" in ${manifestPath} a list of skill names (or remove it), then run the migration again.`);
  }
  return { hashes, names, excluded_from_install: (manifest.excluded_from_install ?? []) as string[] };
}

export function sameInventory(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}
