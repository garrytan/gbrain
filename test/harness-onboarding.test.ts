import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessAdapter, HARNESS_ADAPTERS, renderHarnessReference } from '../src/core/harness/registry.ts';
import { readCredentials, writeCredentials, credentialReceipt, validateCredentials, type HarnessCredentials } from '../src/core/harness/credentials.ts';
import { installHarnessConnection } from '../src/core/harness/install.ts';
import { verifyHarnessConnection, type VerificationPeer } from '../src/core/harness/verify.ts';
import { parseMcpGrant } from '../src/commands/mcp.ts';

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'gbrain-harness-')); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const creds = (): HarnessCredentials => ({ version: 1, mcp_url: 'https://brain.example.com/mcp', issuer_url: 'https://brain.example.com', client_id: 'gbrain_cl_fixture', access_token: 'fixture-access-private-value', client_secret: 'fixture-client-private-value', profile: 'memory-writer', harness: 'codex', source_id: 'default', expires_at: Date.now() / 1000 + 3600 });

describe('harness identity and private handoff', () => {
  test('published adapter facts and guide destinations match the runtime registry', () => {
    expect(readFileSync(new URL('../docs/guides/harness-adapters.md', import.meta.url), 'utf8')).toBe(renderHarnessReference());
    for (const adapter of HARNESS_ADAPTERS) expect(() => statSync(new URL(`../${adapter.guide.split('#')[0]}`, import.meta.url))).not.toThrow();
  });
  test('old grok alias remains Build and personal agents have no asserted native MCP integration', () => {
    expect(harnessAdapter('grok').id).toBe('grok-build');
    for (const id of ['grok-bot', 'muse']) {
      expect(harnessAdapter(id).connection).toBe('thin-cli');
      expect(harnessAdapter(id).evidence.runtimeTestedAt).toBeNull();
      expect(harnessAdapter(id).modes).not.toContain('http');
    }
  });
  test('handoff is private and public receipt contains no credential', () => {
    const path = join(temp(), 'credential.json');
    const expected = creds();
    writeCredentials(path, expected);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readCredentials(path)).toEqual(expected);
    const receipt = JSON.stringify(credentialReceipt(readCredentials(path)));
    expect(receipt).not.toContain('fixture-access-private-value');
    expect(receipt).not.toContain('fixture-client-private-value');
    chmodSync(path, 0o644);
    expect(() => readCredentials(path)).toThrow('private');
  });
  test('rejects a foreign credential destination and cross-origin or insecure delivery', () => {
    const path = join(temp(), 'credential.json');
    writeCredentials(path, creds());
    expect(() => writeCredentials(path, { ...creds(), client_id: 'gbrain_cl_other' })).toThrow('another connection');
    expect(() => validateCredentials({ ...creds(), issuer_url: 'https://other.example.com' })).toThrow('same origin');
    expect(() => validateCredentials({ ...creds(), mcp_url: 'http://brain.example.com/mcp' })).toThrow('HTTPS');
  });
  test('new grant flags preserve explicit unlimited and independent delegated fences', () => {
    const parsed = parseMcpGrant(['grant', 'agent-example', '--profile', 'full', '--budget-usd-per-day', 'unlimited', '--bound-tools', 'search,get_page', '--delegated-slug-prefixes', 'agents/example/', '--if-version', '0']);
    expect(parsed.patch).toMatchObject({ budgetUsdPerDay: null, boundTools: ['search', 'get_page'], delegatedNamespace: 'prefixes', delegatedSlugPrefixes: ['agents/example/'] });
    expect(parsed.patch?.boundSlugPrefixes).toBeUndefined();
    expect(parsed.expectedRevision).toBe(0);
  });
});

describe('target-local configuration installation', () => {
  test('Codex install survives restart without environment and preserves unrelated TOML', async () => {
    const configPath = join(temp(), 'config.toml');
    writeFileSync(configPath, 'model = "example-model"\n');
    await installHarnessConnection(creds(), { harness: 'codex', configPath });
    await installHarnessConnection(creds(), { harness: 'codex', configPath });
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('model = "example-model"');
    expect(text).toContain('http_headers = { Authorization = "Bearer fixture-access-private-value" }');
    expect((text.match(/\[mcp_servers.gbrain\]/g) ?? []).length).toBe(1);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    await installHarnessConnection(creds(), { harness: 'codex', configPath, remove: true });
    expect(readFileSync(configPath, 'utf8')).toContain('model = "example-model"');
    expect(readFileSync(configPath, 'utf8')).not.toContain('fixture-access-private-value');
  });
  test('Claude preserves unrelated config and refuses edited ownership', async () => {
    const configPath = join(temp(), 'claude.json');
    writeFileSync(configPath, JSON.stringify({ theme: 'dark', mcpServers: { other: { type: 'http', url: 'https://other.example.com/mcp' } } }));
    await installHarnessConnection(creds(), { harness: 'claude-code', configPath });
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers.other).toBeDefined();
    cfg.mcpServers.gbrain.url = 'https://changed.example.com/mcp';
    writeFileSync(configPath, JSON.stringify(cfg));
    await expect(installHarnessConnection(creds(), { harness: 'claude-code', configPath })).rejects.toThrow('edited');
  });
  test('thin installer refuses local state even when its config is missing', async () => {
    const root = temp();
    mkdirSync(join(root, '.gbrain', 'pglite'), { recursive: true });
    await expect(installHarnessConnection(creds(), { harness: 'muse', root })).rejects.toThrow('existing state');
    expect(() => statSync(join(root, '.gbrain', 'config.json'))).toThrow();
  });
});

function fakePeer(options: { failCleanup?: boolean; lostWriteResponse?: boolean; workerResult?: boolean } = {}) {
  const pages = new Map<string, string>();
  const facts = new Map<string, string>();
  const calls: string[] = [];
  let prompt = '';
  const peer: VerificationPeer = { connect: async () => {}, close: async () => {}, call: async (name, p) => {
    calls.push(name);
    if (name === 'whoami') return { transport: 'oauth', client_id: 'gbrain_cl_fixture', scopes: ['read', 'write', 'agent'] };
    if (name === 'remember') { facts.set('1', String(p.fact)); if (options.lostWriteResponse) throw new Error('connection lost'); return { id: '1' }; }
    if (name === 'recall') return { facts: [...facts].map(([fact_id, fact]) => ({ fact_id, fact })) };
    if (name === 'forget') { if (options.failCleanup) throw new Error('denied'); facts.delete(String(p.id)); return { expired: true }; }
    if (name === 'list_pages') return [];
    if (name === 'put_page') { pages.set(String(p.slug), String(p.content)); if (options.lostWriteResponse) throw new Error('connection lost'); return { slug: p.slug }; }
    if (name === 'get_page') return { content: pages.get(String(p.slug)) };
    if (name === 'delete_page') { if (options.failCleanup) throw new Error('denied'); pages.delete(String(p.slug)); return { deleted: true }; }
    if (name === 'submit_agent') { prompt = String(p.prompt); return p.dry_run ? { dry_run: true } : { job_id: 17 }; }
    if (name === 'get_agent_job') return { status: 'completed', result: options.workerResult ? prompt : 'wrong output' };
    throw new Error('unexpected tool');
  } };
  return { peer, pages, facts, calls };
}

describe('capability verification', () => {
  test('proves tool roundtrip and cleanup without claiming vendor-session evidence', async () => {
    const fixture = fakePeer();
    const report = await verifyHarnessConnection(creds(), { peer: fixture.peer });
    expect(report.server_status).toBe('passed');
    expect(report.status).toBe('partial');
    expect(report.native_harness.status).toBe('unverified');
    expect(fixture.pages.size).toBe(0);
    expect(fixture.facts.size).toBe(0);
  });
  test('read-only profiles never attempt mutation', async () => {
    const fixture = fakePeer();
    await verifyHarnessConnection({ ...creds(), profile: 'memory-reader' }, { peer: fixture.peer });
    expect(fixture.calls).toEqual(['whoami', 'recall']);
  });
  test('lost write response is reconciled without retry and cleanup failure stays red', async () => {
    const fixture = fakePeer({ lostWriteResponse: true, failCleanup: true });
    const report = await verifyHarnessConnection(creds(), { peer: fixture.peer });
    expect(fixture.calls.filter(n => n === 'remember')).toHaveLength(1);
    expect(report.stages.find(s => s.name === 'write')?.reason).toBe('lost_response_reconciled_by_readback');
    expect(report.status).toBe('failed');
    expect(report.stages.find(s => s.name === 'cleanup')?.status).toBe('failed');
  });
  test('accepted job is insufficient: completed output must match randomized challenge', async () => {
    const fixture = fakePeer();
    const report = await verifyHarnessConnection({ ...creds(), profile: 'delegating-agent' }, { peer: fixture.peer, delegate: true });
    expect(report.stages.find(s => s.name === 'worker_completion')?.status).toBe('failed');
  });
  test('a stalled handshake is bounded even when the peer ignores abort', async () => {
    const fixture = fakePeer();
    fixture.peer.connect = () => new Promise(() => {});
    const report = await verifyHarnessConnection(creds(), { peer: fixture.peer, timeoutMs: 20 });
    expect(report.stages[0]).toMatchObject({ name: 'transport', status: 'failed', reason: 'timeout' });
  });
});
