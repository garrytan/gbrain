// v0.40.6.0 Schema Cathedral v3 — pack mutation primitives.
//
//                  ┌──────────────────────────────────────────────────────┐
//                  │   withMutation 8-step skeleton (failure-safe order)  │
//                  └──────────────────────────────────────────────────────┘
//       1. BUNDLED guard ──── fail ──→ throw PACK_READONLY ─→ auditFailure
//              │
//              ▼
//       2. withPackLock (atomic O_CREAT|O_EXCL) ─── busy ──→ throw LOCK_BUSY
//              │
//              ▼
//       3. read + parse pack file ─── parse fail ──→ throw PACK_CORRUPT ─→ auditFailure
//              │
//              ▼
//       4. mutator(manifest) → next ─── throw ──→ propagate (lock auto-released)
//              │
//              ▼
//       5. runFilePlaneLintRules(next) ─── invalid ──→ throw INVALID_RESULT ─→ auditFailure
//              │
//              ▼
//       6. writeAtomic .tmp + fsync + rename ─── ENOSPC ──→ throw IO ─→ auditFailure
//              │                                                       (lock auto-released)
//              ▼
//       7. auditSuccess → invalidatePackCache → invalidateQueryCache (best-effort, never throw)
//              │
//              ▼
//       8. lock auto-released by withPackLock finally
//
//       Invariant: pack file on disk is NEVER partial. Either step 6 succeeds
//       (atomic rename) or the original file stays untouched. The .tmp may
//       linger on crash; the next call cleans it up before writing.
//
// Public API: 11 mutation primitives wrapping the skeleton:
//   add_type, remove_type, update_type
//   add_alias, remove_alias, add_prefix, remove_prefix
//   add_link_type, remove_link_type
//   set_extractable, set_expert_routing
//
// All primitives return the same MutateResult shape so MCP's batched
// `schema_apply_mutations` op (Phase 7) can compose them homogeneously.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { gbrainPath } from '../config.ts';
import { computeManifestSha8, parseSchemaPackManifest } from './manifest-v1.ts';
import type {
  PackLinkType,
  PackPageType,
  PackPrimitive,
  SchemaPackManifest,
} from './manifest-v1.ts';
import { PACK_PRIMITIVES } from './manifest-v1.ts';
import { loadPackFromFile, parseYamlMini } from './loader.ts';
import { invalidatePackCache } from './registry.ts';
import { invalidateQueryCache } from './query-cache-invalidator.ts';
import { logMutationFailure, logMutationSuccess, type MutationActor, type MutationOp } from './mutate-audit.ts';
import { runFilePlaneLintRules } from './lint-rules.ts';
import { withPackLock, type PackLockOpts } from './pack-lock.ts';
import type { BrainEngine } from '../engine.ts';

export type PackFileFormat = 'json' | 'yaml';

export class SchemaPackMutationError extends Error {
  readonly code:
    | 'PACK_NOT_FOUND'
    | 'PACK_READONLY'
    | 'PACK_CORRUPT'
    | 'TYPE_EXISTS'
    | 'TYPE_NOT_FOUND'
    | 'INVALID_PRIMITIVE'
    | 'INVALID_RESULT'
    | 'IO_ERROR'
    | 'STILL_REFERENCED';
  readonly details?: Record<string, unknown>;
  constructor(
    code: SchemaPackMutationError['code'],
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SchemaPackMutationError';
    this.code = code;
    this.details = details;
  }
}

export const BUNDLED_PACK_NAMES = new Set(['gbrain-base', 'gbrain-recommended', 'gbrain-base-v2']);

export interface MutateResult {
  /** Pack name that was mutated. */
  pack: string;
  /** Disk path of the pack file. */
  path: string;
  /** Format the file was rewritten in. */
  format: PackFileFormat;
  /** Pack identity sha8 before the mutation. */
  prev_sha8: string;
  /** Pack identity sha8 after the mutation. */
  new_sha8: string;
}

export interface MutateOpts extends PackLockOpts {
  /** Who triggered the mutation (for audit logging). */
  actor?: MutationActor;
  /** Engine for the query-cache invalidation hook. Omit when not connected. */
  engine?: BrainEngine;
  /** Source ID to scope query-cache invalidation. Omit to clear all. */
  sourceId?: string;
  /** Atomic batch id when called from `schema_apply_mutations`. */
  batchId?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Disk layout helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Locate a user-mutable pack file. Bundled packs (gbrain-base,
 * gbrain-recommended) are explicitly refused per D6 — they live inside
 * the installed module and edits would be lost on upgrade.
 */
export function locateMutablePackFile(name: string): { path: string; format: PackFileFormat } {
  if (BUNDLED_PACK_NAMES.has(name)) {
    throw new SchemaPackMutationError(
      'PACK_READONLY',
      `pack '${name}' is bundled and read-only. Use 'gbrain schema fork ${name} <new-name>' to create a writable copy.`,
      { pack: name },
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
    `no pack file at ${baseDir}. Run 'gbrain schema init ${name}' or 'gbrain schema fork <source> ${name}' first.`,
    { pack: name, baseDir },
  );
}

// ────────────────────────────────────────────────────────────────────────
// YAML emitter — minimal but correct for SchemaPackManifest shape.
//
// Covers: top-level mapping, nested mappings, sequences of scalars,
// sequences of nested mappings, scalars (string/number/boolean/null).
// Round-trip: emitted YAML parses back through parseYamlMini.
// Does NOT preserve comments or original formatting (documented in plan).
// ────────────────────────────────────────────────────────────────────────

function emitYaml(value: unknown): string {
  return emitYamlNode(value, 0).trimEnd() + '\n';
}

function emitYamlNode(value: unknown, indent: number): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return emitYamlScalar(value);
  if (Array.isArray(value)) return emitYamlArray(value, indent);
  if (typeof value === 'object') return emitYamlMapping(value as Record<string, unknown>, indent);
  return JSON.stringify(value);
}

function emitYamlScalar(s: string): string {
  // Quote if the string would otherwise be misread (numbers, booleans,
  // null, leading whitespace, contains special YAML chars, or is empty).
  if (s === '') return '""';
  if (/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s)) return JSON.stringify(s);
  if (/[:#&*!|>'"%@`{}\[\],\n]/.test(s)) return JSON.stringify(s);
  if (/^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

function emitYamlArray(arr: unknown[], indent: number): string {
  if (arr.length === 0) return '[]';
  const pad = '  '.repeat(indent);
  // The dash itself sits at indent N. For mapping items, the first key
  // goes inline with the dash (`- key: val`). Subsequent keys live at
  // indent N+1 (2 spaces past the dash). Nested structures keep their
  // own relative depth — DO NOT trimStart/re-prefix or nested arrays
  // collapse (the v0.40.6 emitter bug fixed here).
  const parts: string[] = [];
  for (const item of arr) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      // Emit the mapping at indent N+1, then convert the leading "  "
      // of the FIRST line into "- ". All other lines retain their own
      // indent untouched.
      const inner = emitYamlMapping(item as Record<string, unknown>, indent + 1);
      const innerLines = inner.split('\n');
      const firstPad = '  '.repeat(indent + 1);
      // First line should start with firstPad; replace it with pad + '- '.
      const firstLine = innerLines[0]!;
      if (firstLine.startsWith(firstPad)) {
        parts.push(`${pad}- ${firstLine.slice(firstPad.length)}`);
      } else {
        parts.push(`${pad}- ${firstLine.trimStart()}`);
      }
      for (let j = 1; j < innerLines.length; j++) {
        if (innerLines[j] === '') continue;
        parts.push(innerLines[j]!);
      }
    } else if (Array.isArray(item)) {
      // Nested arrays — rare for manifest shape. Emit inline JSON.
      parts.push(`${pad}- ${JSON.stringify(item)}`);
    } else {
      parts.push(`${pad}- ${emitYamlNode(item, indent + 1)}`);
    }
  }
  return parts.join('\n');
}

function emitYamlMapping(obj: Record<string, unknown>, indent: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const pad = '  '.repeat(indent);
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === null) {
      parts.push(`${pad}${k}: null`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        parts.push(`${pad}${k}: []`);
      } else {
        parts.push(`${pad}${k}:`);
        parts.push(emitYamlArray(v, indent + 1));
      }
    } else if (typeof v === 'object') {
      if (Object.keys(v as Record<string, unknown>).length === 0) {
        parts.push(`${pad}${k}: {}`);
      } else {
        parts.push(`${pad}${k}:`);
        parts.push(emitYamlMapping(v as Record<string, unknown>, indent + 1));
      }
    } else {
      parts.push(`${pad}${k}: ${emitYamlNode(v, indent + 1)}`);
    }
  }
  return parts.join('\n');
}

// ────────────────────────────────────────────────────────────────────────
// Atomic write
// ────────────────────────────────────────────────────────────────────────

/** Write `body` to `path` atomically via .tmp + fsync + rename. */
function writeAtomic(path: string, body: string): void {
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  let fd = -1;
  try {
    fd = openSync(tmpPath, 'w');
    writeSync(fd, body);
    try { fsyncSync(fd); } catch { /* not all FS support fsync; rename is still atomic per POSIX */ }
    closeSync(fd);
    fd = -1;
    renameSync(tmpPath, path);
  } catch (e) {
    if (fd !== -1) {
      try { closeSync(fd); } catch { /* swallow */ }
    }
    try { unlinkSync(tmpPath); } catch { /* swallow */ }
    throw new SchemaPackMutationError(
      'IO_ERROR',
      `atomic write failed for ${path}: ${(e as Error).message}`,
      { path },
    );
  }
}

function writePackManifest(
  path: string,
  manifest: SchemaPackManifest,
  format: PackFileFormat,
): void {
  // Validate the manifest shape BEFORE write so an invalid manifest can never
  // hit disk (the in-memory manifest must round-trip cleanly first).
  parseSchemaPackManifest(manifest, { path });
  if (format === 'yaml') {
    const yaml = emitYaml(manifest);
    // Belt-and-suspenders: re-parse what we're about to write to catch
    // any emitter bugs before the rename.
    const reparsed = parseYamlMini(yaml);
    parseSchemaPackManifest(reparsed, { path });
    writeAtomic(path, yaml);
    return;
  }
  writeAtomic(path, JSON.stringify(manifest, null, 2) + '\n');
}

// ────────────────────────────────────────────────────────────────────────
// withMutation skeleton — the 8-step pipeline above
// ────────────────────────────────────────────────────────────────────────

/**
 * Run a mutator function against a pack with full safety guarantees:
 * atomic write, per-pack lock, audit log, cache + query-cache invalidation.
 *
 * All 11 mutation primitives below wrap this skeleton — they're each
 * ~5 lines that build the transformation function. Adding a new
 * primitive only requires writing the pure transformation.
 *
 * The skeleton is the load-bearing piece for the cathedral's safety
 * contract; the primitives are pure data transformations.
 */
export async function withMutation(
  packName: string,
  opts: MutateOpts,
  mutator: (current: SchemaPackManifest) => SchemaPackManifest,
  op: MutationOp,
  primitiveContext?: { type?: string; prefix?: string },
): Promise<MutateResult> {
  const actor: MutationActor = opts.actor ?? 'cli';
  // Step 1: bundled-pack guard (also surfaces in locateMutablePackFile).
  // Captured up-front so audit logging can fire even before the lock acquire.
  let path: string;
  let format: PackFileFormat;
  try {
    ({ path, format } = locateMutablePackFile(packName));
  } catch (e) {
    if (e instanceof SchemaPackMutationError) {
      await logMutationFailure({
        op, pack: packName, actor, ...primitiveContext, reason: e.code,
      });
    }
    throw e;
  }
  return await withPackLock(packName, opts, async () => {
    let current: SchemaPackManifest;
    let prevSha8: string;
    try {
      // Step 3: read + parse current manifest.
      current = loadPackFromFile(path);
      prevSha8 = await computeManifestSha8(current);
    } catch (e) {
      const err = new SchemaPackMutationError(
        'PACK_CORRUPT',
        `cannot read or parse pack file at ${path}: ${(e as Error).message}`,
        { path },
      );
      await logMutationFailure({ op, pack: packName, actor, ...primitiveContext, reason: err.code });
      throw err;
    }
    let next: SchemaPackManifest;
    try {
      // Step 4: pure mutator.
      next = mutator(current);
    } catch (e) {
      // Re-throw user-facing SchemaPackMutationError as-is; wrap others.
      const wrapped = e instanceof SchemaPackMutationError
        ? e
        : new SchemaPackMutationError('INVALID_RESULT', (e as Error).message);
      await logMutationFailure({ op, pack: packName, actor, ...primitiveContext, reason: wrapped.code });
      throw wrapped;
    }
    // Step 5: validation gate — file-plane lint rules only. DB-aware
    // rules deliberately skip pre-write to keep withMutation hermetic
    // (Phase 9 doctor surfaces DB-aware findings after the fact).
    const lintReport = await runFilePlaneLintRules(next);
    if (!lintReport.ok) {
      const msg = lintReport.errors.map((i) => `${i.rule}: ${i.message}`).join('; ');
      const err = new SchemaPackMutationError('INVALID_RESULT', `mutation would produce invalid pack: ${msg}`, { errors: lintReport.errors });
      await logMutationFailure({ op, pack: packName, actor, ...primitiveContext, reason: err.code });
      throw err;
    }
    let newSha8: string;
    try {
      newSha8 = await computeManifestSha8(next);
      // Step 6: atomic write.
      writePackManifest(path, next, format);
    } catch (e) {
      const err = e instanceof SchemaPackMutationError ? e
        : new SchemaPackMutationError('IO_ERROR', (e as Error).message, { path });
      await logMutationFailure({ op, pack: packName, actor, ...primitiveContext, reason: err.code });
      throw err;
    }
    // Step 7: best-effort post-hooks (must NEVER throw or the audit
    // shows success but the cache stays stale).
    try {
      invalidatePackCache(packName);
    } catch { /* swallow — cache invalidation must not block mutation success */ }
    if (opts.engine) {
      try {
        await invalidateQueryCache(opts.engine, opts.sourceId);
      } catch { /* swallow */ }
    }
    await logMutationSuccess({
      op, pack: packName, actor, ...primitiveContext,
      prev_sha8: prevSha8, new_sha8: newSha8, batch_id: opts.batchId,
    });
    return { pack: packName, path, format, prev_sha8: prevSha8, new_sha8: newSha8 };
    // Step 8: withPackLock's finally releases the lock.
  });
}

// ────────────────────────────────────────────────────────────────────────
// Validation helpers used by primitives
// ────────────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9._-]+$/i;

function validateTypeName(name: unknown): void {
  if (typeof name !== 'string' || name.length === 0 || !SLUG_RE.test(name)) {
    throw new SchemaPackMutationError(
      'INVALID_RESULT',
      `type name must be a slug-shape string [a-z0-9._-]+ (got: ${JSON.stringify(name)})`,
    );
  }
}

function validatePrimitive(prim: unknown): asserts prim is PackPrimitive {
  if (typeof prim !== 'string' || !(PACK_PRIMITIVES as readonly string[]).includes(prim)) {
    throw new SchemaPackMutationError(
      'INVALID_PRIMITIVE',
      `primitive must be one of ${PACK_PRIMITIVES.join('|')} (got: ${JSON.stringify(prim)})`,
    );
  }
}

function validatePrefix(prefix: unknown): void {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new SchemaPackMutationError(
      'INVALID_RESULT',
      `prefix is required and must be a non-empty string (got: ${JSON.stringify(prefix)})`,
    );
  }
}

function findType(manifest: SchemaPackManifest, name: string): PackPageType {
  const t = manifest.page_types.find((pt) => pt.name === name);
  if (!t) {
    throw new SchemaPackMutationError(
      'TYPE_NOT_FOUND',
      `type '${name}' is not declared in pack '${manifest.name}'`,
      { pack: manifest.name, type: name },
    );
  }
  return t;
}

/**
 * Codex C14 guard: removing a type that other types reference via
 * aliases / enrichable_types / link_types / frontmatter_links leaves
 * dangling refs. We refuse the remove and surface the references so
 * the agent can break them first.
 */
function checkNoReferences(manifest: SchemaPackManifest, typeName: string): void {
  const refs: string[] = [];
  for (const t of manifest.page_types) {
    if (t.name === typeName) continue;
    if (t.aliases.includes(typeName)) refs.push(`type ${t.name}.aliases`);
  }
  for (const e of manifest.enrichable_types) {
    if (e.type === typeName) refs.push(`enrichable_types[${e.type}]`);
  }
  for (const lt of manifest.link_types) {
    if (lt.inference?.page_type === typeName) refs.push(`link_type ${lt.name}.inference.page_type`);
    if (lt.inference?.target_type === typeName) refs.push(`link_type ${lt.name}.inference.target_type`);
  }
  for (const fl of manifest.frontmatter_links) {
    if (fl.page_type === typeName) refs.push(`frontmatter_links[${fl.page_type}]`);
  }
  if (refs.length > 0) {
    throw new SchemaPackMutationError(
      'STILL_REFERENCED',
      `cannot remove type '${typeName}' — it is referenced by: ${refs.join(', ')}. Break references first.`,
      { pack: manifest.name, type: typeName, references: refs },
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// 11 mutation primitives
// ────────────────────────────────────────────────────────────────────────

export interface AddTypeOpts {
  name: string;
  primitive: PackPrimitive;
  prefix: string;
  extractable?: boolean;
  expertRouting?: boolean;
  aliases?: string[];
}

export async function addTypeToPack(packName: string, opts: AddTypeOpts, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  validateTypeName(opts.name);
  validatePrimitive(opts.primitive);
  validatePrefix(opts.prefix);
  return withMutation(packName, mutateOpts, (m) => {
    if (m.page_types.some((pt) => pt.name === opts.name)) {
      throw new SchemaPackMutationError(
        'TYPE_EXISTS',
        `type '${opts.name}' already exists in pack '${m.name}'`,
        { pack: m.name, type: opts.name },
      );
    }
    const newType: PackPageType = {
      name: opts.name,
      primitive: opts.primitive,
      path_prefixes: [opts.prefix],
      aliases: opts.aliases ?? [],
      extractable: opts.extractable ?? false,
      expert_routing: opts.expertRouting ?? false,
    };
    return { ...m, page_types: [...m.page_types, newType] };
  }, 'add_type', { type: opts.name, prefix: opts.prefix });
}

export async function removeTypeFromPack(packName: string, name: string, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  validateTypeName(name);
  return withMutation(packName, mutateOpts, (m) => {
    findType(m, name);  // throws TYPE_NOT_FOUND if missing
    checkNoReferences(m, name);  // codex C14
    return { ...m, page_types: m.page_types.filter((t) => t.name !== name) };
  }, 'remove_type', { type: name });
}

export interface UpdateTypeOpts {
  name: string;
  patch: Partial<Omit<PackPageType, 'name'>>;
}

export async function updateTypeOnPack(packName: string, opts: UpdateTypeOpts, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  validateTypeName(opts.name);
  if (opts.patch.primitive !== undefined) validatePrimitive(opts.patch.primitive);
  return withMutation(packName, mutateOpts, (m) => {
    const existing = findType(m, opts.name);
    const updated: PackPageType = { ...existing, ...opts.patch, name: existing.name };
    return { ...m, page_types: m.page_types.map((t) => (t.name === opts.name ? updated : t)) };
  }, 'update_type', { type: opts.name });
}

export async function addAliasToType(packName: string, typeName: string, alias: string, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  validateTypeName(typeName);
  validateTypeName(alias);
  return withMutation(packName, mutateOpts, (m) => {
    const t = findType(m, typeName);
    if (t.aliases.includes(alias)) return m;  // idempotent
    const next: PackPageType = { ...t, aliases: [...t.aliases, alias] };
    return { ...m, page_types: m.page_types.map((pt) => (pt.name === typeName ? next : pt)) };
  }, 'add_alias', { type: typeName });
}

export async function removeAliasFromType(packName: string, typeName: string, alias: string, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  validateTypeName(typeName);
  return withMutation(packName, mutateOpts, (m) => {
    const t = findType(m, typeName);
    if (!t.aliases.includes(alias)) return m;  // idempotent
    const next: PackPageType = { ...t, aliases: t.aliases.filter((a) => a !== alias) };
    return { ...m, page_types: m.page_types.map((pt) => (pt.name === typeName ? next : pt)) };
  }, 'remove_alias', { type: typeName });
}

export async function addPrefixToType(packName: string, typeName: string, prefix: string, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  validateTypeName(typeName);
  validatePrefix(prefix);
  return withMutation(packName, mutateOpts, (m) => {
    const t = findType(m, typeName);
    if (t.path_prefixes.includes(prefix)) return m;
    const next: PackPageType = { ...t, path_prefixes: [...t.path_prefixes, prefix] };
    return { ...m, page_types: m.page_types.map((pt) => (pt.name === typeName ? next : pt)) };
  }, 'add_prefix', { type: typeName, prefix });
}

export async function removePrefixFromType(packName: string, typeName: string, prefix: string, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  validateTypeName(typeName);
  return withMutation(packName, mutateOpts, (m) => {
    const t = findType(m, typeName);
    if (!t.path_prefixes.includes(prefix)) return m;
    const next: PackPageType = { ...t, path_prefixes: t.path_prefixes.filter((p) => p !== prefix) };
    return { ...m, page_types: m.page_types.map((pt) => (pt.name === typeName ? next : pt)) };
  }, 'remove_prefix', { type: typeName, prefix });
}

export interface AddLinkTypeOpts {
  name: string;
  inverse?: string;
  inference?: { regex?: string; page_type?: string; target_type?: string };
}

export async function addLinkTypeToPack(packName: string, opts: AddLinkTypeOpts, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  if (typeof opts.name !== 'string' || opts.name.length === 0) {
    throw new SchemaPackMutationError('INVALID_RESULT', `link_type.name is required`);
  }
  return withMutation(packName, mutateOpts, (m) => {
    if (m.link_types.some((lt) => lt.name === opts.name)) {
      throw new SchemaPackMutationError(
        'TYPE_EXISTS',
        `link_type '${opts.name}' already exists in pack '${m.name}'`,
        { pack: m.name, link: opts.name },
      );
    }
    const newLink: PackLinkType = {
      name: opts.name,
      ...(opts.inverse ? { inverse: opts.inverse } : {}),
      ...(opts.inference ? { inference: opts.inference } : {}),
    } as PackLinkType;
    return { ...m, link_types: [...m.link_types, newLink] };
  }, 'add_link_type', { type: opts.name });
}

export async function removeLinkTypeFromPack(packName: string, linkName: string, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  return withMutation(packName, mutateOpts, (m) => {
    if (!m.link_types.some((lt) => lt.name === linkName)) {
      throw new SchemaPackMutationError(
        'TYPE_NOT_FOUND',
        `link_type '${linkName}' is not declared in pack '${m.name}'`,
        { pack: m.name, link: linkName },
      );
    }
    // Check frontmatter_links references too.
    const flRefs = m.frontmatter_links.filter((fl) => fl.link_type === linkName);
    if (flRefs.length > 0) {
      throw new SchemaPackMutationError(
        'STILL_REFERENCED',
        `cannot remove link_type '${linkName}' — referenced by frontmatter_links: ${flRefs.map((f) => f.page_type).join(', ')}`,
        { pack: m.name, link: linkName },
      );
    }
    return { ...m, link_types: m.link_types.filter((lt) => lt.name !== linkName) };
  }, 'remove_link_type', { type: linkName });
}

export async function setExtractableOnType(packName: string, typeName: string, value: boolean, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  return updateTypeOnPack(packName, { name: typeName, patch: { extractable: value } }, { ...mutateOpts });
}

export async function setExpertRoutingOnType(packName: string, typeName: string, value: boolean, mutateOpts: MutateOpts = {}): Promise<MutateResult> {
  return updateTypeOnPack(packName, { name: typeName, patch: { expert_routing: value } }, { ...mutateOpts });
}
