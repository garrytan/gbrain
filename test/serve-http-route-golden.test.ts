/**
 * serve-http route golden by AST (refactor wave 1: A16 + TE1).
 *
 * Protects: the ordered Express registration stack built by `runServeHttp`
 * (global `app.use` middleware, per-route method + path + ordered middleware
 * identities, conditional SPA mounts) is unchanged when W4 splits
 * serve-http.ts into `serve-http-<area>.ts` modules.
 * Fails when: a route is dropped, reordered, gains or loses middleware
 * (e.g. `requireAdmin`, a rate limiter, a body parser), or a global
 * middleware moves relative to the routes it must precede.
 * Why new: the admin-route guard checks `requireAdmin` presence on /admin
 * routes only; nothing pins the full ordered stack.
 *
 * Capture: static walk of `runServeHttp` in source order. Any call that passes
 * the app object to a function declared in a `src/commands/serve-http*.ts`
 * module is followed into that function, so moving registrations into
 * `mount<Area>(app, ...)` keeps the flattened list identical. Handler bodies are
 * `<inline>` (the 415-line /mcp handler is decomposed in W4); factories are
 * recorded by callee and normalized arguments; a mount function's parameters
 * are replaced by the caller's argument identities (so `rateLimiter` inside a
 * mount reads as the limiter the caller passed). The SDK `authRouter`'s own routes
 * are not visible statically; the runtime golden added with the W4
 * `buildServeHttpApp` extraction covers them.
 * Normalizer `serve-http-routes-v1`: identity (AST output is deterministic),
 * proven stable by the double capture below.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { normalizeNode } from '../scripts/lib/normalize-tokens.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable, sha256 } from './helpers/golden.ts';

const COMMANDS_DIR = join(import.meta.dir, '..', 'src', 'commands');
const APP_METHODS = new Set(['use', 'get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head', 'set', 'enable', 'disable']);
const MAX_INLINE_ARG = 120;

export interface RouteEntry {
  method: string;
  path: string | null;
  handlers: string[];
  when: string[];
}

function loadModules(): Map<string, { sf: ts.SourceFile; fn: ts.FunctionDeclaration }> {
  const fns = new Map<string, { sf: ts.SourceFile; fn: ts.FunctionDeclaration }>();
  const files = readdirSync(COMMANDS_DIR).filter((f) => /^serve-http.*\.ts$/.test(f)).sort();
  for (const file of files) {
    const path = join(COMMANDS_DIR, file);
    // test-reads-source-ok[structural]: TE1 route golden is an AST extraction over serve-http*.ts on master; no app handle exists before the W4 buildServeHttpApp extraction.
    const text = readFileSync(path, 'utf8');
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        if (fns.has(stmt.name.text)) throw new Error(`duplicate function ${stmt.name.text} across serve-http modules`);
        fns.set(stmt.name.text, { sf, fn: stmt });
      }
    }
  }
  return fns;
}

function identity(node: ts.Expression, sf: ts.SourceFile, bindings: ReadonlyMap<string, string>): string {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return '<inline>';
  if (ts.isIdentifier(node)) return bindings.get(node.text) ?? node.text;
  if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text);
  if (ts.isPropertyAccessExpression(node)) return normalizeNode(node, sf).replace(/ /g, '');
  if (ts.isCallExpression(node)) {
    const callee = normalizeNode(node.expression, sf).replace(/ /g, '');
    const args = node.arguments.map((a) => {
      if (ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isCallExpression(a) || ts.isIdentifier(a)) return identity(a, sf, bindings);
      const text = normalizeNode(a, sf);
      return text.length <= MAX_INLINE_ARG ? text : `#${sha256(text).slice(0, 12)}`;
    });
    return `${callee}(${args.join(', ')})`;
  }
  const text = normalizeNode(node, sf);
  return text.length <= MAX_INLINE_ARG ? text : `#${sha256(text).slice(0, 12)}`;
}

export function extractServeHttpRoutes(): RouteEntry[] {
  const fns = loadModules();
  const entry = fns.get('runServeHttp');
  if (!entry) throw new Error('runServeHttp not found in src/commands/serve-http*.ts');
  const routes: RouteEntry[] = [];

  const walkFunction = (fn: ts.FunctionDeclaration, sf: ts.SourceFile, appName: string, bindings: ReadonlyMap<string, string>, when: string[], depth: number): void => {
    if (depth > 8) throw new Error('mount recursion too deep');
    const consts = new Map<string, string>();
    const visit = (node: ts.Node, ctx: string[]): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) {
        consts.set(node.name.text, node.initializer.text);
      }
      if (ts.isIfStatement(node)) {
        const cond = normalizeNode(node.expression, sf);
        visit(node.expression, ctx);
        visit(node.thenStatement, [...ctx, `if ${cond}`]);
        if (node.elseStatement) visit(node.elseStatement, [...ctx, `else ${cond}`]);
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === appName && APP_METHODS.has(callee.name.text)) {
          const [first, ...rest] = node.arguments;
          let path: string | null = null;
          let handlerArgs: readonly ts.Expression[] = node.arguments;
          if (first && ts.isStringLiteralLike(first)) {
            path = first.text;
            handlerArgs = rest;
          } else if (first && ts.isIdentifier(first) && consts.has(first.text)) {
            path = consts.get(first.text)!;
            handlerArgs = rest;
          }
          routes.push({ method: callee.name.text, path, handlers: handlerArgs.map((a) => identity(a, sf, bindings)), when: ctx });
          return;
        }
        const appIndex = node.arguments.findIndex((a) => ts.isIdentifier(a) && a.text === appName);
        if (appIndex >= 0 && ts.isIdentifier(callee) && fns.has(callee.text)) {
          const target = fns.get(callee.text)!;
          const param = target.fn.parameters[appIndex];
          if (!param || !ts.isIdentifier(param.name)) throw new Error(`${callee.text}: app parameter ${appIndex} is not an identifier`);
          const inner = new Map<string, string>();
          target.fn.parameters.forEach((p, i) => {
            const arg = node.arguments[i];
            if (i !== appIndex && arg && ts.isIdentifier(p.name)) inner.set(p.name.text, identity(arg, sf, bindings));
          });
          walkFunction(target.fn, target.sf, param.name.text, inner, ctx, depth + 1);
          return;
        }
      }
      ts.forEachChild(node, (child) => visit(child, ctx));
    };
    visit(fn.body!, when);
  };

  walkFunction(entry.fn, entry.sf, 'app', new Map(), [], 0);
  return routes;
}

const normalizer = defineNormalizer('serve-http-routes-v1', (routes: RouteEntry[]) => routes);

describe('serve-http route golden (AST)', () => {
  test('ordered registration stack matches the master golden', async () => {
    const routes = await expectNormalizerStable(() => extractServeHttpRoutes(), normalizer);
    expectGolden('serve-http/routes', routes, normalizer);
  });

  test('anti-vacuity: the stack contains the known global middleware, admin API routes and /mcp', () => {
    const routes = extractServeHttpRoutes();
    const adminApi = routes.filter((r) => r.path?.startsWith('/admin/api/'));
    expect(adminApi.length).toBeGreaterThanOrEqual(19);
    expect(routes.some((r) => r.method === 'use' && r.path === null && r.handlers[0] === 'cookieParser()')).toBe(true);
    expect(routes.some((r) => r.method === 'post' && r.path === '/mcp')).toBe(true);
    const guarded = routes.filter((r) => r.handlers[0] === 'requireAdmin');
    expect(guarded.length).toBeGreaterThanOrEqual(adminApi.length - 2);
  });
});
