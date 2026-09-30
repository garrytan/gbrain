/**
 * `gbrain doctor`: pre-connect dispatch (opens its own engine), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { finishCliTeardown } from '../../core/cli-force-exit.ts';
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
    const eng = await connectEngine();
    try { await runRemediationPlan(eng, args); } finally { await finishCliTeardown({ engine: eng }); }
    return;
  }
  if (args.includes('--remediate')) {
    const { runRemediate } = await import('../../commands/doctor.ts');
    const eng = await connectEngine();
    try { await runRemediate(eng, args); } finally { await finishCliTeardown({ engine: eng }); }
    return;
  }

  // Doctor runs filesystem checks first (no DB needed), then DB checks.
  // --fast skips DB checks entirely.
  const { runDoctor } = await import('../../commands/doctor.ts');
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
