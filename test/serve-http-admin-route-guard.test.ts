/**
 * A10 (test-gap wave) — structural scan: every `/admin`-prefixed route
 * registered on the express app in src/commands/serve-http.ts or any
 * src/commands/serve-http-*.ts module (globbed, so a new module is scanned
 * without editing this file; refactor wave 1 E9) must carry
 * `requireAdmin` as middleware BEFORE its handler, except a documented
 * allowlist (the credential/token auth endpoints and the static SPA
 * surface). `/metrics` (outside the /admin prefix) and `/admin/events` are
 * in the must-carry-requireAdmin scan set explicitly, never allowlisted.
 * Violations report the module file:line. The scan covers app.get/post/put/delete/patch/all/use — an
 * `app.use('/admin', express.static(...))` mount is visible to it — and
 * is robust to the file's multi-line registration style (path literal on
 * the line after `app.post(`).
 *
 * Fails on:
 *   (a) a new unallowlisted /admin route without requireAdmin,
 *   (b) a stale allowlist entry (no longer present, or present a
 *       different number of times than declared),
 *   (c) an allowlisted auth endpoint that dropped its
 *       adminLimits.total, adminLimits.failures middleware,
 *   (d) extractor breakage (anti-vacuity floor: the scan must keep
 *       finding at least the known admin surface, and a self-test proves
 *       the extractor + guard CAN flag a known-bad route).
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';


// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

interface RouteReg {
  method: string;
  /** First-argument string literal, or null for pathless mounts like app.use(cookieParser()). */
  path: string | null;
  /**
   * The registration "head": text from the opening paren up to the start of
   * the inline handler (first `=>` / `function`) or the statement end (first
   * `;`, for handler-less calls like the static mount). Middleware appear
   * here; handler bodies do not — so a `requireAdmin` mention inside a
   * handler body can never masquerade as a guard.
   */
  head: string;
  /** Repo-relative module path, e.g. src/commands/serve-http-admin-api.ts. */
  file: string;
  line: number;
  guarded: boolean;
}

const CALL_RE = /\bapp\.(get|post|put|delete|patch|all|use)\s*\(/g;
const MAX_HEAD_CHARS = 4000;

function extractRegistrations(source: string, file = '<fixture>'): RouteReg[] {
  const regs: RouteReg[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(source)) !== null) {
    const callStart = m.index;
    // Skip matches that sit inside a line comment or a `* `-prefixed block
    // comment line (e.g. the doc comment quoting `app.use('/token', ...)`).
    const lineStart = source.lastIndexOf('\n', callStart) + 1;
    const linePrefix = source.slice(lineStart, callStart);
    if (linePrefix.includes('//') || linePrefix.includes('*')) continue;

    const argsStart = callStart + m[0].length;
    const window = source.slice(argsStart, argsStart + MAX_HEAD_CHARS);

    // Cut the head at the earliest handler/statement boundary. Cutting
    // early on an unexpected shape is fail-CLOSED: a middleware the cut
    // hides makes the route look unguarded, which fails the test loudly
    // instead of silently passing.
    let cut = window.length;
    const arrowIdx = window.indexOf('=>');
    if (arrowIdx !== -1 && arrowIdx < cut) cut = arrowIdx;
    const semiIdx = window.indexOf(';');
    if (semiIdx !== -1 && semiIdx < cut) cut = semiIdx;
    const fnMatch = /\bfunction\b/.exec(window);
    if (fnMatch && fnMatch.index < cut) cut = fnMatch.index;
    const head = window.slice(0, cut);

    // Path = the first argument IF it is a string/template literal. \s*
    // spans newlines, so `app.post(\n  '/ingest',` (the file's multi-line
    // registration style) resolves correctly.
    const pathMatch = /^\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(head);
    const path = pathMatch ? pathMatch[2] : null;

    regs.push({
      method: m[1],
      path,
      head,
      file,
      line: source.slice(0, callStart).split('\n').length,
      guarded: /\brequireAdmin\b/.test(head),
    });
  }
  return regs;
}

/** Broad on purpose (prefix match, not '/admin/'-only): over-inclusion is fail-closed. */
function adminRoutes(regs: RouteReg[]): RouteReg[] {
  return regs.filter((r): r is RouteReg & { path: string } => r.path !== null && r.path.startsWith('/admin'));
}

// Routes outside the /admin prefix that must carry requireAdmin anyway, plus
// /admin/events named explicitly. Members of the scan set, never allowlisted.
const MUST_CARRY_REQUIRE_ADMIN: ReadonlyArray<readonly [string, string]> = [
  ['get', '/metrics'],
  ['get', '/admin/events'],
];

/** The must-carry-requireAdmin scan set: every /admin-prefixed route plus MUST_CARRY_REQUIRE_ADMIN. */
function scanSetRoutes(regs: RouteReg[]): RouteReg[] {
  return regs.filter(r => (r.path !== null && r.path.startsWith('/admin'))
    || MUST_CARRY_REQUIRE_ADMIN.some(([method, path]) => r.method === method && r.path === path));
}

function describeRoute(r: RouteReg): string {
  return `app.${r.method}('${r.path}') at ${r.file}:${r.line}`;
}

// ---------------------------------------------------------------------------
// Allowlist — the ONLY /admin registrations allowed to lack requireAdmin.
// `count` is the exact number of UNGUARDED occurrences expected in the file
// (stale-guard: 0 matches OR a drifted count fails). `mustCarry` asserts a
// required substitute middleware is still attached.
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  method: string;
  path: string;
  count: number;
  mustCarry?: string;
  rationale: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  // Authenticates BY credential (the admin password IS the gate); rate-limited via adminLimits.total, adminLimits.failures.
  { method: 'post', path: '/admin/login', count: 1, mustCarry: 'adminLimits.total, adminLimits.failures', rationale: 'credential login endpoint' },
  // Authenticates BY credential to mint a one-time magic link; rate-limited via adminLimits.total, adminLimits.failures.
  { method: 'post', path: '/admin/api/issue-magic-link', count: 1, mustCarry: 'adminLimits.total, adminLimits.failures', rationale: 'credential-gated magic-link issuance' },
  // Magic-link consumption: authenticates BY the single-use token in the URL; rate-limited via adminLimits.total, adminLimits.failures.
  { method: 'get', path: '/admin/auth/:token', count: 1, mustCarry: 'adminLimits.total, adminLimits.failures', rationale: 'token-gated magic-link consumption' },
  // Static SPA asset mount (dev admin/dist arm): serves the public JS/CSS/HTML bundle; data access is via the guarded /admin/api/* routes.
  { method: 'use', path: '/admin', count: 1, mustCarry: 'express.static', rationale: 'static SPA asset mount' },
  // Bare /admin -> /admin/ redirect (embedded-binary arm): serves no data, only a redirect.
  { method: 'get', path: '/admin', count: 1, rationale: 'trailing-slash redirect' },
  // SPA fallback, BOTH config arms (dev admin/dist arm + embedded-binary arm): serve index.html for
  // client-side routing; API/auth/login paths next() through to the guarded routes above them.
  { method: 'get', path: '/admin/{*path}', count: 2, rationale: 'SPA index.html fallback (two config arms)' },
];

// ---------------------------------------------------------------------------
// The scan, run once against the real file
// ---------------------------------------------------------------------------

const COMMANDS_DIR = join(import.meta.dir, '..', 'src', 'commands');

/** serve-http.ts plus every serve-http-*.ts module, sorted: a glob, not a hand list. */
function serveHttpModuleSources(): Array<{ file: string; text: string }> {
  return readdirSync(COMMANDS_DIR)
    .filter(f => f === 'serve-http.ts' || /^serve-http-.*\.ts$/.test(f))
    .sort()
    // test-reads-source-ok[trust-boundary]: every serve-http module is scanned for admin routes registered without requireAdmin; a glob keeps a new module from escaping the scan.
    .map(f => ({ file: `src/commands/${f}`, text: readFileSync(join(COMMANDS_DIR, f), 'utf-8') }));
}

function scanModules(sources: Array<{ file: string; text: string }>) {
  const all = sources.flatMap(({ file, text }) => extractRegistrations(text, file));
  const admin = adminRoutes(all);
  const scanSet = scanSetRoutes(all);
  return {
    all,
    admin,
    guarded: admin.filter(r => r.guarded),
    scanSet,
    unguarded: scanSet.filter(r => !r.guarded),
  };
}

function violationsOf(unguardedRoutes: RouteReg[]): RouteReg[] {
  return unguardedRoutes.filter(r => !ALLOWLIST.some(e => e.method === r.method && e.path === r.path));
}

const moduleSources = serveHttpModuleSources();
const { admin, guarded, scanSet, unguarded } = scanModules(moduleSources);

describe('serve-http admin route guard (structural)', () => {
  test('anti-vacuity floor: the extractor still sees the known admin surface', () => {
    // If the registration style changes and the extractor goes blind, these
    // floors fail LOUDLY instead of letting the guard test pass vacuously.
    expect(admin.length).toBeGreaterThanOrEqual(20);
    expect(guarded.length).toBeGreaterThanOrEqual(15);
    // Floors at origin/master (f8d1e3936) with this same glob scan, computed
    // once: 37 /admin registrations, 30 guarded; scan set (plus /metrics) 38,
    // 31 guarded. The split into serve-http-<area>.ts modules may not lose any.
    expect(admin.length).toBeGreaterThanOrEqual(37);
    expect(guarded.length).toBeGreaterThanOrEqual(30);
    expect(scanSet.length).toBeGreaterThanOrEqual(38);
    expect(scanSet.filter(r => r.guarded).length).toBeGreaterThanOrEqual(31);
    expect(moduleSources.map(s => s.file)).toContain('src/commands/serve-http.ts');
    // Known sentinel routes must be found AND classified as guarded.
    for (const [method, path] of [
      ['get', '/admin/api/stats'],
      ['get', '/admin/events'],
      ['post', '/admin/api/revoke-client'],
      ['get', '/admin/api/oauth-requests/:id'],
      ['post', '/admin/api/oauth-requests/:id'],
      ['get', '/admin/api/clients'],
      ['get', '/admin/api/clients/:clientId'],
      ['get', '/admin/api/clients/:clientId/setup'],
      ['post', '/admin/api/clients/:clientId/lifecycle'],
      ['post', '/admin/api/recover-client'],
      ['post', '/admin/api/register-client'],
      ['post', '/admin/api/rescope-client'],
    ] as const) {
      const hit = admin.find(r => r.method === method && r.path === path);
      expect(hit, `expected app.${method}('${path}') to be found by the scan`).toBeDefined();
      expect(hit!.guarded, `${path} must carry requireAdmin`).toBe(true);
    }
    // Spec requirement: the static mount is visible to the scan as a `use`.
    const staticMount = admin.find(r => r.method === 'use' && r.path === '/admin');
    expect(staticMount, `expected app.use('/admin', express.static(...)) to be visible to the scan`).toBeDefined();
    expect(staticMount!.head).toContain('express.static');
  });

  test('must-carry set: /metrics and /admin/events are found and carry requireAdmin', () => {
    for (const [method, path] of MUST_CARRY_REQUIRE_ADMIN) {
      const hits = scanSet.filter(r => r.method === method && r.path === path);
      expect(hits.length, `expected app.${method}('${path}') to be found by the scan`).toBeGreaterThanOrEqual(1);
      for (const hit of hits) expect(hit.guarded, `${describeRoute(hit)} must carry requireAdmin`).toBe(true);
      expect(ALLOWLIST.some(e => e.method === method && e.path === path), `${path} must never be allowlisted`).toBe(false);
    }
  });

  test('every /admin route carries requireAdmin before its handler, or is explicitly allowlisted', () => {
    const violations = violationsOf(unguarded);
    expect(
      violations.map(describeRoute),
      `UNGUARDED /admin route(s) without requireAdmin and not on the allowlist:\n` +
        violations.map(r => `  - ${describeRoute(r)}`).join('\n') +
        `\nEither add requireAdmin middleware before the handler, or (only if the route ` +
        `authenticates by credential/token itself, or serves only public SPA assets) add an ` +
        `allowlist entry WITH a rationale in ${import.meta.file}.`,
    ).toEqual([]);
  });

  test('allowlist is not stale: every entry matches its declared unguarded occurrences', () => {
    for (const entry of ALLOWLIST) {
      const matches = unguarded.filter(r => r.method === entry.method && r.path === entry.path);
      expect(
        matches.length,
        `allowlist entry app.${entry.method}('${entry.path}') [${entry.rationale}] expected ` +
          `${entry.count} unguarded occurrence(s), found ${matches.length}. If the route was ` +
          `removed or gained requireAdmin, delete/adjust the allowlist entry.`,
      ).toBe(entry.count);
      if (entry.mustCarry) {
        for (const r of matches) {
          expect(
            r.head.includes(entry.mustCarry),
            `${describeRoute(r)} is allowlisted as "${entry.rationale}" and must still carry ` +
              `${entry.mustCarry} — it no longer does.`,
          ).toBe(true);
        }
      }
    }
  });

  // Refactor wave 1 split the routes into serve-http-<area>.ts modules that
  // take requireAdmin from the shared context (`const { requireAdmin } = ctx`).
  // Dropping it from one route in an in-memory copy of a moved module must
  // surface as a violation that names that module file:line.
  for (const { file, route, method, path } of [
    { file: 'src/commands/serve-http-metrics.ts', route: "app.get('/metrics', requireAdmin, ", method: 'get', path: '/metrics' },
    { file: 'src/commands/serve-http-admin-api.ts', route: "app.get('/admin/api/stats', requireAdmin, ", method: 'get', path: '/admin/api/stats' },
  ]) {
    test(`mutation: dropping requireAdmin from ${path} in ${file} is a violation at that file:line`, () => {
      const original = moduleSources.find(s => s.file === file);
      expect(original, `${file} must be scanned`).toBeDefined();
      expect(original!.text.split(route).length - 1, `${file} registers ${route}exactly once`).toBe(1);
      const mutatedText = original!.text.replace(route, route.replace('requireAdmin, ', ''));
      const mutated = moduleSources.map(s => (s.file === file ? { file, text: mutatedText } : s));
      const line = mutatedText.slice(0, mutatedText.indexOf(route.replace('requireAdmin, ', ''))).split('\n').length;
      expect(violationsOf(scanModules(moduleSources).unguarded)).toEqual([]);
      expect(violationsOf(scanModules(mutated).unguarded).map(describeRoute)).toEqual([`app.${method}('${path}') at ${file}:${line}`]);
    });
  }

  test('self-test: extractor + guard logic CAN fail on a known-bad route (anti-vacuity)', () => {
    // Embedded fixture exercising every shape the real file uses: an
    // allowlisted credential route, a guarded route, a commented-out route
    // (must be ignored), a MULTI-LINE unguarded route, a single-line
    // unguarded route, the static mount, and a non-admin route (filtered).
    const FIXTURE = [
      `  app.post('/admin/login', adminLimits.total, adminLimits.failures, express.json(), (req, res) => {`,
      `    res.json({ ok: true });`,
      `  });`,
      `  app.get('/admin/api/good', requireAdmin, async (_req: Request, res: Response) => {`,
      `    // requireAdmin mentioned in a body comment must NOT guard other routes`,
      `    res.json({ ok: true });`,
      `  });`,
      `  // app.get('/admin/api/commented-out', (req, res) => res.json({}));`,
      `  app.post(`,
      `    '/admin/api/multiline-evil',`,
      `    express.json(),`,
      `    async (req: Request, res: Response) => {`,
      `      res.json({ leaked: true });`,
      `    },`,
      `  );`,
      `  app.get('/admin/api/evil', (req, res) => res.json({ secrets: true }));`,
      `  app.use('/admin', express.static(distPath));`,
      `  app.get('/not-admin/api/other', (req, res) => res.json({}));`,
    ].join('\n');

    const fixtureAdmin = adminRoutes(extractRegistrations(FIXTURE));
    // Commented-out skipped, /not-admin filtered => 5 admin registrations.
    expect(fixtureAdmin.map(r => `${r.method} ${r.path}`).sort()).toEqual(
      [
        'get /admin/api/evil',
        'get /admin/api/good',
        'post /admin/api/multiline-evil',
        'post /admin/login',
        'use /admin',
      ].sort(),
    );

    const good = fixtureAdmin.find(r => r.path === '/admin/api/good')!;
    expect(good.guarded).toBe(true);

    // The same guard predicate the real test uses must flag EXACTLY the two
    // planted bad routes (the multi-line one proves multi-line extraction).
    const fixtureAllowlist = [
      { method: 'post', path: '/admin/login' },
      { method: 'use', path: '/admin' },
    ];
    const fixtureViolations = fixtureAdmin
      .filter(r => !r.guarded)
      .filter(r => !fixtureAllowlist.some(e => e.method === r.method && e.path === r.path))
      .map(r => `${r.method} ${r.path}`)
      .sort();
    expect(fixtureViolations).toEqual(['get /admin/api/evil', 'post /admin/api/multiline-evil']);
  });
});
