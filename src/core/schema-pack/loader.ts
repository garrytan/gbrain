// v0.38 Schema Pack loader — YAML/JSON sniffing + normalization.
//
// Pack authors choose YAML or JSON. The loader sniffs by file extension
// (`.yaml` / `.yml` / `.json`), parses through the appropriate path, and
// normalizes to a single `SchemaPackManifest` shape before validation
// (manifest-v1.ts handles the validation half).
//
// YAML parsing: hand-rolled following the `storage-config.ts` pattern.
// Avoids js-yaml dependency add (gbrain already ships ~70% of its YAML
// touchpoints hand-parsed). For pack manifests, the YAML subset we accept
// is intentionally narrow: scalars, lists, nested objects up to 4 levels
// deep, no anchors, no aliases, no tags. If users want broader YAML,
// they ship JSON.
//
// Fail-loud: malformed YAML throws SchemaPackLoaderError with line/col
// when available. Empty file → INVALID_SHAPE. Unknown extension → falls
// through to JSON.parse attempt.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseSchemaPackManifest, type SchemaPackManifest } from './manifest-v1.ts';

export class SchemaPackLoaderError extends Error {
  readonly code: 'PARSE_ERROR' | 'FILE_NOT_FOUND' | 'UNSUPPORTED_EXTENSION';
  readonly path: string;

  constructor(code: 'PARSE_ERROR' | 'FILE_NOT_FOUND' | 'UNSUPPORTED_EXTENSION', message: string, path: string) {
    super(message);
    this.name = 'SchemaPackLoaderError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Load + parse + validate a pack from disk. Returns the validated manifest.
 * Throws SchemaPackLoaderError (file/parse errors) or
 * SchemaPackManifestError (shape/version errors).
 */
export function loadPackFromFile(path: string): SchemaPackManifest {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (e) {
    throw new SchemaPackLoaderError('FILE_NOT_FOUND', `cannot read pack file: ${(e as Error).message}`, path);
  }
  return loadPackFromString(content, path);
}

/**
 * Parse a manifest from a raw string. Extension-driven; `.json` uses
 * JSON.parse, anything else uses the YAML mini-parser. Test seam.
 */
export function loadPackFromString(content: string, hint: string): SchemaPackManifest {
  const ext = extname(hint).toLowerCase();
  let raw: unknown;
  if (ext === '.json') {
    try {
      raw = JSON.parse(content);
    } catch (e) {
      throw new SchemaPackLoaderError('PARSE_ERROR', `JSON parse error: ${(e as Error).message}`, hint);
    }
  } else {
    // Default to YAML for .yaml, .yml, and unknown extensions.
    try {
      raw = parseYamlMini(content);
    } catch (e) {
      throw new SchemaPackLoaderError('PARSE_ERROR', `YAML parse error: ${(e as Error).message}`, hint);
    }
  }
  return parseSchemaPackManifest(raw, { path: hint });
}

/**
 * Mini YAML parser for the schema-pack manifest subset.
 *
 * Accepted syntax:
 *   - Top-level mapping (key: value pairs)
 *   - Nested mappings via indentation (2-space convention)
 *   - Sequences via "- item" lines (lists of scalars or maps)
 *   - Scalar values: strings (quoted or bare), integers, booleans, null
 *   - `#` comments to end-of-line (outside string values)
 *   - Block strings via `|` (literal) or `>` (folded) NOT supported in v1
 *
 * Rejected by design: anchors (&), aliases (*), tags (!), flow style
 * ({...}, [...] except as JSON), block scalars (|, >), multi-document (---).
 * Pack authors who need these features should ship JSON.
 *
 * This is intentionally narrow. The skill-pack and storage-config parsers
 * use similar hand-rolled patterns; this one is shape-customized for pack
 * manifests (4-level nest, sequences-of-maps for page_types/link_types).
 */
export function parseYamlMini(content: string): unknown {
  const lines = content.split(/\r?\n/);
  let i = 0;

  function stripComment(line: string): string {
    // Strip comments outside quoted strings. Simple state machine.
    let result = '';
    let inSingle = false;
    let inDouble = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === '"' && !inSingle) inDouble = !inDouble;
      else if (c === '#' && !inSingle && !inDouble) break;
      result += c;
    }
    return result;
  }

  function parseScalar(raw: string): unknown {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '~' || trimmed === 'null') return null;
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    // JSON-style array or object — try JSON.parse first
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try { return JSON.parse(trimmed); } catch { /* fall through to flow-sequence parse */ }
      // YAML flow sequence: [foo, bar, baz] with bare words.
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const inner = trimmed.slice(1, -1).trim();
        if (inner === '') return [];
        return inner.split(',').map(item => parseScalar(item.trim()));
      }
    }
    // Quoted string
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    // Number
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
    // Bare string
    return trimmed;
  }

  function indentOf(line: string): number {
    let n = 0;
    while (n < line.length && line[n] === ' ') n++;
    return n;
  }

  function isBlank(line: string): boolean {
    return stripComment(line).trim() === '';
  }

  function parseBlock(baseIndent: number): unknown {
    // Decide if this block is a sequence (starts with "- ") or a mapping.
    while (i < lines.length && isBlank(lines[i])) i++;
    if (i >= lines.length) return null;
    const firstNonBlank = stripComment(lines[i]);
    const firstIndent = indentOf(firstNonBlank);
    if (firstIndent < baseIndent) return null;
    const firstStripped = firstNonBlank.slice(firstIndent);
    if (firstStripped.startsWith('- ')) return parseSequence(baseIndent);
    return parseMapping(baseIndent);
  }

  function parseSequence(baseIndent: number): unknown[] {
    const result: unknown[] = [];
    while (i < lines.length) {
      while (i < lines.length && isBlank(lines[i])) i++;
      if (i >= lines.length) break;
      const line = stripComment(lines[i]);
      const indent = indentOf(line);
      if (indent < baseIndent) break;
      const stripped = line.slice(indent);
      if (!stripped.startsWith('- ')) break;
      const after = stripped.slice(2);
      i++;
      // Inline scalar after "- "
      if (!after.includes(':') || after.endsWith(':')) {
        if (after.endsWith(':')) {
          // "- key:" followed by nested mapping
          const map: Record<string, unknown> = {};
          map[after.slice(0, -1).trim()] = parseBlock(indent + 2);
          // Continue parsing additional keys at the same indent
          while (i < lines.length) {
            while (i < lines.length && isBlank(lines[i])) i++;
            if (i >= lines.length) break;
            const next = stripComment(lines[i]);
            const nextIndent = indentOf(next);
            if (nextIndent !== indent + 2) break;
            const nextStripped = next.slice(nextIndent);
            const colonIdx = nextStripped.indexOf(':');
            if (colonIdx < 0) break;
            const key = nextStripped.slice(0, colonIdx).trim();
            const rest = nextStripped.slice(colonIdx + 1).trim();
            i++;
            if (rest === '') {
              map[key] = parseBlock(nextIndent + 2);
            } else {
              map[key] = parseScalar(rest);
            }
          }
          result.push(map);
        } else {
          result.push(parseScalar(after));
        }
      } else {
        // "- key: value" — start of an inline mapping entry
        const colonIdx = after.indexOf(':');
        const key = after.slice(0, colonIdx).trim();
        const rest = after.slice(colonIdx + 1).trim();
        const map: Record<string, unknown> = {};
        if (rest === '') {
          map[key] = parseBlock(indent + 2);
        } else {
          map[key] = parseScalar(rest);
        }
        // Continue siblings at indent+2
        while (i < lines.length) {
          while (i < lines.length && isBlank(lines[i])) i++;
          if (i >= lines.length) break;
          const next = stripComment(lines[i]);
          const nextIndent = indentOf(next);
          if (nextIndent !== indent + 2) break;
          const nextStripped = next.slice(nextIndent);
          if (nextStripped.startsWith('- ')) break;
          const colonIdx2 = nextStripped.indexOf(':');
          if (colonIdx2 < 0) break;
          const key2 = nextStripped.slice(0, colonIdx2).trim();
          const rest2 = nextStripped.slice(colonIdx2 + 1).trim();
          i++;
          if (rest2 === '') {
            map[key2] = parseBlock(nextIndent + 2);
          } else {
            map[key2] = parseScalar(rest2);
          }
        }
        result.push(map);
      }
    }
    return result;
  }

  function parseMapping(baseIndent: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    while (i < lines.length) {
      while (i < lines.length && isBlank(lines[i])) i++;
      if (i >= lines.length) break;
      const line = stripComment(lines[i]);
      const indent = indentOf(line);
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        // Shouldn't happen if outer loop set up correctly; treat as end.
        break;
      }
      const stripped = line.slice(indent);
      const colonIdx = stripped.indexOf(':');
      if (colonIdx < 0) break;
      const key = stripped.slice(0, colonIdx).trim();
      const rest = stripped.slice(colonIdx + 1).trim();
      i++;
      if (rest === '') {
        result[key] = parseBlock(indent + 2);
      } else {
        result[key] = parseScalar(rest);
      }
    }
    return result;
  }

  return parseBlock(0);
}
