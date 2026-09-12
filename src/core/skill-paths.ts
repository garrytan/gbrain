/** Read-only skill lookup. Additional roots are explicit operator input, never
 * inferred from agent names, resolver prose, manifests, or neighboring agents.
 * Writers deliberately continue to use the workspace-only manifest loader.
 */
import { accessSync, constants, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, resolve, dirname } from 'path';
import { isPathContained } from './path-confine.ts';
import { loadOrDeriveManifest, type ManifestLoadResult } from './skill-manifest.ts';

export interface SkillPathOptions {
  /** Ordered, absolute, operator-approved roots. [] disables ambient roots. */
  skillRoots?: readonly string[];
}
export interface SkillLocation {
  reference: string;
  path: string | null;
  root: string | null;
  source: 'workspace' | 'explicit' | null;
  error?: string;
}

export function createSkillPaths(skillsDir: string, opts: SkillPathOptions = {}) {
  const workspace = resolve(skillsDir);
  const roots = [workspace];
  const errors: string[] = [];
  const addError = (message: string) => { if (!errors.includes(message)) errors.push(message); };
  try {
    if (!statSync(workspace).isDirectory()) throw new Error('not a directory');
    accessSync(workspace, constants.R_OK | constants.X_OK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') addError(`Skill root unavailable: ${workspace}`);
  }
  let additional: unknown = opts.skillRoots;
  if (additional === undefined) {
    try { additional = JSON.parse(process.env.GBRAIN_SKILL_ROOTS ?? '[]'); }
    catch { errors.push('GBRAIN_SKILL_ROOTS must be a JSON array of absolute skill directories'); additional = []; }
  }
  if (!Array.isArray(additional) || additional.length > 32) {
    errors.push('skillRoots must be an array of at most 32 absolute skill directories');
    additional = [];
  }
  for (const root of additional as unknown[]) {
    if (typeof root !== 'string' || !isAbsolute(root) || /[\x00-\x1f]/.test(root)) {
      errors.push('Skill root must be an absolute directory path without control characters');
      continue;
    }
    try {
      if (!statSync(root).isDirectory()) throw new Error('not a directory');
      accessSync(root, constants.R_OK | constants.X_OK);
      const canonical = realpathSync(root);
      if (!roots.some(r => { try { return realpathSync(r) === canonical; } catch { return r === canonical; } })) roots.push(canonical);
    } catch { errors.push(`Skill root unavailable: ${root}`); }
  }

  function locate(reference: string, selectedRoot?: string): SkillLocation {
    const miss = (error: string): SkillLocation => ({ reference, path: null, root: null, source: null, error });
    // References are portable, relative paths. Never normalize traversal into
    // an apparently contained path, or let an absolute reference authorize a root.
    if (!reference || isAbsolute(reference) || /[\\:\x00-\x1f]/.test(reference)
      || reference.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('~'))) {
      return miss('invalid skill reference');
    }
    if (selectedRoot !== undefined && !roots.includes(selectedRoot)) return miss('unapproved skill root');
    for (const root of selectedRoot === undefined ? roots : [selectedRoot]) {
      const candidate = join(root, reference);
      try { lstatSync(candidate); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // A dangling skill-directory link is an invalid higher-priority
          // install, not permission to silently fall back to another root.
          let parent = dirname(candidate);
          while (parent !== root && parent !== dirname(parent)) {
            try {
              if (lstatSync(parent).isSymbolicLink()) {
                if (!roots.some(approved => isPathContained(parent, approved))) return miss('unreachable skill path');
              }
            } catch (parentError) {
              if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') return miss('unreadable skill path');
            }
            parent = dirname(parent);
          }
          continue;
        }
        return miss('unreadable skill path');
      }
      if (!roots.some(approved => isPathContained(candidate, approved))) return miss('skill path escapes approved roots');
      try {
        if (!statSync(candidate).isFile()) return miss('skill path is not a regular file');
        accessSync(candidate, constants.R_OK);
        return { reference, path: realpathSync(candidate), root, source: isPathContained(candidate, workspace) ? 'workspace' : 'explicit' };
      } catch { return miss('unreadable skill path'); }
    }
    return miss('file missing');
  }

  /** Flat skill directories, first root wins. No arbitrary recursive crawl. */
  function references(): string[] {
    const refs = new Set<string>();
    for (const root of roots) {
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.name.startsWith('_') || ['conventions', 'migrations'].includes(entry.name)) continue;
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const ref = `${entry.name}/SKILL.md`;
          // Include invalid existing entries so diagnostics can fail honestly.
          try { lstatSync(join(root, ref)); refs.add(ref); }
          catch (err) {
            // Broken directory symlinks and unreadable entries are inventory,
            // not evidence of absence; retain them for the diagnostic pass.
            if (entry.isSymbolicLink() || (err as NodeJS.ErrnoException).code !== 'ENOENT') refs.add(ref);
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || root !== workspace) addError(`Skill root unavailable: ${root}`);
      }
    }
    return [...refs].sort();
  }

  function manifest(): ManifestLoadResult {
    const load = (root: string) => loadOrDeriveManifest(root, ref => {
      const location = locate(ref, root);
      if (ref === 'manifest.json' && !location.path && location.error !== 'file missing') {
        addError(`Invalid skills manifest at ${root}: ${location.error}`);
      }
      return location.path;
    });
    const result = load(workspace);
    const skills = [...result.skills];
    // Preserve explicit workspace manifest membership (including missing
    // entries). Only additional roots extend the read-only inventory.
    for (const root of roots.slice(1)) {
      for (const entry of load(root).skills) {
        if (!skills.some(s => s.path === entry.path || s.name === entry.name)) skills.push(entry);
      }
    }
    // A broken on-disk entry must remain visible even without a manifest.
    for (const reference of references()) {
      if (!locate(reference).path && !skills.some(s => s.path === reference)) {
        skills.push({ name: reference.replace(/\/SKILL\.md$/, ''), path: reference });
      }
    }
    return { skills, derived: result.derived };
  }

  function contains(path: string): boolean {
    return roots.some(root => isPathContained(path, root));
  }

  function read(reference: string): string | null {
    const location = locate(reference);
    if (!location.path) return null;
    try { return readFileSync(location.path, 'utf-8'); } catch { return null; }
  }
  return { roots, errors, locate, references, manifest, read, contains };
}

export type SkillPaths = ReturnType<typeof createSkillPaths>;
