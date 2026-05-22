/**
 * `gbrain skillpack-check` — agent-readable health report.
 *
 * Wraps `gbrain doctor --json` + `gbrain apply-migrations --list` into a
 * single JSON blob a host agent (your OpenClaw's morning-briefing, any
 * OpenClaw cron) can consume without parsing two subcommands.
 *
 * Usage:
 *   gbrain skillpack-check              # pretty-printed JSON + exit code
 *   gbrain skillpack-check --quiet      # only exits with status; no output
 *   gbrain skillpack-check --help
 *
 * Exit codes:
 *   0 — Healthy. Nothing needs action.
 *   1 — Action needed (partial migration, half-install, or doctor FAIL).
 *   2 — Could not determine (missing binary / crashed).
 */

import { execFileSync } from 'child_process';
import { VERSION } from '../version.ts';
import { getCliOptions } from '../core/cli-options.ts';

/**
 * Resolve the gbrain binary + args for spawning subcommands from
 * within skillpack-check. Handles three install cases:
 *   - Running the compiled binary (argv[1] ends in /gbrain): re-exec it.
 *   - Running via `bun run src/cli.ts` (argv[1] is a .ts file): prefix with `bun run`.
 *   - Anything else: fall back to `which gbrain` on $PATH.
 */
function gbrainSpawn(): { cmd: string; prefix: string[] } {
  const arg1 = process.argv[1] ?? '';
  if (arg1.endsWith('/gbrain') || arg1.endsWith('\\gbrain.exe')) {
    return { cmd: arg1, prefix: [] };
  }
  if (arg1.endsWith('.ts') || arg1.endsWith('.mjs') || arg1.endsWith('.js')) {
    return { cmd: 'bun', prefix: ['run', arg1] };
  }
  const execPath = process.execPath ?? '';
  if (execPath.endsWith('/gbrain') || execPath.endsWith('\\gbrain.exe')) {
    return { cmd: execPath, prefix: [] };
  }
  return { cmd: 'gbrain', prefix: [] };
}

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  issues?: unknown[];
}

interface SkillpackReport {
  version: string;
  ts: string;
  healthy: boolean;
  /** One-line summary for an agent to quote in a briefing. */
  summary: string;
  /** Every recommended action the user/agent should take. */
  actions: string[];
  /** Full doctor output, machine-readable. */
  doctor: {
    exit_code: number;
    checks: DoctorCheck[];
  } | { error: string };
  /** apply-migrations --list output, parsed. */
  migrations: {
    pending_count: number;
    partial_count: number;
    applied_count: number;
    stdout: string;
  } | { error: string };
}

function runDoctor(): SkillpackReport['doctor'] {
  const { cmd, prefix } = gbrainSpawn();
  try {
    // --fast avoids DB dependency; the filesystem half-migration checks
    // we care about most run in the fast path.
    const stdout = execFileSync(cmd, [...prefix, 'doctor', '--fast', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
    // doctor emits a JSON object on success; on FAIL it exits non-zero
    // but still prints JSON. Parse either way.
    const parsed = JSON.parse(stdout) as { checks: DoctorCheck[] };
    return { exit_code: 0, checks: parsed.checks };
  } catch (err: any) {
    // execFileSync throws on non-zero exit; stdout is still on the error.
    const stdout = err.stdout?.toString?.() ?? '';
    try {
      const parsed = JSON.parse(stdout) as { checks: DoctorCheck[] };
      return { exit_code: err.status ?? 1, checks: parsed.checks };
    } catch {
      return { error: `doctor failed: ${err.message ?? String(err)}` };
    }
  }
}

function runMigrationsList(): SkillpackReport['migrations'] {
  const { cmd, prefix } = gbrainSpawn();
  try {
    const stdout = execFileSync(cmd, [...prefix, 'apply-migrations', '--list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });

    // Count rows by status word. Output shape from apply-migrations:
    //   Installed gbrain version: 0.11.1
    //
    //     Status   Version   Headline
    //     -------  --------  ...
    //     applied  0.11.0    ...
    //     pending  0.11.1    ...
    //     partial  0.10.0    ...
    const lines = stdout.split('\n');
    let applied = 0;
    let pending = 0;
    let partial = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Status') || trimmed.startsWith('---')) continue;
      const first = trimmed.split(/\s+/)[0];
      if (first === 'applied') applied++;
      else if (first === 'pending') pending++;
      else if (first === 'partial') partial++;
    }
    return { applied_count: applied, pending_count: pending, partial_count: partial, stdout };
  } catch (err: any) {
    return { error: `apply-migrations --list failed: ${err.message ?? String(err)}` };
  }
}

function buildReport(): SkillpackReport {
  const doctor = runDoctor();
  const migrations = runMigrationsList();

  const actions: string[] = [];
  let healthy = true;

  // Gather actions from doctor failures.
  if ('checks' in doctor) {
    for (const check of doctor.checks) {
      if (check.status === 'fail') {
        healthy = false;
        // Extract remediation command from check message if it follows
        // the `... Run: <cmd>` convention. Otherwise include the whole
        // message so the agent has enough to reason.
        const runMatch = check.message.match(/Run:\s*(.+)$/);
        if (runMatch) actions.push(runMatch[1].trim());
        else actions.push(`[${check.name}] ${check.message}`);
      } else if (check.status === 'warn') {
        // Warnings don't fail the report but surface as informational
        // actions the agent can decide about.
        const runMatch = check.message.match(/Run:\s*(.+)$/);
        if (runMatch && !actions.includes(runMatch[1].trim())) actions.push(runMatch[1].trim());
      }
    }
  } else {
    healthy = false;
    actions.push('Investigate doctor failure: ' + doctor.error);
  }

  // Gather actions from pending/partial migrations.
  if ('applied_count' in migrations) {
    if (migrations.partial_count > 0 || migrations.pending_count > 0) {
      healthy = false;
      const action = 'gbrain apply-migrations --yes';
      if (!actions.includes(action)) actions.unshift(action);
    }
  } else {
    healthy = false;
    actions.push('Investigate apply-migrations failure: ' + migrations.error);
  }

  const summary = healthy
    ? 'gbrain skillpack healthy'
    : `gbrain skillpack needs attention: ${actions.length} action(s) — ${actions[0]}`;

  return {
    version: VERSION,
    ts: new Date().toISOString(),
    healthy,
    summary,
    actions,
    doctor,
    migrations,
  };
}

export async function runSkillpackCheck(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`gbrain skillpack-check — agent-readable health report.

Wraps doctor + apply-migrations --list into one JSON blob. Cron-friendly:
zero interactive prompts, non-zero exit on any needed action.

Usage:
  gbrain skillpack-check            Pretty JSON to stdout, exit 0/1/2.
  gbrain skillpack-check --quiet    Exit code only, no output.

Exit codes:
  0  healthy (no action needed)
  1  action needed (see JSON.actions[])
  2  could not determine (binary or subcommand crash)
`);
    return;
  }

  // --quiet is parsed as a global flag in src/cli.ts (and stripped from argv
  // before reaching here); honor it via the CliOptions singleton.
  const quiet = getCliOptions().quiet;
  const report = buildReport();

  if (!quiet) {
    console.log(JSON.stringify(report, null, 2));
  }

  // Determine exit code.
  if ('error' in report.doctor || 'error' in report.migrations) {
    process.exit(2);
  }
  process.exit(report.healthy ? 0 : 1);
}

/** Exported for unit tests. */
export const __testing = { buildReport, runDoctor, runMigrationsList };
