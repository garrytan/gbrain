/**
 * A small JSON Schema (2020-12 subset) checker for the checked-in contract
 * schemas under docs/schemas/: type (with null unions), const, enum,
 * properties, required, additionalProperties (false or a schema), items,
 * min/maxItems, min/maxLength, pattern, minimum/maximum, anyOf and local
 * $ref (#/$defs/...). Unknown keywords other than annotations fail loudly,
 * so a schema cannot silently rely on something this checker skips.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Schema = Record<string, unknown>;
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'default', '$defs']);
const KNOWN = new Set([...ANNOTATIONS, 'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'anyOf', '$ref']);

export function loadSchema(name: string): Schema {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'docs', 'schemas', `${name}.json`), 'utf8')) as Schema;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Every violation as "path: message"; [] when the value conforms. */
export function validate(root: Schema, value: unknown): string[] {
  const errors: string[] = [];
  const walk = (s: Schema, v: unknown, path: string): void => {
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`json-schema-lite: unsupported keyword ${k} at ${path}`);
    if (typeof s.$ref === 'string') {
      const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
      if (!m) throw new Error(`json-schema-lite: unsupported $ref ${s.$ref}`);
      walk((root.$defs as Record<string, Schema>)[m[1]!]!, v, path);
    }
    if (s.anyOf) {
      const ok = (s.anyOf as Schema[]).some(alt => { const before = errors.length; walk(alt, v, path); const pass = errors.length === before; errors.length = before; return pass; });
      if (!ok) errors.push(`${path}: matches no anyOf branch`);
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type as string[] : [s.type as string];
      const t = typeOf(v);
      if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) { errors.push(`${path}: expected ${types.join('|')}, got ${t}`); return; }
    }
    if ('const' in s && JSON.stringify(v) !== JSON.stringify(s.const)) errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
    if (s.enum && !(s.enum as unknown[]).some(e => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${path}: ${JSON.stringify(v)} not in enum`);
    if (typeof v === 'string') {
      if (typeof s.minLength === 'number' && [...v].length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
      if (typeof s.maxLength === 'number' && [...v].length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`);
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${path}: does not match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) errors.push(`${path}: below ${s.minimum}`);
      if (typeof s.maximum === 'number' && v > s.maximum) errors.push(`${path}: above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
      if (s.items) v.forEach((x, i) => walk(s.items as Schema, x, `${path}[${i}]`));
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const r of (s.required as string[] | undefined) ?? []) if (!(r in o)) errors.push(`${path}: missing ${r}`);
      const props = (s.properties as Record<string, Schema> | undefined) ?? {};
      for (const [k, x] of Object.entries(o)) {
        if (props[k]) walk(props[k]!, x, `${path}.${k}`);
        else if (s.additionalProperties === false) errors.push(`${path}: unexpected property ${k}`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties as Schema, x, `${path}.${k}`);
      }
    }
  };
  walk(root, value, '$');
  return errors;
}
