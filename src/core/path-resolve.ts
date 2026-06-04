import { existsSync } from 'node:fs';

/**
 * Return candidate filesystem paths for a persisted storage path.
 *
 * A brain may index paths from a Windows host, for example
 * `D:/vault/image.jpg`, while doctor later runs inside WSL. In that runtime
 * Node cannot stat the literal drive path, but the same file is available via
 * `/mnt/d/...`. Keep the database value unchanged and resolve only when doing
 * filesystem health checks.
 */
export function storagePathCandidates(storagePath: string, platform = process.platform): string[] {
  const candidates = [storagePath];
  const slash = String.fromCharCode(92);
  const drive = storagePath.charAt(0).toLowerCase();
  const hasWindowsDrive =
    storagePath.length > 2 &&
    storagePath.charAt(1) === ':' &&
    drive >= 'a' &&
    drive <= 'z';

  if (hasWindowsDrive && platform !== 'win32') {
    let rest = storagePath.slice(2);
    while (rest.startsWith('/') || rest.startsWith(slash)) rest = rest.slice(1);
    rest = rest.split(slash).join('/');
    candidates.push(`/mnt/${drive}/${rest}`);
  }

  return Array.from(new Set(candidates));
}

export function resolveExistingStoragePath(storagePath: string): string | null {
  for (const candidate of storagePathCandidates(storagePath)) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Continue to the next platform-specific candidate.
    }
  }
  return null;
}
