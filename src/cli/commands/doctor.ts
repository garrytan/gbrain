/**
 * `gbrain doctor`: pre-connect dispatch (opens its own engine), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { finishCliTeardown, setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { getDbUrlSource, isThinClient, loadConfig } from '../../core/config.ts';
import {
  classifyPgAccessError as classifyDbAccessError,
  formatDbAccessMarker as formatDbMarker,
  shouldEmitDbAccessMarker,
} from '../../core/pg-access-classify.ts';
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const { connectEngine, dbMarkerBrainId } = ctx;
  // W4: --alert runs the page class alone (the alert tier) under its own budget unless --tier / --only / --budget-ms say otherwise.
  const alert = args.includes('--alert');
  if (alert) args = (await import('../../commands/doctor/alert.ts')).alertRunArgs(args);
  // Multi-topology v1: thin-client doctor. When `~/.gbrain/config.json`
  // has remote_mcp set, every DB-bound check is irrelevant. Route to the
  // outbound-HTTP probe set in `src/core/doctor-remote.ts` and return
  // before any local-engine work.
  const cfgForDoctor = loadConfig();
  if (isThinClient(cfgForDoctor)) {
    // #6696 B2: --tier, or --only naming brain checks, asks the serve (run_doctor / get_brain_health) or hands off; never the full report.
    const { parseOnlyChecks, doctorCheckNames } = await import('../../commands/doctor/registry.ts');
    const only = parseOnlyChecks(args);
    const tier = args.find((a, i) => args[i - 1] === '--tier') ?? args.find((a) => a.startsWith('--tier='))?.slice('--tier='.length);
    if (tier !== undefined || (only && only.size > 0 && [...only].every((n) => doctorCheckNames().has(n)))) {
      const { runScopedRemoteDoctor } = await import('../../core/doctor-remote-tier.ts');
      await runScopedRemoteDoctor(cfgForDoctor!, { tier, only, json: args.includes('--json'), label: args.filter((a) => a !== '--json').join(' '), alert });
      return;
    }
    const { runRemoteDoctor } = await import('../../core/doctor-remote.ts');
    await runRemoteDoctor(cfgForDoctor!, args);
    return;
  }

  // A configured PGLite brain (the host's, or the mounted one --brain / GBRAIN_BRAIN_ID selects) that is not
  // there (unmounted drive, moved folder) or is an empty mount point is refused before any connect:
  // connecting would create a new empty brain and report it healthy. Host probe is serve's status-only missing_brain. Runs that never connect (--fast, filesystem-only --only) keep running.
  // The connect waits for the datastore's lock, and the folder can move meanwhile, so the same test runs again under the held lock.
  let releaseGuard = (): void => {};
  if (await doctorWillConnect(args)) {
    const { missingBrainRefusal, refuseMissingBrain, guardMissingBrainAtLock } = await import('../../commands/doctor/missing-brain.ts');
    const brainId = dbMarkerBrainId() ?? 'host';
    const refusal = missingBrainRefusal(brainId);
    if (refusal) { await refuseMissingBrain(args, refusal); return; }
    releaseGuard = guardMissingBrainAtLock(brainId);
  }
  try {
    await runLocalDoctor(args, ctx);
  } catch (e) {
    if (!isMissingBrainRefusal(e)) throw e;
    await (await import('../../commands/doctor/missing-brain.ts')).refuseMissingBrain(args, e as import('../../core/ops/contract.ts').OperationError); // refused under the held lock (the datastore went missing while doctor waited): the same refusal, never the filesystem-only fallback
  } finally {
    // A connect abandoned at the budget still waits for the lock and can still create the folder: the guard outlives it.
    const abandoned = abandonedConnects.splice(0);
    if (abandoned.length) void Promise.allSettled(abandoned).then(releaseGuard); else releaseGuard();
  }
}

/** Connects `runDoctorWithDeadline` stopped waiting for, until each settles. */
const abandonedConnects: Promise<unknown>[] = [];

/** The refusal under the held lock (`missing-brain.ts` builds it); doctor's filesystem-only fallback must not swallow it. Matched on the code so this file need not load that module until a refusal is rendered. */
const isMissingBrainRefusal = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'brain_missing';

/** The local-engine doctor (everything after the thin-client route and the missing-brain refusal). */
async function runLocalDoctor(args: string[], ctx: CliDispatchContext): Promise<void> {
  const { connectEngine, dbMarkerBrainId } = ctx;

  // v0.36+ brain-health-100: --remediation-plan and --remediate go
  // through dedicated functions that compute from engine.getHealth()
  // (cheap path D7), NOT the full doctor walk.
  if (args.includes('--remediation-plan')) {
    const { runRemediationPlan } = await import('../../commands/doctor.ts');
    // ENG-6: observational — probe-only connect (no migrations, no maintenance); pending migrations are reported in the plan.
    const eng = await connectEngine({ probeOnly: true });
    try { await runRemediationPlan(eng, args); } finally { await finishCliTeardown({ engine: eng }); }
    return;
  }
  if (args.includes('--remediate')) {
    const { runRemediate } = await import('../../commands/doctor.ts');
    // A4/C1: observational startup; migrations run only after consent (ctx.completeStartup).
    const eng = await connectEngine({ probeOnly: !args.includes('--dry-run') });
    try { await runRemediate(eng, args, ctx.completeStartup); } finally { await finishCliTeardown({ engine: eng }); }
    return;
  }

  // #6696 B1: the absolute deadline starts before connecting; a bad --tier / --budget-ms exits 2 before any work.
  const { startDoctorDeadline } = await import('../../commands/doctor/budget.ts');
  let deadline: import('../../commands/doctor/budget.ts').DoctorDeadline;
  try { deadline = startDoctorDeadline(args); } catch (error) { await renderDoctorParamError(error, args); return; }
  // #6803 C5: a plain non-interactive --json run caps its check run (started after connect and migrations).
  const { nonInteractiveDefaultBudget, defaultBudgetNotice } = await import('../../commands/doctor/default-budget.ts');
  const deferred = nonInteractiveDefaultBudget(args, { stderrIsTty: !!process.stderr.isTTY });
  if (deferred !== null) Object.assign(deadline, { deferredBudgetMs: deferred, deferredNotice: defaultBudgetNotice(deferred) });

  // Doctor runs filesystem checks first (no DB needed), then DB checks.
  // --fast skips DB checks entirely.
  const { runDoctor } = await import('../../commands/doctor.ts');
  if (await runDoctorOnly(args, connectEngine, runDoctor, deadline)) return;
  if (args.includes('--fast')) {
    // Pass the DB URL source so doctor can tell "no config at all" from
    // "user chose --fast while config is present".
    await runDoctor(null, args, getDbUrlSource(), undefined, deadline);
  } else if (deadline.deadlineAt !== null) {
    await runDoctorWithDeadline(args, connectEngine, runDoctor, deadline);
  } else {
    // #2084: both failure kinds (connect throw, runDoctor(eng) throw) still
    // fall back to filesystem-only checks — identical to the prior shape.
    // The finally closes the gap where a runDoctor(eng) throw used to skip
    // the in-try disconnect. NOTE: runDoctor normally calls process.exit
    // itself, which preempts this finally — in-command exit sites bypassing
    // teardown are a pre-existing class, tracked as a TODOS.md follow-up.
    let eng: BrainEngine | null = null;
    try {
      // #4364: --no-migrate keeps doctor observational — probeOnly skips
      // connectEngine's auto-migrate block so a clean/behind DB is reported
      // on as-is instead of being migrated before the health checks run.
      eng = await connectEngine({ probeOnly: args.includes('--no-migrate') });
      await runDoctor(eng, args, undefined, undefined, deadline);
    } catch (e) {
      if (isMissingBrainRefusal(e)) throw e;
      // DB unavailable OR the DB-backed run threw — still run filesystem
      // checks. Say so on stderr: a silent fallback looks identical to a
      // healthy DB-backed run (minus the DB checks), which has misread as
      // "doctor is broken". Scrub the message through BOTH redactors —
      // connection-info (hosts/IPs/users/quoted libpq passwords) and the
      // URL-userinfo sweep — because doctor output is exactly what users
      // paste into issues and CI logs.
      const { redactUrlsInText } = await import('../../core/url-redact.ts');
      const { redactConnectionInfo } = await import('../../core/audit/redact-connection-info.ts');
      const safeMsg = redactConnectionInfo(redactUrlsInText(e instanceof Error ? e.message : String(e)));
      console.error(`[doctor] DB-backed doctor run failed (${safeMsg}) — falling back to filesystem-only checks`);
      // db-availability loop: doctor is what agents run when things break —
      // the marker here feeds the skills/db-repair trigger. Best-effort.
      try {
        const d = classifyDbAccessError(e, { url: loadConfig()?.database_url ?? null, brainId: dbMarkerBrainId() });
        if (d.reason !== 'unknown' && shouldEmitDbAccessMarker()) {
          console.error(`${formatDbMarker(d)}\n${d.remediation} Run: gbrain db-repair`);
        }
      } catch { /* marker is best-effort */ }
      await runDoctor(null, args, getDbUrlSource(), e, deadline);
    } finally {
      if (eng) await finishCliTeardown({ engine: eng });
    }
  }
}

/** Whether this doctor invocation opens the brain engine (the connect paths below), so the missing-brain refusal applies. */
async function doctorWillConnect(args: string[]): Promise<boolean> {
  if (args.includes('--remediation-plan') || args.includes('--remediate')) return true;
  const { parseOnlyChecks, doctorCheckNames, onlyNeedsEngine } = await import('../../commands/doctor/registry.ts');
  const only = parseOnlyChecks(args);
  if (!only) return !args.includes('--fast');
  const known = doctorCheckNames();
  return only.size > 0 && [...only].every((n) => known.has(n)) && onlyNeedsEngine(only);
}

/** A `--tier` / `--budget-ms` value doctor cannot use: the structured error, exit 2. */
async function renderDoctorParamError(error: unknown, args: string[]): Promise<void> {
  const { renderCliError } = await import('../../core/agent-output.ts');
  const out = renderCliError(error, { json: args.includes('--json'), command: 'doctor', tty: !!process.stderr.isTTY });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  setCliExitVerdict(out.exitCode);
}

/**
 * #6696 B1: a run with an overall deadline (`--tier ops`, or `--budget-ms`).
 * Observational from connection onward (probe-only connect: no migrations, no
 * maintenance), and the connect itself counts against the deadline: a connect
 * still pending at the deadline reports the run as unknown instead of waiting.
 */
async function runDoctorWithDeadline(
  args: string[],
  connectEngine: CliDispatchContext['connectEngine'],
  runDoctor: typeof import('../../commands/doctor.ts').runDoctor,
  deadline: import('../../commands/doctor/budget.ts').DoctorDeadline,
): Promise<void> {
  const { raceBudget, budgetExpired, DoctorBudgetError } = await import('../../commands/doctor/budget.ts');
  const connecting = connectEngine({ probeOnly: true });
  let eng: BrainEngine | null = null;
  try {
    const connected = await raceBudget(connecting, deadline.deadlineAt! - Date.now());
    if (budgetExpired(connected)) {
      abandonedConnects.push(connecting.then((late) => finishCliTeardown({ engine: late }), () => undefined));
      await runDoctor(null, args, getDbUrlSource(), new DoctorBudgetError(Date.now() - deadline.startedAt), deadline);
      return;
    }
    eng = connected;
    await runDoctor(eng, args, undefined, undefined, deadline);
  } catch (e) {
    if (isMissingBrainRefusal(e)) throw e;
    await runDoctor(null, args, getDbUrlSource(), e, deadline);
  } finally {
    if (eng) await finishCliTeardown({ engine: eng });
  }
}

/**
 * `gbrain doctor --only <check>[,…] [--json]` — the default `fix.verify`:
 * read-only, observational startup (probeOnly: no migrations or maintenance),
 * engine-free when every requested check is a filesystem check. Unknown names
 * exit 2 with the valid list. Returns false when `--only` is absent.
 */
async function runDoctorOnly(
  args: string[],
  connectEngine: CliDispatchContext['connectEngine'],
  runDoctor: typeof import('../../commands/doctor.ts').runDoctor,
  deadline: import('../../commands/doctor/budget.ts').DoctorDeadline,
): Promise<boolean> {
  const { parseOnlyChecks, doctorCheckNames, onlyNeedsEngine } = await import('../../commands/doctor/registry.ts');
  const only = parseOnlyChecks(args);
  if (!only) return false;
  const known = doctorCheckNames();
  const unknown = [...only].filter((n) => !known.has(n));
  if (only.size === 0 || unknown.length > 0) {
    const { opError } = await import('../../core/ops/contract.ts');
    const { renderCliError } = await import('../../core/agent-output.ts');
    const { suggestNearest } = await import('../../core/levenshtein.ts');
    const nearest = unknown[0] ? suggestNearest(unknown[0], [...known]) : null;
    const err = opError('invalid_params', `Unknown doctor check: ${unknown.join(', ') || '(none given)'}`,
      `${nearest ? `Did you mean "${nearest}"? ` : ''}Valid names: ${[...known].sort().join(', ')}.`,
      { fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'The full report lists every check name this brain emits.' } });
    const out = renderCliError(err, { json: args.includes('--json'), command: 'doctor', tty: !!process.stderr.isTTY });
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    setCliExitVerdict(out.exitCode);
    return true;
  }
  if (!onlyNeedsEngine(only)) {
    await runDoctor(null, args, getDbUrlSource(), undefined, deadline);
    return true;
  }
  if (deadline.deadlineAt !== null) {
    await runDoctorWithDeadline(args, connectEngine, runDoctor, deadline);
    return true;
  }
  let eng: BrainEngine | null = null;
  try {
    eng = await connectEngine({ probeOnly: true });
    await runDoctor(eng, args, undefined, undefined, deadline);
  } catch (e) {
    if (isMissingBrainRefusal(e)) throw e;
    await runDoctor(null, args, getDbUrlSource(), e, deadline);
  } finally {
    if (eng) await finishCliTeardown({ engine: eng });
  }
  return true;
}
