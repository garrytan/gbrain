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

import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { extname } from 'node:path';
import { parseSchemaPackManifest, type SchemaPackManifest } from './manifest-v1.ts';

export type SchemaPackLoaderErrorCode = 'PARSE_ERROR' | 'FILE_NOT_FOUND' | 'UNSUPPORTED_EXTENSION' | 'PACK_TOO_LARGE';

export class SchemaPackLoaderError extends Error {
  readonly code: SchemaPackLoaderErrorCode;
  readonly path: string;

  constructor(code: SchemaPackLoaderErrorCode, message: string, path: string) {
    super(message);
    this.name = 'SchemaPackLoaderError';
    this.code = code;
    this.path = path;
  }
}

/**
 * The most bytes a pack file may hold (#6432). A hand-written manifest is
 * tens of KB; a mutable pack past this bound is almost certainly the
 * backslash-doubling growth an older release produced, and loading it is
 * what took every CLI process to tens of GB of memory. The bound is read
 * from the file size before any byte is allocated. Override:
 * `GBRAIN_SCHEMA_PACK_MAX_BYTES` (also the doctor warn bound's default).
 */
export const SCHEMA_PACK_MAX_BYTES_DEFAULT = 8 * 1024 * 1024;
export const OVERSIZED_PACK_RUNBOOK = 'docs/architecture/schema-packs.md#oversized-pack';

export function schemaPackMaxBytes(): number {
  const raw = process.env.GBRAIN_SCHEMA_PACK_MAX_BYTES;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SCHEMA_PACK_MAX_BYTES_DEFAULT;
}

export function formatPackBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/**
 * Load + parse + validate a pack from disk. Returns the validated manifest.
 * Throws SchemaPackLoaderError (file/parse/size errors) or
 * SchemaPackManifestError (shape/version errors). The size check runs on
 * the open descriptor before the read, and the read is bounded to that
 * size, so a file that grows under us never allocates past the bound.
 */
export function loadPackFromFile(path: string, opts: { maxBytes?: number } = {}): SchemaPackManifest {
  const maxBytes = opts.maxBytes ?? schemaPackMaxBytes();
  let fd = -1;
  let content: string;
  try {
    try {
      fd = openSync(path, 'r');
    } catch (e) {
      // A pack bundled into a compiled binary lives on Bun's virtual
      // filesystem (`/$bunfs/...`), which serves readFileSync but has no
      // descriptors; the bound is checked on the bytes read instead.
      if (!path.startsWith('/$bunfs/')) throw e;
      const bundled = readFileSync(path);
      if (bundled.byteLength > maxBytes) throw tooLarge(path, bundled.byteLength, maxBytes);
      return loadPackFromString(bundled.toString('utf-8'), path);
    }
    const size = fstatSync(fd).size;
    if (size > maxBytes) throw tooLarge(path, size, maxBytes);
    const buf = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    content = buf.subarray(0, read).toString('utf-8');
  } catch (e) {
    if (e instanceof SchemaPackLoaderError) throw e;
    throw new SchemaPackLoaderError('FILE_NOT_FOUND', `cannot read pack file: ${(e as Error).message}`, path);
  } finally {
    if (fd !== -1) try { closeSync(fd); } catch { /* already closed */ }
  }
  return loadPackFromString(content, path);
}

function tooLarge(path: string, size: number, maxBytes: number): SchemaPackLoaderError {
  return new SchemaPackLoaderError(
    'PACK_TOO_LARGE',
    `pack file ${path} is ${formatPackBytes(size)}, above the ${formatPackBytes(maxBytes)} bound; it was not read. A pack this large is usually a quoted scalar (a link-type regex) whose backslashes an older release doubled on every mutation: open the file in an editor, restore the affected lines by hand, and re-run. Runbook: ${OVERSIZED_PACK_RUNBOOK}.`,
    path,
  );
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
    // Strip comments outside quoted strings. Inside double quotes a
    // backslash escapes the next character (so `\"` and `\\` never toggle
    // the state, #6432); inside single quotes `''` toggles twice and lands
    // back inside, which is the YAML rule.
    let result = '';
    let inSingle = false;
    let inDouble = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (inDouble && c === '\\' && j + 1 < line.length) {
        result += c + line[j + 1];
        j++;
        continue;
      }
      if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === '"' && !inSingle) inDouble = !inDouble;
      else if (c === '#' && !inSingle && !inDouble) break;
      result += c;
    }
    return result;
  }

  /**
   * Decode a quoted scalar (#6432). Double quotes carry the JSON escape
   * subset (`\\ \" \/ \b \f \n \r \t \uXXXX`), which is exactly what the
   * emitter writes; anything else (`\q`, a YAML-only `\x41` or `\e`) is
   * outside the supported subset and refuses naming the line, never a raw
   * slice that would keep the escapes as content. Single quotes hold
   * literal text with `''` for one quote.
   */
  function decodeQuoted(trimmed: string): string {
    if (trimmed.startsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === 'string') return decoded;
    } catch { /* fall through to the declared refusal */ }
    throw new Error(
      `line ${i}: double-quoted scalar ${trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed} is outside the supported escape subset (JSON escapes only: \\\\ \\" \\/ \\b \\f \\n \\r \\t \\uXXXX); use single quotes for literal text or ship JSON`,
    );
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
    if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
      return decodeQuoted(trimmed);
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

  function parseBlockScalar(parentIndent: number, folded: boolean): string {
    const contentIndent = parentIndent + 2;
    const out: string[] = [];
    while (i < lines.length) {
      const raw = lines[i];
      // Inside a block scalar everything is literal content — '#' is NOT a
      // comment here, so use the raw line (no stripComment / isBlank).
      if (raw.trim() === '') {
        out.push('');
        i++;
        continue;
      }
      const indent = indentOf(raw);
      if (indent <= parentIndent) break;
      out.push(raw.slice(Math.min(contentIndent, indent)));
      i++;
    }
    if (folded) {
      return out.join(' ').replace(/\s+$/u, '');
    }
    return out.join('\n').replace(/\n+$/u, '');
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
          } else if (rest2 === '|' || rest2 === '|-' || rest2 === '|+') {
            map[key2] = parseBlockScalar(nextIndent, false);
          } else if (rest2 === '>' || rest2 === '>-' || rest2 === '>+') {
            map[key2] = parseBlockScalar(nextIndent, true);
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
      } else if (rest === '|' || rest === '|-' || rest === '|+') {
        result[key] = parseBlockScalar(indent, false);
      } else if (rest === '>' || rest === '>-' || rest === '>+') {
        result[key] = parseBlockScalar(indent, true);
      } else {
        result[key] = parseScalar(rest);
      }
    }
    return result;
  }

  return parseBlock(0);
}
