/**
 * commands/advisor.ts — `gbrain advisor` CLI surface.
 *
 *   gbrain advisor            # ranked, agent-readable action list (human render)
 *   gbrain advisor --json     # structured findings; exit non-zero on critical (E2)
 *   gbrain advisor --apply ID # run ONE finding's fix, local-only, after confirm (E5)
 *
 * The advisor itself never mutates. `--apply` is the only path that runs a fix,
 * and it: refuses over MCP (CLI is always local), only acts on allowlisted
 * findings (those carrying a dispatch_id), asks through requireConsent first
 * (`--apply <id> --yes` non-interactively), and executes the fix as STRUCTURED
 * ARGV via a child process (never a shell — no injection).
 */

import { resolve as resolvePath } from 'path';

import type { BrainEngine } from '../core/engine.ts';
import type { Effect } from '../core/agent-output.ts';
import { spawnCliChild } from '../core/cli-force-exit.ts';
import { consentGate, engineConsentEnv } from '../core/consent-cli.ts';
import { CONFIRMATION_REQUIRED_EXIT_CODE } from '../core/exit-codes.ts';
import { VERSION } from '../version.ts';
import { loadConfig } from '../core/config.ts';
import { autoDetectSkillsDir } from '../core/repo-root.ts';
import { runAdvisor } from '../core/advisor/run.ts';
import { renderAdvisorReport } from '../core/advisor/render.ts';
import { appendAdvisorRun, summarizeDeltas } from '../core/advisor/history.ts';
import { resolveApplyTarget } from '../core/advisor/apply.ts';
import type { AdvisorContext, AdvisorReport } from '../core/advisor/types.ts';

export interface AdvisorCliResult {
  /** 0 clean / 1 warn / 2 critical or a failed fix / 3 consent required (--apply). */
  exitCode: 0 | 1 | 2 | 3;
}

function buildContext(engine: BrainEngine): AdvisorContext {
  const det = autoDetectSkillsDir();
  const skillsDir = det.dir;
  const workspace = skillsDir ? resolvePath(skillsDir, '..') : null;
  return {
    engine,
    config: loadConfig() ?? ({} as AdvisorContext['config']),
    version: VERSION,
    workspace,
    skillsDir,
    now: new Date(),
    remote: false, // CLI is always the trusted local owner
  };
}

/** Exit-code contract (E2): 0 clean / 1 warn / 2 critical. */
function exitFor(report: AdvisorReport): 0 | 1 | 2 {
  if (report.worst === 'critical') return 2;
  if (report.worst === 'warn') return 1;
  return 0;
}

export async function runAdvisorCli(engine: BrainEngine, args: string[]): Promise<AdvisorCliResult> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'gbrain advisor [--json] [--apply <finding-id>]\n\n' +
        '  (no flags)        Ranked, agent-readable list of high-leverage actions for this brain.\n' +
        '  --json            Structured findings. Exit code: 0 clean / 1 warn / 2 critical.\n' +
        '  --apply <id>      Run ONE finding\'s fix (local-only). Only findings that report an\n' +
        '                    apply id are runnable. It asks first; --yes is the user\'s approval.\n' +
        '                    Without it a non-interactive run changes nothing and exits 3 with the\n' +
        '                    consent payload (the command it would run and its cost).\n\n' +
        'Read-only by default; never mutates without --apply + the user\'s approval.',
    );
    return { exitCode: 0 };
  }

  const json = args.includes('--json');
  const applyIdx = args.indexOf('--apply');
  const applyId = applyIdx >= 0 ? args[applyIdx + 1] : undefined;

  const ctx = buildContext(engine);
  const report = await runAdvisor(ctx);

  if (applyId) {
    return applyFinding(engine, report, applyId, args);
  }

  // Record run history (local-only) for "since last run" deltas.
  let deltaNote = '';
  try {
    const prior = appendAdvisorRun(report);
    deltaNote = summarizeDeltas(prior, report);
  } catch {
    /* history is best-effort; never block the report */
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderAdvisorReport(report));
    if (deltaNote) process.stdout.write(deltaNote + '\n');
  }
  return { exitCode: exitFor(report) };
}

/**
 * What running each allowlisted fix does, for the consent request (C4). An
 * unknown dispatch id is treated as destructive (never preapprovable).
 */
const APPLY_CONSENT: Readonly<Record<string, { effects: Effect[]; risk: string; cost: string }>> = {
  apply_migrations: {
    effects: ['persistent_install'],
    risk: 'Applies the pending schema and data migrations to this brain (forward-only; take a backup first with gbrain backup if one matters) '
      + 'and may install the autopilot background service.',
    cost: 'no model spend (a migration that needs paid re-embedding asks separately)',
  },
};

/**
 * E5/C4: run a single finding's fix. Allowlist = findings carrying a dispatch_id.
 * Local-only (refused over MCP by construction — this is the CLI path). Asks
 * through requireConsent first: `--yes` or a TTY prompt; otherwise exit 3 with
 * the consent payload naming the command and its cost. Executes the
 * structured argv via spawnCliChild with NO shell.
 */
async function applyFinding(engine: BrainEngine, report: AdvisorReport, id: string, args: string[]): Promise<AdvisorCliResult> {
  const target = resolveApplyTarget(report, id);
  if (!target.ok) {
    console.error(
      target.error +
        (target.runnable.length ? ` Runnable now: ${target.runnable.join(', ')}.` : ' Nothing is runnable right now.'),
    );
    return { exitCode: 2 };
  }

  const finding = report.findings.find((f) => f.fix.dispatch_id === id);
  const known = APPLY_CONSENT[id];
  console.error(`About to run: ${target.display}`);
  const auth = await consentGate({
    command: 'advisor --apply', effects: known?.effects ?? ['destructive'], actor: 'agent',
    what: `Run the advisor fix ${id}: ${target.display}`,
    why: finding?.title ?? `The advisor recommends ${id}.`,
    risk: `${known?.risk ?? 'Runs a gbrain maintenance command that changes this brain.'} Cost: ${known?.cost ?? 'unknown'}.`,
    user_message: `Run ${target.display} now (${known?.cost ?? 'cost unknown'})? ${finding?.title ?? ''}`.trim(),
    argv: ['gbrain', 'advisor', '--apply', id, ...(args.includes('--json') ? ['--json'] : [])],
    preview_argv: ['gbrain', 'advisor', '--json'],
    // `--apply <id>` selects the finding here; it is not the consent flag.
    args: args.filter((a, i) => a !== '--apply' && args[i - 1] !== '--apply'),
  }, { json: args.includes('--json'), env: engineConsentEnv(engine) });
  if (!auth) return { exitCode: CONFIRMATION_REQUIRED_EXIT_CODE };

  const [cmd, ...rest] = target.argv;
  const child = spawnCliChild(cmd!, rest, { shell: false });
  const status = await new Promise<number>((resolveStatus) => {
    child.once('error', () => resolveStatus(1));
    child.once('close', (code) => resolveStatus(code ?? 1));
  });
  return { exitCode: status === 0 ? 0 : 2 };
}
