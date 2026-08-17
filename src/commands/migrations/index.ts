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
import { v0_18_1 } from './v0_18_1.ts';
import { v0_21_0 } from './v0_21_0.ts';
import { v0_22_4 } from './v0_22_4.ts';
import { v0_28_0 } from './v0_28_0.ts';
import { v0_29_1 } from './v0_29_1.ts';
import { v0_31_0 } from './v0_31_0.ts';
import { v0_32_2 } from './v0_32_2.ts';
import { v0_43_0 } from './v0_43_0.ts';
import { v0_46_3 } from './v0_46_3.ts';

export const migrations: Migration[] = [
  v0_11_0,
  v0_12_0,
  v0_12_2,
  v0_13_0,
  v0_13_1,
  v0_14_0,
  v0_16_0,
  v0_18_0,
  v0_18_1,
  v0_21_0,
  v0_22_4,
  v0_28_0,
  v0_29_1,
  v0_31_0,
  v0_32_2,
  v0_43_0,
  v0_46_3,
];

/** Look up a migration by exact version string. */
export function getMigration(version: string): Migration | null {
  return migrations.find(m => m.version === version) ?? null;
}

export type { Migration, FeaturePitch, OrchestratorOpts, OrchestratorResult } from './types.ts';

// Canonical home moved to src/core/migration-ledger.ts (shared with the
// get_health migrations block without pulling this registry into the ops
// layer). Re-exported so every existing importer is unchanged.
export { compareVersions } from '../../core/migration-ledger.ts';
