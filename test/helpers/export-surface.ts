/**
 * Public export-surface capture (refactor wave 1: O13).
 *
 * - `runtimeExports()`: sorted runtime export names of every package.json
 *   `exports` subpath, imported through the package name (`gbrain/<subpath>`)
 *   so the exports map itself is exercised.
 * - `enginePrototypeMethods()`: every method/accessor name reachable on the
 *   `PGLiteEngine` and `PostgresEngine` prototype chains (so hoisting methods
 *   into a shared base class does not read as a change).
 * - `typeSurface()`: a .d.ts-level snapshot per subpath from the TypeScript
 *   checker: each exported symbol's kind and printed signature/members, with
 *   `import("<path>").` qualifiers stripped so moving a declaration between
 *   files is not a surface change.
 */

import { resolve } from 'path';
import ts from 'typescript';
import pkg from '../../package.json';

const REPO = resolve(import.meta.dir, '..', '..');

export function exportSubpaths(): Array<{ subpath: string; specifier: string; file: string }> {
  return Object.entries(pkg.exports as Record<string, string>).map(([key, file]) => ({
    subpath: key,
    specifier: key === '.' ? 'gbrain' : `gbrain/${key.slice(2)}`,
    file: resolve(REPO, file),
  }));
}

export async function runtimeExports(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const { subpath, specifier } of exportSubpaths()) {
    const mod = (await import(specifier)) as Record<string, unknown>;
    out[subpath] = Object.keys(mod).sort();
  }
  return out;
}

export function prototypeChainMethods(ctor: { prototype: object }): string[] {
  const names = new Set<string>();
  for (let p: object | null = ctor.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) if (n !== 'constructor') names.add(n);
  }
  return [...names].sort();
}

const FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.WriteArrowStyleSignature;

/** Strip `import("<path>").` qualifiers and checker-internal symbol ids (`__@iterator@123` -> `[iterator]`). */
export function stripImportQualifiers(text: string): string {
  return text.replace(/import\("[^"]*"\)\./g, '').replace(/__@([A-Za-z0-9_$]+)@\d+/g, '[$1]');
}

function kindOf(sym: ts.Symbol): string {
  const f = sym.flags;
  if (f & ts.SymbolFlags.Class) return 'class';
  if (f & ts.SymbolFlags.Function) return 'function';
  if (f & ts.SymbolFlags.Enum) return 'enum';
  if (f & ts.SymbolFlags.Interface) return (f & ts.SymbolFlags.Value) ? 'interface+value' : 'interface';
  if (f & ts.SymbolFlags.TypeAlias) return (f & ts.SymbolFlags.Value) ? 'type+value' : 'type';
  if (f & ts.SymbolFlags.Variable) return 'variable';
  if (f & ts.SymbolFlags.Module) return 'namespace';
  return `flags:${f}`;
}

function memberList(checker: ts.TypeChecker, type: ts.Type, at: ts.Node): string[] {
  const out: string[] = [];
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const mods = decl ? ts.getCombinedModifierFlags(decl as ts.Declaration) : 0;
    if (mods & ts.ModifierFlags.Private || prop.name.startsWith('#')) {
      out.push(`private ${stripImportQualifiers(prop.name)}`);
      continue;
    }
    const prefix = mods & ts.ModifierFlags.Protected ? 'protected ' : '';
    const optional = prop.flags & ts.SymbolFlags.Optional ? '?' : '';
    const readonly = mods & ts.ModifierFlags.Readonly ? 'readonly ' : '';
    const t = checker.getTypeOfSymbolAtLocation(prop, at);
    out.push(`${prefix}${readonly}${stripImportQualifiers(prop.name)}${optional}: ${stripImportQualifiers(checker.typeToString(t, at, FLAGS))}`);
  }
  for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
    out.push(`(call) ${stripImportQualifiers(checker.signatureToString(sig, at, FLAGS))}`);
  }
  for (const info of checker.getIndexInfosOfType(type)) {
    out.push(`[index ${stripImportQualifiers(checker.typeToString(info.keyType, at, FLAGS))}]: ${stripImportQualifiers(checker.typeToString(info.type, at, FLAGS))}`);
  }
  return out.sort();
}

export interface TypeSurfaceEntry {
  name: string;
  kind: string;
  signature?: string[];
  members?: string[];
  statics?: string[];
}

export function typeSurface(): Record<string, TypeSurfaceEntry[]> {
  const subpaths = exportSubpaths();
  const program = ts.createProgram(subpaths.map((s) => s.file), {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['bun-types'],
  });
  const checker = program.getTypeChecker();
  const out: Record<string, TypeSurfaceEntry[]> = {};
  for (const { subpath, file } of subpaths) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`cannot load ${file}`);
    const moduleSym = checker.getSymbolAtLocation(sf);
    if (!moduleSym) {
      out[subpath] = [];
      continue;
    }
    const entries: TypeSurfaceEntry[] = [];
    for (const exported of checker.getExportsOfModule(moduleSym)) {
      const sym = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const kind = kindOf(sym);
      const entry: TypeSurfaceEntry = { name: exported.name, kind };
      if (sym.flags & ts.SymbolFlags.Class) {
        const instance = checker.getDeclaredTypeOfSymbol(sym);
        const staticType = checker.getTypeOfSymbolAtLocation(sym, sf);
        entry.signature = checker
          .getSignaturesOfType(staticType, ts.SignatureKind.Construct)
          .map((s) => `new ${stripImportQualifiers(checker.signatureToString(s, sf, FLAGS))}`);
        entry.members = memberList(checker, instance, sf);
        entry.statics = memberList(checker, staticType, sf).filter((m) => !m.startsWith('prototype:'));
      } else if (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
        const declared = checker.getDeclaredTypeOfSymbol(sym);
        const params = (declared as ts.InterfaceType).typeParameters?.map((p) => checker.typeToString(p, sf, FLAGS));
        if (sym.flags & ts.SymbolFlags.TypeAlias) {
          entry.signature = [stripImportQualifiers(checker.typeToString(declared, sf, FLAGS | ts.TypeFormatFlags.InTypeAlias))];
        } else {
          entry.members = memberList(checker, declared, sf);
          if (params?.length) entry.signature = [`<${params.join(', ')}>`];
        }
      } else if (sym.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable | ts.SymbolFlags.Enum)) {
        const t = checker.getTypeOfSymbolAtLocation(sym, sf);
        entry.signature = [stripImportQualifiers(checker.typeToString(t, sf, FLAGS))];
      }
      entries.push(entry);
    }
    out[subpath] = entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return out;
}
