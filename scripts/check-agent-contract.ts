#!/usr/bin/env bun
/**
 * Agent operator contract scanner (docs/designs/AGENT_OPERATOR_WAVE.md, B9).
 *
 * Syntax-only TypeScript AST walk over src/**\/*.ts. Every rule counts hits
 * per file; per-rule baselines under scripts/agent-contract-baselines/<rule>.tsv
 * (`path<TAB>count`, sorted) are SHRINK-ONLY: a file over its baseline fails
 * (new violation), a file under it fails until the baseline is lowered
 * (`--update` rewrites baselines and refuses any increase). Rules with no
 * baseline file must have zero hits.
 *
 * Rules:
 *   suggestionless-operation-error  new OperationError(code, msg) without a suggestion (use opError)
 *   throw-new-error-in-ops          `throw new Error` in src/core/ops/**, src/mcp/** or an op `handler:` body
 *   hand-built-command              a `fix` / `next_action` value written as a 'gbrain …' string (build argv; shellQuote renders)
 *   legacy-advice-key               a legacy advice key (next_action, fix_argv, hint, docs_url, …) outside the alias allowlist
 *   interactive-io                  raw stdin/readline/raw-mode reads outside interaction.ts / consent.ts and INTERACTIVE_IO_ALLOW (streams/TUI, with a reason)
 *   yes-rerun-string                a raw "re-run with --yes" string outside consent.ts
 *   stdio-inherit                   `stdio: 'inherit'` outside spawnCliChild (cli-force-exit.ts)
 *   marker-literal                  [AGENT] / [SHOW USER] / "ACTION FOR THE AGENT:" outside agent-output.ts / agent-markers.ts
 *   verify-not-read-only            a fix `verify.argv` naming a command not declared read_only
 *   flag-in-mcp-text                a bare `--flag` in MCP-visible error text or an op description (src/core/ops, src/mcp)
 *                                   outside a full `gbrain …` command; render per surface with paramUse()/invalidParam()
 *   in-scope-placeholder            a `<placeholder>` in a fix argv without declared `inputs`, or in an error suggestion
 *                                   (fill the value from scope; only genuinely unknown values are `inputs`;
 *                                   an op's `cliOnly.argv` template is exempt: cliOnlyRefusal declares its inputs)
 *   retry-on-mutating               "retry" advice in an error raised by a mutating, non-idempotent op handler
 *                                   (say "inspect state before resubmitting"; retry only with the same request identity)
 *   defaulted-suggestion            a function that builds an error (opError, new OperationError, usageError, invalidParam,
 *                                   hostOnlyError) from a suggestion/hint parameter that has a default, is optional or is
 *                                   `??`-defaulted: each call site names its own next step (never baselined)
 *   generic-suggestion              a suggestion whose whole text is boilerplate ("see --help", "try again", "check your
 *                                   input"), at an error constructor or a funnel call site; name the exact usage (never baselined)
 *   unregistered-code               a literal error code thrown in src/ missing from src/core/error-registry.ts (never baselined)
 *   code-naming                     a registry code that is not snake_case or carries a transport prefix (never baselined)
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree; baselines read from <root>/baselines/).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const FIXTURE_ROOT = process.env.GBRAIN_GUARD_ROOT;
const ROOT = FIXTURE_ROOT ?? join(import.meta.dir, '..');
const BASELINE_DIR = FIXTURE_ROOT ? join(FIXTURE_ROOT, 'baselines') : join(ROOT, 'scripts', 'agent-contract-baselines');
const DOCS = 'docs/designs/AGENT_OPERATOR_WAVE.md (B9)';

export type Rule =
  | 'suggestionless-operation-error' | 'throw-new-error-in-ops' | 'hand-built-command' | 'legacy-advice-key'
  | 'interactive-io' | 'yes-rerun-string' | 'stdio-inherit' | 'marker-literal' | 'verify-not-read-only'
  | 'flag-in-mcp-text' | 'in-scope-placeholder' | 'retry-on-mutating'
  | 'defaulted-suggestion' | 'generic-suggestion' | 'unregistered-code' | 'code-naming';

export const BASELINED_RULES: readonly Rule[] = [
  'suggestionless-operation-error', 'throw-new-error-in-ops', 'hand-built-command', 'legacy-advice-key',
  'interactive-io', 'yes-rerun-string', 'stdio-inherit', 'marker-literal', 'verify-not-read-only',
  'flag-in-mcp-text', 'in-scope-placeholder', 'retry-on-mutating',
];

export interface Hit { rule: Rule; file: string; line: number; text: string }

/**
 * interactive-io reads that are data streams or terminal UI, not prompts:
 * path → call → one-line reason. A prompt (a question the user answers) never
 * belongs here; it goes through interaction.ts (readLine / promptYesNo).
 */
export const INTERACTIVE_IO_ALLOW: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'src/commands/hook.ts': {
    'process.stdin.on': 'harness hook payload: bounded, fail-open stream read with its own hard timeout (a hook never blocks the agent)',
  },
  'src/commands/watch.ts': {
    createInterface: 'stdin IS the data: transcript turns streamed line by line until EOF or SIGINT',
  },
  'src/commands/jobs-watch.ts': {
    'process.stdin.setRawMode': "TTY-only dashboard: raw mode so a single 'q' keypress quits",
    'process.stdin.on': "TTY-only dashboard: the 'q' / Ctrl-C keypress listener",
  },
  'src/mcp/server.ts': {
    'process.stdin.on': 'stdio MCP transport lifecycle: shut down when the client closes stdin',
  },
};

const LEGACY_ADVICE_KEYS = new Set(['next_action', 'fix_argv', 'agent_action', 'recovery_action', 'docs_url', 'hint', 'remediation', 'next_step']);
const MARKER_RE = /\[\/?AGENT\]|\[\/?SHOW USER\]|ACTION FOR THE AGENT:/;
const YES_RERUN_RE = /re-?run\b[^.\n]{0,40}--yes/i;
const TRANSPORT_PREFIX = /^(mcp|http|cli|stdio)_/;
const ERROR_CALLEE = /^(OperationError|verbError|opError|OperationError\.bare|hostOnlyError)$/;
const FLAG_RE = /(?:^|[\s(`'"])--[a-z][a-z0-9-]*/;
const PLACEHOLDER_RE = /<(?:source|source[-_]id|slug|id|request[-_]id|client[-_]id|page|uuid|brain|name)>/;
const RETRY_RE = /\bretry\b/i;
const SAFE_RETRY_RE = /(?:do not|don't|never) retry|same request_id|same request identity/i;

const SUGGESTION_PARAM = /(?:suggestion|hint)$/i;
const SUGGESTION_SINK = /^(opError|OperationError|usageError|invalidParam|hostOnlyError)$/;
const SUGGESTION_ARG: Readonly<Record<string, number>> = { opError: 2, OperationError: 2, verbError: 2, usageError: 1 };
const GENERIC_SUGGESTION: readonly RegExp[] = [
  /^(?:please )?(?:see|check|read|consult|run|use)(?: with)?(?: the)? (?:gbrain(?: [a-z][a-z0-9-]*)* )?--help(?: (?:output|for usage|for details|for options))?$/,
  /^(?:please )?(?:check|verify|fix|correct|review) (?:your|the) (?:input|arguments|parameters|params|request|options)$/,
  /^(?:please )?(?:try again|retry)(?: later)?$/,
  /^(?:please )?(?:see|check|read) (?:the )?(?:docs|documentation)$/,
];

/** True when a suggestion names no next step: empty, or only a generic denylist phrase. */
export function isGenericSuggestion(text: string): boolean {
  const t = text.replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.!]+$/, '');
  return t === '' || GENERIC_SUGGESTION.some(re => re.test(t));
}

type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
const isFnLike = (n: ts.Node): n is FnLike => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);

function fnName(fn: FnLike): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  return ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : undefined;
}

/** Error-constructor calls in a function body (the `defaulted-suggestion` sinks). */
function sinkCalls(fn: FnLike, sf: ts.SourceFile): Array<ts.CallExpression | ts.NewExpression> {
  const out: Array<ts.CallExpression | ts.NewExpression> = [];
  const visit = (n: ts.Node) => {
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && SUGGESTION_SINK.test(n.expression.getText(sf))) out.push(n);
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}

function nullishDefaulted(fn: FnLike, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      && ts.isIdentifier(n.left) && n.left.text === name) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

/** A file-local function that forwards one of its parameters as an error's suggestion. */
interface Funnel { name: string; index: number }
export interface FunnelSite { file: string; line: number; funnel: string; texts: string[] | undefined; expr: string }

/** File-level `const NAME = <string literal>` bindings, so a shared suggestion constant counts as literal text. */
function literalConsts(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of statement.declarationList.declarations) {
      const t = ts.isIdentifier(d.name) && d.initializer ? flatText(d.initializer, sf) : undefined;
      if (t !== undefined) out.set((d.name as ts.Identifier).text, t);
    }
  }
  return out;
}

/** Literal texts of a suggestion expression (each branch of a conditional); undefined when any branch is not literal. */
function suggestionTexts(n: ts.Expression, sf: ts.SourceFile, consts: Map<string, string>): string[] | undefined {
  if (ts.isParenthesizedExpression(n)) return suggestionTexts(n.expression, sf, consts);
  if (ts.isConditionalExpression(n)) {
    const a = suggestionTexts(n.whenTrue, sf, consts); const b = suggestionTexts(n.whenFalse, sf, consts);
    return a && b ? [...a, ...b] : undefined;
  }
  const t = ts.isIdentifier(n) ? consts.get(n.text) : flatText(n, sf);
  return t === undefined ? undefined : [t];
}

function fileFunnels(sf: ts.SourceFile): Funnel[] {
  const fns: FnLike[] = [];
  const collect = (n: ts.Node) => { if (isFnLike(n)) fns.push(n); ts.forEachChild(n, collect); };
  collect(sf);
  const out: Funnel[] = [];
  const forwards = (fn: FnLike, param: string): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const callee = n.expression.getText(sf);
        const args = n.arguments ?? [];
        if (SUGGESTION_SINK.test(callee) && args.some(a => ts.isIdentifier(a) && a.text === param)) found = true;
        for (const f of out) if (f.name === callee && ts.isIdentifier(args[f.index] ?? n) && (args[f.index] as ts.Identifier).text === param) found = true;
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    return found;
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const fn of fns) {
      const name = fnName(fn);
      if (!name) continue;
      fn.parameters.forEach((p, index) => {
        if (!ts.isIdentifier(p.name) || !SUGGESTION_PARAM.test(p.name.text) || out.some(f => f.name === name && f.index === index)) return;
        if (forwards(fn, p.name.text)) { out.push({ name, index }); grew = true; }
      });
    }
  }
  return out;
}

/** The suggestion parameter names of the function enclosing `n` (a forwarding call is not a call site). */
function enclosingSuggestionParams(n: ts.Node): Set<string> {
  for (let p = n.parent; p; p = p.parent) {
    if (isFnLike(p)) return new Set(p.parameters.flatMap(q => ts.isIdentifier(q.name) && SUGGESTION_PARAM.test(q.name.text) ? [q.name.text] : []));
  }
  return new Set();
}

function funnelCallSites(sf: ts.SourceFile, path: string): FunnelSite[] {
  const funnels = fileFunnels(sf);
  if (!funnels.length) return [];
  const out: FunnelSite[] = [];
  const consts = literalConsts(sf);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      for (const f of funnels) {
        if (f.name !== n.expression.text) continue;
        const arg = n.arguments[f.index];
        if (arg && ts.isIdentifier(arg) && enclosingSuggestionParams(n).has(arg.text)) continue;
        out.push({
          file: path, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, funnel: f.name,
          texts: arg ? suggestionTexts(arg, sf, consts) : undefined, expr: arg ? arg.getText(sf) : '',
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every call site of a suggestion-forwarding funnel (`invalid`, `fail`, `usage`, …) under src/, or in the named files. */
export function funnelSites(files?: readonly string[], root: string = ROOT): FunnelSite[] {
  const paths = files ? files.map(f => join(root, f)) : tsFiles(join(root, 'src'));
  return paths.flatMap(file => funnelCallSites(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true), rel(file)));
}

/** Text args of an error constructor call: message (1) and suggestion (2); hostOnlyError's message is arg 2. */
function errorTextArgs(n: ts.CallExpression | ts.NewExpression, sf: ts.SourceFile): ts.Expression[] {
  const callee = n.expression.getText(sf);
  const args = n.arguments ?? [];
  return callee === 'hostOnlyError' ? args.slice(2, 3) : args.slice(1, 3);
}

/** The op object literal (has `mutating:` and `handler:`) whose handler encloses `n`, if any. */
function enclosingOp(n: ts.Node): ts.ObjectLiteralExpression | undefined {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isPropertyAssignment(p) && propName(p) === 'handler' && ts.isObjectLiteralExpression(p.parent)) return p.parent;
  }
  return undefined;
}

function literalProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p) === name) return p.initializer.getText();
  }
  return undefined;
}
/** Read-only invocations a verify step may always name (doctor --only is the canonical one). */
const STATIC_READ_ONLY = new Set(['doctor', 'errors', 'status', 'get', 'search', 'query', 'list', 'write-request', 'write-requests', 'whoami', 'stats']);
/** Read-only subcommands of otherwise-mutating commands. */
const READ_ONLY_SUBCOMMANDS = new Set(['config get', 'sources list', 'sources status', 'jobs get', 'jobs stats', 'jobs list', 'auth list', 'auth clients', 'backup status', 'engine status',
  // Engine graduation: --status and --plan are zero-mutation (pre-connect; no schema migration, no target DDL).
  'migrate --status', 'migrate --plan']);

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir).sort()) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (e.endsWith('.ts') && !e.endsWith('.generated.ts')) out.push(full);
  }
  return out;
}

const rel = (f: string) => relative(ROOT, f).split(sep).join('/');

function stringText(n: ts.Node): string | undefined {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => s.literal.text).join('');
  return undefined;
}

/** String text of a literal or a `'a' + 'b'` concatenation of literals. */
function flatText(n: ts.Node, sf: ts.SourceFile): string | undefined {
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = flatText(n.left, sf); const r = flatText(n.right, sf);
    return l !== undefined && r !== undefined ? l + r : undefined;
  }
  if (ts.isParenthesizedExpression(n)) return flatText(n.expression, sf);
  return stringText(n);
}

function literalCodes(n: ts.Node): string[] {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
  if (ts.isConditionalExpression(n)) return [...literalCodes(n.whenTrue), ...literalCodes(n.whenFalse)];
  if (ts.isParenthesizedExpression(n)) return literalCodes(n.expression);
  return [];
}

function propName(n: ts.ObjectLiteralElementLike): string | undefined {
  if (!n.name) return undefined;
  if (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) return n.name.text;
  return undefined;
}

function insideHandler(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isPropertyAssignment(p) && propName(p) === 'handler') return true;
  }
  return false;
}

/** Every literal error code thrown in one file (OperationError family, StructuredError builders, CredentialError). */
export function collectThrownCodes(sf: ts.SourceFile): Array<{ code: string; line: number }> {
  const out: Array<{ code: string; line: number }> = [];
  const visit = (n: ts.Node) => {
    if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && n.arguments?.length) {
      const callee = n.expression.getText(sf);
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      if (/^(OperationError|verbError|opError|OperationError\.bare|CredentialError)$/.test(callee)) {
        for (const code of literalCodes(n.arguments[0])) out.push({ code, line });
      } else if (/^(errorFor|buildError)$/.test(callee) && ts.isObjectLiteralExpression(n.arguments[0])) {
        for (const p of n.arguments[0].properties) {
          if (ts.isPropertyAssignment(p) && propName(p) === 'code') for (const code of literalCodes(p.initializer)) out.push({ code, line });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Registered codes, parsed syntactically from the registry module (fixture-safe). */
export function registeredCodes(root: string = ROOT): Set<string> | null {
  const path = join(root, 'src', 'core', 'error-registry.ts');
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const body = text.slice(text.indexOf('export const CODES'));
  return new Set([...body.matchAll(/^ {2}([a-z0-9_]+): \{/gm)].map(m => m[1]!));
}

function readOnlyCommands(root: string): Set<string> {
  const set = new Set(STATIC_READ_ONLY);
  const table = join(root, 'src', 'cli', 'command-table.ts');
  if (existsSync(table)) {
    for (const m of readFileSync(table, 'utf8').matchAll(/\{ name: '([a-z0-9-]+)'[^\n]*read_only: true/g)) set.add(m[1]!);
  }
  return set;
}

export function scan(root: string = ROOT): Hit[] {
  const hits: Hit[] = [];
  const readOnly = readOnlyCommands(root);
  const registry = registeredCodes(root);
  for (const file of tsFiles(join(root, 'src'))) {
    const path = rel(file);
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const isOpsOrMcp = path.startsWith('src/core/ops/') || path.startsWith('src/mcp/');
    const ioExempt = path === 'src/core/interaction.ts' || path === 'src/core/consent.ts';
    const markerExempt = path === 'src/core/agent-output.ts' || path === 'src/core/agent-markers.ts';
    const add = (rule: Rule, n: ts.Node) => hits.push({
      rule, file: path, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      text: n.getText(sf).split('\n')[0]!.slice(0, 120),
    });
    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n) && n.expression.getText(sf) === 'OperationError' && path !== 'src/core/ops/contract.ts') {
        const args = n.arguments ?? [];
        if (args.length < 3 || args[2]!.getText(sf) === 'undefined') add('suggestionless-operation-error', n);
      }
      if (isFnLike(n) && sinkCalls(n, sf).length) {
        for (const p of n.parameters) {
          if (!ts.isIdentifier(p.name) || !SUGGESTION_PARAM.test(p.name.text)) continue;
          if (p.initializer || p.questionToken || nullishDefaulted(n, p.name.text)) add('defaulted-suggestion', p);
        }
      }
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && SUGGESTION_ARG[n.expression.getText(sf)] !== undefined) {
        const arg = (n.arguments ?? [])[SUGGESTION_ARG[n.expression.getText(sf)]!];
        const t = arg ? flatText(arg, sf) : undefined;
        if (t !== undefined && isGenericSuggestion(t)) add('generic-suggestion', arg!);
      }
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && ERROR_CALLEE.test(n.expression.getText(sf))) {
        const texts = errorTextArgs(n, sf);
        for (const arg of texts) {
          const t = stringText(arg);
          if (t === undefined) continue;
          if (isOpsOrMcp && FLAG_RE.test(t) && !t.includes('gbrain ')) add('flag-in-mcp-text', arg);
        }
        const suggestion = n.expression.getText(sf) === 'hostOnlyError' ? undefined : stringText((n.arguments ?? [])[2] ?? n);
        if (suggestion !== undefined && (n.arguments ?? [])[2] && PLACEHOLDER_RE.test(suggestion)) add('in-scope-placeholder', n.arguments![2]!);
        const op = enclosingOp(n);
        if (op && suggestion !== undefined && (n.arguments ?? [])[2] && literalProp(op, 'mutating') === 'true' && literalProp(op, 'idempotent') !== 'true'
          && RETRY_RE.test(suggestion) && !SAFE_RETRY_RE.test(suggestion)) add('retry-on-mutating', n.arguments![2]!);
      }
      if (ts.isArrayLiteralExpression(n) && ts.isPropertyAssignment(n.parent) && propName(n.parent) === 'argv'
        && ts.isObjectLiteralExpression(n.parent.parent) && literalProp(n.parent.parent, 'inputs') === undefined
        && !(ts.isPropertyAssignment(n.parent.parent.parent) && propName(n.parent.parent.parent) === 'cliOnly')
        && n.elements.some(e => /^<[^>]+>$/.test(stringText(e) ?? ''))) add('in-scope-placeholder', n);
      if (isOpsOrMcp && path.startsWith('src/core/ops/') && ts.isPropertyAssignment(n) && propName(n) === 'description'
        && ts.isObjectLiteralExpression(n.parent) && literalProp(n.parent, 'handler') !== undefined) {
        const t = flatText(n.initializer, sf);
        if (t !== undefined && FLAG_RE.test(t) && !t.includes('gbrain ')) add('flag-in-mcp-text', n);
      }
      if (ts.isThrowStatement(n) && n.expression && ts.isNewExpression(n.expression) && n.expression.expression.getText(sf) === 'Error'
        && (isOpsOrMcp || insideHandler(n))) add('throw-new-error-in-ops', n);
      if (ts.isPropertyAssignment(n)) {
        const name = propName(n);
        const value = stringText(n.initializer);
        if ((name === 'fix' || name === 'next_action') && value !== undefined && /(^|`|\s)gbrain /.test(value)) add('hand-built-command', n);
        if (name && LEGACY_ADVICE_KEYS.has(name)) add('legacy-advice-key', n);
        if (name === 'stdio' && value === 'inherit' && path !== 'src/core/cli-force-exit.ts') add('stdio-inherit', n);
        if (name === 'verify' && ts.isObjectLiteralExpression(n.initializer)) {
          for (const p of n.initializer.properties) {
            if (!ts.isPropertyAssignment(p) || propName(p) !== 'argv' || !ts.isArrayLiteralExpression(p.initializer)) continue;
            const words = p.initializer.elements.map(e => stringText(e));
            if (words[0] !== 'gbrain' || words[1] === undefined) continue;
            if (!readOnly.has(words[1]!) && !READ_ONLY_SUBCOMMANDS.has(`${words[1]} ${words[2]}`)) add('verify-not-read-only', p);
          }
        }
      }
      if (ts.isShorthandPropertyAssignment(n) && LEGACY_ADVICE_KEYS.has(n.name.text)) add('legacy-advice-key', n);
      if (!ioExempt) {
        if (ts.isCallExpression(n)) {
          const callee = n.expression.getText(sf);
          if ((/(^|\.)createInterface$/.test(callee) || /^process\.stdin\.(on|once)$/.test(callee) || /\.setRawMode$/.test(callee))
            && !INTERACTIVE_IO_ALLOW[path]?.[callee]) add('interactive-io', n);
          if (/(^|\.)readFileSync$/.test(callee) && n.arguments[0] && stringText(n.arguments[0]) === '/dev/stdin') add('interactive-io', n);
        }
        if (ts.isForOfStatement(n) && n.awaitModifier && n.expression.getText(sf) === 'process.stdin') add('interactive-io', n);
      }
      const lit = stringText(n);
      if (lit !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n))) {
        if (!markerExempt && MARKER_RE.test(lit)) add('marker-literal', n);
        if (path !== 'src/core/consent.ts' && YES_RERUN_RE.test(lit)) add('yes-rerun-string', n);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const site of funnelCallSites(sf, path)) {
      if (site.texts?.some(isGenericSuggestion)) {
        hits.push({ rule: 'generic-suggestion', file: path, line: site.line, text: `${site.funnel}(…, ${site.expr.slice(0, 100)})` });
      }
    }
    if (registry) {
      for (const { code, line } of collectThrownCodes(sf)) {
        if (!registry.has(code)) hits.push({ rule: 'unregistered-code', file: path, line, text: code });
      }
    }
  }
  if (registry) {
    for (const code of registry) {
      if (!/^[a-z][a-z0-9_]*$/.test(code) || TRANSPORT_PREFIX.test(code)) {
        hits.push({ rule: 'code-naming', file: 'src/core/error-registry.ts', line: 0, text: code });
      }
    }
  }
  return hits;
}

function readBaseline(rule: Rule): Map<string, number> | null {
  const path = join(BASELINE_DIR, `${rule}.tsv`);
  if (!existsSync(path)) return null;
  const m = new Map<string, number>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [file, count] = line.split('\t');
    m.set(file!, Number(count));
  }
  return m;
}

function countsByFile(hits: Hit[], rule: Rule): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of hits) if (h.rule === rule) m.set(h.file, (m.get(h.file) ?? 0) + 1);
  return m;
}

function writeBaseline(rule: Rule, counts: Map<string, number>): void {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const lines = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([f, c]) => `${f}\t${c}`);
  writeFileSync(join(BASELINE_DIR, `${rule}.tsv`),
    `# shrink-only baseline for scripts/check-agent-contract.ts rule ${rule}: path<TAB>count\n${lines.join('\n')}${lines.length ? '\n' : ''}`);
}

function main(): number {
  const update = process.argv.includes('--update');
  const started = performance.now();
  const hits = scan();
  const failures: string[] = [];
  for (const h of hits) {
    if (h.rule === 'unregistered-code') failures.push(`${h.file}:${h.line} [unregistered-code] '${h.text}' is thrown but not registered — add a row to src/core/error-registry.ts, then bun run build:error-codes`);
    if (h.rule === 'defaulted-suggestion') failures.push(`${h.file}:${h.line} [defaulted-suggestion] ${h.text}: a default suggestion lets call sites skip their next step — make it required and pass one at every call site`);
    if (h.rule === 'generic-suggestion') failures.push(`${h.file}:${h.line} [generic-suggestion] ${h.text}: name the exact next step (the flag usage, the command, the value to pass), not a generic phrase`);
    if (h.rule === 'code-naming') failures.push(`[code-naming] registry code '${h.text}' must be snake_case with no transport prefix`);
  }
  for (const rule of BASELINED_RULES) {
    const counts = countsByFile(hits, rule);
    const baseline = readBaseline(rule) ?? new Map<string, number>();
    if (update) {
      const grew = [...counts].filter(([f, c]) => c > (baseline.get(f) ?? 0));
      if (grew.length && !process.argv.includes('--allow-grow')) {
        for (const [f, c] of grew) failures.push(`${f} [${rule}] ${c} > baseline ${baseline.get(f) ?? 0}: --update only shrinks baselines`);
      } else {
        writeBaseline(rule, counts);
      }
      continue;
    }
    for (const [file, count] of counts) {
      const allowed = baseline.get(file) ?? 0;
      if (count > allowed) {
        const where = hits.filter(h => h.rule === rule && h.file === file).map(h => `    ${h.file}:${h.line}  ${h.text}`).join('\n');
        failures.push(`${file} [${rule}] ${count} hit(s), baseline ${allowed}. New violation(s):\n${where}`);
      }
    }
    for (const [file, allowed] of baseline) {
      const count = counts.get(file) ?? 0;
      if (count < allowed) failures.push(`${file} [${rule}] shrank to ${count} (baseline ${allowed}): lower the baseline with bun scripts/check-agent-contract.ts --update`);
    }
  }
  const ms = Math.round(performance.now() - started);
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(`check-agent-contract: ${failures.length} failure(s) in ${ms}ms. See ${DOCS}.`);
    return 1;
  }
  console.log(`check-agent-contract: OK (${hits.length} baselined hits, ${ms}ms)`);
  return 0;
}

if (import.meta.main) process.exit(main());
