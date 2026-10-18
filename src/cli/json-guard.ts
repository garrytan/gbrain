/**
 * Agent contract v1 (D2): which `--json` guard mode this invocation runs
 * under. The guard is on only for commands whose command-table record
 * declares `json` (or, for a record whose subcommands differ in shape,
 * `jsonSubcommands[<first positional after the command>]`); they write their
 * result through writeStdoutFinal / writeNdjsonLine, so undeclared commands
 * keep their current stdout. Also wires the E11 `json_document_missing`
 * record for the exit-0 bug case (document mode only), stamped with the
 * gbrain version, the guard and the exit code (#6629).
 */
import { jsonRequested, setJsonDocumentMissingHook } from '../core/cli-force-exit.ts';
import { recordAgentContractEvent } from '../core/agent-contract-log.ts';
import { findCliCommand } from './command-table.ts';
import { VERSION } from '../version.ts';

export function agentJsonGuardMode(argv: readonly string[]): { json?: 'document' | 'ndjson' } {
  const at = argv.findIndex(a => !a.startsWith('-') && findCliCommand(a) !== undefined);
  const command = at >= 0 ? argv[at] : undefined;
  const record = command ? findCliCommand(command) : undefined;
  const sub = argv.slice(at + 1).find(a => !a.startsWith('-'));
  const subs = record?.jsonSubcommands;
  const json = record?.json ?? (sub !== undefined && subs && Object.hasOwn(subs, sub) ? subs[sub] : undefined);
  if (!json || !jsonRequested(argv)) return {};
  // #6629: which release and guard produced the event; never argv values, paths or output. `outcome` stays as-is (D26).
  setJsonDocumentMissingHook(() => recordAgentContractEvent({ transport: 'cli', command, code: 'json_document_missing', outcome: 'committed',
    version: VERSION, guard: 'document', exit_code: 0 }));
  return { json };
}
