/**
 * MCP tool answers on a served Rust brain against the same brain embedded (multi-user Rust, src/core/rust-engine/served/).
 *
 * One Rust brain is seeded through the MCP `put_page` tool on its owner. Then every read tool below runs twice through
 * the MCP dispatcher (`dispatchToolCall`): once on the owner (embedded) and once on a served client of it over a TLS
 * loopback listener. The tool result (content text, isError) must be byte-identical, for a local caller and for an
 * agent-facing remote caller (whose reads the client sends through the remote read list).
 *
 * 1. Protects: the MCP contract of a served brain: the same JSON an embedded brain gives, error results included.
 * 2. Fails on: any read tool whose served answer differs in one byte, or a remote read the served client refuses.
 * 3. Existing coverage: rust-served-cli.test.ts compares CLI output; nothing compared MCP tool results served.
 * 4. Seam: the owner's bearer check is served/auth.ts's `verify` seam (as the served parity variant); everything else
 *    is the real engine, listener, client and MCP dispatcher. Needs the addon `bun run rust:build` writes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const TOKEN = `gbrain_served_mcp_${process.pid}`;
const OWNER = { principal: { kind: 'legacy_token', id: 'served-mcp' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null };

let dir = '';
let tlsDir = '';
let owner: RustEngine;
let client: RustEngine;
let listener: ServedListener;
const savedEnv = process.env.GBRAIN_RUST_MULTIUSER;

const PAGES: Array<[string, string]> = [
  ['people/alice-example', '---\ntype: person\ntitle: Alice Example\ntags: [team, search]\n---\nAlice works on search ranking with [[companies/acme-example]].\n\n## Timeline\n- 2026-01-02: Joined the search team.\n'],
  ['companies/acme-example', '---\ntype: company\ntitle: Acme Example\ntags: [customer]\n---\nAcme Example builds graph memory tools.\n'],
  ['notes/keyword-ranking', '---\ntype: note\ntitle: Keyword ranking\ntags: [search]\n---\nKeyword ranking uses BM25 over chunks. See [[people/alice-example]].\n'],
];

const READS: Array<[string, Record<string, unknown>]> = [
  ['get_page', { slug: 'people/alice-example' }],
  ['get_page', { slug: 'people/alice-example', include_content: true }],
  ['get_page', { slug: 'notes/missing-page' }],
  ['list_pages', { limit: 10 }],
  ['list_pages', { type: 'person' }],
  ['find_pages', { pattern: 'people/*' }],
  ['search', { query: 'keyword ranking' }],
  ['search', { query: 'graph memory', limit: 5 }],
  ['get_backlinks', { slug: 'people/alice-example' }],
  ['get_links', { slug: 'people/alice-example' }],
  ['get_tags', { slug: 'people/alice-example' }],
  ['get_timeline', { slug: 'people/alice-example' }],
  ['get_stats', {}],
];

function selfSigned(): { cert: Buffer; key: Buffer } {
  tlsDir = mkdtempSync(join(tmpdir(), 'gbrain-served-mcp-tls-'));
  const run = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem')], { stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`openssl failed: ${run.stderr.toString()}`);
  return { cert: readFileSync(join(tlsDir, 'cert.pem')), key: readFileSync(join(tlsDir, 'key.pem')) };
}

/** The tool result as an agent receives it: the text of each content part and the error flag. */
const view = (result: { content: Array<{ text?: string }>; isError?: boolean }) =>
  ({ isError: result.isError === true, text: result.content.map(c => c.text ?? '').join('') });

describeAddon('MCP tools on a served Rust brain answer as the embedded brain', () => {
  beforeAll(async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    const addon = await loadRustArmAddon();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-served-mcp-'));
    owner = openRustEngine({ addon, databasePath: dir, servedOptions: { verify: {
      verify: async (_e, token) => { if (token !== TOKEN) throw new Error('Invalid token'); return { ...OWNER }; },
      ownerIds: async () => new Set(['served-mcp']),
    } } });
    await owner.connect({ engine: 'rust', database_path: dir } as never);
    for (const [slug, content] of PAGES) {
      const out = await dispatchToolCall(owner as unknown as BrainEngine, 'put_page', { slug, content, request_id: randomUUID() }, { remote: false });
      if (out.isError) throw new Error(`seed ${slug}: ${out.content.map(c => c.text).join('')}`);
    }
    const tls = selfSigned();
    listener = await listenServed(owner.ownerServer()!, { host: '127.0.0.1', port: 0, tls });
    client = openRustEngine({ addon, databasePath: '', served: { url: `gbrain+tls://localhost:${listener.port}`, token: TOKEN, ca: tls.cert } });
    await client.connect({ engine: 'rust' } as never);
  }, 120_000);

  afterAll(async () => {
    await client?.disconnect().catch(() => undefined);
    await listener?.close();
    await owner?.disconnect().catch(() => undefined);
    if (dir) { rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.gbrain-owner.lock`, { force: true }); }
    if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = savedEnv;
  });

  for (const remote of [false, true]) {
    for (const [tool, params] of READS) {
      test(`${remote ? 'remote' : 'local'} ${tool} ${JSON.stringify(params)}`, async () => {
        // Each side twice, alternating, and the second answers compared: a notice a process gives once (the degraded
        // search notice) then falls on the first call of each pair, never on one side only.
        const run = async (engine: RustEngine) => view(await dispatchToolCall(engine as unknown as BrainEngine, tool, params, { remote }) as never);
        await run(owner); await run(client);
        const embedded = await run(owner);
        const served = await run(client);
        // Not vacuous: a local caller's read of a page that exists answers, on both sides.
        if (!remote && params.slug !== 'notes/missing-page') expect(embedded.isError).toBe(false);
        expect(served).toEqual(embedded);
      });
    }
  }
});
