/**
 * TS migration registry. Compiled into the gbrain binary so migration
 * discovery works on both source installs and `bun build --compile`
 * distributions without reading `skills/migrations/*.md` from disk.
 *
 * Each migration module exports a `Migration` object. Add new migrations
 * to the `migrations` array in chronological (semver) order. The registry
 * is the runtime source of truth; the markdown file at
 * `skills/migrations/vX.Y.Z.md` remains as the host-agent instruction
 * manual (read on demand when pending-host-work.jsonl is non-empty).
 */

import type { Migration } from './types.ts';
import { v0_11_0 } from './v0_11_0.ts';
import { v0_12_0 } from './v0_12_0.ts';
import { v0_12_2 } from './v0_12_2.ts';
import { v0_13_0 } from './v0_13_0.ts';
import { v0_13_1 } from './v0_13_1.ts';
import { v0_14_0 } from './v0_14_0.ts';
import { v0_16_0 } from './v0_16_0.ts';
import { v0_18_0 } from './v0_18_0.ts';

export const migrations: Migration[] = [
  v0_11_0,
  v0_12_0,
  v0_12_2,
  v0_13_0,
  v0_13_1,
  v0_14_0,
  v0_16_0,
  v0_18_0,
];

/** Look up a migration by exact version string. */
export function getMigration(version: string): Migration | null {
  return migrations.find(m => m.version === version) ?? null;
}

export type { Migration, FeaturePitch, OrchestratorOpts, OrchestratorResult } from './types.ts';

/**
 * Compare two semver strings (MAJOR.MINOR.PATCH). Returns -1 / 0 / 1.
 * Extracted from src/commands/upgrade.ts#isNewerThan for shared use across
 * the migration runner + post-upgrade pitch path.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = a.split('.').map(n => parseInt(n, 10) || 0);
  const vb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = va[i] ?? 0;
    const db = vb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
