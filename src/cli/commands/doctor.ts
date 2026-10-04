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
  // Multi-topology v1: thin-client doctor. When `~/.gbrain/config.json`
  // has remote_mcp set, every DB-bound check is irrelevant. Route to the
  // outbound-HTTP probe set in `src/core/doctor-remote.ts` and return
  // before any local-engine work.
  const cfgForDoctor = loadConfig();
  if (isThinClient(cfgForDoctor)) {
    const { runRemoteDoctor } = await import('../../core/doctor-remote.ts');
    await runRemoteDoctor(cfgForDoctor!, args);
    return;
  }

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

  // Doctor runs filesystem checks first (no DB needed), then DB checks.
  // --fast skips DB checks entirely.
  const { runDoctor } = await import('../../commands/doctor.ts');
  if (await runDoctorOnly(args, connectEngine, runDoctor)) return;
  if (args.includes('--fast')) {
    // Pass the DB URL source so doctor can tell "no config at all" from
    // "user chose --fast while config is present".
    await runDoctor(null, args, getDbUrlSource());
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
      await runDoctor(eng, args);
    } catch (e) {
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
      await runDoctor(null, args, getDbUrlSource(), e);
    } finally {
      if (eng) await finishCliTeardown({ engine: eng });
    }
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
    await runDoctor(null, args, getDbUrlSource());
    return true;
  }
  let eng: BrainEngine | null = null;
  try {
    eng = await connectEngine({ probeOnly: true });
    await runDoctor(eng, args);
  } catch (e) {
    await runDoctor(null, args, getDbUrlSource(), e);
  } finally {
    if (eng) await finishCliTeardown({ engine: eng });
  }
  return true;
}
