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
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Distinctive token so keyword search can't accidentally match anything else.
const MARKER = 'qantani-marker-9f3z';

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
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
    const { tools } = await client!.listTools();
    const names = new Set(tools.map((t) => t.name));
    // The core MCP tools the connect LEARN_INSTRUCTION promises always work.
    // `capture` is deliberately NOT here — it's a CLI-only wrapper, not an MCP
    // tool; the agent writes via put_page (regression guard for the stale
    // LEARN_INSTRUCTION that named capture as an MCP tool).
    for (const core of ['search', 'query', 'get_page', 'put_page', 'get_brain_identity', 'think', 'find_experts']) {
      expect(names.has(core)).toBe(true);
    }
    expect(names.has('capture')).toBe(false); // CLI-only, must not be advertised as MCP
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
});
