import { safeLoad, safeDump, Schema, Type, DEFAULT_SAFE_SCHEMA } from 'js-yaml';

// js-yaml's timestamp type builds `2024-02-30` as March 1 (Date.UTC rolls the
// day over). A calendar-invalid timestamp stays the string the author wrote,
// so date consumers reject it instead of storing the wrong day.
type TimestampBehavior = { resolve(data: string): boolean; construct(data: string): Date; represent(data: object): string };
const baseTimestamp = (DEFAULT_SAFE_SCHEMA as unknown as { compiledTypeMap: { scalar: Record<string, TimestampBehavior> } })
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
  construct: baseTimestamp.construct,
  instanceOf: Date,
  represent: baseTimestamp.represent,
});
const FRONTMATTER_SCHEMA = new Schema({ include: [DEFAULT_SAFE_SCHEMA], implicit: [calendarTimestamp] });

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
    value = block.trim() === '' ? {} : language === 'json' ? JSON.parse(block) : safeLoad(block, { schema: FRONTMATTER_SCHEMA });
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

/** Serialize metadata without ever interpreting the body as frontmatter. */
export function stringifyDataFrontmatter(content: string, data: Record<string, unknown>): string {
  const yaml = safeDump(data).trim();
  const header = yaml === '{}' ? '' : `---\n${yaml}\n---\n`;
  return header + (content.endsWith('\n') ? content : content + '\n');
}

// Small compatibility surface for callers that parse and serialize together.
// Unlike the removed dependency, stringify never parses its content argument.
export const dataFrontmatter = Object.assign(parseDataFrontmatter, { stringify: stringifyDataFrontmatter });
