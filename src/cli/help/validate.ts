/**
 * Agent contract v1 (D4, CLI-only half): typed flag values from the curated
 * help spec (D3). For a command with a help module, a `number` flag whose
 * value is missing or not numeric, or an `enum` flag whose value is not one of
 * its `values`, is a usage error (`invalid_params`, exit 2) naming the flag,
 * the bad value and a valid example. Accepts `--flag value` and
 * `--flag=value`; scanning stops at a bare `--`. Unknown flags stay the
 * acceptance registry's job (src/core/cli-flag-registry.generated.ts).
 */
import type { OperationError } from '../../core/ops/contract.ts';
import type { CliHelpFlag, CliHelpSpec } from '../command-table.ts';
import { flagValueError } from '../flag-values.ts';
import { loadCuratedHelp } from './render.ts';

/** A value for `flag` taken from the spec's examples, else a placeholder. */
function exampleValue(spec: CliHelpSpec, flag: CliHelpFlag): string {
  if (flag.values?.length) return flag.values[0]!;
  for (const example of spec.examples) {
    const tokens = example.split(/\s+/);
    const at = tokens.indexOf(flag.name);
    if (at >= 0 && tokens[at + 1] && !tokens[at + 1]!.startsWith('-')) return tokens[at + 1]!;
    const inline = tokens.find(t => t.startsWith(`${flag.name}=`));
    if (inline) return inline.slice(flag.name.length + 1);
  }
  return '<n>';
}

function valueOk(flag: CliHelpFlag, raw: string): boolean {
  if (flag.type === 'enum') return flag.values?.includes(raw) === true;
  return raw.trim() !== '' && Number.isFinite(Number(raw));
}

export async function curatedFlagError(command: string, args: readonly string[]): Promise<OperationError | null> {
  const spec = await loadCuratedHelp(command);
  if (!spec) return null;
  const typed = new Map(spec.flags.filter(f => f.type === 'number' || f.type === 'enum').map(f => [f.name, f]));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;
    const eq = arg.indexOf('=');
    const flag = typed.get(eq > 0 ? arg.slice(0, eq) : arg);
    if (!flag) continue;
    const raw = eq > 0 ? arg.slice(eq + 1) : args[i + 1];
    if (eq < 0 && raw !== undefined && !raw.startsWith('--')) i++;
    if (raw !== undefined && !raw.startsWith('--') && valueOk(flag, raw)) continue;
    const accepts = flag.type === 'enum' ? `one of ${flag.values!.join('|')}` : 'a number';
    return flagValueError(flag.name, raw, accepts, exampleValue(spec, flag));
  }
  return null;
}
