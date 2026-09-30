#!/usr/bin/env bun
/**
 * Refactor wave 1 porting kit (plan W6 / W7, E2 + O11): the moved-symbol map.
 *
 * Diffs the TypeScript under `src/` between a base (default: the merge-base of
 * `origin/master` and HEAD) and HEAD, and records where every top-level symbol
 * of a changed base file went: `old path:name -> one or more new path:name`,
 * plus the façade (the old module path that still exports the name, if any).
 *
 * How a destination is found (TypeScript AST + the shared token normalizer):
 *   1. The base symbol's whole token stream appears inside a new or changed
 *      HEAD symbol -> that symbol (a move).
 *   2. Otherwise its sub-statements (>= MIN_CHUNK_CHARS normalized characters) are looked up
 *      one by one -> every HEAD symbol that received a piece (a split).
 *   3. A symbol that still exists in the old file but now calls a same-named
 *      import (`return factsImpl.insertFact(...)`) -> that import (a façade
 *      delegating to its implementation).
 *   4. Last resort: a new or changed HEAD symbol with the same qualified name.
 * Symbols whose tokens are unchanged are omitted; a changed symbol with no
 * destination is an in-place edit and is omitted too; a removed symbol with
 * no destination is listed under `unmapped`.
 *
 * Outputs (both committed; regenerate, never hand-edit):
 *   docs/architecture/wave-1-moves.json   machine-readable map
 *   docs/architecture/wave-1-porting.md   map + recipes + agent prompt, rendered from the JSON
 * The `landing` block of the JSON (integration owner, freeze window, who may
 * lift the freeze) is kept across regenerations: edit it in the JSON, then run
 * `--render` to refresh the markdown.
 *
 * Usage:
 *   bun scripts/generate-wave-1-moves.ts [--base <ref>] [--head <ref>]   regenerate JSON + markdown
 *   bun scripts/generate-wave-1-moves.ts --render                        re-render markdown from the JSON
 * Pinned by test/scripts/generate-wave-1-moves.test.ts.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import ts from 'typescript';

export const JSON_PATH = 'docs/architecture/wave-1-moves.json';
export const MARKDOWN_PATH = 'docs/architecture/wave-1-porting.md';

/** Smallest chunk looked up, in normalized characters (a 30-token statement, or one short SQL literal). */
const MIN_CHUNK_CHARS = 160;
/** A smaller chunk (one moved dispatch line) still counts when its one home is in a new file. */
const MIN_UNIQUE_CHUNK_CHARS = 60;
const ANCHOR = 8;
/** A chunk found in more places than this is boilerplate, not a move. */
const MAX_CHUNK_HOMES = 4;

export interface SourceFile {
  path: string;
  text: string;
}

export interface MoveEntry {
  old: string;
  kind: 'moved' | 'split' | 'extracted';
  /** The old module path that still exports the name, or null. */
  facade: string | null;
  /** Whether the base module exported the name (a null façade then breaks the façade rule). */
  wasExported: boolean;
  new: string[];
}

export interface Landing {
  integrationOwner: string;
  freezeStart: string;
  freezeEnd: string;
  freezeLiftedBy: string;
}

export interface MovesDoc {
  generatedBy: string;
  base: string;
  head: string;
  landing: Landing;
  moves: MoveEntry[];
  unmapped: string[];
  /** Base modules with no file at the same path in HEAD (deleted or renamed). */
  removedModules: string[];
}

export const DEFAULT_LANDING: Landing = {
  integrationOwner: '<INTEGRATION_OWNER>',
  freezeStart: '<FREEZE_START>',
  freezeEnd: '<FREEZE_END>',
  freezeLiftedBy: '<FREEZE_LIFT_AUTHORITY>',
};

// ── symbols ───────────────────────────────────────────────────────────────

export interface Unit {
  path: string;
  name: string;
  node: ts.Node;
  ids: number[];
  imports: Map<string, { module: string; name: string | null }>;
}

interface ParsedFile {
  path: string;
  sf: ts.SourceFile;
  starts: number[];
  ids: number[];
  units: Unit[];
  exported: Set<string>;
  imports: Map<string, { module: string; name: string | null }>;
}

const interned = new Map<string, number>();
const tokenLength: number[] = [];
function intern(token: string): number {
  let id = interned.get(token);
  if (id === undefined) {
    id = interned.size;
    interned.set(token, id);
    tokenLength.push(token.length + 1);
  }
  return id;
}

function weight(ids: number[]): number {
  let n = 0;
  for (const id of ids) n += tokenLength[id]!;
  return n;
}

function isLiteralLike(node: ts.Node): boolean {
  return ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    || ts.isBigIntLiteral(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateHead(node)
    || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
}

/** The normalized token stream of a file (same normal form as scripts/lib/normalize-tokens.ts), with token starts. */
function tokenize(sf: ts.SourceFile): { starts: number[]; ids: number[] } {
  const starts: number[] = [];
  const ids: number[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if ((node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) || isLiteralLike(node)) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      let text = node.getText(sf);
      // `import('./x.ts')` / `require('../y.ts')` become repo paths, so re-rooting a moved block is not an edit.
      if (ts.isStringLiteral(node) && node.text.startsWith('.') && ts.isCallExpression(node.parent)
        && (node.parent.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.parent.expression) && node.parent.expression.text === 'require'))) {
        text = `'<repo>/${posix.normalize(posix.join(posix.dirname(sf.fileName), node.text))}'`;
      }
      if (text.length === 0) return;
      starts.push(node.getStart(sf));
      ids.push(intern(text));
      return;
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  for (const child of sf.getChildren(sf)) visit(child);
  return { starts, ids };
}

function lowerBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nodeIds(file: Pick<ParsedFile, 'sf' | 'starts' | 'ids'>, node: ts.Node): number[] {
  return file.ids.slice(lowerBound(file.starts, node.getStart(file.sf)), lowerBound(file.starts, node.end));
}

function memberName(member: ts.ClassElement, sf: ts.SourceFile): string | null {
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  if (!member.name) return null;
  if (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name) || ts.isStringLiteral(member.name)) return member.name.text;
  return member.name.getText(sf);
}

function hasExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

export function parseFile(file: SourceFile): ParsedFile {
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { starts, ids } = tokenize(sf);
  const parsed: ParsedFile = { path: file.path, sf, starts, ids, units: [], exported: new Set(), imports: new Map() };
  const seen = new Map<string, number>();
  const add = (name: string, node: ts.Node): void => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    parsed.units.push({ path: file.path, name: n === 1 ? name : `${name}#${n}`, node, ids: nodeIds(parsed, node), imports: parsed.imports });
  };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.importClause) {
      const module = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (clause.name) parsed.imports.set(clause.name.text, { module, name: 'default' });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) parsed.imports.set(bindings.name.text, { module, name: null });
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) parsed.imports.set(el.name.text, { module, name: (el.propertyName ?? el.name).text });
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) parsed.exported.add(el.name.text);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name) add(stmt.name.text, stmt);
    else if (ts.isClassDeclaration(stmt) && stmt.name) {
      for (const member of stmt.members) {
        const name = memberName(member, sf);
        if (name) add(`${stmt.name.text}.${name}`, member);
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) add(decl.name.text, stmt.declarationList.declarations.length === 1 ? stmt : decl);
      }
    } else if ((ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt))) {
      add(stmt.name.text, stmt);
    } else if (ts.isExportAssignment(stmt)) add('default', stmt);
    if (hasExport(stmt)) {
      if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)
        || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name) parsed.exported.add(stmt.name.text);
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) if (ts.isIdentifier(decl.name)) parsed.exported.add(decl.name.text);
      }
    }
  }
  return parsed;
}

/** Every name a file declares or exports (declared units, export lists and re-exports). */
export function symbolNames(file: SourceFile): Set<string> {
  const parsed = parseFile(file);
  const names = new Set<string>(parsed.exported);
  for (const unit of parsed.units) names.add(unit.name);
  return names;
}

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function anchorKey(ids: number[], pos: number): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < ANCHOR; k++) h = Math.imul(h ^ ids[pos + k]!, 0x01000193);
  return h >>> 0;
}

class HeadIndex {
  private readonly anchors = new Map<number, number[]>();
  constructor(readonly units: Unit[]) {
    units.forEach((unit, u) => {
      for (let pos = 0; pos + ANCHOR <= unit.ids.length; pos++) {
        const key = anchorKey(unit.ids, pos);
        const list = this.anchors.get(key);
        if (list) list.push(u, pos);
        else this.anchors.set(key, [u, pos]);
      }
    });
  }

  /** Indices of the units whose token stream contains `chunk`. */
  homes(chunk: number[]): Set<number> {
    const found = new Set<number>();
    const list = this.anchors.get(anchorKey(chunk, 0));
    if (!list) return found;
    for (let i = 0; i < list.length; i += 2) {
      const u = list[i]!;
      const pos = list[i + 1]!;
      if (found.has(u)) continue;
      const ids = this.units[u]!.ids;
      if (pos + chunk.length > ids.length) continue;
      let ok = true;
      for (let k = ANCHOR; k < chunk.length; k++) {
        if (ids[pos + k] !== chunk[k]) { ok = false; break; }
      }
      if (ok) found.add(u);
    }
    return found;
  }
}

function exportedAtBase(file: ParsedFile, unit: Unit): boolean {
  return file.exported.has(unit.name.split('.')[0]!.replace(/#\d+$/, ''));
}

function key(unit: Pick<Unit, 'path' | 'name'>): string {
  return `${unit.path}:${unit.name}`;
}

function resolveModule(fromPath: string, spec: string, headByPath: Map<string, ParsedFile>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  for (const candidate of [base, `${base}.ts`, base.replace(/\.js$/, '.ts'), `${base}/index.ts`]) {
    if (headByPath.has(candidate)) return candidate;
  }
  return null;
}

/** Same-named imports the unit calls: `ns.name(...)` over a namespace import, or `name(...)` / `alias(...)` over a named import. */
function delegationTargets(unit: Unit, lastName: string, headByPath: Map<string, ParsedFile>): string[] {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let local: string | null = null;
      let member: string | null = null;
      if (ts.isIdentifier(callee)) local = callee.text;
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        local = callee.expression.text;
        member = callee.name.text;
      }
      const imp = local ? unit.imports.get(local) : undefined;
      if (imp) {
        const name = imp.name === null ? member : imp.name;
        const target = resolveModule(unit.path, imp.module, headByPath);
        if (name && target && name === lastName && headByPath.get(target)!.units.some((u) => u.name === name)) out.add(`${target}:${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(unit.node);
  return [...out];
}

export interface DiffInput {
  base: SourceFile[];
  head: SourceFile[];
  /** base path -> head path for renamed files; absent = same path (or deleted when missing from head). */
  renames?: Record<string, string>;
}

export function computeMoves(input: DiffInput): { moves: MoveEntry[]; unmapped: string[]; removedModules: string[] } {
  const baseFiles = input.base.map(parseFile);
  const headFiles = input.head.map(parseFile);
  const headByPath = new Map(headFiles.map((f) => [f.path, f]));
  const baseByKey = new Map<string, Unit>();
  for (const f of baseFiles) {
    const headPath = input.renames?.[f.path] ?? f.path;
    for (const u of f.units) baseByKey.set(`${headPath}:${u.name}`, u);
  }
  const renamedTo = new Set(Object.values(input.renames ?? {}));
  const basePaths = new Set(input.base.map((f) => input.renames?.[f.path] ?? f.path));
  const newFiles = new Set(headFiles.map((f) => f.path).filter((p) => !basePaths.has(p)));
  // Chunk destinations: HEAD symbols that are new, or live in a renamed file.
  // A symbol that already existed at the same path (the other engine's twin,
  // say) is never a destination by token overlap, only by delegation.
  const indexed = headFiles.flatMap((f) => f.units).filter((u) => renamedTo.has(u.path) || !baseByKey.has(key(u)));
  const index = new HeadIndex(indexed);
  const changed = new Set(headFiles.flatMap((f) => f.units).filter((u) => {
    const before = baseByKey.get(key(u));
    return !before || !sameIds(before.ids, u.ids);
  }).map(key));

  const moves: MoveEntry[] = [];
  const unmapped: string[] = [];
  for (const file of baseFiles) {
    const headPath = input.renames?.[file.path] ?? file.path;
    const headFile = headByPath.get(headPath);
    for (const unit of file.units) {
      const same = headFile?.units.find((u) => u.name === unit.name);
      if (same && headPath !== file.path) {
        moves.push({ old: key(unit), kind: 'moved', facade: null, wasExported: exportedAtBase(file, unit), new: [key(same)] });
        continue;
      }
      if (same && sameIds(same.ids, unit.ids)) continue;
      const sameKey = same ? key(same) : null;
      const coverage = new Map<string, number>();
      const search = (node: ts.Node): void => {
        const ids = nodeIds(file, node);
        const size = weight(ids);
        if (ids.length < ANCHOR || size < MIN_UNIQUE_CHUNK_CHARS) return;
        const homes = [...index.homes(ids)].map((u) => key(indexed[u]!)).filter((k) => k !== sameKey);
        if (homes.length > 0) {
          const counts = size >= MIN_CHUNK_CHARS
            ? homes.length <= MAX_CHUNK_HOMES
            : homes.length === 1 && newFiles.has(homes[0]!.slice(0, homes[0]!.lastIndexOf(':')));
          if (counts) for (const k of homes) coverage.set(k, (coverage.get(k) ?? 0) + Math.max(size, MIN_CHUNK_CHARS));
          return;
        }
        for (const child of node.getChildren(file.sf)) search(child);
      };
      search(unit.node);
      const dests = new Set([...coverage].filter(([, n]) => n >= MIN_CHUNK_CHARS).map(([k]) => k));
      const lastName = unit.name.replace(/#\d+$/, '').split('.').pop()!;
      if (same) for (const target of delegationTargets(same, lastName, headByPath)) dests.add(target);
      if (dests.size === 0 && !same) {
        const byName = indexed.filter((u) => u.name === unit.name && u.path !== headPath && changed.has(key(u)));
        if (byName.length === 1) dests.add(key(byName[0]!));
      }
      if (dests.size === 0) {
        if (!same) unmapped.push(key(unit));
        continue;
      }
      const facade = same ? sameKey : headFile?.exported.has(unit.name) ? `${headPath}:${unit.name}` : null;
      const extracted = same !== undefined && same.ids.length * 2 > unit.ids.length && !delegationTargets(same, lastName, headByPath).length;
      moves.push({
        old: key(unit),
        kind: extracted ? 'extracted' : dests.size === 1 ? 'moved' : 'split',
        facade,
        wasExported: exportedAtBase(file, unit),
        new: [...dests].sort(),
      });
    }
  }
  moves.sort((a, b) => (a.old < b.old ? -1 : a.old > b.old ? 1 : 0));
  unmapped.sort();
  const removedModules = baseFiles.map((f) => f.path).filter((p) => !headByPath.has(p)).sort();
  return { moves, unmapped, removedModules };
}

// ── git ───────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

const isTsSource = (p: string): boolean => p.startsWith('src/') && p.endsWith('.ts') && !p.endsWith('.d.ts');

export function diffInputFromGit(root: string, baseRef: string, headRef: string): DiffInput {
  const status = git(['diff', '--name-status', '-M', baseRef, headRef, '--', 'src'], root).trim().split('\n').filter(Boolean);
  const base: SourceFile[] = [];
  const head: SourceFile[] = [];
  const renames: Record<string, string> = {};
  const show = (ref: string, path: string): string => git(['show', `${ref}:${path}`], root);
  for (const line of status) {
    const [code, a, b] = line.split('\t');
    if (!code || !a) continue;
    if (code.startsWith('R')) {
      if (isTsSource(a)) base.push({ path: a, text: show(baseRef, a) });
      if (b && isTsSource(b)) head.push({ path: b, text: show(headRef, b) });
      if (b) renames[a] = b;
    } else if (code === 'A') {
      if (isTsSource(a)) head.push({ path: a, text: show(headRef, a) });
    } else if (code === 'D') {
      if (isTsSource(a)) base.push({ path: a, text: show(baseRef, a) });
    } else if (isTsSource(a)) {
      base.push({ path: a, text: show(baseRef, a) });
      head.push({ path: a, text: show(headRef, a) });
    }
  }
  return { base, head, renames };
}

// ── markdown ──────────────────────────────────────────────────────────────

const LIST_LIMIT = 8;

function code(s: string): string {
  return '`' + s + '`';
}

function renderMap(doc: MovesDoc): string {
  const byFile = new Map<string, MoveEntry[]>();
  for (const m of doc.moves) {
    const file = m.old.slice(0, m.old.lastIndexOf(':'));
    const list = byFile.get(file) ?? [];
    list.push(m);
    byFile.set(file, list);
  }
  const out: string[] = [];
  for (const [file, entries] of byFile) {
    out.push(`### ${code(file)}`, '', '| Old symbol | Kind | Still importable from | New location(s) |', '|---|---|---|---|');
    for (const m of entries) {
      const shown = m.new.slice(0, LIST_LIMIT).map(code).join('<br>');
      const more = m.new.length > LIST_LIMIT ? `<br>… and ${m.new.length - LIST_LIMIT} more (see the JSON)` : '';
      const name = m.old.slice(m.old.lastIndexOf(':') + 1);
      const facade = m.facade ? code(m.facade)
        : !m.wasExported ? 'module-private'
          : doc.removedModules.includes(file) ? '**old module removed**' : '**not re-exported**';
      out.push(`| ${code(name)} | ${m.kind} | ${facade} | ${shown}${more} |`);
    }
    out.push('');
  }
  if (doc.unmapped.length > 0) {
    out.push('### Removed without a traceable destination', '', 'Deleted with their callers, or rewritten beyond token matching. Search the new module directories by behavior.', '');
    for (const u of doc.unmapped) out.push(`- ${code(u)}`);
    out.push('');
  }
  return out.join('\n');
}

export function renderMarkdown(doc: MovesDoc): string {
  const L = doc.landing;
  return `# Refactor wave 1 porting guide

<!-- GENERATED by scripts/generate-wave-1-moves.ts from docs/architecture/wave-1-moves.json. Do not edit by hand:
     change the landing block in the JSON, then run \`bun scripts/generate-wave-1-moves.ts --render\`. -->

Refactor wave 1 is a behavior-preserving structural refactor: storage SQL moved to one implementation per
domain, the migrations array became one file per migration, and the doctor, sync, serve-http, CLI, jobs,
hybrid-search and autopilot god functions were split into modules. Nothing a user or downstream importer
sees changed: every moved exported symbol is still importable from its old module (the façade rule in
CLAUDE.md). What changed is where the code you edit lives. This page tells an open pull request how to
follow it. The map below is generated from the AST (${code(doc.generatedBy)}); the machine-readable copy is
[${code('wave-1-moves.json')}](wave-1-moves.json). Where a contribution goes today is in
[CONTRIBUTING.md, "Where does my change go?"](../../CONTRIBUTING.md#where-does-my-change-go).

Base ${code(doc.base)}, head ${code(doc.head)}.

## Landing window

- **Integration owner:** ${L.integrationOwner}. Ports upstream fixes that land on master during the window
  into the moved code.
- **Freeze:** target paths (the files in the map below and their new module directories) are frozen from
  ${L.freezeStart} to ${L.freezeEnd}. Only the integration owner merges into them.
- **Who can lift the freeze:** ${L.freezeLiftedBy}.
- **Hotfix lane:** an urgent fix lands on master as usual. The integration owner ports it into the moved
  code within hours, reruns the W0 goldens and \`bun run verify\`, and notes the port in the wave PR.
- **After the merge:** follow-ups on moved paths wait out a 72-hour revert-clean window; forward-fix is
  the primary rollback path.

## Porting an open pull request

Rebase onto master. For each conflicting hunk, look up the symbol you edited in the map, apply the same
edit at its new location, and let the old file keep only its façade. Then follow the recipe for the kind
of change. Every recipe ends with \`bun run verify\` and the named tests.

### Engine fix (a storage method)

If the method's domain is migrated (a ${code('migrated')} row in ${code('scripts/engine-sql-baseline.tsv')}),
the SQL now lives once in ${code('src/core/engine-sql/<domain>.ts')} and both engines delegate to it. Apply
the fix there once, not in ${code('pglite-engine.ts')} and ${code('postgres-engine.ts')}. Keep master's
Postgres text byte for byte unless the fix changes SQL on purpose, then refresh the SQL-text golden
(${code('GBRAIN_TEST_UPDATE_GOLDENS=1 bun test --timeout=60000 test/engine-sql-sql-text.test.ts')}) and say why in the PR.
Run ${code('bun test --timeout=60000 test/engine-sql-*.test.ts')} and the domain's parity E2E. If the domain is not migrated,
fix both engines as before; a new SQL-bearing engine member fails ${code('check:engine-sql-ratchet')}.

### Schema migration

${code('MIGRATIONS')} is no longer an array you append to. Take your migration's body and run
${code('bun run new:migration <snake_name>')}; it scaffolds ${code('src/core/schema-migrations/v<NNN>-<name>.ts')}
with the next free version and regenerates the registry. Paste the body into the scaffold. If master
already took your number, renumber: ${code('git mv')} the file, edit ${code('version:')}, and run
${code('bun run build:schema-migrations')}. Never renumber a migration that already ran on retained data.
Schema text for fresh installs goes in ${code('src/schema.sql')} (or its TS fragment), then
${code('bun run build:schema')}. Run ${code('bun test --timeout=60000 test/scripts/build-schema-migrations.test.ts test/migrate.test.ts')}.

### Doctor check

${code('buildChecks')} is a registry runner. A check you added inline now goes in a
${code('{ name, emits, run }')} entry in the topic module under ${code('src/commands/doctor/checks/')},
listed in ${code('DOCTOR_CHECK_REGISTRY')} (${code('src/commands/doctor/registry.ts')}) at the position its
output should take, with every emitted name categorized in ${code('src/core/doctor-categories.ts')}.
Run ${code('bun test --timeout=60000 test/doctor-registry.test.ts test/doctor-mode-matrix.serial.test.ts')}; refresh the
registry and ${code('--json')} goldens deliberately if the output is meant to change.

### CLI flag or command

The ${code('handleCliOnly')} switch became ${code('src/cli/command-table.ts')} plus one dispatch module per
command in ${code('src/cli/commands/')}. A new command is one record plus its module; a new flag on an
existing command is an edit to the command's implementation. Then ${code('bun run build:flag-registry')}
and ${code('bun test --timeout=60000 test/cli-command-table.test.ts test/cli-flag-validation.test.ts')}. A new command
changes the membership and dispatch goldens: regenerate them with ${code('GBRAIN_TEST_UPDATE_GOLDENS=1')}
and review the diff.

### serve-http route

${code('runServeHttp')} became ${code('buildServeHttpApp')} plus ${code('serve-http-<area>.ts')} modules, each
exporting ${code('mount<Area>(app, ctx)')} over one shared ${code('ServeHttpContext')}. Put the route in the
module for its area; an ${code('/admin')} route carries ${code('requireAdmin')} before its handler. Run
${code('bun test --timeout=60000 test/serve-http-admin-route-guard.test.ts test/serve-http-route-runtime-golden.test.ts')}
and refresh the route goldens deliberately for a new route.

### Sync closure

${code('performSyncInner')}'s closure ${code('let')}s became fields of the ${code('SyncRun')} object
(${code('src/commands/sync/sync-run.ts')}), and the body became phases under ${code('src/commands/sync/')}.
Rewrite a read or write of a former local as ${code('run.<field>')} at each use; never destructure a
mutable field or copy it into a local (${code('check:sync-run-state')}). Checkpoint state changes only
through a ${code('sync-run.ts')} function. Run ${code('bun test --timeout=60000 test/sync.test.ts test/sync-run-ordering.serial.test.ts')}.

### Jobs handler

Built-in Minion handler bodies moved from ${code('src/commands/jobs.ts')} to one module each under
${code('src/core/minions/handlers/')}; ${code('registerBuiltinHandlers')} (still exported from
${code('jobs.ts')}) registers them in the same order. Apply the handler fix in its module. A new handler
is a module plus one registration line, and changes ${code('test/fixtures/goldens/jobs/handler-registry.json')}
(${code('bun test --timeout=60000 test/jobs-handler-registry-golden.test.ts')}).

### Hybrid search stage

${code('hybridSearch')} and ${code('hybridSearchCached')} run as named stages under
${code('src/core/search/hybrid/')} (request, arms, rank, cache stages, keyword-only, degraded). Apply the
fix in the stage that owns the code. The deterministic output is pinned exactly:
${code('bun test --timeout=60000 test/hybrid-golden.test.ts')}. A retrieval change also needs ${code('gbrain eval replay')}.

### Generated-file conflicts: regenerate, never hand-merge

Take either side of the conflict, then rerun the generator and commit its output:

| File | Command |
|---|---|
| ${code('src/core/schema-migrations/registry.generated.ts')} | ${code('bun run build:schema-migrations')} |
| ${code('src/core/schema-embedded.generated.ts')} | ${code('bun run build:schema')} |
| ${code('src/core/pglite-schema.generated.ts')} | ${code('bun run build:schema')} |
| ${code('src/core/cli-flag-registry.generated.ts')} | ${code('bun run build:flag-registry')} |

The freshness guards (${code('check:schema-migrations')}, ${code('check:schema-fresh')}, and
${code('test/cli-flag-validation.test.ts')}) fail on a hand-merged copy.

## Say to your agent

> Rebase this pull request onto master. Refactor wave 1 moved code without changing behavior; use
> docs/architecture/wave-1-moves.json to find where each symbol my branch edits now lives (${code('old')} ->
> ${code('new')}; a ${code('facade')} entry means the old file only re-exports or delegates). Move each
> conflicting hunk to the new location, apply the matching recipe in docs/architecture/wave-1-porting.md,
> regenerate generated files instead of merging them, and keep the old module's exports working. Then
> run \`bun run verify\` and the tests the recipe names, and list every hunk you relocated in the PR body.

## Moved-symbol map

Kinds: **moved** (one new home), **split** (pieces went to several homes), **extracted** (the old symbol
keeps most of its body; the listed homes received pieces of it). "Still importable from" is the old
module path when it keeps exporting the name; "module-private" means the old module never exported it;
"old module removed" means the file was deleted or renamed, so import the new location.

${renderMap(doc)}`;
}

// ── main ──────────────────────────────────────────────────────────────────

function main(argv: string[]): void {
  const root = resolve(import.meta.dir, '..');
  const jsonFile = join(root, JSON_PATH);
  const previous: MovesDoc | null = existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf-8')) : null;
  if (argv.includes('--render')) {
    if (!previous) throw new Error(`${JSON_PATH} is missing; run without --render first`);
    writeFileSync(join(root, MARKDOWN_PATH), renderMarkdown(previous));
    console.log(`✓ rendered ${MARKDOWN_PATH} from ${JSON_PATH}`);
    return;
  }
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const headRef = arg('--head') ?? 'HEAD';
  const baseRef = arg('--base') ?? git(['merge-base', 'origin/master', headRef], root).trim();
  const baseSha = git(['rev-parse', '--short=12', baseRef], root).trim();
  const headSha = git(['rev-parse', '--short=12', headRef], root).trim();
  const { moves, unmapped, removedModules } = computeMoves(diffInputFromGit(root, baseRef, headRef));
  const doc: MovesDoc = {
    generatedBy: 'scripts/generate-wave-1-moves.ts',
    base: baseSha,
    head: headSha,
    landing: previous?.landing ?? DEFAULT_LANDING,
    moves,
    unmapped,
    removedModules,
  };
  writeFileSync(jsonFile, JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(join(root, MARKDOWN_PATH), renderMarkdown(doc));
  console.log(`✓ ${moves.length} moved symbols, ${unmapped.length} unmapped (${baseSha}..${headSha}) -> ${JSON_PATH}, ${MARKDOWN_PATH}`);
}

if (import.meta.main) main(process.argv.slice(2));
