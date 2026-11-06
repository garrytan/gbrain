/**
 * wakeshift_openclaw (Wakeshift plan D11): drift between Wakeshift's OpenClaw plugin as installed and the version
 * this gbrain pins (WAKESHIFT_OPENCLAW_VERSION, which `gbrain setup openclaw --wakeshift` installs). Runs only
 * where openclaw is on PATH; reads `openclaw plugins inspect wakeshift --runtime --json` with a 15 s cap. A
 * different version is a warning, never a failure: the fix reruns setup, which reinstalls the pinned version.
 */
import type { Check } from '../../doctor.ts';
import type { DoctorEntry } from '../context.ts';
import { defaultOpenclawRun, findOpenclawBin, installedWakeshiftOpenclawVersion, WAKESHIFT_OPENCLAW_VERSION, type OpenclawRun } from '../../setup-openclaw-wakeshift.ts';

/** The check for this machine; none when openclaw is not on PATH. `opts` injects the binary and runner (tests). */
export async function runWakeshiftOpenclawCheck(_ctx: unknown, opts: { bin?: string | null; run?: OpenclawRun } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const bin = opts.bin !== undefined ? opts.bin : findOpenclawBin();
  if (!bin) return checks;
  const installed = installedWakeshiftOpenclawVersion(opts.run ?? ((argv) => defaultOpenclawRun(argv, 15_000)), bin);
  const details = { pinned: WAKESHIFT_OPENCLAW_VERSION, installed, docs: 'docs/mcp/OPENCLAW.md#have-gbrain-report-back-to-this-chat' };
  if (installed === null) {
    checks.push({ name: 'wakeshift_openclaw', status: 'ok', severity: 'info', message: "Wakeshift's OpenClaw plugin is not installed here (gbrain setup openclaw --wakeshift installs it).", details });
  } else if (installed === WAKESHIFT_OPENCLAW_VERSION) {
    checks.push({ name: 'wakeshift_openclaw', status: 'ok', message: `Wakeshift's OpenClaw plugin ${installed} matches the version this gbrain pins.`, details });
  } else {
    checks.push({ name: 'wakeshift_openclaw', status: 'warn', message: `Wakeshift's OpenClaw plugin is ${installed}; this gbrain pins ${WAKESHIFT_OPENCLAW_VERSION}. Fix: gbrain setup openclaw --wakeshift (reinstalls the pinned version).`, details });
  }
  return checks;
}

export const wakeshiftOpenclawEntry: DoctorEntry = { name: 'wakeshift_openclaw', emits: ['wakeshift_openclaw'], run: runWakeshiftOpenclawCheck };
