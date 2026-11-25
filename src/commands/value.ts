/**
 * `gbrain value [--json]`: the value card (roadmap PR 3, core in src/core/value/card.ts, text in
 * src/core/value/format.ts): what this brain holds and has done, each row measured, off or unavailable. Trusted local
 * CLI only in phase 1: there is no MCP operation and a thin client refuses the command (src/cli/command-table.ts).
 * Every count failing is the registered value_unavailable error, which the CLI prints and exits non-zero on.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { CliDispatchContext } from '../cli/command-table.ts';
import { endSlowRead } from '../core/read-heartbeat.ts';

const VALUE_HELP = `Usage: gbrain value [--json]

What your brain holds and has done for you, as counts: conversations archived, pages by kind, links, facts kept,
lookups served, pages brought up on their own and later retrieved, nightly items and the brain score. Each row is
measured, off (with the command that turns it on) or unavailable (with a code and cause). Reads only; stamps nothing.
Runs on the brain host only: it is not an MCP tool, and a thin client refuses it.

  --json   Print the card as one JSON document (schema gbrain.value, schema_version 1).

Examples:
  gbrain value
  gbrain value --json
`;

export async function runValue(engine: BrainEngine, args: string[], makeContext: NonNullable<CliDispatchContext['makeContext']>): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(VALUE_HELP); return; }
  const { buildValueCard } = await import('../core/value/card.ts');
  const card = await buildValueCard(await makeContext(engine, {}));
  endSlowRead();
  if (args.includes('--json')) {
    const { writeJsonDocument } = await import('../core/cli-force-exit.ts');
    await writeJsonDocument(JSON.stringify(card, null, 2));
    return;
  }
  const { formatValueCard } = await import('../core/value/format.ts');
  process.stdout.write(formatValueCard(card));
}
