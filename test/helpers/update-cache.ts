/**
 * Test helper (GBRA-224): write one channel's update-check cache in the partitioned format
 * (core/self-upgrade.ts readUpdateCache) without importing the module into a subprocess fixture.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeChannelCache(gbrainDir: string, markerLine: string | null, opts: { channel?: 'stable' | 'alpha'; latest?: string | null; knownBad?: string[]; checkedAt?: number } = {}): string {
  const channel = opts.channel ?? 'alpha';
  const policy = channel === 'stable' ? 'stable-record-v1;matrix-from=none' : 'alpha-version-file-v1';
  const latest = opts.latest !== undefined ? opts.latest : markerLine?.split(/\s+/)[2] ?? null;
  mkdirSync(gbrainDir, { recursive: true });
  const path = join(gbrainDir, `update-check.${channel}.json`);
  writeFileSync(path, JSON.stringify({ schema: 2, channel, policy, checked_at: opts.checkedAt ?? Date.now(), marker: markerLine, latest, known_bad: opts.knownBad ?? [], error: null }) + '\n');
  return path;
}
