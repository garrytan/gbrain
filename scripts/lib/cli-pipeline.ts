/**
 * Static view of the CLI-only dispatch pipeline (refactor wave 1, W4 cli).
 *
 * src/cli.ts handleCliOnly is an explicit ordered pipeline: it calls stage
 * functions tagged `@cliPipelineStage` and two table steps
 * (`dispatchPreConnectCommand`, `dispatchConnectedCommand`) that run the
 * command modules named by src/cli/command-table.ts. Two tools read that
 * shape as source and must see the same thing:
 *
 *   - test/helpers/cli-dispatch-extract.ts (the W0 dispatch-shape goldens)
 *   - scripts/generate-flag-registry.ts (per-command legal flags)
 *
 * `flattenCliPipeline` returns handleCliOnly's statements with every call to a
 * tagged stage replaced by that stage's own statements, in order, so a stage
 * split never changes what either tool sees. Pure: reads source text only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const PIPELINE_ENTRY = 'handleCliOnly';
export const PIPELINE_STAGE_TAG = 'cliPipelineStage';
export const PRE_CONNECT_TABLE_STEP = 'dispatchPreConnectCommand';
export const POST_CONNECT_TABLE_STEP = 'dispatchConnectedCommand';
export const COMMAND_TABLE_PATH = 'src/cli/command-table.ts';

export function readSource(root: string, rel: string): string {
  // CRLF-normalized so line-anchored scans behave the same on every platform.
  return readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
}

export function parseSource(root: string, rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, readSource(root, rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function topLevelFunctions(sf: ts.SourceFile): Map<string, ts.FunctionDeclaration> {
  const fns = new Map<string, ts.FunctionDeclaration>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) fns.set(st.name.text, st);
  }
  return fns;
}

function isStage(fn: ts.FunctionDeclaration): boolean {
  return ts.getJSDocTags(fn).some((t) => t.tagName.text === PIPELINE_STAGE_TAG);
}

/** Names of functions called directly by a statement (not inside nested functions). */
function calledNames(st: ts.Statement): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.push(n.expression.text);
    n.forEachChild(visit);
  };
  visit(st);
  return out;
}

export interface CliPipeline {
  sourceFile: ts.SourceFile;
  entry: ts.FunctionDeclaration;
  /** Stage functions in call order (entry excluded). */
  stages: ts.FunctionDeclaration[];
  /** Entry statements with each stage call inlined, in dispatch order. */
  statements: ts.Statement[];
}

export function flattenCliPipeline(sf: ts.SourceFile): CliPipeline {
  const fns = topLevelFunctions(sf);
  const entry = fns.get(PIPELINE_ENTRY);
  if (!entry) throw new Error(`cli-pipeline: ${PIPELINE_ENTRY} not found in ${sf.fileName}`);
  const stages: ts.FunctionDeclaration[] = [];
  const flatten = (list: readonly ts.Statement[], depth: number): ts.Statement[] => {
    if (depth > 4) throw new Error('cli-pipeline: stage nesting too deep');
    const out: ts.Statement[] = [];
    for (const st of list) {
      const stageName = calledNames(st).find((n) => {
        const fn = fns.get(n);
        return !!fn && isStage(fn);
      });
      if (!stageName) {
        out.push(st);
        continue;
      }
      const fn = fns.get(stageName)!;
      if (stages.includes(fn)) throw new Error(`cli-pipeline: stage ${stageName} is called twice`);
      stages.push(fn);
      out.push(...flatten(fn.body!.statements, depth + 1));
    }
    return out;
  };
  const statements = flatten(entry.body!.statements, 0);
  const untagged = [...fns.values()].filter((fn) => isStage(fn) && !stages.includes(fn));
  if (untagged.length > 0) {
    throw new Error(`cli-pipeline: @${PIPELINE_STAGE_TAG} function(s) not called from ${PIPELINE_ENTRY}: ${untagged.map((f) => f.name!.text).join(', ')}`);
  }
  return { sourceFile: sf, entry, stages, statements };
}

/** The statement that runs a table step (`if (await dispatchPreConnectCommand(...)) return;`). */
export function isTableStep(st: ts.Statement, step: string): boolean {
  return calledNames(st).includes(step);
}

export interface CommandModule {
  /** Repo-relative path of the module file. */
  path: string;
  sourceFile: ts.SourceFile;
  /** The exported `run` function the table step calls. */
  run: ts.FunctionDeclaration;
}

/** src/cli/commands/<name>.ts for a table record whose load names that module, else null. */
export function readCommandModule(root: string, loadSpecifier: string): CommandModule | null {
  const abs = resolve(join(root, dirname(COMMAND_TABLE_PATH)), loadSpecifier);
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (!rel.startsWith('src/cli/commands/') || !existsSync(abs)) return null;
  const sf = parseSource(root, rel);
  const run = topLevelFunctions(sf).get('run');
  if (!run) throw new Error(`cli-pipeline: ${rel} exports no run()`);
  return { path: rel, sourceFile: sf, run };
}

export interface TableRecordShape {
  name: string;
  /** Literal specifier of `load: () => import('<literal>')`, or null when load is not that shape. */
  loadSpecifier: string | null;
}

/** Every record of CLI_COMMANDS in table order, read by AST (the EO13 literal-load contract). */
export function readTableRecords(root: string): TableRecordShape[] {
  const sf = parseSource(root, COMMAND_TABLE_PATH);
  let table: ts.ArrayLiteralExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'CLI_COMMANDS' && n.initializer && ts.isArrayLiteralExpression(n.initializer)) table = n.initializer;
    n.forEachChild(visit);
  };
  visit(sf);
  if (!table) throw new Error(`cli-pipeline: CLI_COMMANDS array not found in ${COMMAND_TABLE_PATH}`);
  return table.elements.map((el) => {
    if (!ts.isObjectLiteralExpression(el)) throw new Error('cli-pipeline: CLI_COMMANDS element is not an object literal');
    const prop = (key: string) => el.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key);
    const name = prop('name')?.initializer;
    if (!name || !ts.isStringLiteral(name)) throw new Error('cli-pipeline: CLI_COMMANDS record without a string-literal name');
    const load = prop('load')?.initializer;
    let loadSpecifier: string | null = null;
    if (load && ts.isArrowFunction(load) && load.parameters.length === 0 && ts.isCallExpression(load.body)
      && load.body.expression.kind === ts.SyntaxKind.ImportKeyword && load.body.arguments.length === 1
      && ts.isStringLiteral(load.body.arguments[0]!)) {
      loadSpecifier = load.body.arguments[0].text;
    }
    return { name: name.text, loadSpecifier };
  });
}
