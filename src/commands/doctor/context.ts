/**
 * Doctor check registry contract (refactor wave 1, W4 doctor).
 *
 * `buildChecks` parses the argument vector once and resolves the skills dir
 * once into a DoctorContext; the runner in ./registry.ts calls every entry in
 * order with it. An entry returns the checks it produced, or STOP_DOCTOR to
 * end the run there (the two places master's buildChecks returned early).
 * Fields an entry writes for later entries are named explicitly below.
 */

import type { BrainEngine } from '../../core/engine.ts';
import type { DbUrlSource } from '../../core/config.ts';
import type { AutoFixReport } from '../../core/dry-fix.ts';
import type { createProgress } from '../../core/progress.ts';
import type { resolveSkillsDir } from '../check-resolvable.ts';
import type { Check } from '../doctor.ts';

/** Returned by an entry to end the run; the checks gathered so far are the result. */
export const STOP_DOCTOR: unique symbol = Symbol('STOP_DOCTOR');

export interface DoctorEntry {
  /** The entry's primary check name (an entry that only stops names the check it gates on). */
  name: string;
  /** Every check name `run` can push, categorized in src/core/doctor-categories.ts. */
  emits: readonly string[];
  run(ctx: DoctorContext): Promise<Check[] | typeof STOP_DOCTOR>;
}

export interface DoctorContext {
  engine: BrainEngine | null;
  args: string[];
  dbSource?: DbUrlSource;
  connectError?: unknown;
  jsonOutput: boolean;
  fastMode: boolean;
  doFix: boolean;
  dryRun: boolean;
  scope: 'all' | 'brain';
  orphanRatioSourceId: string | undefined;
  progress: ReturnType<typeof createProgress>;
  /** `--skills-dir` / env / walk-up resolution; `source: 'none'` under `--scope=brain`. */
  skillsDirResolution: ReturnType<typeof resolveSkillsDir> | { dir: null; source: 'none' };
  skillsDir: string | null;
  /** Written by the resolver-health entry when `--fix` runs the DRY auto-repair. */
  autoFixReport: AutoFixReport | null;
  /** Written by the schema-version entry: the brain's `config.version` (0 until read). */
  schemaVersion: number;
  /** Written by the connection entry when `getStats` fails; the next entry stops the run. */
  connectionFailed: boolean;
  /** `--only <check>[,…]`: run only the entries that emit these checks (plus the connection lane). */
  only?: ReadonlySet<string> | null;
}

/**
 * The engine for entries that run after the DB-checks early stop, which ends
 * the run when there is no engine or `--fast` is set.
 */
export function connectedEngine(ctx: DoctorContext): BrainEngine {
  if (!ctx.engine) throw new Error('doctor: a DB check ran without an engine; it must be ordered after the DB-checks early stop');
  return ctx.engine;
}
