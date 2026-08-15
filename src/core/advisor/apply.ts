/**
 * advisor/apply.ts — pure resolution + validation for `gbrain advisor --apply`.
 *
 * Kept separate from the CLI command so the allowlist + injection guard are
 * unit-testable without spawning a process. The CLI confirms + executes; this
 * module decides WHAT (if anything) is safe to run.
 *
 * Safety model (#10/C5):
 *   - Only findings carrying a `dispatch_id` are runnable (the allowlist).
 *   - The command is a STRUCTURED argv; it is rejected if any token contains a
 *     shell metacharacter (defense in depth — we never invoke a shell).
 *   - argv[0] must be 'gbrain' (the advisor never runs arbitrary binaries).
 */

import type { AdvisorReport } from './types.ts';

export type ApplyResolution =
  | { ok: true; argv: string[]; display: string }
  | { ok: false; error: string; runnable: string[] };

const SHELL_META = /[;&|`$<>(){}\n]/;

export function resolveApplyTarget(report: AdvisorReport, id: string): ApplyResolution {
  const runnable = report.findings.filter((f) => f.fix.dispatch_id).map((f) => f.fix.dispatch_id!) as string[];
  const finding = report.findings.find((f) => f.fix.dispatch_id === id);
  if (!finding) {
    return { ok: false, error: `No runnable finding with apply id "${id}".`, runnable };
  }
  const argv = finding.fix.command_argv;
  if (!argv || argv.length === 0) {
    return { ok: false, error: `Finding "${id}" has no runnable command.`, runnable };
  }
  if (argv[0] !== 'gbrain') {
    return { ok: false, error: `Refusing to run: fix does not invoke gbrain.`, runnable };
  }
  if (!argv.every((a) => typeof a === 'string' && !SHELL_META.test(a))) {
    return { ok: false, error: `Refusing to run: fix command contains unexpected characters.`, runnable };
  }
  return { ok: true, argv, display: argv.join(' ') };
}
