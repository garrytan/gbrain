/**
 * GST-2476 G2: prints the enforced member classification (every CLI command and operation-backed command, with the
 * subcommands whose class differs) as a Markdown table. Usage: bun scripts/enforced-member-table.ts
 */
import { OPERATION_MANIFEST } from '../src/cli/op-manifest.ts';
import { CLI_COMMANDS } from '../src/cli/command-table.ts';
import { OPERATION_CLASSES, CLI_COMMAND_CLASSES, OPERATION_SUBCOMMANDS, type EnforcedClass, type EnforcedSubcommands } from '../src/cli/enforced-member-classes.ts';

const rows = new Map<string, EnforcedClass | 'UNCLASSIFIED'>();
const add = (name: string, spec: EnforcedClass | EnforcedSubcommands | undefined) => {
  if (spec === undefined) { rows.set(name, 'UNCLASSIFIED'); return; }
  if (typeof spec === 'string') { rows.set(name, spec); return; }
  rows.set(name, spec.default);
  for (const [sub, cls] of Object.entries(spec.sub)) rows.set(name + ' ' + sub, cls);
};
for (const c of CLI_COMMANDS) add(c.name, CLI_COMMAND_CLASSES[c.name]);
const cliOnly = new Set(CLI_COMMANDS.map(c => c.name));
for (const op of OPERATION_MANIFEST) {
  if (op.cliHints?.hidden) continue;
  const cls = OPERATION_CLASSES[op.name];
  for (const name of [op.cliHints?.name ?? op.name, ...(op.cliHints?.aliases ?? [])]) {
    if (cliOnly.has(name) || rows.has(name)) continue;
    const sub = OPERATION_SUBCOMMANDS[name];
    add(name, cls === undefined ? undefined : sub && cls !== 'refused' ? sub : cls);
  }
}
const sorted = [...rows].sort(([a], [b]) => a.localeCompare(b));
const count = (c: string) => sorted.filter(([, v]) => v === c).length;
console.log('Commands: ' + sorted.length + ' (read ' + count('read') + ', write ' + count('write') + ', allowed ' + count('allowed') + ', silent ' + count('silent') + ', refused ' + count('refused') + ', unclassified ' + count('UNCLASSIFIED') + '; anything unclassified is refused).\n');
console.log('| Command | Class |\n|---|---|');
for (const [name, cls] of sorted) console.log('| ' + name + ' | ' + cls + ' |');
