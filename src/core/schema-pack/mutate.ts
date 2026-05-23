// Schema cathedral v2 — pack mutation primitives.
//
// `gbrain schema add-type` and `gbrain schema remove-type` are the
// authoring verbs that close the loop on `init`/`fork`: once a pack
// exists, the operator needs first-class commands to add and remove
// page_type entries without hand-editing YAML/JSON and risking shape
// drift. These helpers:
//
//   1. Locate the active pack (or a named pack) on disk.
//   2. Read it preserving format (pack.json | pack.yaml | pack.yml).
//   3. Mutate the page_types list (add or remove by name).
//   4. Validate the resulting manifest BEFORE writing — the pack file
//      on disk is never left in a broken state.
//   5. Write back in the original format.
//
// Bundled packs (gbrain-base, gbrain-recommended) are read-only by
// design: their manifests are generated source and live inside the
// distributed module. Attempting to mutate them throws explicitly so
// downstream packagers don't accidentally clobber the source tree.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  loadPackFromFile,
  parseSchemaPackManifest,
  parseYamlMini,
  type PackPrimitive,
  type SchemaPackManifest,
} from './index.ts';
import { gbrainPath } from '../config.ts';
import { PACK_PRIMITIVES } from './manifest-v1.ts';

export type PackFileFormat = 'json' | 'yaml';

export interface AddTypeOpts {
  /** Type name to register on the pack. Required, must be unique. */
  name: string;
  /** Composable primitive backing the type. Must be one of PACK_PRIMITIVES. */
  primitive: PackPrimitive;
  /** Path prefix the type binds to (e.g. "media/photos/"). */
  prefix: string;
  /** Mark the type as eligible for facts extraction. */
  extractable?: boolean;
  /** Route the type through expert / whoknows queries. */
  expertRouting?: boolean;
  /** Optional alias list driving query closure. */
  aliases?: string[];
}

export interface RemoveTypeOpts {
  /** Type name to remove. Must already exist in the pack. */
  name: string;
}

export interface MutateResult {
  /** Disk path of the pack file that was mutated. */
  path: string;
  /** Pack name (from the manifest). */
  pack: string;
  /** Format the file was rewritten in. */
  format: PackFileFormat;
  /** Type name that was added or removed. */
  type: string;
}

export class SchemaPackMutationError extends Error {
  readonly code:
    | 'PACK_NOT_FOUND'
    | 'PACK_READONLY'
    | 'TYPE_EXISTS'
    | 'TYPE_NOT_FOUND'
    | 'INVALID_PRIMITIVE'
    | 'INVALID_RESULT';
  constructor(
    code: SchemaPackMutationError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'SchemaPackMutationError';
    this.code = code;
  }
}

const BUNDLED_PACK_NAMES = new Set(['gbrain-base', 'gbrain-recommended']);

/**
 * Locate a user-mutable pack file. Bundled packs are explicitly refused —
 * they live inside the installed module and edits would be lost on
 * upgrade. User packs live under ~/.gbrain/schema-packs/<name>/.
 */
export function locateMutablePackFile(name: string): { path: string; format: PackFileFormat } {
  if (BUNDLED_PACK_NAMES.has(name)) {
    throw new SchemaPackMutationError(
      'PACK_READONLY',
      `Pack '${name}' is bundled and read-only. Use 'gbrain schema fork ${name} <new-name>' to create a writable copy.`,
    );
  }
  const baseDir = gbrainPath('schema-packs', name);
  const candidates: Array<{ file: string; format: PackFileFormat }> = [
    { file: 'pack.json', format: 'json' },
    { file: 'pack.yaml', format: 'yaml' },
    { file: 'pack.yml', format: 'yaml' },
  ];
  for (const c of candidates) {
    const p = join(baseDir, c.file);
    if (existsSync(p)) return { path: p, format: c.format };
  }
  throw new SchemaPackMutationError(
    'PACK_NOT_FOUND',
    `No pack file at ${baseDir}. Run 'gbrain schema init ${name}' or 'gbrain schema fork <source> ${name}' first.`,
  );
}

/**
 * Format-preserving read of a pack file. Returns the manifest and the
 * detected file format so the writer can round-trip without coercion.
 */
export function readPackForMutation(path: string): { manifest: SchemaPackManifest; format: PackFileFormat } {
  if (!existsSync(path)) {
    throw new SchemaPackMutationError('PACK_NOT_FOUND', `pack file not found: ${path}`);
  }
  const ext = extname(path).toLowerCase();
  const format: PackFileFormat = ext === '.json' ? 'json' : 'yaml';
  const manifest = loadPackFromFile(path);
  return { manifest, format };
}

/**
 * Write a manifest back to disk in the requested format.
 *
 * Round-trip note: JSON is round-trip safe; the YAML mini-parser does
 * not preserve comments or formatting. We emit a canonical YAML shape
 * via JSON-to-YAML normalization so the file remains valid input to
 * `parseYamlMini`. Authors who care about layout should pin pack.json.
 */
export function writePackManifest(
  path: string,
  manifest: SchemaPackManifest,
  format: PackFileFormat,
): void {
  // Always validate before writing — the file on disk must parse.
  parseSchemaPackManifest(manifest, { path });
  // Confirm YAML round-trip too if we're emitting YAML, by serializing
  // and re-parsing through the mini-parser. Belt-and-suspenders.
  if (format === 'yaml') {
    const yaml = manifestToYaml(manifest);
    const reparsed = parseYamlMini(yaml);
    parseSchemaPackManifest(reparsed, { path });
    writeFileSync(path, yaml, 'utf-8');
    return;
  }
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

/**
 * Add a page_type to a pack. Validates the new manifest before
 * committing. Throws SchemaPackMutationError on duplicate names,
 * unknown primitives, or shape violations.
 */
export function addTypeToPack(packName: string, opts: AddTypeOpts): MutateResult {
  if (!opts.name || !/^[a-z0-9._-]+$/i.test(opts.name)) {
    throw new SchemaPackMutationError(
      'INVALID_RESULT',
      `type name must be a non-empty slug-shape string (got: ${JSON.stringify(opts.name)})`,
    );
  }
  if (!PACK_PRIMITIVES.includes(opts.primitive)) {
    throw new SchemaPackMutationError(
      'INVALID_PRIMITIVE',
      `primitive must be one of ${PACK_PRIMITIVES.join('|')} (got: ${opts.primitive})`,
    );
  }
  if (!opts.prefix) {
    throw new SchemaPackMutationError(
      'INVALID_RESULT',
      `--prefix is required (e.g. --prefix media/photos/)`,
    );
  }
  const { path, format } = locateMutablePackFile(packName);
  const { manifest } = readPackForMutation(path);
  if (manifest.page_types.some((t) => t.name === opts.name)) {
    throw new SchemaPackMutationError(
      'TYPE_EXISTS',
      `type '${opts.name}' already exists in pack '${packName}'. Use 'gbrain schema remove-type ${opts.name}' first.`,
    );
  }
  const next: SchemaPackManifest = {
    ...manifest,
    page_types: [
      ...manifest.page_types,
      {
        name: opts.name,
        primitive: opts.primitive,
        path_prefixes: [opts.prefix],
        aliases: opts.aliases ?? [],
        extractable: opts.extractable ?? false,
        expert_routing: opts.expertRouting ?? false,
      },
    ],
  };
  writePackManifest(path, next, format);
  return { path, pack: manifest.name, format, type: opts.name };
}

/**
 * Remove a page_type from a pack. Throws if the type isn't present.
 */
export function removeTypeFromPack(packName: string, opts: RemoveTypeOpts): MutateResult {
  const { path, format } = locateMutablePackFile(packName);
  const { manifest } = readPackForMutation(path);
  const idx = manifest.page_types.findIndex((t) => t.name === opts.name);
  if (idx < 0) {
    const known = manifest.page_types.map((t) => t.name).join(', ') || '<none>';
    throw new SchemaPackMutationError(
      'TYPE_NOT_FOUND',
      `type '${opts.name}' not found in pack '${packName}'. Known types: ${known}`,
    );
  }
  const next: SchemaPackManifest = {
    ...manifest,
    page_types: manifest.page_types.filter((_, i) => i !== idx),
  };
  writePackManifest(path, next, format);
  return { path, pack: manifest.name, format, type: opts.name };
}

// ---------------------------------------------------------------
// YAML emitter for the manifest subset our mini-parser accepts.
// ---------------------------------------------------------------
//
// The mini-parser in loader.ts handles scalars, lists of scalars, lists
// of maps, and nested maps. We emit only those shapes. Strings are
// quoted defensively when they contain reserved chars (colon, hash,
// brackets, leading dash, etc.); otherwise emitted bare.

function manifestToYaml(m: SchemaPackManifest): string {
  const out: string[] = [];
  out.push(`api_version: ${m.api_version}`);
  out.push(`name: ${m.name}`);
  out.push(`version: ${m.version}`);
  if (m.gbrain_min_version) out.push(`gbrain_min_version: ${m.gbrain_min_version}`);
  out.push(`extends: ${m.extends ?? 'null'}`);
  if (m.description) out.push(`description: ${quoteScalar(m.description)}`);

  out.push('');
  out.push('takes_kinds:');
  if (!m.takes_kinds || m.takes_kinds.length === 0) {
    // Trailing empty list — represent as flow.
    out[out.length - 1] = 'takes_kinds: []';
  } else {
    for (const k of m.takes_kinds) out.push(`  - ${k}`);
  }

  out.push('');
  out.push('borrow_from:');
  if (!m.borrow_from || m.borrow_from.length === 0) {
    out[out.length - 1] = 'borrow_from: []';
  } else {
    for (const b of m.borrow_from) {
      out.push(`  - pack: ${b.pack}`);
      if (b.types && b.types.length) {
        out.push('    types:');
        for (const t of b.types) out.push(`      - ${t}`);
      }
    }
  }

  out.push('');
  if (!m.page_types || m.page_types.length === 0) {
    out.push('page_types: []');
  } else {
    out.push('page_types:');
    for (const t of m.page_types) {
      out.push(`  - name: ${t.name}`);
      out.push(`    primitive: ${t.primitive}`);
      out.push('    path_prefixes:');
      if (!t.path_prefixes || t.path_prefixes.length === 0) {
        out[out.length - 1] = '    path_prefixes: []';
      } else {
        for (const p of t.path_prefixes) out.push(`      - ${quoteScalar(p)}`);
      }
      out.push('    aliases:');
      if (!t.aliases || t.aliases.length === 0) {
        out[out.length - 1] = '    aliases: []';
      } else {
        for (const a of t.aliases) out.push(`      - ${a}`);
      }
      out.push(`    extractable: ${t.extractable}`);
      out.push(`    expert_routing: ${t.expert_routing}`);
    }
  }

  out.push('');
  if (!m.link_types || m.link_types.length === 0) {
    out.push('link_types: []');
  } else {
    out.push('link_types:');
    for (const l of m.link_types) {
      out.push(`  - name: ${l.name}`);
      if (l.inverse) out.push(`    inverse: ${l.inverse}`);
      if (l.inference) {
        out.push('    inference:');
        if (l.inference.regex) out.push(`      regex: ${quoteScalar(l.inference.regex)}`);
        if (l.inference.page_type) out.push(`      page_type: ${l.inference.page_type}`);
        if (l.inference.target_type) out.push(`      target_type: ${l.inference.target_type}`);
      }
    }
  }

  out.push('');
  if (!m.frontmatter_links || m.frontmatter_links.length === 0) {
    out.push('frontmatter_links: []');
  } else {
    out.push('frontmatter_links:');
    for (const f of m.frontmatter_links) {
      out.push(`  - page_type: ${f.page_type}`);
      out.push(`    link_type: ${f.link_type}`);
      out.push('    fields:');
      for (const fld of f.fields) out.push(`      - ${fld}`);
    }
  }

  out.push('');
  if (!m.enrichable_types || m.enrichable_types.length === 0) {
    out.push('enrichable_types: []');
  } else {
    out.push('enrichable_types:');
    for (const e of m.enrichable_types) {
      out.push(`  - type: ${e.type}`);
      if (e.rubric) out.push(`    rubric: ${e.rubric}`);
    }
  }

  out.push('');
  if (!m.filing_rules || m.filing_rules.length === 0) {
    out.push('filing_rules: []');
  } else {
    out.push('filing_rules:');
    for (const r of m.filing_rules) {
      out.push(`  - kind: ${r.kind}`);
      out.push(`    directory: ${quoteScalar(r.directory)}`);
      if (r.description) out.push(`    description: ${quoteScalar(r.description)}`);
      if (r.examples && r.examples.length) {
        out.push('    examples:');
        for (const ex of r.examples) out.push(`      - ${quoteScalar(ex)}`);
      } else {
        out.push('    examples: []');
      }
    }
  }

  return out.join('\n') + '\n';
}

function quoteScalar(s: string): string {
  if (s === '') return '""';
  // Quote if string contains characters the mini-parser treats specially
  // at scalar boundaries, or could be confused with a literal.
  if (/^[\s'"\-\[\]{}#,&*!|>%@`]/.test(s) || /[:#]/.test(s)) {
    return JSON.stringify(s);
  }
  // Quote if it looks like a number, bool, or null so the parser doesn't
  // coerce it.
  if (/^(true|false|null|~|-?\d+(?:\.\d+)?)$/i.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}
