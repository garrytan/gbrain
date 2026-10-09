/**
 * Refactor wave 1 (W0, A16b / EO5 / EO13): static extraction of the CLI
 * dispatch contract with the TypeScript compiler API.
 *
 * On master the dispatcher was a hand-written `main()` plus a
 * `handleCliOnly()` whose pre-connect `if (command === ...)` branches ran
 * engine-free and whose `switch (command)` ran after the `connectEngine()`
 * terminator. W4 (cli) replaced the plain branches and the switch with the
 * command table (src/cli/command-table.ts + src/cli/commands/*.ts) and split
 * the remaining explicit branches into `@cliPipelineStage` functions. This
 * module reads that shape and reports it in master's vocabulary, so the W0
 * goldens stay byte-identical:
 *
 *   - membership sets (CLI_ONLY, CLI_ONLY_SELF_HELP, SELF_HELP_WITHOUT_ENGINE,
 *     THIN_CLIENT_REFUSED_COMMANDS, THIN_CLIENT_REFUSE_HINTS,
 *     STARTUP_HOOK_SKIP_COMMANDS), sorted, because they are sets; the table
 *     derives them, so they are read from the runtime table exports;
 *   - per-command dispatch phase (pre-connect / pre-connect-own-engine /
 *     post-connect / unhandled) relative to the connectEngine terminator. The
 *     pipeline is flattened with every stage inlined (scripts/lib/cli-pipeline.ts);
 *     the pre-connect table step contributes, at its position, the rule a
 *     plain `command === 'x'` branch contributed on master (condition
 *     `command === 'x'`, terminating, flags read from the module's run()),
 *     for each pre-connect record no earlier explicit branch already decided;
 *   - per-command thin-client mode (none / refuse / route-then-refuse) and
 *     every explicit subcommand routing rule, as whitespace-collapsed source
 *     text of the branch condition, in dispatch order;
 *   - per post-connect record (master's switch cases, in table order), the
 *     dynamic `import()` specifiers of its module's run(), rewritten relative to
 *     src/ as the case bodies wrote them (EO13 baseline).
 *
 * Pure: reads source text and the side-effect-free command table; no engine,
 * no env, no network.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import ts from 'typescript';
import {
  CLI_COMMANDS,
  CLI_ONLY as TABLE_CLI_ONLY,
  CLI_ONLY_SELF_HELP as TABLE_SELF_HELP,
  STARTUP_HOOK_SKIP_COMMANDS as TABLE_STARTUP_HOOK_SKIP,
  THIN_CLIENT_REFUSED_COMMANDS as TABLE_REFUSED,
} from '../../src/cli/command-table.ts';
import {
  PRE_CONNECT_TABLE_STEP,
  flattenCliPipeline,
  isTableStep,
  readCommandModule,
  readTableRecords,
} from '../../scripts/lib/cli-pipeline.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');

export function readRepoFile(rel: string): string {
  // test-reads-source-ok[structural]: W0 dispatch-shape golden is extracted from the CLI source AST by design (EO5/EO13).
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

export function parseTs(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, readRepoFile(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

function findVariable(sf: ts.SourceFile, name: string): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;
  walk(sf, (n) => {
    if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n;
  });
  if (!found) throw new Error(`cli-dispatch-extract: variable ${name} not found`);
  return found;
}

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body) return st;
  }
  throw new Error(`cli-dispatch-extract: function ${name} not found`);
}

/** Property names of `const NAME = { ... }`, in source order. */
export function objectKeys(sf: ts.SourceFile, name: string): string[] {
  const init = findVariable(sf, name).initializer;
  if (!init || !ts.isObjectLiteralExpression(init)) throw new Error(`cli-dispatch-extract: ${name} is not an object literal`);
  return init.properties.map((p) => {
    if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      throw new Error(`cli-dispatch-extract: ${name} has a computed key`);
    }
    return p.name.text;
  });
}

function isCommandIdent(e: ts.Expression): boolean {
  return ts.isIdentifier(e) && e.text === 'command';
}

/**
 * Commands an `if` condition dispatches on: `command === 'x'` literals and
 * `SET.has(command)` expanded through `sets`. Negated / `!==` forms are not
 * dispatch conditions and are ignored.
 */
function commandsIn(expr: ts.Expression, sets: Record<string, string[]>): string[] {
  const out: string[] = [];
  walk(expr, (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      if (isCommandIdent(n.left) && ts.isStringLiteral(n.right)) out.push(n.right.text);
      else if (isCommandIdent(n.right) && ts.isStringLiteral(n.left)) out.push(n.left.text);
    }
    if (
      ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'has' &&
      ts.isIdentifier(n.expression.expression) && n.arguments.length === 1 && isCommandIdent(n.arguments[0]!)
    ) {
      const members = sets[n.expression.expression.text];
      if (members) out.push(...members);
    }
  });
  return [...new Set(out)];
}

/** `callee` is referenced anywhere under `node` (a call or a passed thunk). */
function containsCall(node: ts.Node, callee: string): boolean {
  let hit = false;
  walk(node, (n) => {
    if (ts.isIdentifier(n) && n.text === callee) hit = true;
  });
  return hit;
}

function isExitCall(st: ts.Statement): boolean {
  return ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) &&
    ts.isPropertyAccessExpression(st.expression.expression) &&
    st.expression.expression.getText() === 'process.exit';
}

/** The branch body always leaves handleCliOnly (last statement returns or exits). */
function terminates(st: ts.Statement): boolean {
  if (ts.isReturnStatement(st) || isExitCall(st)) return true;
  if (ts.isBlock(st)) {
    const last = st.statements[st.statements.length - 1];
    return !!last && (ts.isReturnStatement(last) || isExitCall(last));
  }
  return false;
}

/** A top-level statement of `handleCliOnly` whose try block runs `engine = await connectEngine(...)`. */
function isConnectTerminator(st: ts.Statement): boolean {
  if (!ts.isTryStatement(st)) return false;
  return st.tryBlock.statements.some((s) =>
    ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) &&
    s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(s.expression.left) && s.expression.left.text === 'engine' &&
    containsCall(s.expression.right, 'connectEngine'),
  );
}

function importSpecifiers(node: ts.Node): { literal: string[]; computed: string[] } {
  const literal: string[] = [];
  const computed: string[] = [];
  walk(node, (n) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteral(arg)) literal.push(arg.text);
      else computed.push(collapse(n.getText()));
    }
  });
  return { literal, computed };
}

export interface BranchRule {
  /** Whitespace-collapsed source text of the `if` condition. */
  condition: string;
  /** Body always returns / exits (the command never reaches the terminator). */
  terminates: boolean;
  /** Body references connectEngine (calls it or passes it as a thunk). */
  connectsEngine: boolean;
  /** Body consults isThinClient. */
  thinClientCheck: boolean;
  /** Body calls refuseThinClient. */
  refusesThinClient: boolean;
  /** Body calls routeThinClientCommand. */
  routesThinClient: boolean;
  /** Commands for which the condition is `command === 'c'` alone (or an `||` disjunct of it). */
  unconditionalFor: string[];
}

function rule(st: ts.IfStatement): BranchRule {
  return {
    unconditionalFor: commandsIn(st.expression, {}).filter((c) => isUnconditional(st.expression, c)),
    condition: collapse(st.expression.getText()),
    terminates: terminates(st.thenStatement),
    connectsEngine: containsCall(st.thenStatement, 'connectEngine'),
    thinClientCheck: containsCall(st, 'isThinClient'),
    refusesThinClient: containsCall(st.thenStatement, 'refuseThinClient'),
    routesThinClient: containsCall(st.thenStatement, 'routeThinClientCommand'),
  };
}

/** The condition is `command === 'c'`, or an `||` chain with that exact disjunct. */
function isUnconditional(e: ts.Expression, command: string): boolean {
  if (ts.isParenthesizedExpression(e)) return isUnconditional(e.expression, command);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return isUnconditional(e.left, command) || isUnconditional(e.right, command);
  }
  return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    isCommandIdent(e.left) && ts.isStringLiteral(e.right) && e.right.text === command;
}

/**
 * Subcommand literals a branch's `if (isThinClient(...))` block compares
 * against before it refuses (e.g. `jobsSub === 'list'`).
 */
function thinClientBranchSubcommands(st: ts.IfStatement): string[] {
  const subs: string[] = [];
  walk(st.thenStatement, (n) => {
    if (!ts.isIfStatement(n) || !containsCall(n.expression, 'isThinClient')) return;
    walk(n.thenStatement, (m) => {
      if (ts.isBinaryExpression(m) && m.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isIdentifier(m.left) && m.left.text !== 'command' && ts.isStringLiteral(m.right)) subs.push(m.right.text);
    });
  });
  return subs;
}

/** Subcommands `routeThinClientCommand` routes per command (src/commands/thin-client-routing.ts). */
export function thinClientRoutes(): Record<string, string[]> {
  const sf = parseTs('src/commands/thin-client-routing.ts');
  const fn = findFunction(sf, 'routeThinClientCommand');
  const routes: Record<string, string[]> = {};
  for (const st of fn.body!.statements) {
    if (!ts.isIfStatement(st)) continue;
    for (const cmd of commandsIn(st.expression, {})) {
      const subs: string[] = [];
      walk(st, (n) => {
        if (ts.isCaseClause(n) && ts.isStringLiteral(n.expression)) subs.push(n.expression.text);
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          ts.isIdentifier(n.left) && n.left.text === 'sub' && ts.isStringLiteral(n.right)) subs.push(n.right.text);
      });
      routes[cmd] = [...new Set([...(routes[cmd] ?? []), ...subs])];
    }
  }
  return routes;
}

export type Phase = 'pre-connect' | 'pre-connect-own-engine' | 'post-connect' | 'unhandled';
export type ThinClientMode = 'none' | 'refuse' | 'route-then-refuse';

export interface CommandDispatch {
  phase: Phase;
  thinClient: ThinClientMode;
  /** Subcommands routed over MCP before refusal (route-then-refuse only). */
  thinClientRoutedSubcommands: string[];
  /** Every pre-connect branch in handleCliOnly naming this command, in order. */
  preConnectRules: BranchRule[];
  hasSwitchCase: boolean;
}

export interface CliDispatchShape {
  sets: {
    CLI_ONLY: string[];
    CLI_ONLY_SELF_HELP: string[];
    SELF_HELP_WITHOUT_ENGINE: string[];
    THIN_CLIENT_REFUSED_COMMANDS: string[];
    THIN_CLIENT_REFUSE_HINTS: string[];
    STARTUP_HOOK_SKIP_COMMANDS: string[];
  };
  /** Source order of the CLI_ONLY literal (kept separately; order is not a set contract). */
  cliOnlySourceOrder: string[];
  /** Pre-dispatch rules in main() before `CLI_ONLY.has(command)`, in order. */
  mainRules: Array<BranchRule & { commands: string[] }>;
  /** Commands main() rewrites before dispatch (`if (command === 'a') command = 'b'`). */
  mainCommandRewrites: Record<string, string>;
  /** Condition of the handleCliOnly thin-client guard and its extra literal members. */
  thinClientGuard: { condition: string; members: string[] };
  /** Pre-connect branches that dispatch on no command literal but connect an engine. */
  commandAgnosticConnectBranches: string[];
  commands: Record<string, CommandDispatch>;
  switchCases: string[];
  /** Per switch case, the `import()` specifiers in order (EO13). */
  switchCaseImports: Record<string, string[]>;
  /** Every non-literal `import(...)` in src/cli.ts (EO13 expects none). */
  computedImports: string[];
}

/** Every .ts file of the CLI dispatch surface: src/cli.ts plus src/cli/** (sorted). */
function cliSurfaceFiles(): string[] {
  const out = ['src/cli.ts'];
  const walkDir = (rel: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, rel)).sort()) {
      const child = `${rel}/${entry}`;
      if (statSync(join(REPO_ROOT, child)).isDirectory()) walkDir(child);
      else if (entry.endsWith('.ts')) out.push(child);
    }
  };
  walkDir('src/cli');
  return out;
}

/** A module's `import()` specifier rewritten relative to src/, the way master's case bodies spelled it. */
function srcRelativeSpecifier(modulePath: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const abs = resolve(REPO_ROOT, dirname(modulePath), specifier);
  return `./${relative(join(REPO_ROOT, 'src'), abs).replace(/\\/g, '/')}`;
}

/** The rule master's plain `if (command === 'x') { ...; return; }` branch contributed, rebuilt from the module. */
function tableRule(name: string, run: ts.FunctionDeclaration): BranchRule {
  return {
    unconditionalFor: [name],
    condition: `command === '${name}'`,
    terminates: true,
    connectsEngine: containsCall(run.body!, 'connectEngine'),
    thinClientCheck: containsCall(run.body!, 'isThinClient'),
    refusesThinClient: containsCall(run.body!, 'refuseThinClient'),
    routesThinClient: containsCall(run.body!, 'routeThinClientCommand'),
  };
}

export function extractCliDispatch(): CliDispatchShape {
  const sf = parseTs('src/cli/main.ts');
  const cliOnly = [...TABLE_CLI_ONLY];
  const refused = [...TABLE_REFUSED];
  const setsByName: Record<string, string[]> = {
    CLI_ONLY: cliOnly,
    CLI_ONLY_SELF_HELP: [...TABLE_SELF_HELP],
    THIN_CLIENT_REFUSED_COMMANDS: refused,
    STARTUP_HOOK_SKIP_COMMANDS: [...TABLE_STARTUP_HOOK_SKIP],
  };
  const sorted = (xs: string[]) => [...xs].sort();

  const main = findFunction(sf, 'main');
  const mainRules: CliDispatchShape['mainRules'] = [];
  const mainCommandRewrites: Record<string, string> = {};
  for (const st of main.body!.statements) {
    if (!ts.isIfStatement(st)) continue;
    if (st.expression.getText() === 'CLI_ONLY.has(command)') break;
    const commands = commandsIn(st.expression, {});
    const text = collapse(st.expression.getText());
    if (commands.length === 0 && !/\bcommand\b/.test(text)) continue;
    mainRules.push({ ...rule(st), commands });
    walk(st.thenStatement, (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isCommandIdent(n.left) && ts.isStringLiteral(n.right) && commands.length === 1) {
        mainCommandRewrites[commands[0]!] = n.right.text;
      }
    });
  }

  const body = flattenCliPipeline(sf).statements;
  const terminatorIdx = body.findIndex(isConnectTerminator);
  if (terminatorIdx < 0) throw new Error('cli-dispatch-extract: connectEngine terminator not found in the handleCliOnly pipeline');
  const pre = body.slice(0, terminatorIdx);

  const astRecords = readTableRecords(REPO_ROOT);
  const modules = new Map(astRecords.map((r) => [r.name, r.loadSpecifier ? readCommandModule(REPO_ROOT, r.loadSpecifier) : null] as const));
  const switchCases: string[] = [];
  const switchCaseImports: Record<string, string[]> = {};
  for (const record of CLI_COMMANDS) {
    if (record.phase !== 'post-connect') continue;
    const mod = modules.get(record.name);
    if (!mod) throw new Error(`cli-dispatch-extract: post-connect record ${record.name} has no src/cli/commands module`);
    switchCases.push(record.name);
    switchCaseImports[record.name] = importSpecifiers(mod.run).literal.map((spec) => srcRelativeSpecifier(mod.path, spec));
  }

  const routes = thinClientRoutes();
  const firstIf = pre.find(ts.isIfStatement);
  if (!firstIf || !firstIf.expression.getText().includes('THIN_CLIENT_REFUSED_COMMANDS.has(command)')) {
    throw new Error('cli-dispatch-extract: handleCliOnly no longer opens with the thin-client guard');
  }
  const guardMembers = commandsIn(firstIf.expression, setsByName);
  const guardExtras = commandsIn(firstIf.expression, {});

  const commandAgnosticConnectBranches: string[] = [];
  const rulesByCommand = new Map<string, Array<{ st: ts.IfStatement | null; r: BranchRule }>>();
  const addRule = (c: string, entry: { st: ts.IfStatement | null; r: BranchRule }) => {
    const list = rulesByCommand.get(c) ?? [];
    list.push(entry);
    rulesByCommand.set(c, list);
  };
  const decided = (c: string) => (rulesByCommand.get(c) ?? []).some(({ r }) => r.unconditionalFor.includes(c) && r.terminates);
  for (const st of pre) {
    if (isTableStep(st, PRE_CONNECT_TABLE_STEP)) {
      for (const record of CLI_COMMANDS) {
        if (record.phase === 'post-connect' || record.dispatchedBy || decided(record.name)) continue;
        const mod = modules.get(record.name);
        if (!mod) throw new Error(`cli-dispatch-extract: pre-connect record ${record.name} has no src/cli/commands module`);
        addRule(record.name, { st: null, r: tableRule(record.name, mod.run) });
      }
      continue;
    }
    if (!ts.isIfStatement(st) || st === firstIf) continue;
    const cmds = commandsIn(st.expression, setsByName);
    if (cmds.length === 0) {
      if (containsCall(st.thenStatement, 'connectEngine')) commandAgnosticConnectBranches.push(collapse(st.expression.getText()));
      continue;
    }
    for (const c of cmds) addRule(c, { st, r: rule(st) });
  }

  const commands: Record<string, CommandDispatch> = {};
  const all = [...new Set([...cliOnly, ...switchCases, ...rulesByCommand.keys()])].sort();
  for (const c of all) {
    const rules = rulesByCommand.get(c) ?? [];
    const decisive = rules.find(({ r }) => r.unconditionalFor.includes(c) && r.terminates);
    const hasSwitchCase = switchCases.includes(c);
    const phase: Phase = decisive
      ? (decisive.r.connectsEngine ? 'pre-connect-own-engine' : 'pre-connect')
      : hasSwitchCase ? 'post-connect' : 'unhandled';
    let thinClient: ThinClientMode = 'none';
    let routed: string[] = [];
    if (guardMembers.includes(c)) {
      routed = routes[c] ?? [];
      thinClient = routed.length > 0 ? 'route-then-refuse' : 'refuse';
    } else if (rules.some(({ r }) => r.refusesThinClient)) {
      const refusing = rules.filter(({ r }) => r.refusesThinClient);
      routed = [...new Set([...refusing.flatMap(({ st }) => (st ? thinClientBranchSubcommands(st) : [])), ...(routes[c] ?? [])])];
      thinClient = routed.length > 0 ? 'route-then-refuse' : 'refuse';
    }
    commands[c] = {
      phase,
      thinClient,
      thinClientRoutedSubcommands: routed,
      preConnectRules: rules.map(({ r }) => r),
      hasSwitchCase,
    };
  }

  return {
    sets: {
      CLI_ONLY: sorted(cliOnly),
      CLI_ONLY_SELF_HELP: sorted(setsByName.CLI_ONLY_SELF_HELP!),
      SELF_HELP_WITHOUT_ENGINE: sorted(objectKeys(sf, 'SELF_HELP_WITHOUT_ENGINE')),
      THIN_CLIENT_REFUSED_COMMANDS: sorted(refused),
      THIN_CLIENT_REFUSE_HINTS: sorted(objectKeys(sf, 'THIN_CLIENT_REFUSE_HINTS')),
      STARTUP_HOOK_SKIP_COMMANDS: sorted(setsByName.STARTUP_HOOK_SKIP_COMMANDS!),
    },
    cliOnlySourceOrder: cliOnly,
    mainRules,
    mainCommandRewrites,
    thinClientGuard: { condition: collapse(firstIf.expression.getText()), members: guardExtras },
    commandAgnosticConnectBranches,
    commands,
    switchCases,
    switchCaseImports,
    computedImports: cliSurfaceFiles().flatMap((rel) => importSpecifiers(parseTs(rel)).computed),
  };
}
