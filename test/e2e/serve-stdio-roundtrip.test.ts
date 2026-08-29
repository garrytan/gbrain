/**
 * E2E for the "standalone from nothing" funnel: `gbrain init --pglite` →
 * `gbrain serve` (stdio) wired into a coding agent as an MCP subprocess.
 *
 * This is the canonical local path the docs encourage for Claude Code / Codex
 * users with no remote brain:
 *
 *     claude mcp add gbrain -- gbrain serve
 *     codex  mcp add gbrain -- gbrain serve
 *
 * The `connect`/bearer E2E proves the REMOTE (HTTP) funnel. Nothing proved the
 * LOCAL stdio funnel end-to-end: that a freshly-init'd PGLite brain, served
 * over stdio, actually answers real MCP `tools/call`s through the official MCP
 * SDK client (the same handshake Claude Code / Codex perform). The
 * serve-stdio-lifecycle unit test only covers shutdown signalling.
 *
 * No Postgres / Docker. PGLite, hermetic temp HOME. Drives the real
 * StdioClientTransport, so the MCP SDK spawns `gbrain serve` for us, runs the
 * `initialize` handshake, and round-trips `tools/list` + `tools/call`.
 *
 * The second session (v0.45.7) covers `gbrain serve --surface verbs`: the
 * frozen 7-verb MEMORY_VERBS surface over the same real stdio transport —
 * exact tool list, the two ambient-recall verbs (context_pack + delta),
 * fail-closed dispatch on hidden ops, and the delta session cursor advancing
 * across two wakes.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VERB_NAMES } from '../../src/core/verbs.ts';
import { GBRAIN_MCP_INSTRUCTIONS } from '../../src/mcp/instructions.ts';

// Distinctive token so keyword search can't accidentally match anything else.
const MARKER = 'qantani-marker-9f3z';
const FEDERATED_MARKER = 'umbriel-federated-marker-71c4';

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
}

function resultSourceIds(text: string): string[] {
  const result = JSON.parse(text) as Array<{ source_id?: unknown }>;
  return result.flatMap((row) => (typeof row.source_id === 'string' ? [row.source_id] : []));
}

describe('serve stdio round-trip E2E (local PGLite → real MCP tool calls)', () => {
  let home: string;
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let connected = false;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-stdio-e2e-'));
    // Hermetic PGLite: strip any ambient Postgres URL so `init --pglite` and the
    // served brain actually use PGLite even when the shell/CI has DATABASE_URL
    // set (otherwise the subprocess comes up on Postgres → `engine: pglite`
    // assertion fails).
    // Build a concrete Record<string,string> (StdioClientTransport.env rejects
    // undefined values), dropping the ambient DB URLs so the subprocess is PGLite.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.GBRAIN_HOME = home;
    delete env.DATABASE_URL;
    delete env.GBRAIN_DATABASE_URL;
    delete env.GBRAIN_SOURCE;

    // 1. Init a local PGLite brain (the "from nothing" step).
    execFileSync('bun', ['run', 'src/cli.ts', 'init', '--pglite', '--no-embedding', '--non-interactive'], {
      cwd: process.cwd(), env, stdio: 'ignore',
    });

    // 2. Seed one page so page_count > 0 and search has something to find.
    //    --no-embed keeps it hermetic (no embedding provider configured); the
    //    keyword path still finds the distinctive marker.
    const notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(
      join(notes, 'marker.md'),
      `---\ntitle: ${MARKER} note\n---\n\n# ${MARKER}\n\nThis page exists to prove ${MARKER} is retrievable over stdio MCP.\n`,
    );
    execFileSync('bun', ['run', 'src/cli.ts', 'import', notes, '--no-embed'], {
      cwd: process.cwd(), env, stdio: 'ignore',
    });

    // Seed a second source that participates in unqualified federated reads.
    // Import through the CLI so this uses the ordinary source registration
    // and page-routing path.
    const federatedNotes = join(home, 'federated-notes');
    mkdirSync(federatedNotes, { recursive: true });
    writeFileSync(
      join(federatedNotes, 'marker.md'),
      `---\ntitle: ${FEDERATED_MARKER} note\n---\n\n# ${FEDERATED_MARKER}\n\nThis page exists only in the federated source.\n`,
    );
    execFileSync(
      'bun',
      ['run', 'src/cli.ts', 'sources', 'add', 'federated-source', '--path', federatedNotes, '--federated', '--force'],
      { cwd: process.cwd(), env, stdio: 'ignore' },
    );
    execFileSync(
      'bun',
      ['run', 'src/cli.ts', 'import', federatedNotes, '--no-embed', '--source-id', 'federated-source'],
      { cwd: process.cwd(), env, stdio: 'ignore' },
    );

    // 3. Let the MCP SDK spawn `gbrain serve` (stdio) and run the initialize
    //    handshake — exactly what `claude mcp add gbrain -- gbrain serve` does.
    transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', 'src/cli.ts', 'serve'],
      cwd: process.cwd(),
      env, // includes PATH (to find `bun`) + GBRAIN_HOME
    });
    client = new Client({ name: 'gbrain-stdio-e2e', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    connected = true;
  }, 60_000);

  afterAll(async () => {
    if (client) { try { await client.close(); } catch { /* best-effort */ } }
    if (transport) { try { await transport.close(); } catch { /* best-effort */ } }
    if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('initialize handshake + tools/list exposes the core retrieval tools', async () => {
    expect(connected).toBe(true);
    expect(client!.getInstructions()).toBe(GBRAIN_MCP_INSTRUCTIONS);
    const { tools } = await client!.listTools();
    const names = new Set(tools.map((t) => t.name));
    // The core MCP tools the connect LEARN_INSTRUCTION promises always work.
    // `capture` earned its MCP slot in the CLI-to-MCP gap-closure wave: the
    // LEARN_INSTRUCTION names it, so tools/list parity requires it advertised
    // (regression guard against re-demoting it to a CLI-only wrapper).
    for (const core of ['search', 'query', 'get_page', 'put_page', 'get_brain_identity', 'think', 'find_experts']) {
      expect(names.has(core)).toBe(true);
    }
    expect(names.has('capture')).toBe(true); // MCP-advertised since the gap-closure wave
  }, 30_000);

  test('tools/call get_brain_identity returns version + engine + a populated counter', async () => {
    expect(connected).toBe(true);
    const res = await client!.callTool({ name: 'get_brain_identity', arguments: {} });
    const text = textOf(res);
    const id = JSON.parse(text) as { version: string; engine: string; page_count: number };
    expect(typeof id.version).toBe('string');
    expect(id.engine).toBe('pglite');
    expect(id.page_count).toBeGreaterThanOrEqual(1); // the seeded page
  }, 30_000);

  test('tools/call search surfaces the seeded page (keyword path, no embeddings)', async () => {
    expect(connected).toBe(true);
    const res = await client!.callTool({ name: 'search', arguments: { query: MARKER, limit: 5 } });
    const text = textOf(res);
    // The result payload (slug / title / snippet) must mention the marker.
    expect(text).toContain(MARKER);
  }, 30_000);

  test('query treats an explicit __all__ like an omitted source in federated stdio', async () => {
    expect(connected).toBe(true);
    const args = { query: FEDERATED_MARKER, expand: false, limit: 5 };

    const omitted = textOf(await client!.callTool({ name: 'query', arguments: args }));
    const explicitAll = textOf(await client!.callTool({
      name: 'query',
      arguments: { ...args, source_id: '__all__' },
    }));
    const explicitDefault = textOf(await client!.callTool({
      name: 'query',
      arguments: { ...args, source_id: 'default' },
    }));

    expect(omitted).toContain(FEDERATED_MARKER);
    expect(explicitAll).toContain(FEDERATED_MARKER);
    expect(explicitDefault).not.toContain(FEDERATED_MARKER);
    expect(resultSourceIds(omitted)).toContain('federated-source');
    expect(resultSourceIds(explicitAll)).toContain('federated-source');
    expect(resultSourceIds(explicitDefault)).not.toContain('federated-source');
  }, 30_000);
});

// Distinct marker for the verbs-surface session (own temp brain, own token).
const VERBS_MARKER = 'veridian-verbs-7q2x';

describe('serve --surface verbs stdio E2E (the 7 frozen memory verbs over a real MCP session)', () => {
  let home: string;
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let connected = false;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-stdio-verbs-e2e-'));
    // Same hermetic-PGLite env dance as the full-surface session above.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.GBRAIN_HOME = home;
    delete env.DATABASE_URL;
    delete env.GBRAIN_DATABASE_URL;
    // Quiescent brain: the startup sweep could touch pages BETWEEN the two
    // delta wakes and legitimately re-surface them (a changed page is SUPPOSED
    // to re-appear), turning the cursor-advance assertion flaky. Kill switch
    // keeps the only writers the test's own tool calls.
    env.GBRAIN_SWEEP = '0';

    // 1. Init a local PGLite brain.
    execFileSync('bun', ['run', 'src/cli.ts', 'init', '--pglite', '--no-embedding', '--non-interactive'], {
      cwd: process.cwd(), env, stdio: 'ignore',
    });

    // 2. Seed two pages BEFORE serve spawns so the first delta wake has pages
    //    to deliver (the cursor-advance assertion needs a non-empty delivery).
    const notes = join(home, 'notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(
      join(notes, 'pack-a.md'),
      `---\ntitle: ${VERBS_MARKER} alpha\n---\n\n# ${VERBS_MARKER} alpha\n\nSeed page A for the verbs-surface delta cursor.\n`,
    );
    writeFileSync(
      join(notes, 'pack-b.md'),
      `---\ntitle: ${VERBS_MARKER} beta\n---\n\n# ${VERBS_MARKER} beta\n\nSeed page B for the verbs-surface delta cursor.\n`,
    );
    execFileSync('bun', ['run', 'src/cli.ts', 'import', notes, '--no-embed'], {
      cwd: process.cwd(), env, stdio: 'ignore',
    });

    // 3. Spawn the QUICKSTART surface — exactly the 7 protocol verbs.
    transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', 'src/cli.ts', 'serve', '--surface', 'verbs'],
      cwd: process.cwd(),
      env,
    });
    client = new Client({ name: 'gbrain-stdio-verbs-e2e', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    connected = true;
  }, 60_000);

  afterAll(async () => {
    if (client) { try { await client.close(); } catch { /* best-effort */ } }
    if (transport) { try { await transport.close(); } catch { /* best-effort */ } }
    if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('tools/list advertises EXACTLY the 7 frozen verbs — nothing more, nothing less', async () => {
    expect(connected).toBe(true);
    const { tools } = await client!.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...VERB_NAMES].sort());
  }, 30_000);

  test('tools/call context_pack on an unknown entity → schema-valid empty pack, protocol_version 1', async () => {
    expect(connected).toBe(true);
    const res = await client!.callTool({ name: 'context_pack', arguments: { entities: 'nonexistent-entity' } });
    expect((res as { isError?: boolean }).isError).not.toBe(true);
    const pack = JSON.parse(textOf(res)) as {
      protocol_version: number;
      entities: string[];
      cards: unknown[];
      open_threads: unknown[];
      facts: unknown[];
      text: string;
    };
    expect(pack.protocol_version).toBe(1);
    // The handler echoes the CAPPED entity list even when nothing resolves.
    expect(pack.entities).toEqual(['nonexistent-entity']);
    expect(Array.isArray(pack.cards)).toBe(true);
    expect(pack.cards.length).toBe(0); // unknown entity → no card, no error
    expect(Array.isArray(pack.open_threads)).toBe(true);
    expect(Array.isArray(pack.facts)).toBe(true);
    expect(typeof pack.text).toBe('string');
  }, 30_000);

  test('tools/call delta with an explicit epoch cursor → protocol_version 1 + has_more + next_cursor', async () => {
    expect(connected).toBe(true);
    const res = await client!.callTool({ name: 'delta', arguments: { since: '1970-01-01T00:00:00Z' } });
    expect((res as { isError?: boolean }).isError).not.toBe(true);
    const d = JSON.parse(textOf(res)) as {
      protocol_version: number;
      since: string;
      pages: Array<{ slug: string; title: string; updated_at: string }>;
      facts: unknown[];
      threads: unknown[];
      has_more: boolean;
      next_cursor: { since: string; slug: string };
    };
    expect(d.protocol_version).toBe(1);
    // `since` is NORMALIZED to ISO before it reaches rendering (red-team F4).
    expect(d.since).toBe('1970-01-01T00:00:00.000Z');
    expect(typeof d.has_more).toBe('boolean');
    expect(typeof d.next_cursor.since).toBe('string');
    expect(typeof d.next_cursor.slug).toBe('string');
    // From the epoch, both seeded pages are "changed since".
    const titles = d.pages.map((p) => p.title).join('\n');
    expect(titles).toContain(`${VERBS_MARKER} alpha`);
    expect(titles).toContain(`${VERBS_MARKER} beta`);
  }, 30_000);

  test('hidden op stays fail-closed: tools/call list_pages returns the unknown_tool envelope', async () => {
    expect(connected).toBe(true);
    // list_pages exists in the full catalog but is NOT a verb — surface
    // enforcement must reject it at dispatch (codex c2), with the same
    // envelope as a truly unknown op so the surface doesn't leak names.
    const res = await client!.callTool({ name: 'list_pages', arguments: {} });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const err = JSON.parse(textOf(res)) as { error: string; message: string };
    expect(err.error).toBe('unknown_tool');
    expect(err.message).toContain('list_pages');
  }, 30_000);

  test('remember → delta ×2 with one session_id: the cursor advances (no page re-delivery)', async () => {
    expect(connected).toBe(true);
    const SESSION = 'verbs-e2e-session-1';

    // Write through the protocol write verb — proves the verbs surface carries
    // writes over stdio and gives the first wake a fact to deliver.
    const remembered = await client!.callTool({
      name: 'remember',
      arguments: {
        fact: `${VERBS_MARKER} chose PGLite for the verbs-surface e2e`,
        provenance: 'e2e: serve-stdio-roundtrip',
      },
    });
    expect((remembered as { isError?: boolean }).isError).not.toBe(true);
    const rem = JSON.parse(textOf(remembered)) as { id: string; status: string; protocol_version: number };
    expect(rem.protocol_version).toBe(1);
    expect(['inserted', 'duplicate', 'superseded']).toContain(rem.status);
    expect(typeof rem.id).toBe('string');

    // Wake 1: explicit epoch cursor + session_id — delivers every seeded page
    // and establishes the per-session keyset cursor server-side.
    const first = await client!.callTool({
      name: 'delta',
      arguments: { since: '1970-01-01T00:00:00Z', session_id: SESSION },
    });
    const d1 = JSON.parse(textOf(first)) as {
      protocol_version: number;
      pages: Array<{ slug: string }>;
      facts: Array<{ fact: string }>;
      has_more: boolean;
    };
    expect(d1.protocol_version).toBe(1);
    expect(d1.pages.length).toBeGreaterThanOrEqual(2); // the seeded pages
    expect(d1.has_more).toBe(false); // tiny brain: everything fits in one wake
    // The remembered fact (world visibility) rides the facts arm.
    expect(d1.facts.some((f) => f.fact.includes(VERBS_MARKER))).toBe(true);

    // Wake 2: session_id ONLY — the stored cursor must exclude everything
    // wake 1 delivered (keyset advance over the real transport, red-team F2:
    // a delivered page never re-appears unless it changes).
    const second = await client!.callTool({ name: 'delta', arguments: { session_id: SESSION } });
    const d2 = JSON.parse(textOf(second)) as { protocol_version: number; pages: Array<{ slug: string }> };
    expect(d2.protocol_version).toBe(1);
    const delivered = new Set(d1.pages.map((p) => p.slug));
    for (const pg of d2.pages) expect(delivered.has(pg.slug)).toBe(false);
    expect(d2.pages.length).toBe(0); // nothing changed between wakes
  }, 30_000);
});
