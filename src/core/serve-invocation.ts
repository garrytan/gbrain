/**
 * #5079: is this process `serve --http`, whose stdout/stderr are log streams
 * only (the MCP transport is the HTTP socket)? cli.ts installs the cleanup
 * handlers through installCleanupSignalHandlers below, before main(). Kept
 * out of cli-force-exit.ts, which most commands import: the CLI flag-registry
 * generator harvests flag literals from imported modules, so the literal here
 * would widen their accepted flags.
 */
import { parseGlobalFlags } from './cli-options.ts';
import { installSignalHandlers } from './process-cleanup.ts';

export function isHttpServeInvocation(argv: string[] = process.argv.slice(2)): boolean {
  let rest: string[];
  try {
    rest = parseGlobalFlags(argv).rest;
  } catch {
    rest = argv;
  }
  return rest[0] === 'serve' && rest.includes('--http');
}

/** cli.ts entrypoint: the process-cleanup handlers, log-pipe tolerant for `serve --http` only. */
export function installCleanupSignalHandlers(argv: string[] = process.argv.slice(2)): void {
  installSignalHandlers({ keepServingOnLogEpipe: isHttpServeInvocation(argv) });
}
