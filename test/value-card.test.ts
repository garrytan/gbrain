/**
 * Roadmap PR 3: the value card (gbrain value), trusted local CLI only in phase 1, on repo-less and git-backed brains
 * (in-memory PGLite; Postgres too when DATABASE_URL is set).
 *
 * 1. Protects: value is not an MCP tool on either transport, the full surface included; the card counts the whole
 *    brain for the brain host's own CLI; recall and keyword-only search are each counted once as a lookup; nightly
 *    items are read without stamping them seen; archive counts come only from published ledger units; an off counter
 *    names the command that turns it on; one failed query degrades its row only and every query failing is the
 *    registered value_unavailable error.
 * 2. Fails when: an MCP client can list or call value, a row shows 0 where its number is unavailable, a lookup is
 *    counted twice or not at all, the card stamps learned items, or the session-start path imports the card.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { getTelemetryWriter } from '../src/core/search/telemetry.ts';
import { setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { buildValueCard, type ValueCard, type ValueRow } from '../src/core/value/card.ts';
import { formatValueCard } from '../src/core/value/format.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const row = (card: ValueCard, id: string): ValueRow => {
  const r = card.rows.find(x => x.id === id);
  if (!r) throw new Error('no row ' + id);
  return r;
};

for (const kind of testBackends()) {
  describe('value card (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let token = '';
    const local = (e: BrainEngine = engine) => buildValueCard({ engine: e, remote: false } as unknown as OperationContext);
    const page = (slug: string, fm: string) => importFromContent(engine, slug, '---\n' + fm + '\n---\n# ' + slug + '\n\nBody for ' + slug + '.', { sourceId: 'default', noEmbed: true });
    async function fact(slug: string, text: string, extra = '') {
      const [r] = await engine.executeRaw<{ id: number | string }>('INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug) VALUES ($1, $2, $3, $4, $5, $6, $2) RETURNING id', ['default', slug, text, 'fact', 'world', 'fixture']); // gbrain-allow-direct-insert: test fixture facts
      if (extra) await engine.executeRaw('UPDATE facts SET ' + extra + ' WHERE id = $1', [Number(r!.id)]);
      return Number(r!.id);
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      token = (await mintLegacyToken(engine, { name: 'owner-example', scopes: ['read', 'write', 'admin'], takesHolders: ['world'], sourceGrant: ['default'] })).token;
      await page('people/carol-example', 'type: person\ntitle: Carol Example');
      await page('companies/acme-example', 'type: company\ntitle: Acme Example');
      await engine.addLink('people/carol-example', 'companies/acme-example', 'works at', 'works_at', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' }); // gbrain-allow-direct-insert: test fixture edge
      const kept = await fact('people/carol-example', 'Carol prefers email');
      await fact('people/carol-example', 'Carol lives in town-a', 'superseded_by = ' + kept + ', expired_at = now()');
      await fact('people/carol-example', 'Carol owns a boat');
    }, 180_000);
    afterAll(async () => { await close(); });

    test('value is not an MCP tool: absent from the full surface and unknown on stdio and HTTP', async () => {
      expect(operations.map(o => o.name)).not.toContain('value');
      expect(filterOpsForSurface(operations, 'full').map(o => o.name)).not.toContain('value');
      const stdio = await dispatchToolCall(engine, 'value', {}, { remote: true, transport: 'stdio', sourceId: 'default' });
      expect(stdio.isError).toBe(true);
      expect(stdio.content.map(c => c.text).join('\n')).toContain('unknown_tool');
      const limit = () => new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 });
      const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: { ip: limit(), token: limit() } });
      try {
        const rpc = async (method: string, params: Record<string, unknown>) => (await fetch('http://127.0.0.1:' + server.port + '/mcp', {
          method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).text();
        const listedText = await rpc('tools/list', {});
        const listed = JSON.parse(listedText.startsWith('{') ? listedText : listedText.split('\n').find(l => l.startsWith('data: '))!.slice(6)) as { result: { tools: Array<{ name: string }> } };
        const names = listed.result.tools.map(t => t.name);
        expect(names).toContain('get_page');
        expect(names).not.toContain('value');
        const called = await rpc('tools/call', { name: 'value', arguments: {} });
        expect(called).toContain('unknown_tool');
        expect(called).not.toContain('gbrain.value');
      } finally { server.stop?.(true); }
    }, 60_000);

    test('the brain host counts the whole brain: pages by kind, links and facts kept, private and restricted pages included', async () => {
      const before = await local();
      expect(before).toMatchObject({ schema: 'gbrain.value', schema_version: 1, state: 'complete' });
      expect(row(before, 'pages')).toMatchObject({ status: 'measured', value: { total: 2, by_kind: { person: 1, company: 1 } } });
      expect(row(before, 'links')).toMatchObject({ status: 'measured', value: { total: 1 } });
      expect(row(before, 'facts')).toMatchObject({ status: 'measured', value: { active: 2, superseded: 1, withdrawn: 0 } });
      await page('notes/alice-only', 'type: note\ntitle: Alice only\nreadable_by: [alice-example]');
      await page('notes/private-draft', 'type: note\ntitle: Private draft\nvisibility: private');
      for (const added of ['notes/alice-only', 'notes/private-draft']) {
        await engine.addLink('people/carol-example', added, 'see', 'mentions', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' }); // gbrain-allow-direct-insert: test fixture edge
        await fact(added, 'A claim on ' + added);
      }
      const after = await local();
      expect(row(after, 'pages')).toMatchObject({ value: { total: 4, by_kind: { person: 1, company: 1, note: 2 } } });
      expect(row(after, 'links')).toMatchObject({ value: { total: 3 } });
      expect(row(after, 'facts')).toMatchObject({ value: { active: 4, superseded: 1, withdrawn: 0 } });
    });

    test('activity rows: lookups served, pages brought up on their own, later retrieved and the brain score', async () => {
      const day = new Date().toISOString().slice(0, 10);
      await engine.executeRaw("INSERT INTO search_telemetry (date, mode, intent, count) VALUES ($1, 'hybrid', 'general', 7)", [day]);
      await engine.executeRaw("INSERT INTO context_volunteer_events (source_id, slug, confidence, match_arm, channel) VALUES ('default', 'people/carol-example', 0.9, 'title', 'claude-code'), ('default', 'companies/acme-example', 0.9, 'title', 'claude-code')");
      const [carol] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id = 'default' AND slug = 'people/carol-example'");
      await engine.executeRaw("INSERT INTO page_retrievals (page_id, last_retrieved_at) VALUES ($1, now() + interval '1 minute') ON CONFLICT (page_id) DO UPDATE SET last_retrieved_at = EXCLUDED.last_retrieved_at", [carol!.id]);
      const c = await local();
      expect(row(c, 'lookups_served')).toMatchObject({ status: 'measured', value: { total: 7, searches: 7, recalls: 0 }, note: 'best effort, may undercount' });
      expect(row(c, 'pages_brought_up')).toMatchObject({ status: 'measured', value: { pages: 2 } });
      expect(row(c, 'pages_later_retrieved')).toMatchObject({ status: 'measured', value: { pages: 1 } });
      expect(row(c, 'brain_score').status).toBe('measured');
    });

    test('a facts-only recall is counted as a recall', async () => {
      const before = (row(await local(), 'lookups_served').value as { recalls: number }).recalls;
      const out = await dispatchToolCall(engine, 'recall', { entity: 'people/carol-example' }, { remote: true, transport: 'stdio', sourceId: 'default' });
      expect(out.isError ?? false).toBe(false);
      await getTelemetryWriter(engine).flush();
      const after = row(await local(), 'lookups_served').value as { recalls: number; total: number };
      expect(after.recalls).toBe(before + 1);
    });

    test('a recall with a query and a keyword-only search are each counted exactly once', async () => {
      const lookups = async () => row(await local(), 'lookups_served').value as { total: number; searches: number };
      const before = await lookups();
      const recall = await dispatchToolCall(engine, 'recall', { query: 'Carol boat' }, { remote: true, transport: 'stdio', sourceId: 'default' });
      expect(recall.isError ?? false).toBe(false);
      await getTelemetryWriter(engine).flush();
      const mid = await lookups();
      expect(mid.total).toBe(before.total + 1);
      const search = await dispatchToolCall(engine, 'search', { query: 'Carol', match: 'keyword' }, { remote: true, transport: 'stdio', sourceId: 'default' });
      expect(search.isError ?? false).toBe(false);
      await getTelemetryWriter(engine).flush();
      const after = await lookups();
      expect(after.total).toBe(mid.total + 1);
      expect(after.searches).toBe(mid.searches + 1);
    });

    test('nightly items are counted without stamping them seen', async () => {
      const [f] = await engine.executeRaw<{ id: number | string }>("SELECT id FROM facts WHERE fact = 'Carol owns a boat'");
      await engine.executeRaw("INSERT INTO learning_items (run_id, source_id, kind, target_table, target_id, subject_slug) VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'fact_added', 'facts', $1, 'people/carol-example')", [Number(f!.id)]);
      const c = await local();
      expect(row(c, 'nightly_items')).toMatchObject({ status: 'measured', value: { items: 1 } });
      const [li] = await engine.executeRaw<{ shown_at: string | null }>('SELECT shown_at FROM learning_items');
      expect(li!.shown_at).toBeNull();
    });

    test('an off counter says off and names the command that turns it on', async () => {
      await setArchiveEnabled(engine, false);
      await engine.setConfig('search.track_retrieval', 'false');
      try {
        const c = await local();
        expect(row(c, 'conversations_archived')).toMatchObject({ status: 'off', turn_on: { argv: ['gbrain', 'transcripts', 'archive', 'on'] } });
        expect(row(c, 'pages_later_retrieved')).toMatchObject({ status: 'off', turn_on: { argv: ['gbrain', 'config', 'set', 'search.track_retrieval', 'true'] } });
        expect('value' in row(c, 'conversations_archived')).toBe(false);
        expect(c.state).toBe('complete');
        const text = formatValueCard(c);
        expect(text).toContain('off; turn it on with: gbrain transcripts archive on');
      } finally {
        await setArchiveEnabled(engine, true);
        await engine.setConfig('search.track_retrieval', 'true');
      }
    });

    test('archive counts come only from published ledger units', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('conversations', 'conversations') ON CONFLICT (id) DO NOTHING");
      for (const [hash, day] of [['h1', '2026-11-20'], ['h1', '2026-11-21'], ['h2', '2026-11-21']] as const) {
        const slug = 'conversations/claude-code/' + day + '/' + hash;
        await importFromContent(engine, slug, '---\ntype: conversation\ntitle: ' + slug + '\nvisibility: private\n---\n# ' + slug + '\n\nArchived.', { sourceId: 'conversations', noEmbed: true });
        await engine.setConfig('transcripts.archive.ledger.conversations.claude-code.' + hash + '.' + day, JSON.stringify({ hash: 'sha-' + hash + day, slug, complete: true }));
      }
      await engine.setConfig('transcripts.archive.ledger.conversations.codex.h3.2026-11-22', JSON.stringify({ held: { code: 'redaction_hold' } }));
      expect(row(await local(), 'conversations_archived')).toMatchObject({ status: 'measured', value: { conversations: 2, days: 2, units: 3 } });
    });

    test('one failed query degrades its row only; every query failing is the registered value_unavailable error', async () => {
      const failing = (match: (sql: string) => boolean) => new Proxy(engine, {
        get(t, k) {
          if (k === 'executeRaw') return async (sql: string, params?: unknown[]) => { if (match(sql)) throw new Error('simulated read failure'); return t.executeRaw(sql, params as never); };
          if (k === 'getHealth' && match('getHealth')) return async () => { throw new Error('simulated read failure'); };
          const v = (t as unknown as Record<PropertyKey, unknown>)[k];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }) as BrainEngine;
      const degraded = await local(failing(sql => /FROM links/.test(sql)));
      expect(degraded.state).toBe('degraded');
      expect(row(degraded, 'links')).toMatchObject({ status: 'unavailable', code: 'query_failed' });
      expect('value' in row(degraded, 'links')).toBe(false);
      expect(row(degraded, 'pages').status).toBe('measured');

      const broken = failing(() => true);
      await expect(local(broken)).rejects.toMatchObject({ code: 'value_unavailable' });
    });

    test('the card renders each status in words, and a keyless score reads N of N reachable without a key', () => {
      const text = formatValueCard({
        schema: 'gbrain.value', schema_version: 1, generated_at: '2026-11-25T00:00:00.000Z', window_days: 30, state: 'degraded',
        rows: [
          { id: 'brain_score', label: 'Brain score', status: 'measured', value: { score: 50, reachable: 50, max: 100, keyless: true } },
          { id: 'links', label: 'Links', status: 'unavailable', code: 'query_failed', cause: 'simulated read failure' },
          { id: 'lookups_served', label: 'Lookups served', status: 'measured', window_days: 30, value: { total: 3, searches: 2, recalls: 1 }, note: 'best effort, may undercount' },
        ],
      });
      expect(text).toContain('50 of 50 reachable without a key');
      expect(text).toContain('unavailable (query_failed): simulated read failure');
      expect(text).toContain('3 (2 searches, 1 recall); best effort, may undercount');
      expect(text).not.toMatch(/Links\s+0/);
    });
  });
}

describe('value card on a git-backed brain', () => {
  let engine: PGLiteEngine;
  let repo: string;
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'gb-value-git-'));
    execFileSync('git', ['init', '-q', repo]);
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    await engine.disconnect();
    rmSync(repo, { recursive: true, force: true });
  });

  test('a source with a git checkout counts the same way', async () => {
    {
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes', 'notes', $1)", [repo]);
      await importFromContent(engine, 'people/dana-example', '---\ntype: person\ntitle: Dana Example\n---\n# Dana\n\nHello.', { sourceId: 'notes', noEmbed: true });
      const c = await buildValueCard({ engine, remote: false } as unknown as OperationContext);
      expect(row(c, 'pages')).toMatchObject({ status: 'measured', value: { total: 1, by_kind: { person: 1 } } });
    }
  });
});

describe('value card wiring', () => {
  test('no session-start module imports the card (no aggregate scan at session start)', () => {
    for (const f of ['src/core/context/session-start-pack.ts', 'src/core/context/session-start-sections.ts', 'src/core/context/session-start-output.ts', 'src/commands/hook.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/value\/card|commands\/value/);
    }
  });

  test('gbrain value --json on a fresh keyless brain prints the versioned card, counts a CLI recall, the human card names the keyless score, and serve --surface full neither lists nor runs value', async () => {
    const gh = mkdtempSync(join(tmpdir(), 'gb-value-cli-'));
    const env = { ...process.env, GBRAIN_HOME: gh, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: '', GEMINI_API_KEY: '', DATABASE_URL: '' };
    try {
      const init = Bun.spawnSync(['bun', 'src/cli.ts', 'init', '--pglite', '--no-embedding'], { env, stdout: 'pipe', stderr: 'pipe' });
      expect(init.exitCode).toBe(0);
      expect(Bun.spawnSync(['bun', 'src/cli.ts', 'recall', 'people/nobody-example'], { env, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
      const json = Bun.spawnSync(['bun', 'src/cli.ts', 'value', '--json'], { env, stdout: 'pipe', stderr: 'pipe' });
      expect(json.exitCode).toBe(0);
      const doc = JSON.parse(json.stdout.toString()) as ValueCard;
      expect(doc).toMatchObject({ schema: 'gbrain.value', schema_version: 1, state: 'complete' });
      expect(row(doc, 'brain_score').value).toMatchObject({ keyless: true });
      expect(row(doc, 'lookups_served').value).toMatchObject({ recalls: 1 });
      const human = Bun.spawnSync(['bun', 'src/cli.ts', 'value'], { env, stdout: 'pipe', stderr: 'pipe' });
      expect(human.exitCode).toBe(0);
      expect(human.stdout.toString()).toContain('reachable without a key');
      const transport = new StdioClientTransport({ command: 'bun', args: ['src/cli.ts', 'serve', '--surface', 'full'], env: env as Record<string, string>, stderr: 'pipe' });
      const client = new Client({ name: 'value-card', version: '1' }, { capabilities: {} });
      await client.connect(transport);
      try {
        const names = (await client.listTools()).tools.map(t => t.name);
        expect(names).toContain('get_page');
        expect(names).not.toContain('value');
        const called = await client.callTool({ name: 'value', arguments: {} });
        expect(called.isError).toBe(true);
        expect(JSON.stringify(called.content)).toContain('unknown_tool');
      } finally { await client.close().catch(() => {}); }
    } finally { rmSync(gh, { recursive: true, force: true }); }
  }, 120_000);
});
