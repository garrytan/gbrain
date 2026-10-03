import { basename } from 'node:path';

/** Ownership metadata written beside/inside a managed canonical root. Never brain content. */
export function isPhysicalRootMetadata(name: string): boolean {
  return name === '.gbrain-owner.json' || /^\.gbrain-owner-[a-f0-9]{64}\.json$/.test(name)
    || /^\.gbrain-owner\.json\.[a-f0-9-]{36}\.tmp$/.test(name);
}

/**
 * Drops `git status --porcelain` (v1) entries for physical-root metadata, so the
 * ownership stamp gbrain itself writes does not make a managed tree look dirty.
 */
export function withoutPhysicalRootMetadata(porcelain: string): string {
  return porcelain
    .split('\n')
    .filter(line => line.trim() !== '' && !isPhysicalRootMetadata(basename(line.slice(3).trim())))
    .join('\n');
}
