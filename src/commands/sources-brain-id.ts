import { createHash } from 'crypto';
import type { SourceRow as OpsSourceRow } from '../core/sources-ops.ts';

/**
 * Derive a stable brain-id for nag keying from the source's canonical git
 * remote (the repo carrying the pack) when available; else a deterministic
 * hash of the canonical local path. NOT the brain DB identity.
 */
export function deriveBrainId(created: OpsSourceRow, localPath: string): string {
  const remote = (created.config as Record<string, unknown>).remote_url as string | undefined;
  if (remote && remote.length > 0) return `git:${remote}`;
  return `path:${createHash('sha256').update(localPath).digest('hex').slice(0, 16)}`;
}

