import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { OperationError } from '../ops/contract.ts';

export const setupHash = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');

export function checkedContentRoot(path: string): string {
  const root = resolve(path);
  let current = root;
  while (true) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new OperationError('local_conflict', 'A content-root component is not a real directory.');
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

export function inventorySkillpack(root: string): PackInventory | null {
  checkedContentRoot(root);
  const manifestPath = join(root, 'skillpack.json');
  if (!existsSync(manifestPath)) return null;
  const hashes: Record<string, string> = {};
  let bytes = 0;
  let entries = 0;
  const read = (path: string): string => {
    const absolute = join(root, path);
    const rel = relative(realpathSync(root), realpathSync(absolute));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new OperationError('local_conflict', 'A skillpack path escapes its source root.');
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 262144) throw new OperationError('local_conflict', 'A skillpack file is unsafe or exceeds the migration limit.');
    const data = readFileSync(absolute);
    bytes += data.length;
    if (Object.keys(hashes).length >= 256 || bytes > 4 * 1024 * 1024) throw new OperationError('local_conflict', 'The skillpack exceeds the bounded migration inventory.');
    hashes[path] = setupHash(data);
    return data.toString('utf8');
  };
  let manifest: { skills?: unknown; shared_deps?: unknown; excluded_from_install?: unknown };
  try { manifest = JSON.parse(read('skillpack.json')); }
  catch (error) { if (error instanceof OperationError) throw error; throw new OperationError('local_conflict', 'The existing skillpack manifest is malformed.'); }
  if (!Array.isArray(manifest.skills) || manifest.skills.some(path => typeof path !== 'string' || !/^skills\/[a-z0-9][a-z0-9-]*$/.test(path))) {
    throw new OperationError('local_conflict', 'The existing skillpack has ambiguous skill paths.');
  }
  const names = (manifest.skills as string[]).map(path => path.slice(7));
  if (new Set(names).size !== names.length) throw new OperationError('local_conflict', 'The existing skillpack has duplicate skill names.');
  const visit = (path: string, depth: number): void => {
    if (++entries > 1024 || depth > 8 || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(path)) throw new OperationError('local_conflict', 'The skillpack contains an unsafe dependency path.');
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new OperationError('local_conflict', 'Skillpack migration does not follow symlinks.');
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, path)).sort()) visit(`${path}/${name}`, depth + 1);
    } else if (!hashes[path]) read(path);
  };
  for (const path of manifest.skills as string[]) visit(path, 0);
  if (manifest.shared_deps !== undefined && (!Array.isArray(manifest.shared_deps) || manifest.shared_deps.some(path => typeof path !== 'string'))) throw new OperationError('local_conflict', 'The skillpack dependency declaration is malformed.');
  for (const path of (manifest.shared_deps ?? []) as string[]) visit(path, 0);
  if (manifest.excluded_from_install !== undefined && (!Array.isArray(manifest.excluded_from_install) || manifest.excluded_from_install.some(name => typeof name !== 'string'))) throw new OperationError('local_conflict', 'The skillpack exclusions are malformed.');
  return { hashes, names, excluded_from_install: (manifest.excluded_from_install ?? []) as string[] };
}

export function sameInventory(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}
