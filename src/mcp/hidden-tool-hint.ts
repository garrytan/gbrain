/**
 * F6: the hidden-tool hint on the owner's stdio pipe. A stdio caller that
 * names a real tool outside this server's surface (or its read-only access)
 * learns that the tool exists, its CLI equivalent, and how to widen the
 * surface. The stdio pipe is the brain owner's own process, so this is not
 * an existence oracle; HTTP keeps the opaque unknown_tool envelope.
 */
import type { Action } from '../core/agent-output.ts';
import type { Operation } from '../core/operations.ts';
import { cliEquivalent } from '../core/ops/cli-equivalent.ts';

export function hiddenToolHint(op: Operation | undefined, opts: { transport?: string; remote?: boolean; surface?: string; allowedOps?: ReadonlySet<string> }):
  { suggestion: string; fix: Action } | null {
  if (!op || op.localOnly || opts.transport !== 'stdio' || opts.remote === false || !opts.allowedOps || opts.allowedOps.has(op.name)) return null;
  const name = op.name;
  const argv = cliEquivalent(op);
  const surface = opts.surface ?? 'full';
  const why = surface === 'full'
    ? `${name} exists, but this server is read-only (access read-only), so it is not listed.`
    : `${name} exists, but this server runs the ${surface} tool surface, which does not include it. Its CLI equivalent does the same on the brain host; to call it here, set GBRAIN_SURFACE=full for this machine's gbrain server and start a new session.`;
  return {
    suggestion: `${why} CLI equivalent: \`${argv.join(' ')}\`.`,
    fix: { argv, consent: [], actor: 'agent', requires_exclusive: false, why,
      ...(argv.includes('<params_json>') ? { inputs: [{ name: 'params_json', how: `The arguments you passed to ${name}, as one JSON object.` }] } : {}) },
  };
}
