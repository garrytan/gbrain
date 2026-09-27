/** Durable stop marker for a source checkout whose update may be incomplete. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from './config.ts';

function markerPath(): string {
  return gbrainPath('source-upgrade-incomplete');
}

export function sourceUpgradeIncomplete(): boolean {
  return existsSync(markerPath());
}

interface SourceUpgradeMarker {
  repoRoot?: string;
  targetVersion?: string;
  recoveredBinaryVersion?: string;
}

export function readSourceUpgradeGuard(): SourceUpgradeMarker | null {
  try {
    const value = JSON.parse(readFileSync(markerPath(), 'utf8')) as SourceUpgradeMarker;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null; // A corrupt marker still blocks the source and binary paths.
  }
}

export function beginSourceUpgrade(repoRoot: string, targetVersion?: string): void {
  const path = markerPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readSourceUpgradeGuard()?.repoRoot !== repoRoot) {
    throw new Error('another source checkout has an incomplete upgrade');
  }
  writeFileSync(path, JSON.stringify({ repoRoot, targetVersion } satisfies SourceUpgradeMarker), { mode: 0o600 });
}

export function recordRecoveredBinary(version: string): void {
  const marker = readSourceUpgradeGuard();
  if (!marker?.targetVersion) throw new Error('source upgrade marker has no target version');
  const path = markerPath();
  const next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, JSON.stringify({ ...marker, recoveredBinaryVersion: version }), { mode: 0o600 });
  renameSync(next, path);
}

export function clearSourceUpgradeGuard(repoRoot: string): void {
  if (existsSync(markerPath()) && readSourceUpgradeGuard()?.repoRoot !== repoRoot) {
    throw new Error('source upgrade guard belongs to a different checkout');
  }
  try { unlinkSync(markerPath()); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
