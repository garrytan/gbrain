/**
 * E5 — the truthful-catalog invariant (T13; plan E5 + D10 carve-out, ENG-21
 * recipe, FOV-4/6c, amendment 31).
 *
 * THE INVARIANT: the catalog is an API promise. For each token class:
 * tools/list, then probe every listed tool — NO probe may return a
 * LIST-LEVEL denial (publish-gate `config_key=...`, bound-client op-fence
 * `fence=op`, scope `insufficient_scope`, or an unknown-tool envelope for a
 * name the list itself advertised). `invalid_params` is an acceptable probe
 * outcome. Inversely: what the list hides stays uncallable — surface-hidden
 * and localOnly ops return the no-leak unknown-tool envelope; gate-hidden
 * ops hit the fail-closed `config_key=` backstop; bound-fence-hidden ops hit
 * `fence=op`. Argument-level fence denials (out-of-prefix slugs on a LISTED
 * write op) are legitimate and excluded (D10) — pinned below as carrying NO
 * list-level marker.
 *
 * PLACEMENT (why not test/e2e/): the test/e2e/ tree runs only under
 * scripts/run-e2e.sh on a Postgres-equipped host; this file needs no
 * DATABASE_URL, so it lives in the unit tree (picked up by `bun test` /
 * run-unit-shard.sh) and guards the invariant in CI without Postgres.
 *
 * WHAT RUNS WHERE (ENG-21 recipe, adapted to a no-Postgres host):
 *   (a) the legacy bearer HTTP transport runs FOR REAL — ONE
 *       startHttpTransport server over a real PGLiteEngine, reused across
 *       cells (per-request gate reads make config flips restart-free; the
 *       surface axis for this transport is startup-bound, so surface cells
 *       run on path (b)).
 *   (b) the OAuth serve-http path runs through the SAME SEAMS serve-http.ts
 *       composes — filterOpsForSurface + hasScope (with the FOV-4
 *       agentCallable carve-out) + opAllowedForBoundClient +
 *       disabledOpsForPublishGates for the list; the scope gate + the real
 *       dispatchToolCall (allowedOps / auth / surface / surfaceCeiling) for
 *       the call. The only serve-http code NOT under test here is its
 *       express/SDK glue and verifyAccessToken; the full OAuth-server sweep
 *       (real HTTP, real tokens) runs on a Postgres-equipped host via
 *       test/e2e/serve-http-oauth.test.ts.
 *
 * Config is pinned on the DB plane (which wins the dual-plane read) so the
 * developer's real ~/.gbrain/config.json can never flip an assertion, and
 * GBRAIN_HOME is redirected to a tmpdir for the file plane. mcp.strict_params
 * is pinned 'reject' so no garbage-arg probe can ever execute a write handler
 * (FOV-6c: exactly ONE warn-mode case below, probing a READ op only).
 *
 * Wall-clock budget: the whole file should finish in < 3 minutes (ENG-21).
 * The budget is ENFORCED only under GBRAIN_ENFORCE_E5_BUDGET=1 (a loaded CI
 * shard or laptop makes wall-clock assertions flaky); otherwise an overrun
 * warns loudly so drift is still visible.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  operations,
  opAllowedForBoundClient,
  type Operation,
  type AuthInfo,
} from '../src/core/operations.ts';
import { hasScope } from '../src/core/scope.ts';
import {
  filterOpsForSurface,
  STARTER_OPS,
  effectiveSurfaceForClient,
  resolveClientRowSurface,
  resolveDefaultClientSurface,
  type McpSurface,
} from '../src/mcp/surface.ts';
import { disabledOpsForPublishGates } from '../src/mcp/publish-gates.ts';
import {
  dispatchToolCall,
  isListLevelDenialEnvelope,
  type ToolResult,
} from '../src/mcp/dispatch.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { __setUsageLogPathForTests } from '../src/core/verbs/usage-log.ts';
import { withEnv } from './helpers/with-env.ts';

// Set in beforeAll — module-load time would charge other files' transpile
// and collection work against this file's budget.
let T0 = 0;
const WALL_CLOCK_BUDGET_MS = 3 * 60 * 1000;

const SKILL_FIXTURE = join(import.meta.dir, 'fixtures', 'skill-catalog', 'skills');
const BOUND_PREFIX = 'e2e-bound/';
const LEGACY_TOKEN = 'e5-truthful-catalog-legacy-token';

/**
 * Hermetic env pins, applied via withEnv (the repo's R1-compliant pattern):
 * the file config plane reads $GBRAIN_HOME/.gbrain/config.json, and a stray
 * GBRAIN_MCP_FORCE_SURFACE would silently narrow every resolved surface.
 * All decision-relevant config is ALSO pinned on the DB plane (which wins
 * the dual-plane reads), so the pins are belt-and-suspenders.
 */
const home = mkdtempSync(join(tmpdir(), 'e5-truthful-catalog-'));
const ENV_PINS: Record<string, string | undefined> = {
  GBRAIN_HOME: home,
  GBRAIN_MCP_FORCE_SURFACE: undefined,
};

/** test() wrapper: every body runs under the hermetic env pins. */
function e5test(name: string, fn: () => Promise<void> | void): void {
  test(name, () => withEnv(ENV_PINS, async () => { await fn(); }));
}

let engine: PGLiteEngine;
let legacyUrl: string;
let legacyStop: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Shared setup — ONE engine, ONE legacy server, reused across every cell
// (ENG-21). Gate/strict flips happen on the DB plane per cell, restart-free.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  T0 = Date.now();
  __setUsageLogPathForTests(join(home, 'verb-usage.jsonl'));
  await withEnv(ENV_PINS, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // DB-plane pins (DB > file, so the dev's real config can't leak in):
    // strict_params=reject means a garbage-arg probe NEVER executes a handler;
    // gates start OFF (the default-off consent posture); the skill catalog
    // points at the test fixture so gate-ON probes are deterministic.
    await engine.setConfig('mcp.strict_params', 'reject');
    await setGates(false);
    await engine.setConfig('mcp.skills_dir', SKILL_FIXTURE);

    // One REAL legacy bearer server over the real engine, started inside the
    // env pins (its surface clamp + file-config snapshot resolve at startup).
    // Generous limiters — the full probe sweep would exhaust the default
    // 30 req/min IP bucket.
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2)`,
      ['e5-truthful-catalog', createHash('sha256').update(LEGACY_TOKEN).digest('hex')],
    );
    const server = await startHttpTransport({
      port: 0,
      engine,
      limiters: {
        ip: new RateLimiter({ limit: 100_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 100_000, windowMs: 60_000, lruCap: 100 }),
      },
      surface: 'full',
    });
    legacyUrl = `http://localhost:${(server as { port: number }).port}`;
    legacyStop = () => (server as unknown as { stop: (force: boolean) => void }).stop(true);
  });
});

afterAll(async () => {
  legacyStop?.();
  await engine.disconnect();
  __setUsageLogPathForTests(null);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** Flip BOTH publish gates together on the DB plane (per-key independence is
 * pinned by test/publish-gates.test.ts; the matrix treats gates as one axis). */
async function setGates(on: boolean): Promise<void> {
  await engine.setConfig('mcp.publish_skills', on ? 'true' : 'false');
  await engine.setConfig('mcp.publish_advisor', on ? 'true' : 'false');
}

interface Cell {
  label: string;
  /** OAuth token scopes; null = legacy bearer semantics (no scope checks). */
  scopes: string[] | null;
  surface: McpSurface;
  gatesOn: boolean;
  bound: boolean;
}

function cellAuth(cell: Cell): AuthInfo {
  return {
    token: 'e5-token',
    clientId: `e5-${cell.label}`,
    scopes: cell.scopes ?? [],
    ...(cell.bound ? { boundSlugPrefixes: [BOUND_PREFIX] } : {}),
  };
}

/**
 * The INDEPENDENTLY-composed expectation for what a cell's tools/list must
 * contain, written per-axis from the plan's rules (D7 localOnly, frozen
 * verbs / STARTER_OPS, scope hierarchy + FOV-4 carve-out, ENG-3 bound
 * predicate, WP1 gates). The probes below then assert the REAL dispatch
 * agrees with this set — listed means callable, hidden means denied.
 */
function expectedVisibleSet(cell: Cell): Set<string> {
  const out = new Set<string>();
  for (const op of operations) {
    if (op.localOnly) continue;                                  // D7: network transport
    if (cell.surface === 'verbs' && op.verb !== true) continue;  // frozen verb surface
    if (cell.surface === 'starter' && !STARTER_OPS.has(op.name)) continue;
    if (cell.scopes !== null) {
      const scopeOk = hasScope(cell.scopes, op.scope ?? 'read')
        || (op.agentCallable === true && hasScope(cell.scopes, 'agent')); // FOV-4
      if (!scopeOk) continue;
    }
    if (cell.bound && !opAllowedForBoundClient({ boundSlugPrefixes: [BOUND_PREFIX] }, op)) continue;
    if (op.publishGateKey && !cell.gatesOn) continue;            // WP1 honest catalog
    out.add(op.name);
  }
  return out;
}

/**
 * The serve-http ListTools computation, composed from the exact seams the
 * real handler uses (serve-http.ts POST /mcp → ListToolsRequestSchema):
 * surface filter after the localOnly filter, then scope (+ agentCallable
 * carve-out), bound-client predicate, publish gates.
 */
async function oauthToolsList(cell: Cell): Promise<Set<string>> {
  const mcpOperations = filterOpsForSurface(operations.filter(op => !op.localOnly), cell.surface);
  const gateDisabled = await disabledOpsForPublishGates(engine, null);
  const auth = cellAuth(cell);
  const visible = mcpOperations.filter(op =>
    (hasScope(auth.scopes, op.scope ?? 'read')
      || (op.agentCallable === true && hasScope(auth.scopes, 'agent')))
    && opAllowedForBoundClient(auth, op)
    && !gateDisabled.has(op.name));
  return new Set(visible.map(o => o.name));
}

type ProbeKind =
  | 'success'
  | 'invalid_params'
  | 'unknown'             // unknown_tool / unknown_operation
  | 'list_level_denial'   // config_key= / fence=op / insufficient_scope
  | 'arg_level_denial'    // permission_denied WITHOUT a list-level marker (D10: legitimate)
  | 'other_error';

interface ProbeVerdict { kind: ProbeKind; envelope: Record<string, unknown> | null }

function classify(result: ToolResult): ProbeVerdict {
  if (!result.isError) return { kind: 'success', envelope: null };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;
  } catch {
    return { kind: 'other_error', envelope: null };
  }
  if (isListLevelDenialEnvelope(parsed)) return { kind: 'list_level_denial', envelope: parsed };
  if (parsed.error === 'insufficient_scope') return { kind: 'list_level_denial', envelope: parsed };
  if (parsed.error === 'unknown_tool' || parsed.error === 'unknown_operation') return { kind: 'unknown', envelope: parsed };
  if (parsed.error === 'invalid_params') return { kind: 'invalid_params', envelope: parsed };
  if (parsed.error === 'permission_denied') return { kind: 'arg_level_denial', envelope: parsed };
  return { kind: 'other_error', envelope: parsed };
}

/**
 * The serve-http CallTool path over the shared dispatcher: op resolution
 * against the surfaced set (unknown_operation outside it), the hasScope +
 * agentCallable gate (insufficient_scope — logged denied_after_list in
 * production), then the REAL dispatchToolCall with the same opts serve-http
 * passes (remote/http/allowedOps/auth/surface/surfaceCeiling).
 */
async function oauthToolCall(
  cell: Cell,
  name: string,
  args: Record<string, unknown>,
): Promise<ProbeVerdict> {
  const mcpOperations = filterOpsForSurface(operations.filter(op => !op.localOnly), cell.surface);
  const op = mcpOperations.find(o => o.name === name);
  if (!op) return { kind: 'unknown', envelope: { error: 'unknown_operation' } };
  const auth = cellAuth(cell);
  const scopeSatisfied = hasScope(auth.scopes, op.scope ?? 'read')
    || (op.agentCallable === true && hasScope(auth.scopes, 'agent'));
  if (!scopeSatisfied) {
    return { kind: 'list_level_denial', envelope: { error: 'insufficient_scope' } };
  }
  const surfaceAllowedOps: ReadonlySet<string> | undefined =
    cell.surface === 'full' ? undefined : new Set(mcpOperations.map(o => o.name));
  const result = await dispatchToolCall(engine, name, args, {
    remote: true,
    transport: 'http',
    sourceId: 'default',
    auth,
    ...(surfaceAllowedOps ? { allowedOps: surfaceAllowedOps } : {}),
    surface: cell.surface,
    surfaceCeiling: cell.surface,
  });
  return classify(result);
}

/**
 * D10 probe semantics: WRONG-TYPED values for every required param (rejects
 * in warn AND reject modes, before any handler runs); ops with no required
 * params get one undeclared key, which the pinned strict_params=reject
 * refuses — so a full sweep can never execute a write handler.
 */
function probeArgsFor(op: Operation): Record<string, unknown> {
  const wrong: Record<string, unknown> = {};
  let hasRequired = false;
  for (const [key, def] of Object.entries(op.params)) {
    if (!def.required) continue;
    hasRequired = true;
    wrong[key] =
      def.type === 'string' ? 42
      : def.type === 'number' ? 'not-a-number'
      : def.type === 'boolean' ? 'not-a-boolean'
      : def.type === 'array' ? 'not-an-array'
      : 42; // object → number
  }
  return hasRequired ? wrong : { e5_garbage_probe: true };
}

/** Probe EVERY listed tool; return invariant violations (empty = truthful). */
async function sweepCell(cell: Cell, listed: ReadonlySet<string>): Promise<string[]> {
  const violations: string[] = [];
  for (const name of [...listed].sort()) {
    const op = operations.find(o => o.name === name);
    if (!op) { violations.push(`${cell.label}: listed "${name}" is not a known operation`); continue; }
    const verdict = await oauthToolCall(cell, name, probeArgsFor(op));
    // Garbage probes must die at validation — anything else means either a
    // list-level denial (the invariant breach) or a handler executed on
    // garbage args despite strict_params=reject.
    if (verdict.kind !== 'invalid_params') {
      violations.push(`${cell.label}: listed "${name}" → ${verdict.kind} ${JSON.stringify(verdict.envelope)}`);
    }
  }
  return violations;
}

function sortedArray(s: ReadonlySet<string>): string[] {
  return [...s].sort();
}

// --- legacy bearer transport (real HTTP) helpers ---------------------------

async function legacyRpc(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${legacyUrl}/mcp`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LEGACY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) }),
  });
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

async function legacyToolsList(): Promise<Set<string>> {
  const body = await legacyRpc('tools/list');
  const tools = (body.result as { tools: Array<{ name: string }> }).tools;
  return new Set(tools.map(t => t.name));
}

async function legacyToolCall(name: string, args: Record<string, unknown>): Promise<ProbeVerdict> {
  const body = await legacyRpc('tools/call', { name, arguments: args });
  return classify(body.result as ToolResult);
}

// ---------------------------------------------------------------------------
// (a) The legacy bearer transport — real HTTP server, real engine
// ---------------------------------------------------------------------------

describe('E5 truthful catalog — legacy bearer transport (real HTTP, PGLite)', () => {
  e5test('gates off: tools/list is exactly the expected honest set (no gated, no localOnly)', async () => {
    await setGates(false);
    const listed = await legacyToolsList();
    const expected = expectedVisibleSet({
      label: 'legacy-full-gates-off', scopes: null, surface: 'full', gatesOn: false, bound: false,
    });
    expect(sortedArray(listed)).toEqual(sortedArray(expected));
    for (const gated of ['list_skills', 'get_skill', 'list_brain_skillpack', 'advisor']) {
      expect(listed.has(gated)).toBe(false);
    }
    for (const localOnly of ['file_list', 'file_upload', 'file_url', 'sync_brain']) {
      expect(listed.has(localOnly)).toBe(false);
    }
  });

  e5test('full probe sweep: every listed tool dies at validation, never at a list-level denial', async () => {
    await setGates(false);
    const listed = await legacyToolsList();
    expect(listed.size).toBeGreaterThan(50); // the sweep is real, not vacuous
    const violations: string[] = [];
    for (const name of sortedArray(listed)) {
      const op = operations.find(o => o.name === name);
      if (!op) { violations.push(`legacy: listed "${name}" is not a known operation`); continue; }
      const verdict = await legacyToolCall(name, probeArgsFor(op));
      if (verdict.kind !== 'invalid_params') {
        violations.push(`legacy: listed "${name}" → ${verdict.kind} ${JSON.stringify(verdict.envelope)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  e5test('inverse: localOnly op is uncallable with the no-leak unknown_tool envelope', async () => {
    const denied = await legacyToolCall('file_list', {});
    expect(denied.kind).toBe('unknown');
    expect(denied.envelope?.message).toBe('Unknown tool: file_list');
    // Byte-identical error class to a nonexistent op — no existence oracle.
    const noSuchOp = await legacyToolCall('e5_no_such_op_xyz', {});
    expect(noSuchOp.kind).toBe('unknown');
    expect(denied.envelope?.error).toBe(noSuchOp.envelope?.error);
  });

  e5test('inverse: gate-hidden op is call-time-denied with the config_key grammar, never success', async () => {
    await setGates(false);
    expect((await legacyToolsList()).has('list_skills')).toBe(false);
    const verdict = await legacyToolCall('list_skills', {});
    expect(verdict.kind).toBe('list_level_denial');
    expect(verdict.envelope?.detail).toBe('config_key=mcp.publish_skills');
  });

  e5test('restart-free gate flip: ON lists + allows the gated ops; OFF hides them again (per-request read)', async () => {
    await setGates(true);
    const listedOn = await legacyToolsList();
    for (const gated of ['list_skills', 'get_skill', 'list_brain_skillpack', 'advisor']) {
      expect(listedOn.has(gated)).toBe(true);
    }
    // Listed means callable: the gate-on probe reaches the handler and is
    // never a list-level denial (the fixture catalog makes it a clean read).
    const skills = await legacyToolCall('list_skills', {});
    expect(skills.kind).toBe('success');
    const skill = await legacyToolCall('get_skill', { name: 'brain-ops' });
    expect(skill.kind).toBe('success');

    await setGates(false);
    const listedOff = await legacyToolsList();
    for (const gated of ['list_skills', 'get_skill', 'list_brain_skillpack', 'advisor']) {
      expect(listedOff.has(gated)).toBe(false);
    }
  });

  e5test('FOV-6c: the ONE warn-mode case — a READ op accepts the garbage key with a warning, never a denial', async () => {
    try {
      await engine.setConfig('mcp.strict_params', 'warn');
      const body = await legacyRpc('tools/call', {
        name: 'list_pages',
        arguments: { limit: 1, e5_garbage_probe: true },
      });
      const result = body.result as ToolResult;
      expect(result.isError ?? false).toBe(false); // warn mode accepts
      const meta = result._meta as { warnings?: Array<{ code: string; param: string }> } | undefined;
      expect(meta?.warnings?.[0]?.code).toBe('unknown_param');
      expect(meta?.warnings?.[0]?.param).toBe('e5_garbage_probe');
      // The model-visible grace-period notice rides the second content block.
      const blocks = result.content.map(c => c.text);
      expect(blocks.some(t => t.includes('unknown parameter "e5_garbage_probe"'))).toBe(true);
    } finally {
      await engine.setConfig('mcp.strict_params', 'reject');
    }
  });
});

// ---------------------------------------------------------------------------
// (b) The OAuth serve-http semantics — in-process over the real dispatcher
// ---------------------------------------------------------------------------

const SCOPE_ROWS: ReadonlyArray<[string, string[]]> = [
  ['read', ['read']],
  ['write', ['write']],
  ['admin', ['admin']],
  ['agent', ['agent']],
];
const SURFACES: ReadonlyArray<McpSurface> = ['verbs', 'starter', 'full'];

function makeCell(scopeName: string, scopes: string[], surface: McpSurface, gatesOn: boolean, bound: boolean): Cell {
  return {
    label: `${scopeName}+${surface}+gates-${gatesOn ? 'on' : 'off'}${bound ? '+bound' : ''}`,
    scopes, surface, gatesOn, bound,
  };
}

describe('E5 truthful catalog — OAuth-path cells (serve-http seams over dispatch)', () => {
  e5test('extreme cell: admin + full + gates-on — list-set equality + full probe sweep + gate reachability', async () => {
    await setGates(true);
    const cell = makeCell('admin', ['admin'], 'full', true, false);
    const listed = await oauthToolsList(cell);
    expect(sortedArray(listed)).toEqual(sortedArray(expectedVisibleSet(cell)));
    // Gated ops are LISTED with gates on…
    for (const gated of ['list_skills', 'get_skill', 'list_brain_skillpack', 'advisor']) {
      expect(listed.has(gated)).toBe(true);
    }
    // …and agent-lane ops are NOT (admin does not imply agent, v0.38 D13).
    expect(listed.has('submit_agent')).toBe(false);

    expect(await sweepCell(cell, listed)).toEqual([]);

    // Listed-gated ops are REACHABLE with valid args (the call-time gate
    // backstop must agree with the list): never a list-level denial.
    for (const [name, args] of [
      ['list_skills', {}],
      ['get_skill', { name: 'brain-ops' }],
      ['list_brain_skillpack', {}],
      ['advisor', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const verdict = await oauthToolCall(cell, name, args);
      expect(['list_level_denial', 'unknown']).not.toContain(verdict.kind);
    }
  });

  e5test('extreme cell: read + starter + gates-off — list-set equality + full probe sweep', async () => {
    await setGates(false);
    const cell = makeCell('read', ['read'], 'starter', false, false);
    const listed = await oauthToolsList(cell);
    expect(sortedArray(listed)).toEqual(sortedArray(expectedVisibleSet(cell)));
    // The starter read slice keeps discovery (FOV-4/D4) and hides writes.
    expect(listed.has('request_tools')).toBe(true);
    expect(listed.has('put_page')).toBe(false);
    // STARTER_OPS carries localOnly daily-driver names (file_list); the
    // network list must still exclude them (localOnly filters run FIRST).
    expect(listed.has('file_list')).toBe(false);

    expect(await sweepCell(cell, listed)).toEqual([]);
  });

  e5test('extreme cell: bound client + write + full + gates-on — sweep + ENG-3/D9/D10 fence pins', async () => {
    await setGates(true);
    const cell = makeCell('write', ['write'], 'full', true, true);
    const listed = await oauthToolsList(cell);
    expect(sortedArray(listed)).toEqual(sortedArray(expectedVisibleSet(cell)));
    // The fenced-write allow-list and the D9 discovery carve-out are listed;
    // unfenceable writes are not.
    expect(listed.has('put_page')).toBe(true);
    expect(listed.has('request_tools')).toBe(true);
    expect(listed.has('extract_facts')).toBe(false);

    expect(await sweepCell(cell, listed)).toEqual([]);

    // Listed fenced write is genuinely callable (dry-run, in-prefix).
    const inPrefix = await oauthToolCall(cell, 'put_page', {
      slug: `${BOUND_PREFIX}e5-probe`, content: '# probe', dry_run: true,
    });
    expect(inPrefix.kind).toBe('success');

    // D10 carve-out: an out-of-prefix slug on a LISTED op is an ARGUMENT-level
    // denial — permission_denied WITHOUT the fence=op marker, excluded from
    // the invariant (and from the denied_after_list metric).
    const outOfPrefix = await oauthToolCall(cell, 'put_page', {
      slug: 'wiki/other/e5-probe', content: '# probe', dry_run: true,
    });
    expect(outOfPrefix.kind).toBe('arg_level_denial');
    expect(isListLevelDenialEnvelope(outOfPrefix.envelope)).toBe(false);

    // Inverse (ENG-3, same predicate at list and call time): a fence-hidden
    // unfenceable write with VALID args denies with the fence=op marker.
    const fenced = await oauthToolCall(cell, 'extract_facts', { turn_text: 'e5 probe' });
    expect(fenced.kind).toBe('list_level_denial');
    expect(fenced.envelope?.detail).toBe('fence=op');

    // D9: discovery survives the fence for slug-bound clients.
    const discovery = await oauthToolCall(cell, 'request_tools', {});
    expect(discovery.kind).toBe('success');
  });

  e5test('matrix: list-set equality for every scope × surface × gates × bound cell (amendment 31)', async () => {
    const mismatches: string[] = [];
    for (const gatesOn of [true, false]) {
      await setGates(gatesOn);
      for (const [scopeName, scopes] of SCOPE_ROWS) {
        for (const surface of SURFACES) {
          for (const bound of [false, true]) {
            const cell = makeCell(scopeName, scopes, surface, gatesOn, bound);
            const actual = sortedArray(await oauthToolsList(cell));
            const expected = sortedArray(expectedVisibleSet(cell));
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              mismatches.push(`${cell.label}: listed [${actual.join(',')}] != expected [${expected.join(',')}]`);
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  e5test('matrix: denial-class representative probes per cell (gated ×4, admin op, localOnly op, request_tools)', async () => {
    const violations: string[] = [];
    const record = (cell: Cell, name: string, msg: string) =>
      violations.push(`${cell.label} / ${name}: ${msg}`);

    for (const gatesOn of [true, false]) {
      await setGates(gatesOn);
      for (const [scopeName, scopes] of SCOPE_ROWS) {
        for (const surface of SURFACES) {
          const cell = makeCell(scopeName, scopes, surface, gatesOn, false);
          const expected = expectedVisibleSet(cell);

          // The four publish-gated ops, probed with VALID args so the
          // call-time gate backstop is actually reached. advisor's listed
          // case uses a garbage probe instead (its full run is exercised
          // once in the extreme cell; reachability is scope/surface-blind).
          const gatedProbes: Array<[string, Record<string, unknown>, Record<string, unknown> | null]> = [
            ['list_skills', {}, null],
            ['get_skill', { name: 'brain-ops' }, null],
            ['list_brain_skillpack', {}, null],
            ['advisor', {}, { e5_garbage_probe: true }],
          ];
          for (const [name, hiddenArgs, listedArgsOverride] of gatedProbes) {
            if (expected.has(name)) {
              const verdict = await oauthToolCall(cell, name, listedArgsOverride ?? hiddenArgs);
              if (verdict.kind === 'list_level_denial' || verdict.kind === 'unknown') {
                record(cell, name, `listed but ${verdict.kind}: ${JSON.stringify(verdict.envelope)}`);
              }
            } else {
              const verdict = await oauthToolCall(cell, name, hiddenArgs);
              if (verdict.kind === 'success') record(cell, name, 'hidden but callable');
              if (verdict.kind !== 'unknown' && verdict.kind !== 'list_level_denial') {
                record(cell, name, `hidden with unexpected verdict ${verdict.kind}: ${JSON.stringify(verdict.envelope)}`);
              }
            }
          }

          // One admin op: listed → dies at validation; hidden → scope/surface
          // denial, never success (the honest-catalog inverse).
          {
            const verdict = await oauthToolCall(cell, 'run_doctor', { e5_garbage_probe: true });
            if (expected.has('run_doctor')) {
              if (verdict.kind !== 'invalid_params') {
                record(cell, 'run_doctor', `listed but ${verdict.kind}: ${JSON.stringify(verdict.envelope)}`);
              }
            } else if (verdict.kind !== 'unknown' && verdict.kind !== 'list_level_denial') {
              record(cell, 'run_doctor', `hidden with unexpected verdict ${verdict.kind}`);
            }
          }

          // One localOnly op: never listed, always the no-leak unknown envelope.
          {
            if (expected.has('file_list')) record(cell, 'file_list', 'localOnly op in the expected list');
            const verdict = await oauthToolCall(cell, 'file_list', {});
            if (verdict.kind !== 'unknown') {
              record(cell, 'file_list', `expected unknown, got ${verdict.kind}: ${JSON.stringify(verdict.envelope)}`);
            }
          }

          // request_tools probed with {surface:'garbage'} → invalid_params on
          // the listed surfaces (never a persist), unknown on verbs (D4/D10).
          {
            const verdict = await oauthToolCall(cell, 'request_tools', { surface: 'garbage' });
            if (expected.has('request_tools')) {
              if (verdict.kind !== 'invalid_params') {
                record(cell, 'request_tools', `expected invalid_params, got ${verdict.kind}: ${JSON.stringify(verdict.envelope)}`);
              }
            } else if (verdict.kind !== 'unknown') {
              record(cell, 'request_tools', `expected unknown on ${cell.surface}, got ${verdict.kind}`);
            }
            const rows = await engine.executeRaw(
              `SELECT count(*)::int AS n FROM oauth_clients WHERE client_id = $1`,
              [`e5-${cell.label}`],
            ) as Array<{ n: number }>;
            if (rows[0].n !== 0) record(cell, 'request_tools', 'garbage surface probe persisted a client row');
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  e5test('FOV-4: the agent-only token row lists exactly its callable set, and every member is callable', async () => {
    await setGates(false);
    const cell = makeCell('agent', ['agent'], 'full', false, false);
    const listed = await oauthToolsList(cell);
    // #4098: the generic queue ops (get/list/progress/cancel) are
    // agentCallable with an owner-client fence, so the honest agent-lane
    // row includes them alongside the submit_agent/get_agent_job pair.
    expect(sortedArray(listed)).toEqual([
      'cancel_job', 'get_agent_job', 'get_job', 'get_job_progress',
      'list_jobs', 'request_tools', 'submit_agent',
    ]);

    // Probes: garbage args die at validation (proving the scope layer let
    // them through), and discovery genuinely works for the agent class.
    for (const name of ['submit_agent', 'get_agent_job', 'get_job', 'get_job_progress', 'cancel_job', 'list_jobs']) {
      const op = operations.find(o => o.name === name)!;
      const verdict = await oauthToolCall(cell, name, probeArgsFor(op));
      expect(verdict.kind).toBe('invalid_params');
    }
    const discovery = await oauthToolCall(cell, 'request_tools', {});
    expect(discovery.kind).toBe('success');

    // Inverse: a read op is NOT listed and NOT callable for the agent class.
    expect(listed.has('get_page')).toBe(false);
    const denied = await oauthToolCall(cell, 'get_page', { slug: 'x' });
    expect(denied.kind).toBe('list_level_denial');
  });

  e5test('monotonicity: verbs ⊆ starter ⊆ full listing per token class (both gate states)', async () => {
    const rows: Array<[string, string[], boolean]> = [
      ...SCOPE_ROWS.map(([name, scopes]) => [name, scopes, false] as [string, string[], boolean]),
      ['bound-write', ['write'], true],
    ];
    for (const gatesOn of [true, false]) {
      await setGates(gatesOn);
      for (const [scopeName, scopes, bound] of rows) {
        const verbs = await oauthToolsList(makeCell(scopeName, scopes, 'verbs', gatesOn, bound));
        const starter = await oauthToolsList(makeCell(scopeName, scopes, 'starter', gatesOn, bound));
        const full = await oauthToolsList(makeCell(scopeName, scopes, 'full', gatesOn, bound));
        for (const name of verbs) {
          expect(starter.has(name)).toBe(true);
        }
        for (const name of starter) {
          expect(full.has(name)).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// persist → re-list flip (amendment 20: per-request recompute, no restart)
// ---------------------------------------------------------------------------

describe('E5 truthful catalog — request_tools persist flips the very next list', () => {
  e5test('{surface: starter} persist → the next per-request resolution serves the starter list, no restart', async () => {
    await setGates(false);
    const clientId = 'e5-flip-client';
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name) VALUES ($1, $2)
       ON CONFLICT (client_id) DO NOTHING`,
      [clientId, 'e5 flip client'],
    );
    const auth: AuthInfo = { token: 't', clientId, scopes: ['read'] };

    // Request #1: NULL row surface + unset DCR default → the server ceiling
    // (full) — pre-WP4 behavior, existing clients untouched.
    const readRowSurface = async (): Promise<unknown> => {
      const rows = await engine.executeRaw(
        `SELECT surface FROM oauth_clients WHERE client_id = $1`, [clientId],
      ) as Array<{ surface: unknown }>;
      return rows[0]?.surface ?? null;
    };
    const resolveEffective = async (): Promise<McpSurface> => effectiveSurfaceForClient({
      ceiling: 'full',
      clientSurface: resolveClientRowSurface(await readRowSurface(), clientId),
      defaultSurface: await resolveDefaultClientSurface(engine, null),
    });

    const before = await resolveEffective();
    expect(before).toBe('full');
    const listBefore = await oauthToolsList({ label: 'flip-before', scopes: ['read'], surface: before, gatesOn: false, bound: false });

    // The REAL persist through the real dispatcher (the same seam serve-http
    // drives). NOTE the verifyAccessToken row-read leg of the loop is
    // emulated by re-reading the row below; the full OAuth-server round trip
    // is the Postgres-host assertion in test/e2e/serve-http-oauth.test.ts.
    const persist = await dispatchToolCall(engine, 'request_tools', { surface: 'starter' }, {
      remote: true, transport: 'http', sourceId: 'default', auth,
      surface: before, surfaceCeiling: 'full',
    });
    expect(persist.isError ?? false).toBe(false);
    const body = JSON.parse(persist.content[0].text) as { persisted: boolean; surface: string };
    expect(body.persisted).toBe(true);
    expect(body.surface).toBe('starter');

    // Request #2, same process, no restart: per-request recompute reads the
    // persisted row and the effective surface narrows to starter.
    const after = await resolveEffective();
    expect(after).toBe('starter');
    const listAfter = await oauthToolsList({ label: 'flip-after', scopes: ['read'], surface: after, gatesOn: false, bound: false });
    expect(sortedArray(listAfter)).toEqual(sortedArray(expectedVisibleSet({
      label: 'flip-expected', scopes: ['read'], surface: 'starter', gatesOn: false, bound: false,
    })));
    // Strictly narrower, and still a subset of what full served (ENG-1 ladder).
    expect(listAfter.size).toBeLessThan(listBefore.size);
    for (const name of listAfter) {
      expect(listBefore.has(name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Wall-clock budget (ENG-21) — declared LAST so it runs after every cell.
// ---------------------------------------------------------------------------

describe('E5 budget', () => {
  test(`the whole file completes in < ${WALL_CLOCK_BUDGET_MS / 60000} minutes`, () => {
    const elapsed = Date.now() - T0;
    if (elapsed >= WALL_CLOCK_BUDGET_MS) {
      const msg =
        `E5 truthful-catalog run took ${(elapsed / 1000).toFixed(1)}s — past the ${WALL_CLOCK_BUDGET_MS / 1000}s ` +
        `budget (ENG-21). The invariant guard must stay cheap enough to run in every unit pass; ` +
        `trim probe work or split cells before raising this budget.`;
      // Machine load makes wall-clock assertions flaky — hard-fail only when
      // the budget gate is explicitly armed (dedicated perf lane / local run).
      if (process.env.GBRAIN_ENFORCE_E5_BUDGET === '1') throw new Error(msg);
      console.warn(msg);
    }
  });
});
