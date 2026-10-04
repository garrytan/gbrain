/**
 * Agent contract v1 (D3): `gbrain <cmd> --help` from a command's curated help
 * module (`src/cli/help/<command>.ts`, loaded lazily through the record's
 * `help`). Engine-free: reads the spec and prints; never opens a brain.
 * Human text on stdout; `--help --json` prints the spec as one JSON document.
 */
import { CONTRACT_VERSION } from '../../core/agent-output.ts';
import { jsonRequested, writeJsonDocument } from '../../core/cli-force-exit.ts';
import { findCliCommand, type CliHelpFlag, type CliHelpSpec } from '../command-table.ts';

/** The command's curated help spec, or null when its record has no help module. */
export async function loadCuratedHelp(command: string): Promise<CliHelpSpec | null> {
  const load = findCliCommand(command)?.help;
  return load ? (await load()).help : null;
}

const VALUE_PLACEHOLDER: Record<CliHelpFlag['type'], string> = { boolean: '', string: ' <value>', number: ' <n>', enum: ' <choice>' };

export function renderCuratedHelp(command: string, spec: CliHelpSpec): string {
  const [first, ...rest] = spec.usage.split('\n');
  const lines = [`gbrain ${command}: ${spec.summary}`, '', `Usage: ${first}`, ...rest.map(l => `       ${l}`)];
  if (spec.flags.length > 0) {
    const labels = spec.flags.map(f => `${f.name}${VALUE_PLACEHOLDER[f.type]}`);
    const width = Math.max(...labels.map(l => l.length));
    lines.push('', 'Flags:');
    spec.flags.forEach((f, i) => {
      const values = f.values?.length ? ` One of: ${f.values.join('|')}.` : '';
      const consent = f.consent?.length ? ` [consent: ${f.consent.join(', ')}]` : '';
      lines.push(`  ${labels[i]!.padEnd(width)}  ${f.type.padEnd(7)}  ${f.desc}${values}${consent}`);
    });
  }
  lines.push('', 'Examples:', ...spec.examples.map(e => `  ${e}`));
  if (spec.end_of_options) lines.push('', 'A bare `--` ends options; every later argument is a positional.');
  if (spec.flags.some(f => f.consent?.length)) lines.push('', 'A flag marked [consent: …] authorizes that effect: get the user\'s agreement before passing it.');
  if (spec.flags.some(f => f.name === '--json')) lines.push('', `Machine-readable: gbrain ${command} --help --json`);
  return `${lines.join('\n')}\n`;
}

/** Prints the curated help when the command has one; returns false otherwise. */
export async function printCuratedHelp(command: string, args: readonly string[]): Promise<boolean> {
  const spec = await loadCuratedHelp(command);
  if (!spec) return false;
  if (jsonRequested(args)) await writeJsonDocument(JSON.stringify({ command, ...spec, contract_version: CONTRACT_VERSION }));
  else process.stdout.write(renderCuratedHelp(command, spec));
  return true;
}
