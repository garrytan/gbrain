/**
 * Which CLI invocations are slow whole-brain reads, and the start of their heartbeat (core/read-heartbeat.ts).
 * Each command record names its reads with `slowRead` (command-table.ts).
 */
import { findCliCommand, THIN_CLIENT_REFUSED_COMMANDS } from './command-table.ts';
import { isThinClient, loadConfig } from '../core/config.ts';
import { beginSlowRead } from '../core/read-heartbeat.ts';
import { jsonRequested } from '../core/cli-force-exit.ts';
import { getCliOptions } from '../core/cli-options.ts';

/** The value after `flag` (`--source x` or `--source=x`), else undefined. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at >= 0 && args[at + 1] && !args[at + 1]!.startsWith('-')) return args[at + 1];
  return args.find(a => a.startsWith(flag + '='))?.slice(flag.length + 1);
}

/** Starts the heartbeat when `command args` is a slow read this install runs (a thin client refuses or routes the refused ones); returns the function that ends it (a no-op otherwise). */
export function beginCommandRead(command: string, args: readonly string[]): () => void {
  if (args.includes('--help') || args.includes('-h') || getCliOptions().quiet) return () => {};
  const label = findCliCommand(command)?.slowRead?.(args);
  if (!label || THIN_CLIENT_REFUSED_COMMANDS.has(command) && isThinClient(loadConfig())) return () => {};
  return beginSlowRead(label, { json: jsonRequested(args) });
}
