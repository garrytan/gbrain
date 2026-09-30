/**
 * serve-http route golden by runtime introspection (refactor wave 1: TE1, S-2).
 *
 * Protects: the full ordered Express 5 router stack that `buildServeHttpApp`
 * builds for `gbrain serve --http`: every global `app.use` layer (cookie
 * parser, the admin no-store header middleware, the metrics tracker, the
 * CORS / OAuth preflight gates, body parsers, the SDK auth router with its own
 * nested routes), every route's method, path and ordered handler chain, and
 * which middleware objects are SHARED across routes (the admin limiters, the
 * OAuth token limiter, requireAdmin) - the property a module split can break
 * silently by building a second limiter instance per module (T-6).
 * Fails when: a layer is added, dropped or reordered, a route gains or loses a
 * middleware, a shared middleware instance splits (or two merge), or the
 * runtime stack stops describing the same registrations as the AST golden
 * (`serve-http/routes.json`, owned by test/serve-http-route-golden.test.ts).
 * Why new: the AST golden cannot see the SDK authRouter's routes or runtime
 * object identity; before the move-only buildServeHttpApp extraction there was
 * no app handle to introspect (AR6).
 *
 * Captured at the move-only extraction commit (behavior identical to master).
 * Normalizer `serve-http-routes-runtime-v1`: identity over a deterministic
 * projection (function names, probed mount paths, first-appearance ordinals
 * for shared handler objects), proven stable by the double capture below.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { METHODS } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable, GOLDENS_DIR } from './helpers/golden.ts';

interface RuntimeLayer {
  method: string;
  path: string | null;
  handlers: string[];
  children?: RuntimeLayer[];
}

interface RuntimeCapture {
  spaArm: 'dev' | 'embedded';
  trustProxy: unknown;
  variants: Record<string, RuntimeLayer[]>;
}

interface AstEntry {
  method: string;
  path: string | null;
  handlers: string[];
  when: string[];
}

// Express keeps no path string on `use` layers, only a matcher; each non-root
// mount path is recovered by probing these candidates. An unlisted mount path
// records as <unprobed> and fails the golden until it is added here.
const USE_PATH_PROBES = [
  '/mcp', '/authorize', '/token', '/register', '/revoke', '/admin',
  '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp',
];
const UNMATCHED_PROBE = '/__gbrain_route_probe_unmatched__';
const ALL_METHODS = METHODS.map((m) => m.toLowerCase());

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

type Layer = {
  name: string;
  slash?: boolean;
  handle: ((...args: unknown[]) => unknown) & { stack?: Layer[]; resetKey?: unknown };
  matchers: Array<(p: string) => unknown>;
  route?: { path: string; methods: Record<string, boolean>; stack: Array<Layer & { method?: string }> };
};

function useLayerPath(layer: Layer): string | null {
  if (layer.slash) return null;
  if (layer.matchers.some((m) => m(UNMATCHED_PROBE))) return '<unmatched-probe>';
  return USE_PATH_PROBES.find((p) => layer.matchers.some((m) => m(p))) ?? '<unprobed>';
}

function routeShape(route: NonNullable<Layer['route']>): { method: string; stack: Layer[] } {
  const methods = Object.keys(route.methods).filter((m) => m !== '_all');
  if (route.methods._all && methods.length === 0) return { method: 'all', stack: route.stack };
  if (methods.length === 1) return { method: methods[0], stack: route.stack };
  if (ALL_METHODS.every((m) => methods.includes(m))) {
    return { method: 'all', stack: route.stack.filter((l) => l.method === methods[0]) };
  }
  throw new Error(`route ${route.path} registers an unexpected method set: ${methods.join(',')}`);
}

/** Every handler object in stack order (route.all copies collapsed), for shared-instance ordinals. */
function handlerObjects(stack: Layer[]): unknown[] {
  return stack.flatMap((layer) => {
    if (layer.route) return routeShape(layer.route).stack.map((l) => l.handle);
    const nested = layer.name === 'router' && Array.isArray(layer.handle.stack) ? handlerObjects(layer.handle.stack) : [];
    return [layer.handle, ...nested];
  });
}

function captureStack(app: express.Express): RuntimeLayer[] {
  const root = (app as unknown as { router: { stack: Layer[] } }).router.stack;
  const seen = new Map<unknown, number>();
  for (const h of handlerObjects(root)) seen.set(h, (seen.get(h) ?? 0) + 1);
  const ordinals = new Map<unknown, number>();
  for (const [h, count] of seen) if (count > 1) ordinals.set(h, ordinals.size + 1);

  const describeHandler = (layer: Layer): string => {
    const base = typeof layer.handle.resetKey === 'function' ? 'rateLimit' : layer.name;
    const ordinal = ordinals.get(layer.handle);
    return ordinal === undefined ? base : `${base}#${ordinal}`;
  };

  const walk = (stack: Layer[]): RuntimeLayer[] =>
    stack.map((layer) => {
      if (layer.route) {
        const { method, stack: routeStack } = routeShape(layer.route);
        return { method, path: layer.route.path, handlers: routeStack.map(describeHandler) };
      }
      const entry: RuntimeLayer = { method: 'use', path: useLayerPath(layer), handlers: [describeHandler(layer)] };
      if (layer.name === 'router' && Array.isArray(layer.handle.stack)) entry.children = walk(layer.handle.stack);
      return entry;
    });
  return walk(root);
}

async function buildApp(enableDcr: boolean): Promise<express.Express> {
  const app = express();
  await buildServeHttpApp(app, engine, { port: 0, tokenTtl: 3600, enableDcr });
  return app;
}

async function captureRuntime(): Promise<RuntimeCapture> {
  const defaultApp = await buildApp(false);
  const dcrApp = await buildApp(true);
  return {
    spaArm: existsSync(join(process.cwd(), 'admin', 'dist')) ? 'dev' : 'embedded',
    trustProxy: defaultApp.get('trust proxy'),
    variants: { default: captureStack(defaultApp), enableDcr: captureStack(dcrApp) },
  };
}

const normalizer = defineNormalizer('serve-http-routes-runtime-v1', (capture: RuntimeCapture) => capture);

// AST identity (serve-http/routes.json) -> runtime handler base name. Shared
// objects keep their identity through `#<ordinal>` (checked separately below).
const AST_TO_RUNTIME: Array<[RegExp, string]> = [
  [/^cookieParser\(\)$/, 'cookieParser'],
  [/^express\.json\(\)$/, 'jsonParser'],
  [/^express\.urlencoded\(/, 'urlencodedParser'],
  [/^express\.raw\(/, 'rawParser'],
  [/^express\.static\(/, 'serveStatic'],
  [/^cors\(/, 'corsMiddleware'],
  [/^requireAdmin$/, 'requireAdmin'],
  [/^(ccRateLimiter|adminLimits\.(total|failures|consent)|ingestRateLimiter|githubWebhookLimiter)$/, 'rateLimit'],
  [/^authRouter$/, 'router'],
  [/^(<inline>|mountOAuthCorsGate\(.*|metricsTrackingMiddleware\(.*|withBearerScopeHint\(.*|requireBearerAuth\(.*)$/, '<anonymous>'],
];

function runtimeBase(astIdentity: string): string {
  const hit = AST_TO_RUNTIME.find(([re]) => re.test(astIdentity));
  if (!hit) throw new Error(`no AST->runtime mapping for handler identity ${astIdentity}; extend AST_TO_RUNTIME`);
  return hit[1];
}

function loadAstGolden(): AstEntry[] {
  return (JSON.parse(readFileSync(join(GOLDENS_DIR, 'serve-http', 'routes.json'), 'utf8')) as { golden: AstEntry[] }).golden;
}

describe('serve-http route golden (runtime)', () => {
  let capture: RuntimeCapture;

  beforeAll(async () => {
    capture = await expectNormalizerStable(captureRuntime, normalizer);
  });

  test('ordered router stack matches the golden captured at the move-only extraction', () => {
    expect(capture.spaArm, 'bun test runs from the repo root, where the committed admin/dist selects the dev SPA arm').toBe('dev');
    expectGolden('serve-http/routes-runtime', capture, normalizer);
  });

  test('runtime stack describes the same registrations as the AST golden', () => {
    const arm = capture.spaArm === 'dev' ? 'if useDevPath' : 'else useDevPath';
    const ast = loadAstGolden().filter((e) => e.when.length === 0 || (e.when.length === 1 && e.when[0] === arm));
    const settings = ast.filter((e) => e.method === 'set');
    expect(settings.map((e) => e.path)).toEqual(['trust proxy']);
    expect(capture.trustProxy).toBe('loopback');

    const runtime = capture.variants.default;
    const expanded = ast
      .filter((e) => e.method !== 'set')
      .flatMap((e) => (e.method === 'use' ? e.handlers.map((h) => ({ method: 'use', path: e.path, handlers: [h] })) : [e]));
    expect(runtime.length).toBe(expanded.length);

    const identityToRuntime = new Map<string, string>();
    const runtimeToIdentity = new Map<string, string>();
    expanded.forEach((e, i) => {
      const r = runtime[i];
      const where = `layer ${i} (${e.method} ${e.path})`;
      expect(r.method, where).toBe(e.method);
      expect(r.path, where).toBe(e.path);
      expect(r.handlers.length, where).toBe(e.handlers.length);
      e.handlers.forEach((astId, j) => {
        const rt = r.handlers[j];
        expect(rt.replace(/#\d+$/, ''), `${where} handler ${j} (${astId})`).toBe(runtimeBase(astId));
        if (!/#\d+$/.test(rt)) return;
        const prevRt = identityToRuntime.get(astId);
        if (prevRt !== undefined) expect(rt, `${astId} must stay one shared object (${where})`).toBe(prevRt);
        identityToRuntime.set(astId, rt);
        const prevId = runtimeToIdentity.get(rt);
        if (prevId !== undefined) expect(astId, `${rt} is shared by two AST identities (${where})`).toBe(prevId);
        runtimeToIdentity.set(rt, astId);
      });
    });
    for (const shared of ['requireAdmin', 'ccRateLimiter', 'adminLimits.total', 'adminLimits.failures', 'adminLimits.consent']) {
      expect(identityToRuntime.has(shared), `${shared} must be one object shared across its routes`).toBe(true);
    }
  });

  test('anti-vacuity: the SDK auth router is one layer whose nested routes are recorded', () => {
    const routers = capture.variants.default.filter((l) => l.handlers[0] === 'router');
    expect(routers.length).toBe(1);
    expect(routers[0].children?.length ?? 0).toBeGreaterThanOrEqual(4);
    const dcrPaths = JSON.stringify(capture.variants.enableDcr.find((l) => l.handlers[0] === 'router'));
    expect(dcrPaths).toContain('/register');
    expect(JSON.stringify(capture)).not.toContain('<unprobed>');
  });
});
