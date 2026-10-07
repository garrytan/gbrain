import { basename } from 'node:path';

export const PHYSICAL_ROOT_MARKER = '.gbrain-owner.json';

/** Ownership metadata gbrain writes inside or beside a managed canonical root; never brain content. */
export function isPhysicalRootMetadata(name: string): boolean {
  return name === PHYSICAL_ROOT_MARKER || /^\.gbrain-owner-[a-f0-9]{64}\.json$/.test(name)
    || /^\.gbrain-owner\.json\.[a-f0-9-]{36}\.tmp$/.test(name);
}

/**
 * `git status --porcelain` (v1) output without entries whose every path is
 * physical-root metadata, so the stamp gbrain writes does not make a managed
 * tree look dirty. A rename or copy keeps its line unless both sides are
 * metadata, and a quoted path never matches an exact metadata name.
 */
export function withoutPhysicalRootMetadata(porcelain: string): string {
  return porcelain
    .split('\n')
    .filter(line => line.trim() !== '' && !line.slice(3).split(' -> ').every(path => isPhysicalRootMetadata(basename(path.trim()))))
    .join('\n');
}
