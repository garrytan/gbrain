/**
 * Agent contract v1 (D4): typed CLI values for shared operations, from the
 * op's `ParamDef`. A number flag that is not a finite number, or a string
 * flag outside its declared `enum`, is a usage error (`invalid_params`,
 * exit 2) naming the flag and a valid example, instead of reaching the
 * handler as NaN or an unknown choice. Mirrors the MCP side's
 * `validateParams` (types + enums) for the CLI parser.
 */
import { inertText } from '../core/agent-output.ts';
import type { OperationMeta, ParamDef } from '../core/ops/contract.ts';
import { usageError } from './cli-error.ts';

/** Coerce one raw CLI token for `op.params[key]`; `positional` labels a positional slot instead of a flag. */
export function opParamValue(op: OperationMeta, key: string, def: ParamDef | undefined, raw: string, positional = false): unknown {
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

/**
 * The value for one `--flag value` token. A `cliKeyValue` object param
 * (`--where key=value`) collects every repetition into a list that
 * `opStructuredValue` turns into the object; every other flag is one value.
 */
export function opFlagValue(op: OperationMeta, key: string, def: ParamDef | undefined, raw: string, prev: unknown): unknown {
  if (def?.cliKeyValue) return [...(Array.isArray(prev) ? prev : []), raw];
  return opParamValue(op, key, def, raw);
}

/**
 * An object/array param from its CLI text: JSON, or for a string-item array
 * a comma list (`--types person,company`), for a `cliKeyValue` object
 * repeated `key=value` pairs, where `key=a,b` is a list and a repeated key
 * merges, or for a `cliRange` window `N-M` (inclusive) or `N`. Other values pass through.
 */
export function opStructuredValue(key: string, def: ParamDef, value: unknown): unknown {
  const flag = `--${key.replace(/_/g, '-')}`;
  if (def.cliKeyValue && Array.isArray(value) && !(value.length === 1 && String(value[0]).trimStart().startsWith('{'))) {
    const out: Record<string, string | string[]> = {};
    for (const pair of value as string[]) {
      const eq = pair.indexOf('=');
      const name = eq > 0 ? pair.slice(0, eq).trim() : '';
      if (!name) {
        throw usageError(`${flag} takes key=value; got '${inertText(pair, 40)}'.`,
          `Pass ${flag} key=value, repeated for more keys (all must match), e.g. ${flag} status=active ${flag} stage=seed,series-a.`);
      }
      const values = [...[out[name] ?? []].flat(), ...pair.slice(eq + 1).split(',').map(v => v.trim())];
      out[name] = values.length === 1 ? values[0]! : values;
    }
    return out;
  }
  const text = def.cliKeyValue && Array.isArray(value) ? value[0] : value;
  if ((def.type !== 'object' && def.type !== 'array') || typeof text !== 'string') return value;
  const range = def.cliRange && /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(text);
  if (def.cliRange && range) {
    const start = Number(range[1]), end = range[2] === undefined ? start : Number(range[2]);
    if (end < start) throw usageError(`${flag} ${inertText(text, 40)} ends before it starts.`, `Pass ${flag} N-M with N <= M, e.g. ${flag} 100-140.`);
    return { [def.cliRange[0]]: start, [def.cliRange[1]]: end - start + 1 };
  }
  if (def.type === 'array' && def.items?.type === 'string' && !text.trimStart().startsWith('[')) return text.split(',').map(v => v.trim()).filter(Boolean);
  const jsonError = () => def.cliRange
    ? usageError(`${flag} takes a range N-M (inclusive) or N, or a JSON object.`, `Pass ${flag} 100-140, or ${flag} '{"${def.cliRange[0]}":100,"${def.cliRange[1]}":41}'.`)
    : usageError(`${flag} requires a JSON ${def.type}.`, `Pass JSON, e.g. ${flag} '${def.type === 'array' ? '["a","b"]' : '{"key":"value"}'}'.`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw jsonError(); }
  if (def.type === 'array' ? !Array.isArray(parsed) : parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw jsonError();
  return parsed;
}
