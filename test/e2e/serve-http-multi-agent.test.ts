/**
 * E2E: multi-agent shared brain — continuity + isolation (cathedral-6, T7).
 *
 * Spins up a real `gbrain serve --http` against real Postgres, mints scoped
 * agent clients through the NEW `gbrain agent register` CLI (presets,
 * --json --show-token, --url probe, --reissue), and exercises the full
 * cross-agent story end-to-end:
 *
 *   1.  CLI register IS the canonical creation of client A (coding-agent).
 *   2.  Continuity: B writes → A reads (search + get_page); A's workspace
 *       stays invisible to B.
 *   3.  Isolation: an out-of-grant per-call source_id → permission_denied.
 *   4.  put_page with a foreign `source_id` param: warn-ignored (put_page
 *       declares no such param), row lands in the token's write source.
 *   5.  Facts: B `remember`s a world fact → B and A (federated grant) recall
 *       it; a nova-scoped C does not — the cross-agent recall continuity pin.
 *   6.  Concurrency hammer: ~24 parallel put_page across A+B tokens.
 *   7.  takes_* regression pin (source-scoped via the take's page source).
 *   8.  Serve-version probe notes (live OK line; dead port → note, exit 0).
 *   9.  Admin register-client route: source binding + invalid_source +
 *       unknown_source structured 400s (absorbs TODOS:894).
 *   10. --reissue rotates the secret; OUTSTANDING tokens stay valid.
 *   11. CHAOS (last, own serve on 19134): SIGKILL mid-hammer, then direct SQL
 *       proves every landed row kept its writer's source and zero
 *       cross-source links exist.
 *
 * Run: DATABASE_URL=... bun test test/e2e/serve-http-multi-agent.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { hasDatabase, setupDB, teardownDB, getConn } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const skip = !hasDatabase();
// #3485 name floor: this suite opens direct SQL on the ambient URL and runs
// DELETE cleanups — refuse non-test-shaped database names before any
// connection is made.
if (!skip) {
  assertSafeE2eDatabaseUrl(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '');
}
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E serve-http-multi-agent tests (DATABASE_URL not set)');
}

// Non-vacuity guard: this file must never be a green skip in CI. It lives
// OUTSIDE describeE2E so it runs even when the gated suite is skipped.
test('not vacuously skipped in CI', () => {
  if (process.env.CI) expect(skip).toBe(false);
});

const PORT = 19133; // unique per e2e file (serve-http-oauth uses 19131)
const CHAOS_PORT = 19134; // chaos serve — fully isolated spawn + cleanup
const DEAD_PORT = 19140; // free per port census — nothing ever listens here
const BASE = `http://localhost:${PORT}`;
const ADMIN_BOOTSTRAP_TOKEN = 'e2e-admin-bootstrap-token-000000000000';

// Every client_name this file may mint. Pre-cleaned in beforeAll so a crashed
// prior run can't trip the duplicate_name guard (oauth_clients is NOT in
// helpers.ALL_TABLES, so rows survive setupDB's truncation).
const CLIENT_NAMES = [
  'aurora-coder',
  'nova-daily',
  'nova-reader',
  'probe-live-agent',
  'probe-dead-agent',
  'reissue-target',
  'admin-bound-agent',
] as const;

// Write sources by client (A's workspace derives from its name).
const A_SOURCE = 'aurora-coder-workspace';
const B_SOURCE = 'proj-widget';
const C_SOURCE = 'nova-notes';

// Embedding is FORCED UNAVAILABLE in every serve this file spawns: the
// nightly coverage lane (and dev shells) inject real provider keys, and the
// hammer must not spend. Blanking OPENAI alone is not enough — the gateway's
// config-less default embedding model is zeroentropyai:zembed-1 (1280-dim,
// keyed by ZEROENTROPY_API_KEY), and a lane-injected ZE/Voyage/Gemini key
// would make the serve embed for real: 1280-dim vectors into the 1536-dim
// column kill every write with a pgvector dimension error (observed), and
// each one costs money. Blank every embedding-capable provider key.
const NO_EMBED_ENV = {
  OPENAI_API_KEY: '',
  ZEROENTROPY_API_KEY: '',
  VOYAGE_API_KEY: '',
  GEMINI_API_KEY: '',
  GOOGLE_API_KEY: '',
} as const;

describeE2E('serve-http multi-agent E2E (cathedral-6)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let serveStderr = '';
  // Client ids accumulate here THE MOMENT they are parsed so afterAll can
  // revoke every one of them even if a later assertion throws.
  const registeredClientIds: string[] = [];

  let clientIdA: string | undefined;
  let tokenA: string | undefined;
  let tokenB: string | undefined;
  let tokenC: string | undefined;

  beforeAll(async () => {
    // Schema init + table truncation via the standard helper (also connects
    // the direct SQL pool used by the seed + assert queries below).
    const engine = await setupDB();
    const conn = getConn();

    // Pre-clean any clients a crashed prior run left behind (static name
    // list — no interpolation of runtime values).
    const nameList = CLIENT_NAMES.map(n => `'${n}'`).join(', ');
    await conn.unsafe(
      `DELETE FROM oauth_tokens WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE client_name IN (${nameList}))`,
    );
    await conn.unsafe(`DELETE FROM oauth_clients WHERE client_name IN (${nameList})`);

    // Seed the two shared sources. setupDB deleted every non-default source,
    // so this is a fresh create; ON CONFLICT keeps it re-runnable.
    await conn.unsafe(`
      INSERT INTO sources (id, name) VALUES
        ('proj-widget', 'proj-widget'),
        ('nova-notes', 'nova-notes')
      ON CONFLICT (id) DO NOTHING
    `);

    // Seed a nova-notes page so grant-exclusion assertions are non-vacuous:
    // it deliberately shares the 'handoff' keyword with B's proj-widget page.
    const { importFromContent } = await import('../../src/core/import-file.ts');
    await importFromContent(
      engine,
      'notes/nova-secret',
      '---\ntitle: Nova secret handoff\n---\nThe nova-only handoff decision that agent A must never see.',
      { noEmbed: true, sourceId: C_SOURCE },
    );

    // Start the HTTP server. env spread is required: bun's spawn/execSync do
    // NOT inherit process.env mutations (helpers.ts loads .env.testing via
    // mutation) unless we re-pass { ...process.env }. NO_EMBED_ENV forces
    // embedding unavailable (see its comment).
    const { spawn } = await import('child_process');
    serverProcess = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(PORT),
      '--public-url', `http://localhost:${PORT}`,
      '--enable-dcr',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GBRAIN_POOL_SIZE: '16',
        GBRAIN_ADMIN_BOOTSTRAP_TOKEN: ADMIN_BOOTSTRAP_TOKEN,
        ...NO_EMBED_ENV,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.stderr?.on('data', (d: Buffer) => { serveStderr += d.toString(); });

    // Wait for the server to be ready (up to 15s).
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) throw new Error('Server failed to start within 15s.\nstderr: ' + serveStderr.slice(-800));
  }, 90_000);

  afterAll(async () => {
    // Kill server first so it can't issue more tokens during cleanup.
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    // Revoke every client this file registered; surface cleanup failures to
    // stderr without throwing — a real test failure is more interesting than
    // the cleanup error that follows it.
    const { execSync } = await import('child_process');
    for (const id of registeredClientIds) {
      try {
        execSync(`bun run src/cli.ts auth revoke-client "${id}"`,
          { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error(`[afterAll] revoke-client cleanup failed for ${id}: ${e.message}`);
      }
    }
    await teardownDB();
  }, 30_000);

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Call MCP JSON-RPC with a bearer token (model-file idiom). */
  async function mcpCall(token: string, method: string, params?: any, base = BASE): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    });
  }

  /** Parse an /mcp response body — plain JSON or SSE-framed (`data:` lines). */
  function parseRpcText(raw: string): any {
    const trimmed = raw.trim();
    try { return JSON.parse(trimmed); } catch { /* fall through to SSE */ }
    const dataLines = trimmed.split('\n').filter(l => l.startsWith('data:'));
    if (dataLines.length > 0) {
      return JSON.parse(dataLines[dataLines.length - 1].slice(5).trim());
    }
    throw new Error(`unparseable /mcp response: ${trimmed.slice(0, 400)}`);
  }

  interface ToolCallResult {
    status: number;
    isError: boolean;
    /** JSON.parse of content[0].text when parseable, else null. */
    payload: any;
    /** All content-block texts joined (op result + warn blocks). */
    text: string;
    raw: string;
  }

  /** tools/call helper: unwraps the dispatch ToolResult envelope. */
  async function callTool(token: string, name: string, args: Record<string, unknown>, base = BASE): Promise<ToolCallResult> {
    const res = await mcpCall(token, 'tools/call', { name, arguments: args }, base);
    const raw = await res.text();
    let isError = false;
    let payload: any = null;
    let text = '';
    try {
      const rpc = parseRpcText(raw);
      if (rpc.error) {
        isError = true;
        text = JSON.stringify(rpc.error);
      } else {
        const result = rpc.result ?? {};
        isError = result.isError === true;
        const blocks: Array<{ text?: string }> = Array.isArray(result.content) ? result.content : [];
        text = blocks.map(b => b?.text ?? '').join('\n');
        if (typeof blocks[0]?.text === 'string') {
          try { payload = JSON.parse(blocks[0].text); } catch { /* non-JSON content */ }
        }
      }
    } catch {
      isError = true;
      text = raw;
    }
    return { status: res.status, isError, payload, text, raw };
  }

  /** Run `gbrain agent register <args>` as a subprocess. spawnSync (not
   * execSync) so stdout and stderr assert separately — same ambient-env
   * passthrough idiom as the model file's execSync calls (the CLI reaches
   * the serve's brain via the ambient DATABASE_URL). */
  function runRegister(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync('bun', ['run', 'src/cli.ts', 'agent', 'register', ...args],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  /** Parse the --json register output. JSON.parse of the ENTIRE stdout is
   * itself the stdout-purity assertion (all notes must go to stderr). */
  function parseRegisterJson(r: { status: number | null; stdout: string; stderr: string }): any {
    if (r.status !== 0) {
      throw new Error(`agent register exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }
    let doc: any;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      throw new Error(`register stdout is not a single JSON document (stdout-purity violation):\n${r.stdout}\nstderr: ${r.stderr}`);
    }
    // Dedupe: a --reissue doc carries the SAME client_id as its original
    // registration; revoking twice would log a spurious cleanup failure.
    if (typeof doc.client_id === 'string' && !registeredClientIds.includes(doc.client_id)) {
      registeredClientIds.push(doc.client_id);
    }
    return doc;
  }

  async function adminCookie(): Promise<string> {
    const login = await fetch(`${BASE}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_BOOTSTRAP_TOKEN }),
    });
    expect(login.ok).toBe(true);
    const match = (login.headers.get('set-cookie') || '').match(/gbrain_admin=([^;]+)/);
    expect(match).toBeTruthy();
    return `gbrain_admin=${match![1]}`;
  }

  const pageBody = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}`;

  // =========================================================================
  // Case 1 — CLI register end-to-end IS client A's canonical creation
  // =========================================================================

  test('case 1: agent register mints client A (coding-agent) and the token works at /mcp', async () => {
    const r = runRegister([
      'aurora-coder',
      '--harness', 'claude-code',
      '--preset', 'coding-agent',
      '--federated-read', 'proj-widget',
      '--url', `http://localhost:${PORT}`,
      '--json', '--show-token',
    ]);
    const doc = parseRegisterJson(r);

    expect(doc.ok).toBe(true);
    expect(doc.schema_version).toBe(1);
    // coding-agent derives the write source from the client name.
    expect(doc.preset_resolved.write_source).toBe(A_SOURCE);
    expect(doc.created_workspace_source).toBe(true);
    expect(doc.preset_resolved.federated_read).toEqual([A_SOURCE, 'proj-widget']);
    expect(doc.client_id).toMatch(/^gbrain_cl_/);
    expect(doc.access_token).toMatch(/^gbrain_at_/);
    expect(doc.token_redacted).toBe(false);
    expect(doc.mcp_url).toBe(`http://localhost:${PORT}/mcp`);

    clientIdA = doc.client_id;
    tokenA = doc.access_token;

    // USE the minted token against the live serve.
    const list = await mcpCall(tokenA!, 'tools/list');
    expect(list.status).toBe(200);
    const body = await list.text();
    expect(body).toContain('tools');
    expect(body).toContain('search');
  }, 45_000);

  // =========================================================================
  // Case 2 — continuity: B writes, A reads; A's workspace invisible to B
  // =========================================================================

  test('case 2: B (daily-driver) writes notes/handoff → A reads it; A workspace page denied to B', async () => {
    const r = runRegister([
      'nova-daily',
      '--harness', 'claude-code',
      '--preset', 'daily-driver',
      '--source', 'proj-widget',
      '--federated-read', 'proj-widget,nova-notes',
      '--url', `http://localhost:${PORT}`,
      '--json', '--show-token',
    ]);
    const doc = parseRegisterJson(r);
    expect(doc.ok).toBe(true);
    expect(doc.preset_resolved.write_source).toBe(B_SOURCE);
    tokenB = doc.access_token;
    expect(tokenB).toMatch(/^gbrain_at_/);

    // B writes the handoff page (lands in proj-widget, B's write source).
    const put = await callTool(tokenB!, 'put_page', {
      slug: 'notes/handoff',
      content: pageBody('Widget handoff', 'Handoff decision: ship the widget importer next sprint.'),
    });
    expect(put.isError).toBe(false);
    expect(put.payload?.slug).toBe('notes/handoff');

    // A reads it via search (keyword arm — embedding is forced unavailable)…
    const search = await callTool(tokenA!, 'search', { query: 'handoff', limit: 10 });
    expect(search.isError).toBe(false);
    const slugs = (Array.isArray(search.payload) ? search.payload : []).map((x: any) => x.slug);
    expect(slugs).toContain('notes/handoff');
    // …and the nova-notes page sharing the keyword stays OUT of A's grant.
    expect(slugs).not.toContain('notes/nova-secret');

    // …AND via get_page (federated grant includes proj-widget).
    const get = await callTool(tokenA!, 'get_page', { slug: 'notes/handoff' });
    expect(get.isError).toBe(false);
    expect(get.payload?.slug).toBe('notes/handoff');
    expect(get.payload?.source_id).toBe(B_SOURCE);

    // A writes into its own workspace…
    const scratch = await callTool(tokenA!, 'put_page', {
      slug: 'agents/scratch',
      content: pageBody('Aurora scratch', 'Private workspace scratchpad for aurora-coder.'),
    });
    expect(scratch.isError).toBe(false);

    // …and B (grant: proj-widget + nova-notes) cannot read it.
    const denied = await callTool(tokenB!, 'get_page', { slug: 'agents/scratch' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('page_not_found');
  }, 45_000);

  // =========================================================================
  // Case 3 — isolation: per-call source_id outside the grant
  // =========================================================================

  test('case 3: A query with source_id nova-notes → permission_denied; unqualified query stays in grant', async () => {
    const denied = await callTool(tokenA!, 'query', {
      query: 'handoff', source_id: 'nova-notes', expand: false,
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('permission_denied');

    const ok = await callTool(tokenA!, 'query', { query: 'handoff', expand: false });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain('notes/handoff');
    // The nova-notes page matching the same keyword must never leak.
    expect(ok.text).not.toContain('nova-secret');
  }, 30_000);

  // =========================================================================
  // Case 4 — put_page with a foreign source_id param (undeclared → warn-ignore)
  // =========================================================================

  test('case 4: put_page foreign source_id param is warn-ignored; row lands in the token write source', async () => {
    // put_page declares NO source_id param; in the default strict_params=warn
    // mode the dispatcher accepts the call, appends a warning content block,
    // and the write routes by the TOKEN's source — never the param.
    const put = await callTool(tokenA!, 'put_page', {
      slug: 'agents/foreign-param',
      content: pageBody('Foreign param probe', 'Body written with a foreign source_id param.'),
      source_id: 'proj-widget',
    });
    expect(put.isError).toBe(false);
    expect(put.payload?.slug).toBe('agents/foreign-param');
    // The warn-ignore block is model-visible (content[1]).
    expect(put.text).toContain('unknown parameter "source_id" ignored');

    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT source_id FROM pages WHERE slug = 'agents/foreign-param'`,
    ) as unknown as Array<{ source_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe(A_SOURCE);
  }, 30_000);

  // =========================================================================
  // Case 5 — facts continuity across agents (the cathedral-6 pin)
  // =========================================================================

  test('case 5: B remembers a world fact → B and A recall it; nova-scoped C does not', async () => {
    // Register client C first: read lane scoped ONLY to nova-notes (no preset
    // → passthrough grants federated_read=[nova-notes]).
    const r = runRegister([
      'nova-reader',
      '--harness', 'claude-code',
      '--source', 'nova-notes',
      '--url', `http://localhost:${PORT}`,
      '--json', '--show-token',
    ]);
    const doc = parseRegisterJson(r);
    expect(doc.ok).toBe(true);
    expect(doc.preset_resolved.federated_read).toEqual([C_SOURCE]);
    tokenC = doc.access_token;

    // B writes the fact into its write source (proj-widget), world-visible.
    const remembered = await callTool(tokenB!, 'remember', {
      fact: 'The Q3 launch decision is frozen (e2e-ma-fact).',
      provenance: 'e2e multi-agent case 5',
      visibility: 'world',
    });
    expect(remembered.isError).toBe(false);
    expect(['inserted', 'duplicate', 'superseded']).toContain(remembered.payload?.status);

    // B recalls its own fact.
    const recallB = await callTool(tokenB!, 'recall', { grep: 'e2e-ma-fact' });
    expect(recallB.isError).toBe(false);
    expect((recallB.payload?.facts ?? []).some((f: any) => f.fact.includes('e2e-ma-fact'))).toBe(true);

    // A recalls it too — federated grant includes proj-widget (cross-agent
    // recall continuity, Deliverable 1b).
    const recallA = await callTool(tokenA!, 'recall', { grep: 'e2e-ma-fact' });
    expect(recallA.isError).toBe(false);
    expect((recallA.payload?.facts ?? []).some((f: any) => f.fact.includes('e2e-ma-fact'))).toBe(true);

    // C is scoped to nova-notes only: the fact must NOT surface.
    const recallC = await callTool(tokenC!, 'recall', { grep: 'e2e-ma-fact' });
    expect(recallC.isError).toBe(false);
    expect((recallC.payload?.facts ?? []).some((f: any) => f.fact.includes('e2e-ma-fact'))).toBe(false);
  }, 45_000);

  // =========================================================================
  // Case 6 — concurrency hammer (write integrity under parallel load)
  // =========================================================================

  test('case 6: 24 parallel put_page across A+B — zero 5xx, exact per-source counts, no cross-source links', async () => {
    // Bodies carry [[wikilinks]] deliberately: auto-link does NOT run for
    // remote (MCP) callers (ops/pages.ts skips runAutoLink when
    // ctx.remote !== false), so ZERO link rows may appear from these writes.
    const body = (slug: string) =>
      pageBody(`Hammer ${slug}`, `Hammer body for ${slug} referencing [[notes/handoff]] and [[hammer/a-0]].`);

    interface Put { token: string; slug: string }
    const puts: Put[] = [];
    for (let i = 0; i < 10; i++) puts.push({ token: tokenA!, slug: `hammer/a-${i}` });
    // shared-a: same slug, same source, written twice by A. The two writes
    // sit in DIFFERENT chunks (sequential) so the case pins last-write-wins
    // row semantics rather than manufacturing an insert race.
    puts.push({ token: tokenA!, slug: 'hammer/shared-a' });
    for (let i = 0; i < 5; i++) puts.push({ token: tokenB!, slug: `hammer/b-${i}` });
    for (let i = 5; i < 10; i++) puts.push({ token: tokenB!, slug: `hammer/b-${i}` });
    puts.push({ token: tokenA!, slug: 'hammer/shared-a' });
    // shared-x: same slug, CROSS source, concurrently in the same chunk —
    // distinct (source_id, slug) rows must both land.
    puts.push({ token: tokenA!, slug: 'hammer/shared-x' });
    puts.push({ token: tokenB!, slug: 'hammer/shared-x' });
    expect(puts.length).toBe(24);

    const failures: string[] = [];
    for (let i = 0; i < puts.length; i += 8) {
      const chunk = puts.slice(i, i + 8);
      await Promise.all(chunk.map(async p => {
        const res = await callTool(p.token, 'put_page', { slug: p.slug, content: body(p.slug) });
        if (res.status >= 500) failures.push(`${p.slug}: HTTP ${res.status}`);
        else if (res.isError) failures.push(`${p.slug}: isError ${res.text.slice(0, 200)}`);
      }));
    }
    expect(
      failures.length,
      `hammer failures: ${failures.join(' | ')}\nserve stderr tail: ${serveStderr.slice(-800)}`,
    ).toBe(0);
    expect(
      serveStderr.includes('connect_timeout'),
      `serve stderr carries connect_timeout — pool starvation under the hammer.\nstderr tail: ${serveStderr.slice(-800)}`,
    ).toBe(false);

    const conn = getConn();
    // Per-source row counts, exact: A wrote a-0..a-9 + shared-a + shared-x =
    // 12 rows in its workspace; B wrote b-0..b-9 + shared-x = 11 rows.
    const aCount = await conn.unsafe(
      `SELECT count(*)::int AS n FROM pages WHERE source_id = '${A_SOURCE}' AND slug LIKE 'hammer/%'`,
    ) as unknown as Array<{ n: number }>;
    expect(aCount[0].n).toBe(12);
    const bCount = await conn.unsafe(
      `SELECT count(*)::int AS n FROM pages WHERE source_id = '${B_SOURCE}' AND slug LIKE 'hammer/%'`,
    ) as unknown as Array<{ n: number }>;
    expect(bCount[0].n).toBe(11);

    // Both same-slug-cross-source rows exist.
    const sharedX = await conn.unsafe(
      `SELECT source_id FROM pages WHERE slug = 'hammer/shared-x' ORDER BY source_id`,
    ) as unknown as Array<{ source_id: string }>;
    expect(sharedX.map(r => r.source_id)).toEqual([A_SOURCE, B_SOURCE]);

    // Zero cross-source links, brain-wide (remote put_page skips auto-link).
    const crossLinks = await conn.unsafe(`
      SELECT count(*)::int AS n
      FROM links l
      JOIN pages pf ON l.from_page_id = pf.id
      JOIN pages pt ON l.to_page_id = pt.id
      WHERE pf.source_id <> pt.source_id
    `) as unknown as Array<{ n: number }>;
    expect(crossLinks[0].n).toBe(0);
  }, 45_000);

  // =========================================================================
  // Case 7 — takes_* regression pin (source-scoped via the take's page)
  // =========================================================================

  test('case 7: takes_list never returns foreign rows — starter surface denies A; scoped C sees only its source', async () => {
    const conn = getConn();
    // Seed one world-holder take per source (world passes the fail-closed
    // per-token holder allow-list, so the only filter under test is SOURCE).
    await conn.unsafe(`
      INSERT INTO takes (page_id, row_num, claim, kind, holder)
      SELECT id, 9001, 'nova secret take e2e-ma', 'take', 'world'
      FROM pages WHERE slug = 'notes/nova-secret' AND source_id = '${C_SOURCE}'
      ON CONFLICT (page_id, row_num) DO NOTHING
    `);
    await conn.unsafe(`
      INSERT INTO takes (page_id, row_num, claim, kind, holder)
      SELECT id, 9001, 'proj widget take e2e-ma', 'take', 'world'
      FROM pages WHERE slug = 'notes/handoff' AND source_id = '${B_SOURCE}'
      ON CONFLICT (page_id, row_num) DO NOTHING
    `);

    // A runs on the 'starter' surface (coding-agent preset): takes_list is
    // hidden there, and a hidden op is indistinguishable from a nonexistent
    // one — denied. Either way, the foreign claim must never appear.
    const deniedA = await callTool(tokenA!, 'takes_list', { page_slug: 'notes/nova-secret' });
    expect(deniedA.isError).toBe(true);
    expect(deniedA.text).not.toContain('nova secret take e2e-ma');

    // C has no per-client surface row (no preset) → effective surface 'full',
    // so takes_list dispatches and the SOURCE scope does the work: a
    // proj-widget page's takes are foreign to nova-scoped C → empty.
    const foreignC = await callTool(tokenC!, 'takes_list', { page_slug: 'notes/handoff' });
    expect(foreignC.isError).toBe(false);
    expect(Array.isArray(foreignC.payload)).toBe(true);
    expect(foreignC.payload.length).toBe(0);
    expect(foreignC.text).not.toContain('proj widget take e2e-ma');

    // Positive control: C DOES see the take inside its own granted source —
    // the empty result above is scoping, not a broken op.
    const ownC = await callTool(tokenC!, 'takes_list', { page_slug: 'notes/nova-secret' });
    expect(ownC.isError).toBe(false);
    expect((ownC.payload ?? []).some((t: any) => t.claim === 'nova secret take e2e-ma')).toBe(true);
  }, 30_000);

  // =========================================================================
  // Case 8 — serve probe notes (live OK; dead port → note, still exit 0)
  // =========================================================================

  test('case 8: register --url probes the serve — live OK note; dead port note with exit 0', async () => {
    // Live serve: the probe note prints to stderr in --json mode.
    const live = runRegister([
      'probe-live-agent',
      '--harness', 'claude-code',
      '--source', 'proj-widget',
      '--url', `http://localhost:${PORT}`,
      '--json',
    ]);
    const liveDoc = parseRegisterJson(live);
    expect(liveDoc.ok).toBe(true);
    expect(live.stderr).toContain('serve health: OK');

    // Dead port: the probe is informational, NEVER a failure — exit stays 0
    // and the JSON document still lands on stdout.
    const dead = runRegister([
      'probe-dead-agent',
      '--harness', 'claude-code',
      '--source', 'proj-widget',
      '--url', `http://localhost:${DEAD_PORT}/mcp`,
      '--json',
    ]);
    expect(dead.status).toBe(0);
    const deadDoc = parseRegisterJson(dead);
    expect(deadDoc.ok).toBe(true);
    expect(dead.stderr).toContain('could not reach');
  }, 45_000);

  // =========================================================================
  // Case 9 (task item 9) — admin register-client route (absorbs TODOS:894)
  // =========================================================================

  test('case 9: admin register-client — source binding stored; invalid_source and unknown_source are structured 400s', async () => {
    const cookie = await adminCookie();

    // Happy path with source binding.
    const res = await fetch(`${BASE}/admin/api/register-client`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'admin-bound-agent',
        source: 'proj-widget',
        federatedRead: ['proj-widget', 'nova-notes'],
      }),
    });
    expect(res.ok).toBe(true);
    const created = await res.json() as { clientId: string };
    expect(created.clientId).toMatch(/^gbrain_cl_/);
    registeredClientIds.push(created.clientId);

    // The stored binding is visible through the admin listing route.
    const agentsRes = await fetch(`${BASE}/admin/api/agents`, { headers: { Cookie: cookie } });
    expect(agentsRes.ok).toBe(true);
    const agents = await agentsRes.json() as Array<{ id: string; source_id: string | null; federated_read: string[] }>;
    const row = agents.find(a => a.id === created.clientId);
    expect(row).toBeDefined();
    expect(row!.source_id).toBe('proj-widget');
    expect(row!.federated_read).toContain('proj-widget');
    expect(row!.federated_read).toContain('nova-notes');

    // Malformed source id → structured 400 invalid_source.
    const malformed = await fetch(`${BASE}/admin/api/register-client`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'admin-bad-agent', source: 'Bad/Source' }),
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as any).error).toBe('invalid_source');

    // Well-formed but nonexistent source → structured 400 unknown_source
    // (pre-fix this surfaced as a 500 when the FK fired inside the INSERT).
    const ghost = await fetch(`${BASE}/admin/api/register-client`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'admin-ghost-agent', source: 'ghost-source' }),
    });
    expect(ghost.status).toBe(400);
    expect(((await ghost.json()) as any).error).toBe('unknown_source');
  }, 30_000);

  // =========================================================================
  // --reissue lifecycle — rotation is NOT revocation
  // =========================================================================

  test('reissue: secret rotates, OLD access token still works until expiry, new secret mints', async () => {
    const reg = runRegister([
      'reissue-target',
      '--harness', 'claude-code',
      '--source', 'proj-widget',
      '--url', `http://localhost:${PORT}`,
      '--json', '--show-token',
    ]);
    const doc = parseRegisterJson(reg);
    expect(doc.ok).toBe(true);
    const clientId = doc.client_id as string;
    const oldSecret = doc.client_secret as string;
    const oldToken = doc.access_token as string;
    expect((await mcpCall(oldToken, 'tools/list')).status).toBe(200);

    const reissue = runRegister([
      '--reissue', clientId,
      '--harness', 'claude-code',
      '--url', `http://localhost:${PORT}`,
      '--json', '--show-token',
    ]);
    const doc2 = parseRegisterJson(reissue);
    expect(doc2.ok).toBe(true);
    expect(doc2.client_id).toBe(clientId);
    const newSecret = doc2.client_secret as string;
    const newToken = doc2.access_token as string;
    expect(newSecret).not.toBe(oldSecret);

    // Rotation is not revocation: the OLD access token STILL WORKS until it
    // expires — assert that explicitly.
    expect((await mcpCall(oldToken, 'tools/list')).status).toBe(200);
    // The token minted by the reissue works too.
    expect((await mcpCall(newToken, 'tools/list')).status).toBe(200);

    // The old secret no longer mints…
    const oldMint = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${encodeURIComponent(oldSecret)}&scope=read`,
    });
    expect(oldMint.ok).toBe(false);
    // …and the new secret exchanges OK.
    const newMint = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${encodeURIComponent(newSecret)}&scope=read`,
    });
    expect(newMint.ok).toBe(true);
    expect(((await newMint.json()) as any).access_token).toMatch(/^gbrain_at_/);
  }, 45_000);

  // =========================================================================
  // Case 10 — CHAOS (LAST): SIGKILL the serve mid-hammer; integrity holds
  // =========================================================================

  test('case 10 CHAOS: SIGKILL mid-hammer on own serve — landed rows keep writer source, zero cross-source links', async () => {
    const { spawn } = await import('child_process');
    let chaosProcess: ReturnType<typeof spawn> | null = null;
    let chaosStderr = '';
    try {
      // Own serve, fully isolated from 19133 (own spawn + own cleanup).
      chaosProcess = spawn('bun', [
        'run', 'src/cli.ts', 'serve', '--http',
        '--port', String(CHAOS_PORT),
        '--public-url', `http://localhost:${CHAOS_PORT}`,
        '--enable-dcr',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GBRAIN_POOL_SIZE: '16',
          GBRAIN_ADMIN_BOOTSTRAP_TOKEN: ADMIN_BOOTSTRAP_TOKEN,
          ...NO_EMBED_ENV,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      chaosProcess.stderr?.on('data', (d: Buffer) => { chaosStderr += d.toString(); });

      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`http://localhost:${CHAOS_PORT}/health`);
          if (res.ok) { ready = true; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      if (!ready) throw new Error('Chaos server failed to start within 15s.\nstderr: ' + chaosStderr.slice(-800));

      // Fire 16 writes WITHOUT awaiting, then SIGKILL mid-flight. Tokens are
      // DB-backed, so A/B tokens verify against 19134 too.
      const chaosBase = `http://localhost:${CHAOS_PORT}`;
      const body = (slug: string) =>
        pageBody(`Chaos ${slug}`, `Chaos body for ${slug} referencing [[notes/handoff]].`);
      const inflight: Promise<unknown>[] = [];
      for (let i = 0; i < 8; i++) {
        inflight.push(callTool(tokenA!, 'put_page', { slug: `chaos/a-${i}`, content: body(`chaos/a-${i}`) }, chaosBase).catch(() => null));
        inflight.push(callTool(tokenB!, 'put_page', { slug: `chaos/b-${i}`, content: body(`chaos/b-${i}`) }, chaosBase).catch(() => null));
      }
      await new Promise(r => setTimeout(r, 200));
      chaosProcess.kill('SIGKILL');
      await Promise.allSettled(inflight);
    } finally {
      if (chaosProcess && !chaosProcess.killed) chaosProcess.kill('SIGKILL');
    }

    // Integrity via direct SQL: every landed chaos row carries its WRITER's
    // source (partial landings are fine — the invariant is per-row, and a
    // kill before any landing still satisfies it).
    const conn = getConn();
    const rows = await conn.unsafe(
      `SELECT slug, source_id FROM pages WHERE slug LIKE 'chaos/%'`,
    ) as unknown as Array<{ slug: string; source_id: string }>;
    expect(rows.length).toBeLessThanOrEqual(16);
    for (const row of rows) {
      const expected = row.slug.startsWith('chaos/a-') ? A_SOURCE : B_SOURCE;
      expect(`${row.slug}=${row.source_id}`).toBe(`${row.slug}=${expected}`);
    }

    // Zero cross-source links survive the chaos too.
    const crossLinks = await conn.unsafe(`
      SELECT count(*)::int AS n
      FROM links l
      JOIN pages pf ON l.from_page_id = pf.id
      JOIN pages pt ON l.to_page_id = pt.id
      WHERE pf.source_id <> pt.source_id
    `) as unknown as Array<{ n: number }>;
    expect(crossLinks[0].n).toBe(0);

    // The 19133 serve was never touched: still healthy.
    const health = await fetch(`${BASE}/health`);
    expect(health.ok).toBe(true);
  }, 45_000);
});
