/**
 * #6803 C5 (Decision 1): a plain non-interactive CLI `gbrain doctor --json`
 * (stderr not a terminal; no `--budget-ms`, `--tier`, `--remediate`,
 * `--remediation-plan` or `--fix`) caps its check run at
 * `doctor.default_budget_ms` (default 90000 ms, 0 off), so an agent's tool call
 * gets a report, with unknown checks named, instead of a timeout. The key is on
 * the file plane (~/.gbrain/config.json) and read before connecting; connect
 * and migrations are not counted. `--budget-ms 0` turns it off for one run.
 * MCP `run_doctor`, remote and ops paths never apply it.
 */
import type { GBrainConfig } from '../../core/config.ts';
import { loadConfigFileOnly } from '../../core/config.ts';

export const DEFAULT_BUDGET_KEY = 'doctor.default_budget_ms';
export const DEFAULT_BUDGET_MS = 90_000;
const EXPLICIT_MODE_FLAGS = ['--budget-ms', '--tier', '--remediate', '--remediation-plan', '--fix'];

/** A configured value: a whole number of ms (0: off), else null (not a valid value). */
export function parseDefaultBudgetValue(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/** `doctor.default_budget_ms` from the file plane; unset or not a whole number: the 90000 ms default. */
export function readDefaultBudgetMs(cfg: GBrainConfig | null = loadConfigFileOnly()): number {
  return parseDefaultBudgetValue(cfg?.doctor?.default_budget_ms) ?? DEFAULT_BUDGET_MS;
}

/** The check-run cap this CLI doctor run gets by default, or null (an interactive run, an explicit mode, or the key set to 0). */
export function nonInteractiveDefaultBudget(args: readonly string[], opts: { stderrIsTty: boolean; configuredMs?: number }): number | null {
  if (opts.stderrIsTty || !args.includes('--json')) return null;
  if (args.some(a => EXPLICIT_MODE_FLAGS.some(flag => a === flag || a.startsWith(`${flag}=`)))) return null;
  const ms = opts.configuredMs ?? readDefaultBudgetMs();
  return ms > 0 ? ms : null;
}

/** The one stderr line a capped run prints when its check run starts. */
export function defaultBudgetNotice(ms: number): string {
  return `[gbrain doctor] non-interactive run: the check run (not connect or migrations) is capped at ${ms} ms (${DEFAULT_BUDGET_KEY}); `
    + 'checks past it report health unknown. Off for one run: --budget-ms 0; off for good: gbrain config set doctor.default_budget_ms 0. '
    + 'On PGLite a statement already running cannot be stopped, so a check can finish late.\n';
}

/** `gbrain config set doctor.default_budget_ms <n>` (file plane). */
export function setDoctorDefaultBudget(cfg: GBrainConfig, value: string, saveConfig: (cfg: GBrainConfig) => void): void {
  const n = parseDefaultBudgetValue(value);
  if (n === null) {
    console.error(`[config] ${DEFAULT_BUDGET_KEY} must be a whole number of milliseconds (0 turns the non-interactive doctor budget off)`);
    process.exit(1);
  }
  cfg.doctor = { ...(cfg.doctor ?? {}), default_budget_ms: n };
  saveConfig(cfg);
  console.log(`Set ${DEFAULT_BUDGET_KEY} = ${n} (file plane: ~/.gbrain/config.json; --budget-ms overrides it for one run)`);
}
