/**
 * Agent contract v1 (D4): typed CLI values for shared operations, from the
 * op's `ParamDef`. A number flag that is not a finite number, or a string
 * flag outside its declared `enum`, is a usage error (`invalid_params`,
 * exit 2) naming the flag and a valid example, instead of reaching the
 * handler as NaN or an unknown choice. Mirrors the MCP side's
 * `validateParams` (types + enums) for the CLI parser.
 */
import { inertText } from '../core/agent-output.ts';
import type { Operation, ParamDef } from '../core/ops/contract.ts';
import { usageError } from './cli-error.ts';

/** Coerce one raw CLI token for `op.params[key]`; `positional` labels a positional slot instead of a flag. */
export function opParamValue(op: Operation, key: string, def: ParamDef | undefined, raw: string, positional = false): unknown {
  if (!def) return raw;
  const name = positional ? `<${key}>` : `--${key.replace(/_/g, '-')}`;
  const usage = `gbrain ${op.cliHints?.name ?? op.name}`;
  if (def.type === 'number') {
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n)) return n;
    const example = typeof def.default === 'number' ? def.default : 10;
    throw usageError(`${name} must be a number; got '${inertText(raw, 40)}'.`,
      `Pass a number, e.g. ${usage} ${positional ? example : `${name} ${example}`}.`);
  }
  if (def.type === 'string' && def.enum && !def.enum.includes(raw)) {
    throw usageError(`${name} must be one of: ${def.enum.join(', ')}; got '${inertText(raw, 40)}'.`,
      `Pass one of the declared values, e.g. ${usage} ${positional ? def.enum[0] : `${name} ${def.enum[0]}`}.`);
  }
  return raw;
}
