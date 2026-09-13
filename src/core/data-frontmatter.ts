import { safeLoad, safeDump } from 'js-yaml';

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
    value = block.trim() === '' ? {} : language === 'json' ? JSON.parse(block) : safeLoad(block);
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
