/**
 * G6 (surface-verbs) — E2E: `gbrain serve --http --surface verbs` is a hard
 * tool-surface CEILING over a real HTTP boot. Hermetic PGLite (no Postgres /
 * Docker / DATABASE_URL), same boot pattern as connect-bearer.test.ts.
 *
 * What this pins (src/mcp/surface.ts + serve-http.ts resolveEffectiveSurface):
 *
 *   1. CEILING: tools/list under a verbs ceiling returns EXACTLY the seven
 *      frozen MEMORY_VERBS for BOTH a "full-preset" OAuth client (row surface
 *      rescoped to 'full') and a bare legacy bearer token. The per-request
 *      resolution is min(ceiling, client row surface ?? default), and a
 *      'verbs' ceiling short-circuits before the row is even read — a client
 *      preset can never widen past the CLI-declared ceiling.
 *   2. FAIL-CLOSED DISPATCH: tools/call on a real catalog op that the surface
 *      hides (list_pages) returns the SAME unknown-op envelope as a truly
 *      unknown name — hidden ops are uncallable, not just unlisted [c2]:
 *      { content: [{ type:'text', text: '{"error":"unknown_operation",...}' }],
 *        isError: true }.
 *   3. KILL SWITCH IS NARROW-ONLY (FOV-6a): GBRAIN_MCP_FORCE_SURFACE=full on
 *      the SERVER process cannot widen a --surface verbs ceiling. Precedence
 *      reality: ceiling = clampSurface(cliCeiling) = min(cliCeiling, env), so
 *      the env var min()s IN — widening requires an explicit --surface restart.
 *   4. VERB ROUND-TRIP: remember + recall execute over the verbs surface and
 *      every response carries protocol_version: 1 (MEMORY_VERBS v1).
 *
 * Two hermetic brains because PGLite is single-writer and the kill-switch env
 * must be pinned at a SECOND server process's spawn time.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VERB_NAMES } from '../../src/core/verbs.ts';
import { operations } from '../../src/core/operations.ts';

const PORT_A = 19833; // plain --surface verbs (unique across the e2e suite)
const PORT_B = 19834; // --surface verbs + GBRAIN_MCP_FORCE_SURFACE=full
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;

const CANONICAL_VERBS = ['recall', 'remember', 'entity', 'synthesize', 'forget', 'context_pack', 'delta'];

describe('serve --http --surface verbs ceiling E2E (hermetic PGLite)', () => {
  let homeA: string;
  let homeB: string;
  let serverA: ChildProcess | null = null;
  let serverB: ChildProcess | null = null;
  let bareTokenA = '';   // legacy bearer (`auth create`) — no client preset at all
  let bareTokenB = '';
  let fullClientId = '';     // OAuth client rescoped --surface full ("full preset")
  let fullClientSecret = '';
  let fullPresetToken = '';
  let readyA = false;
  let readyB = false;

  // Hermetic env for one brain: strip ambient Postgres URLs (a leaked
  // DATABASE_URL would put the spawned serve on Postgres) and any ambient
  // kill-switch value (server B sets its own explicitly).
  function brainEnv(home: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
    delete env.DATABASE_URL;
    delete env.GBRAIN_DATABASE_URL;
    delete env.GBRAIN_MCP_FORCE_SURFACE;
    return env;
  }

  function cli(env: Record<string, string | undefined>, args: string[]): string {
    return execFileSync('bun', ['run', 'src/cli.ts', ...args], {
      cwd: process.cwd(), env, encoding: 'utf8',
    });
  }

  async function waitReady(base: string, stderrRef: { text: string }): Promise<boolean> {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) return true;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`serve --http did not become ready at ${base}:\n${stderrRef.text.slice(-800)}`);
  }

  beforeAll(async () => {
    homeA = mkdtempSync(join(tmpdir(), 'gbrain-surface-a-'));
    homeB = mkdtempSync(join(tmpdir(), 'gbrain-surface-b-'));
    const envA = brainEnv(homeA);
    const envB = brainEnv(homeB);

    // ── Brain A: bare legacy token + a "full preset" OAuth client. All writes
    // happen BEFORE serve spawns — PGLite is single-writer.
    cli(envA, ['init', '--pglite', '--no-embedding', '--non-interactive']);
    const authA = cli(envA, ['auth', 'create', 'e2e-surface-bare']);
    bareTokenA = (authA.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    if (!bareTokenA) throw new Error(`auth create did not yield a token:\n${authA}`);

    const reg = cli(envA, [
      'auth', 'register-client', 'e2e-surface-full-preset',
      '--grant-types', 'client_credentials', '--scopes', 'read write',
      '--token-endpoint-auth-method', 'client_secret_post',
    ]);
    fullClientId = (reg.match(/Client ID:\s+(\S+)/) ?? ['', ''])[1];
    fullClientSecret = (reg.match(/Client Secret:\s+(\S+)/) ?? ['', ''])[1];
    if (!fullClientId || !fullClientSecret) throw new Error(`register-client did not yield creds:\n${reg}`);
    // The "full preset": pin the client's row surface to 'full' — the widest
    // possible per-client request. The verbs ceiling must still win.
    const rescope = cli(envA, ['auth', 'rescope-client', fullClientId, '--surface', 'full']);
    if (!/full/.test(rescope)) throw new Error(`rescope-client --surface full did not confirm:\n${rescope}`);

    // ── Brain B: bare legacy token only (kill-switch server).
    cli(envB, ['init', '--pglite', '--no-embedding', '--non-interactive']);
    const authB = cli(envB, ['auth', 'create', 'e2e-surface-force']);
    bareTokenB = (authB.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    if (!bareTokenB) throw new Error(`auth create did not yield a token:\n${authB}`);

    // ── Spawn both servers. B carries the kill switch set to FULL — the
    // widening attempt this suite proves impossible.
    const errA = { text: '' };
    const errB = { text: '' };
    serverA = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http', '--surface', 'verbs',
      '--bind', '127.0.0.1', '--port', String(PORT_A), '--public-url', BASE_A,
    ], { cwd: process.cwd(), env: envA, stdio: ['ignore', 'pipe', 'pipe'] });
    serverA.stderr?.on('data', (d: Buffer) => { errA.text += d.toString(); });

    serverB = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http', '--surface', 'verbs',
      '--bind', '127.0.0.1', '--port', String(PORT_B), '--public-url', BASE_B,
    ], {
      cwd: process.cwd(),
      env: { ...envB, GBRAIN_MCP_FORCE_SURFACE: 'full' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverB.stderr?.on('data', (d: Buffer) => { errB.text += d.toString(); });

    readyA = await waitReady(BASE_A, errA);
    readyB = await waitReady(BASE_B, errB);

    // Mint the full-preset client's token via the real /token endpoint.
    const tokenRes = await fetch(`${BASE_A}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${fullClientId}&client_secret=${fullClientSecret}&scope=${encodeURIComponent('read write')}`,
    });
    if (!tokenRes.ok) throw new Error(`token mint failed: ${tokenRes.status} ${await tokenRes.text()}`);
    fullPresetToken = ((await tokenRes.json()) as { access_token: string }).access_token;
  }, 120_000);

  afterAll(() => {
    for (const s of [serverA, serverB]) {
      if (s) { try { s.kill('SIGTERM'); } catch { /* best-effort */ } }
    }
    for (const h of [homeA, homeB]) {
      if (h) { try { rmSync(h, { recursive: true, force: true }); } catch { /* best-effort */ } }
    }
  });

  // /mcp responses arrive as plain JSON or as an SSE stream depending on the
  // SDK transport's negotiated mode — same helper shape as serve-http-oauth.
  function parseJsonRpc(text: string): any {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    const dataLines = trimmed.split('\n').filter((l) => l.startsWith('data:'));
    if (dataLines.length === 0) throw new Error('No JSON-RPC payload in /mcp response: ' + trimmed.slice(0, 300));
    return JSON.parse(dataLines[dataLines.length - 1].slice('data:'.length).trim());
  }

  async function mcp(base: string, token: string, method: string, params?: unknown): Promise<any> {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    });
    expect(res.status).toBe(200);
    const rpc = parseJsonRpc(await res.text());
    expect(rpc.error).toBeUndefined();
    return rpc.result;
  }

  async function listToolNames(base: string, token: string): Promise<string[]> {
    const result = await mcp(base, token, 'tools/list');
    expect(Array.isArray(result.tools)).toBe(true);
    return (result.tools as Array<{ name: string }>).map((t) => t.name).sort();
  }

  test('canonical frozen verb list sanity (source of truth: src/core/verbs.ts)', () => {
    // The e2e asserts against VERB_NAMES; VERB_NAMES must itself be the
    // frozen seven — if the canonical list drifts, fail HERE with a clear
    // message, not inside a tools/list diff.
    expect(([...VERB_NAMES] as string[]).sort()).toEqual([...CANONICAL_VERBS].sort());
    expect(VERB_NAMES.length).toBe(7);
  });

  test('ceiling: bare legacy token sees EXACTLY the 7 frozen verbs', async () => {
    expect(readyA).toBe(true);
    const names = await listToolNames(BASE_A, bareTokenA);
    expect(names).toEqual([...VERB_NAMES].sort());
  }, 30_000);

  test('ceiling: full-preset client (row surface=full) STILL sees exactly the 7 verbs', async () => {
    expect(readyA).toBe(true);
    // effective = min(ceiling='verbs', row='full') — the verbs ceiling
    // short-circuits before the row is read; the preset cannot widen it.
    const names = await listToolNames(BASE_A, fullPresetToken);
    expect(names).toEqual([...VERB_NAMES].sort());
  }, 30_000);

  test('fail-closed dispatch: tools/call on a surface-hidden real op (list_pages) returns the unknown-op envelope', async () => {
    expect(readyA).toBe(true);
    // Guard the premise: list_pages is a REAL catalog op that is NOT a verb —
    // so the deny below proves surface hiding, not a typo'd tool name.
    const listPagesOp = operations.find((o) => o.name === 'list_pages');
    expect(listPagesOp).toBeDefined();
    expect(listPagesOp!.verb).not.toBe(true);

    const result = await mcp(BASE_A, bareTokenA, 'tools/call', {
      name: 'list_pages',
      arguments: {},
    });
    // Pin the REAL envelope shape from serve-http.ts's CallTool handler: a
    // hidden op is indistinguishable from a nonexistent one (isError tool
    // result, never a transport-level error).
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'unknown_operation',
      message: 'Unknown: list_pages',
    });
  }, 30_000);

  test('kill switch cannot widen: GBRAIN_MCP_FORCE_SURFACE=full on the server process still serves exactly the 7 verbs', async () => {
    expect(readyB).toBe(true);
    // Precedence reality (surface.ts clampSurface + serve-http.ts
    // resolveEffectiveSurface): ceiling = min(cliCeiling, env force). The env
    // var is NARROW-ONLY (FOV-6a) — 'full' min()s into 'verbs' as a no-op.
    // Widening past the CLI-declared ceiling requires a --surface restart.
    const names = await listToolNames(BASE_B, bareTokenB);
    expect(names).toEqual([...VERB_NAMES].sort());
  }, 30_000);

  test('verb round-trip: remember then recall over the verbs surface, protocol_version 1 on both', async () => {
    expect(readyA).toBe(true);
    const factText = 'the surface ceiling e2e wrote this fact through the remember verb';

    const rememberResult = await mcp(BASE_A, bareTokenA, 'tools/call', {
      name: 'remember',
      arguments: { fact: factText, provenance: 'e2e: serve-http-surface-ceiling' },
    });
    expect(rememberResult.isError).toBeFalsy();
    const remembered = JSON.parse(rememberResult.content[0].text);
    expect(remembered.protocol_version).toBe(1);
    expect(remembered.status).toBe('inserted');
    expect(typeof remembered.id).toBe('string');

    const recallResult = await mcp(BASE_A, bareTokenA, 'tools/call', {
      name: 'recall',
      arguments: {},
    });
    expect(recallResult.isError).toBeFalsy();
    const recalled = JSON.parse(recallResult.content[0].text);
    expect(recalled.protocol_version).toBe(1);
    expect(Array.isArray(recalled.facts)).toBe(true);
    expect(recalled.total).toBeGreaterThanOrEqual(1);
    expect(recalled.facts.some((f: { fact: string }) => f.fact === factText)).toBe(true);
  }, 30_000);
});
