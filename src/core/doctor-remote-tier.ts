/**
 * #6696 B2: thin-client `gbrain doctor --tier ops` and `--only <check>`.
 *
 * The thin client asks the serve what it lists for this token (tools/list,
 * already filtered by scope) and sends a parameter only where it is
 * advertised:
 *
 *   1. `run_doctor` lists `tier` / `only` -> the serve runs the ops sections
 *      (admin scope) and the client prints that report;
 *   2. otherwise, when every requested check is one the bands cover (or the
 *      tier is ops) and `get_brain_health` is listed -> the read-scope bands,
 *      shown as checks (a token without admin lands here);
 *   3. otherwise (an older serve) -> the structured handoff
 *      `doctor_tier_unavailable`: run doctor on the brain host. The full
 *      thin-client report is never run in place of the request.
 */
import type { GBrainConfig } from './config.ts';
import { callRemoteTool, listRemoteTools, RemoteMcpError, unpackToolResult } from './mcp-client.ts';
import { isScopeErrorCode } from './error-catalogue.ts';
import { opError } from './ops/contract.ts';
import { renderCliError } from './agent-output.ts';
import { setCliExitVerdict, writeJsonDocument } from './cli-force-exit.ts';

/** The checks `get_brain_health` answers, and the band each is read from. */
export const BAND_CHECKS: ReadonlySet<string> = new Set(['persistence_capacity', 'persistence_terminal_failures']);

interface BandsResult {
  status: string;
  capacity: { band: string; days: string; max_pct_band: string; forecast: string };
  write_failures: { band: string; active_blockers: string; window_days: number | null };
  [section: string]: unknown;
}
interface ScopedCheck { name: string; status: 'ok' | 'warn' | 'fail'; message: string; details?: Record<string, unknown> }

/** Bands as doctor checks: `low` warns, `critical` fails, `unknown` warns with health unknown (never a clear band). */
export function bandChecks(bands: BandsResult, only: ReadonlySet<string> | null): ScopedCheck[] {
  const checks: ScopedCheck[] = [];
  const c = bands.capacity;
  if (!only || only.has('persistence_capacity')) {
    const status = c.band === 'critical' ? 'fail' : c.band === 'ok' ? 'ok' : 'warn';
    checks.push({ name: 'persistence_capacity', status, details: { band: c.band, days: c.days, max_pct_band: c.max_pct_band, forecast: c.forecast, ...(c.band === 'unknown' ? { health: 'unknown' } : {}) },
      message: c.band === 'unknown' ? 'Write capacity could not be read on the serve. Health is unknown.'
        : `Write capacity band ${c.band} (highest use ${c.max_pct_band}%, days to exhaustion ${c.days.replaceAll('_', ' ')}).${c.band === 'ok' ? '' : ' Run on the brain host: gbrain doctor --only persistence_capacity --json'}` });
  }
  const f = bands.write_failures;
  if (!only || only.has('persistence_terminal_failures')) {
    const blocked = f.active_blockers !== 'none' && f.active_blockers !== 'unknown';
    checks.push({ name: 'persistence_terminal_failures', status: f.band === 'unknown' || blocked ? 'warn' : 'ok',
      details: { band: f.band, active_blockers: f.active_blockers, window_days: f.window_days, ...(f.band === 'unknown' ? { health: 'unknown' } : {}) },
      message: f.band === 'unknown' ? 'Write failures could not be read on the serve. Health is unknown.'
        : `Unresolved write failures in your sources: ${f.band}; active blockers: ${f.active_blockers}.${blocked ? ' Run on the brain host: gbrain doctor --only persistence_terminal_failures --json' : ''}` });
  }
  return checks;
}

/** `tier` / `only` as parsed by the doctor dispatch (src/cli/commands/doctor.ts); `label` names the request in the handoff. */
export async function runScopedRemoteDoctor(config: GBrainConfig, req: { tier?: string; only: ReadonlySet<string> | null; json: boolean; label: string }): Promise<void> {
  const { tier, only, json } = req;
  const handoff = (why: string) => {
    const out = renderCliError(opError('doctor_tier_unavailable', `The remote brain cannot answer gbrain doctor ${req.label} for this client: ${why}`,
      'Run gbrain doctor --tier ops --json on the brain host, or upgrade and restart its serve.'), { json, command: 'doctor', tty: !!process.stderr.isTTY });
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    setCliExitVerdict(out.exitCode);
  };
  if (tier !== undefined && tier !== 'ops') return handoff(`only the ops tier is served remotely (the ${tier} tier runs on the brain host).`);

  const tools = await listRemoteTools(config);
  const runDoctor = tools.find((t) => t.name === 'run_doctor');
  const needs = [...(tier ? ['tier'] : []), ...(only ? ['only'] : [])];
  if (runDoctor && needs.every((p) => runDoctor.params.includes(p))) {
    try {
      const report = unpackToolResult<{ status: string; checks: unknown[] }>(await callRemoteTool(config, 'run_doctor', { ...(tier ? { tier } : {}), ...(only ? { only: [...only] } : {}) }));
      return print(report, json);
    } catch (e) {
      if (!(e instanceof RemoteMcpError && isScopeErrorCode(e.detail?.code, e.detail?.canonical_code, e.detail?.reason))) throw e;
    }
  }
  const bandsCover = !only || [...only].every((n) => BAND_CHECKS.has(n));
  if (bandsCover && tools.some((t) => t.name === 'get_brain_health')) {
    const bands = unpackToolResult<BandsResult>(await callRemoteTool(config, 'get_brain_health', {}));
    const checks = bandChecks(bands, only);
    const status = checks.some((c) => c.status === 'fail') ? 'unhealthy' : checks.some((c) => c.status === 'warn') ? 'warnings' : 'healthy';
    return print({ schema_version: 2, mode: 'bands', status, source: 'get_brain_health', ...(tier ? { tier } : {}), checks, bands }, json);
  }
  return handoff(runDoctor || tools.some((t) => t.name === 'get_brain_health')
    ? `this token cannot run ${only ? `the ${[...only].join(', ')} check(s)` : 'the ops tier'} remotely and the read-scope bands do not cover ${only ? 'them' : 'every ops section'}.`
    : 'the serve predates the doctor ops tier (run_doctor lists no tier or only parameter and get_brain_health is not served).');
}

function print(report: { status: string; checks: unknown[] } & Record<string, unknown>, json: boolean): void {
  if (json) void writeJsonDocument(JSON.stringify(report));
  else {
    console.log(`\nGBrain Health Check (remote${report.mode === 'bands' ? ', bands' : report.tier ? `, ${report.tier} tier` : ''})`);
    for (const c of report.checks as ScopedCheck[]) console.log(`  [${c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'WARN' : 'FAIL'}] ${c.name}: ${c.message}`);
  }
  setCliExitVerdict(report.status === 'unhealthy' ? 1 : 0);
}
