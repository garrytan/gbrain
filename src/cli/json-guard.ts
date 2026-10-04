/**
 * Agent contract v1 (D2): which `--json` guard mode this invocation runs
 * under. The guard is on only for commands whose command-table record
 * declares `json` (or, for a record whose subcommands differ in shape,
 * `jsonSubcommands[<first positional after the command>]`); they write their
 * result through writeStdoutFinal / writeNdjsonLine, so undeclared commands
 * keep their current stdout. Also wires the E11 `json_document_missing`
 * record for the exit-0 bug case.
 */
import { jsonRequested, setJsonDocumentMissingHook } from '../core/cli-force-exit.ts';
import { recordAgentContractEvent } from '../core/agent-contract-log.ts';
import { findCliCommand } from './command-table.ts';

export function agentJsonGuardMode(argv: readonly string[]): { json?: 'document' | 'ndjson' } {
  const at = argv.findIndex(a => !a.startsWith('-') && findCliCommand(a) !== undefined);
  const command = at >= 0 ? argv[at] : undefined;
  const record = command ? findCliCommand(command) : undefined;
  const sub = argv.slice(at + 1).find(a => !a.startsWith('-'));
  const subs = record?.jsonSubcommands;
  const json = record?.json ?? (sub !== undefined && subs && Object.hasOwn(subs, sub) ? subs[sub] : undefined);
  if (!json || !jsonRequested(argv)) return {};
  setJsonDocumentMissingHook(() => recordAgentContractEvent({ transport: 'cli', command, code: 'json_document_missing', outcome: 'committed' }));
  return { json };
}
