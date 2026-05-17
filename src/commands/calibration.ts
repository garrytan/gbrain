/**
 * v0.36.0.0 (T7) — `gbrain calibration` CLI.
 *
 * Reads the latest calibration profile from the DB and prints it. Mirror of
 * the v0.29 `gbrain salience` / `gbrain anomalies` shape (pure data fn + JSON
 * formatter + human formatter + thin CLI dispatch).
 *
 * Sub-commands:
 *   gbrain calibration                              — print active profile for default holder
 *   gbrain calibration --holder <id>                — print for a specific holder
 *   gbrain calibration --json                       — machine output
 *   gbrain calibration --regenerate                 — run the calibration_profile phase now
 *   gbrain calibration --undo-wave <version>        — D18 undo command (Lane D adds the impl)
 *   gbrain calibration ab-report                    — D19 A/B harness report (Lane D adds the impl)
 *
 * MCP op: `get_calibration_profile` (scope: read) routes the same read path.
 * Source-scoping via sourceScopeOpts(ctx) on the MCP path keeps multi-source
 * brains source-isolated per the v0.34.1 discipline.
 */

import type { BrainEngine } from '../core/engine.ts';
import { runPhaseCalibrationProfile } from '../core/cycle/calibration-profile.ts';
import { sourceScopeOpts, type OperationContext } from '../core/operations.ts';
import type { GBrainConfig } from '../core/config.ts';
import { GBrainError } from '../core/types.ts';

export interface CalibrationProfileRow {
  id: number;
  source_id: string;
  holder: string;
  wave_version: string;
  generated_at: string;
  published: boolean;
  total_resolved: number;
  brier: number | null;
  accuracy: number | null;
  partial_rate: number | null;
  grade_completion: number;
  pattern_statements: string[];
  active_bias_tags: string[];
  voice_gate_passed: boolean;
  voice_gate_attempts: number;
  model_id: string;
}

/** Source-scoped read of the latest profile row for a holder. */
export async function getLatestProfile(
  engine: BrainEngine,
  opts: { holder: string; sourceId?: string; sourceIds?: string[] },
): Promise<CalibrationProfileRow | null> {
  let sql = `SELECT id, source_id, holder, wave_version, generated_at, published,
            total_resolved, brier, accuracy, partial_rate, grade_completion,
            pattern_statements, active_bias_tags,
            voice_gate_passed, voice_gate_attempts, model_id
       FROM calibration_profiles
       WHERE holder = $1`;
  const params: unknown[] = [opts.holder];

  if (opts.sourceIds && opts.sourceIds.length > 0) {
    sql += ` AND source_id = ANY($2::text[])`;
    params.push(opts.sourceIds);
  } else if (opts.sourceId) {
    sql += ` AND source_id = $2`;
    params.push(opts.sourceId);
  }

  sql += ` ORDER BY generated_at DESC LIMIT 1`;

  const rows = await engine.executeRaw<CalibrationProfileRow>(sql, params);
  return rows[0] ?? null;
}

/** Human format the profile for terminal output. */
export function formatProfileText(profile: CalibrationProfileRow | null, holder: string): string {
  if (!profile) {
    return (
      `No calibration profile yet for holder "${holder}".\n` +
      `Build one by resolving 5+ takes then running:\n` +
      `  gbrain dream --phase calibration_profile\n` +
      `Or wait for the next autopilot cycle.`
    );
  }
  const lines: string[] = [];
  const generatedLocal = new Date(profile.generated_at).toLocaleString();
  lines.push(`Calibration profile — holder: ${profile.holder}, source: ${profile.source_id}`);
  lines.push(`Generated: ${generatedLocal}  ${profile.published ? '(published to mounts)' : ''}`);
  if (profile.grade_completion < 0.9) {
    lines.push(`Note: built on ${(profile.grade_completion * 100).toFixed(0)}% graded — partial completion this cycle.`);
  }
  if (!profile.voice_gate_passed) {
    lines.push(`Note: voice gate fell back to template (${profile.voice_gate_attempts} attempts).`);
  }
  lines.push('');
  lines.push(`Resolved: ${profile.total_resolved} takes`);
  if (profile.brier !== null) lines.push(`Brier:    ${profile.brier.toFixed(3)} (lower is better)`);
  if (profile.accuracy !== null) lines.push(`Accuracy: ${(profile.accuracy * 100).toFixed(1)}%`);
  if (profile.partial_rate !== null) lines.push(`Partial:  ${(profile.partial_rate * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('Pattern statements:');
  for (const p of profile.pattern_statements) {
    lines.push(`  • ${p}`);
  }
  if (profile.active_bias_tags.length > 0) {
    lines.push('');
    lines.push(`Active bias tags: ${profile.active_bias_tags.join(', ')}`);
  }
  return lines.join('\n');
}

/** Build an OperationContext shape suitable for the cycle phase from a CLI engine. */
function ctxFromCli(engine: BrainEngine, config: GBrainConfig, sourceId: string): OperationContext {
  return {
    engine,
    config,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId,
  };
}

export interface RunCalibrationArgs {
  holder?: string;
  json?: boolean;
  regenerate?: boolean;
  undoWave?: string;
  abReport?: boolean;
}

function parseArgs(args: string[]): { sub?: string; opts: RunCalibrationArgs } {
  const opts: RunCalibrationArgs = {};
  let sub: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'ab-report') {
      opts.abReport = true;
      continue;
    }
    if (!a?.startsWith('--') && !sub) {
      sub = a;
      continue;
    }
    if (a === '--holder') opts.holder = args[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--regenerate') opts.regenerate = true;
    else if (a === '--undo-wave') opts.undoWave = args[++i];
  }
  return { sub, opts };
}

/**
 * CLI entry point. The `config` param is forwarded so the calibration_profile
 * phase has access to the budget cap config key.
 */
export async function runCalibration(
  engine: BrainEngine,
  args: string[],
  config: GBrainConfig,
): Promise<void> {
  const { opts } = parseArgs(args);
  const holder = opts.holder ?? 'garry';
  const sourceId = 'default';

  if (opts.undoWave) {
    // T17 / D18 CDX-3 — reverse the wave's mutations on canonical state.
    const { undoWave } = await import('../core/calibration/undo-wave.ts');
    const scrubGstack = args.includes('--scrub-gstack');
    const dryRun = args.includes('--dry-run');
    process.stderr.write(
      `[calibration] ${dryRun ? '[dry-run] ' : ''}reversing wave ${opts.undoWave}...\n`,
    );
    const result = await undoWave(engine, {
      waveVersion: opts.undoWave,
      dryRun,
      scrubGstack,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      const verb = dryRun ? 'would revert' : 'reverted';
      process.stdout.write(
        `${verb}:\n` +
          `  ${result.resolutions_reverted} take resolutions\n` +
          `  ${result.profiles_deleted} calibration profile(s)\n` +
          `  ${result.nudges_purged} nudge log row(s)\n` +
          `  ${result.grade_cache_unapplied} grade-cache rows marked unapplied\n`,
      );
      if (result.gstack_scrub_attempted) {
        if (result.warnings.length > 0) {
          process.stdout.write(`  gstack scrub: failed (${result.warnings.join('; ')})\n`);
        } else {
          process.stdout.write(`  gstack scrub: ok\n`);
        }
      }
    }
    return;
  }

  if (opts.abReport) {
    // D19 A/B harness report wired in Lane D (T18). Placeholder.
    process.stderr.write(
      `[calibration] ab-report: implementation lands in Lane D (T18 — A/B harness for think).\n`,
    );
    process.exit(2);
  }

  if (opts.regenerate) {
    process.stderr.write(`[calibration] regenerating profile for holder=${holder}...\n`);
    const ctx = ctxFromCli(engine, config, sourceId);
    const result = await runPhaseCalibrationProfile(ctx, { holder });
    if (result.status === 'fail') {
      process.stderr.write(`[calibration] regenerate failed: ${result.error?.message ?? 'unknown'}\n`);
      process.exit(1);
    }
    process.stderr.write(`[calibration] ${result.summary}\n`);
  }

  const profile = await getLatestProfile(engine, { holder, sourceId });

  if (opts.json) {
    process.stdout.write(JSON.stringify(profile, null, 2) + '\n');
    return;
  }

  process.stdout.write(formatProfileText(profile, holder) + '\n');
}

/**
 * Op-handler entry point for `get_calibration_profile` MCP op. Source-scoped
 * via sourceScopeOpts(ctx). scope: 'read' on the op definition; this handler
 * is the implementation.
 */
export async function getCalibrationProfileOp(
  ctx: OperationContext,
  params: { holder?: string },
): Promise<CalibrationProfileRow | null> {
  const holder = params.holder ?? 'garry';
  if (typeof holder !== 'string' || holder.length === 0) {
    throw new GBrainError(
      'INVALID_HOLDER',
      'get_calibration_profile.holder must be a non-empty string',
      'pass holder="<slug>" or omit to default to "garry"',
    );
  }
  const scope = sourceScopeOpts(ctx);
  return getLatestProfile(ctx.engine, { holder, ...scope });
}

export const __testing = {
  parseArgs,
  formatProfileText,
};
