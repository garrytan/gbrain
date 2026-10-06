import { load, dump, Type, DEFAULT_SCHEMA } from 'js-yaml';
import { NAIVE_DATETIME } from './effective-date.ts';

// js-yaml's timestamp type builds `2024-02-30` as March 1 (Date.UTC rolls the
// day over). A calendar-invalid timestamp stays the string the author wrote,
// so date consumers reject it instead of storing the wrong day.
type TimestampBehavior = { resolve(data: string): boolean; construct(data: string): Date; represent(data: object): string };
const baseTimestamp = (DEFAULT_SCHEMA as unknown as { compiledTypeMap: { scalar: Record<string, TimestampBehavior> } })
  .compiledTypeMap.scalar['tag:yaml.org,2002:timestamp']!;
const calendarTimestamp = new Type('tag:yaml.org,2002:timestamp', {
  kind: 'scalar',
  resolve: (data: string) => {
    if (!baseTimestamp.resolve(data)) return false;
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(data);
    if (!m) return true;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  },
  // An offset-less datetime keeps its wall-clock reading for brain.timezone.
  construct: (data: string) => {
    const date = baseTimestamp.construct(data);
    if (/^\d{4}-\d{1,2}-\d{1,2}(?:[Tt]|[ \t]+)\d/.test(data) && !/(?:[Zz]|[+-]\d{1,2}(?::?\d{2})?)\s*$/.test(data)) {
      Object.defineProperty(date, NAIVE_DATETIME, { value: true });
    }
    return date;
  },
  instanceOf: Date,
  represent: baseTimestamp.represent,
});
export const FRONTMATTER_SCHEMA = DEFAULT_SCHEMA.extend({ implicit: [calendarTimestamp] });

export interface DataFrontmatter {
  data: Record<string, unknown>;
  content: string;
  hasFrontmatter: boolean;
}

export class FrontmatterLanguageError extends Error {
  constructor() {
    super('Unsupported frontmatter language; only YAML and JSON are allowed');
    this.name = 'FrontmatterLanguageError';
  }
}

/** Parse data only. There is deliberately no pluggable engine or evaluator. */
export function parseDataFrontmatter(input: string): DataFrontmatter {
  const original = input.replace(/^\uFEFF/, '');
  // Preserve ordinary body whitespace; lift leading blank lines only for a fence.
  const lifted = original.replace(/^(?:[\t ]*\r?\n)+(?=---)/, '');
  const opening = /^---([^\r\n]*)(?:\r?\n|$)/.exec(lifted);
  if (!opening || opening[1]!.startsWith('-') || opening[1]!.trimEnd().endsWith('---')) {
    return { data: {}, content: original, hasFrontmatter: false };
  }
  const language = opening[1]!.trim().toLowerCase();
  if (language !== '' && language !== 'yaml' && language !== 'yml' && language !== 'json') {
    throw new FrontmatterLanguageError();
  }
  const rest = lifted.slice(opening[0].length);
  const closing = /^---[\t ]*(?:\r?\n|$)/m.exec(rest);
  // Match the established parser's missing-close behavior: parse the remaining
  // block and let the higher-level markdown validator report MISSING_CLOSE.
  const block = closing ? rest.slice(0, closing.index) : rest;
  let value: unknown;
  try {
    value = block.trim() === '' ? {} : language === 'json' ? JSON.parse(block) : load(block, { schema: FRONTMATTER_SCHEMA });
  } catch (error) {
    // Parser messages can contain the document itself. Report only location,
    // so request/job diagnostics never copy private frontmatter into logs.
    const line = (error as { mark?: { line?: number } })?.mark?.line;
    throw new Error(`Malformed ${language === 'json' ? 'JSON' : 'YAML'} frontmatter${typeof line === 'number' ? ` at line ${line + 2}` : ''}`);
  }
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('Frontmatter must be a YAML or JSON object');
  }
  return {
    data: (value ?? {}) as Record<string, unknown>,
    content: closing ? rest.slice(closing.index + closing[0].length) : '',
    hasFrontmatter: true,
  };
}

/**
 * YAML dump that refuses `undefined`. js-yaml 4 silently drops an undefined
 * mapping value, so a field a caller meant to write would vanish; a write site
 * omits the key (conditional spread) or writes null instead.
 */
export function dumpFrontmatterYaml(data: unknown, opts: { lineWidth?: number } = {}): string {
  return dump(data, { ...opts, replacer: (key: string, value: unknown) => {
    if (value === undefined) {
      throw new TypeError(`Frontmatter field "${key}" is undefined. Why: YAML has no undefined, so the field would be dropped silently. Fix: omit the key at the write site (\`...(v ? { ${key}: v } : {})\`) or pass null.`);
    }
    return value;
  } });
}

/** Serialize metadata without ever interpreting the body as frontmatter. */
export function stringifyDataFrontmatter(content: string, data: Record<string, unknown>): string {
  const yaml = dumpFrontmatterYaml(data).trim();
  const header = yaml === '{}' ? '' : `---\n${yaml}\n---\n`;
  return header + (content.endsWith('\n') ? content : content + '\n');
}

// Small compatibility surface for callers that parse and serialize together.
// Unlike the removed dependency, stringify never parses its content argument.
export const dataFrontmatter = Object.assign(parseDataFrontmatter, { stringify: stringifyDataFrontmatter });
