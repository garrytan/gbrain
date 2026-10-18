import { basename } from 'node:path';

export const PHYSICAL_ROOT_MARKER = '.gbrain-owner.json';
/**
 * #5186: gitignore-dialect globs for every file `isPhysicalRootMetadata`
 * recognizes (the stamp, the reservation beside the root, a staged stamp).
 * Written to `<gitdir>/info/exclude` on stamp/adopt and denied by
 * `workspace-push`, so the ownership token never reaches a remote.
 */
export const OWNERSHIP_MARKER_GLOBS: readonly string[] = ['.gbrain-owner.json', '.gbrain-owner-*.json', '.gbrain-owner.json.*.tmp'];

/** Ownership metadata gbrain writes inside or beside a managed canonical root; never brain content. */
export function isPhysicalRootMetadata(name: string): boolean {
  return name === PHYSICAL_ROOT_MARKER || /^\.gbrain-owner-[a-f0-9]{64}\.json$/.test(name)
    || /^\.gbrain-owner\.json\.[a-f0-9-]{36}\.tmp$/.test(name);
}

/**
 * `git status --porcelain` (v1) output without entries whose every path is
 * physical-root metadata, so the stamp gbrain writes does not make a managed
 * tree look dirty. A rename or copy keeps its line unless both sides are
 * metadata, a quoted path never matches an exact metadata name, and an
 * untracked directory (porcelain's trailing `/`) is never metadata.
 */
export function withoutPhysicalRootMetadata(porcelain: string): string {
  return porcelain
    .split('\n')
    .filter(line => line.trim() !== '' && !line.slice(3).split(' -> ').every(path => !path.trim().endsWith('/') && isPhysicalRootMetadata(basename(path.trim()))))
    .join('\n');
}
