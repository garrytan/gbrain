/**
 * Roadmap PR 3: the value card (gbrain value, MCP value) on repo-less and git-backed brains (in-memory PGLite;
 * Postgres too when DATABASE_URL is set), dispatched with remote=true over both MCP transports (stdio and HTTP).
 *
 * 1. Protects: a member's counts come only from what it can read, so adding pages it cannot read (readable_by, a
 *    folder rule, visibility: private), links touching them and facts on them never moves its numbers; brain-wide
 *    activity (lookups served, pages brought up on their own and later retrieved, the brain score) reaches only the
 *    owner and the trusted local CLI; recall is counted as a lookup; nightly items are read without stamping them
 *    seen; an off counter names the command that turns it on; one failed query degrades its row only and every query
 *    failing is the registered value_unavailable error.
 * 2. Fails when: a member token sees a count that includes a hidden page, a member sees any telemetry number, a row
 *    shows 0 where its number is unavailable, the card stamps learned items, or the session-start path imports the card.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { OWNER_MEMBER_KEY, __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { getTelemetryWriter } from '../src/core/search/telemetry.ts';
import { setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { buildValueCard, type ValueCard, type ValueRow } from '../src/core/value/card.ts';
import { formatValueCard } from '../src/core/value/format.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gb-value-card-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const row = (card: ValueCard, id: string): ValueRow => {
  const r = card.rows.find(x => x.id === id);
  if (!r) throw new Error('no row ' + id);
  return r;
};
const VISIBILITY_ROWS = ['pages', 'links', 'facts', 'conversations_archived'] as const;
const OWNER_ROWS = ['lookups_served', 'pages_brought_up', 'pages_later_retrieved', 'brain_score'] as const;

for (const kind of testBackends()) {
  describe('value card (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const local = (e: BrainEngine = engine) => buildValueCard({ engine: e, remote: false } as unknown as OperationContext);

    async function call(via: { stdioMember?: string; token?: string }, e: BrainEngine = engine) {
      const opts = via.token
        ? { remote: true, transport: 'http' as const, auth: await provider().verifyAccessToken(tokens[via.token]!) as unknown as AuthInfo, sourceId: 'default', takesHoldersAllowList: ['world'] }
        : { remote: true, transport: 'stdio' as const, sourceId: 'default', ...(via.stdioMember ? { stdioMember: via.stdioMember } : {}) };
      const out = await dispatchToolCall(e, 'value', {}, opts);
      const text = out.content.map(c => c.text).join('\n');
      let json: ValueCard | null = null;
      try { json = JSON.parse(text) as ValueCard; } catch { /* an error envelope */ }
      return { isError: out.isError === true, text, json };
    }
    async function card(via: { stdioMember?: string; token?: string }): Promise<ValueCard> {
      const r = await call(via);
      if (r.isError || !r.json) throw new Error('value failed: ' + r.text);
      return r.json;
    }
    async function rules(args: string[]): Promise<unknown> {
      const log = console.log;
      const lines: string[] = [];
      console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
      try { await runAccessRules(engine, args[0]!, args.slice(1), args.includes('--json')); } finally { console.log = log; }
      return args.includes('--json') ? JSON.parse(lines.join('\n')) : lines.join('\n');
    }
    const page = (slug: string, fm: string) => importFromContent(engine, slug, '---\n' + fm + '\n---\n# ' + slug + '\n\nBody for ' + slug + '.', { sourceId: 'default', noEmbed: true });
    async function fact(slug: string, text: string, extra = '') {
      const [r] = await engine.executeRaw<{ id: number | string }>('INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug) VALUES ($1, $2, $3, $4, $5, $6, $2) RETURNING id', ['default', slug, text, 'fact', 'world', 'fixture']); // gbrain-allow-direct-insert: test fixture facts
      if (extra) await engine.executeRaw('UPDATE facts SET ' + extra + ' WHERE id = $1', [Number(r!.id)]);
      return Number(r!.id);
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await addMember(engine, 'alice-example');
      await addMember(engine, 'bob-example');
      await engine.setConfig(OWNER_MEMBER_KEY, 'alice-example');
      for (const name of ['alice', 'bob']) tokens[name] = (await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] })).token;
      const ids = await engine.executeRaw<{ id: string; name: string }>("SELECT id::text AS id, name FROM access_tokens WHERE name IN ('alice', 'bob')");
      for (const t of ids) await bindCredential(engine, { kind: 'token', id: t.id }, { member: t.name === 'alice' ? 'alice-example' : 'bob-example' });
      await page('people/carol-example', 'type: person\ntitle: Carol Example');
      await page('companies/acme-example', 'type: company\ntitle: Acme Example');
      await engine.addLink('people/carol-example', 'companies/acme-example', 'works at', 'works_at', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' }); // gbrain-allow-direct-insert: test fixture edge
      const kept = await fact('people/carol-example', 'Carol prefers email');
      await fact('people/carol-example', 'Carol lives in town-a', 'superseded_by = ' + kept + ', expired_at = now()');
      await fact('people/carol-example', 'Carol owns a boat');
      const preview = await rules(['rule', 'add', '--source', 'default', '--prefix', 'restricted/', '--readers', 'alice-example', '--json']) as { expect: number };
      await rules(['rule', 'add', '--source', 'default', '--prefix', 'restricted/', '--readers', 'alice-example', '--yes', '--expect', String(preview.expect), '--json']);
    }, 180_000);
    afterAll(async () => { await close(); });

    test('a member counts only what it reads, and adding pages it cannot read, their links and facts never moves its numbers', async () => {
      const before = { http: await card({ token: 'bob' }), stdio: await card({ stdioMember: 'bob-example' }) };
      const ownerBefore = await local();
      for (const c of [before.http, before.stdio]) {
        expect(c).toMatchObject({ schema: 'gbrain.value', schema_version: 1, view: 'member' });
        expect(row(c, 'pages')).toMatchObject({ status: 'measured', value: { total: 2, by_kind: { person: 1, company: 1 } } });
        expect(row(c, 'links')).toMatchObject({ status: 'measured', value: { total: 1 } });
        expect(row(c, 'facts')).toMatchObject({ status: 'measured', value: { active: 2, superseded: 1, withdrawn: 0 } });
      }

      await page('notes/alice-only', 'type: note\ntitle: Alice only\nreadable_by: [alice-example]');
      await page('restricted/plan', 'type: note\ntitle: Restricted plan');
      await page('notes/private-draft', 'type: note\ntitle: Private draft\nvisibility: private');
      for (const hidden of ['notes/alice-only', 'restricted/plan', 'notes/private-draft']) {
        await engine.addLink('people/carol-example', hidden, 'see', 'mentions', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' }); // gbrain-allow-direct-insert: test fixture edge
        await engine.addLink(hidden, 'companies/acme-example', 'see', 'mentions', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' }); // gbrain-allow-direct-insert: test fixture edge
        await fact(hidden, 'A hidden claim on ' + hidden);
      }

      const after = { http: await card({ token: 'bob' }), stdio: await card({ stdioMember: 'bob-example' }) };
      for (const t of ['http', 'stdio'] as const) {
        for (const id of VISIBILITY_ROWS) expect(row(after[t], id)).toEqual(row(before[t], id));
      }
      const ownerAfter = await local();
      expect((row(ownerAfter, 'pages').value as { total: number }).total).toBe((row(ownerBefore, 'pages').value as { total: number }).total + 3);
      expect((row(ownerAfter, 'links').value as { total: number }).total).toBe(7);
      expect((row(ownerAfter, 'facts').value as { active: number }).active).toBe(5);
    });

    test('brain-wide activity reaches the owner and the local CLI only, never a member on either transport', async () => {
      const day = new Date().toISOString().slice(0, 10);
      await engine.executeRaw("INSERT INTO search_telemetry (date, mode, intent, count) VALUES ($1, 'hybrid', 'general', 7)", [day]);
      await engine.executeRaw("INSERT INTO context_volunteer_events (source_id, slug, confidence, match_arm, channel) VALUES ('default', 'people/carol-example', 0.9, 'title', 'claude-code'), ('default', 'companies/acme-example', 0.9, 'title', 'claude-code')");
      const [carol] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id = 'default' AND slug = 'people/carol-example'");
      await engine.executeRaw("INSERT INTO page_retrievals (page_id, last_retrieved_at) VALUES ($1, now() + interval '1 minute') ON CONFLICT (page_id) DO UPDATE SET last_retrieved_at = EXCLUDED.last_retrieved_at", [carol!.id]);

      for (const via of [{ token: 'bob' }, { stdioMember: 'bob-example' }]) {
        const r = await call(via);
        for (const id of OWNER_ROWS) {
          const x = row(r.json!, id);
          expect(x).toMatchObject({ status: 'unavailable', code: 'owner_only' });
          expect('value' in x).toBe(false);
        }
        expect(r.json!.state).toBe('complete');
      }
      for (const c of [await card({ token: 'alice' }), await card({}), await local()]) {
        expect(c.view).toBe('owner');
        expect(row(c, 'lookups_served')).toMatchObject({ status: 'measured', value: { total: 7, searches: 7, recalls: 0 }, note: 'best effort, may undercount' });
        expect(row(c, 'pages_brought_up')).toMatchObject({ status: 'measured', value: { pages: 2 } });
        expect(row(c, 'pages_later_retrieved')).toMatchObject({ status: 'measured', value: { pages: 1 } });
        expect(row(c, 'brain_score').status).toBe('measured');
      }
    });

    test('recall is counted as a lookup; a recall that also searches pages is counted once, as a search', async () => {
      const before = (row(await local(), 'lookups_served').value as { recalls: number }).recalls;
      const out = await dispatchToolCall(engine, 'recall', { entity: 'people/carol-example' }, { remote: true, transport: 'stdio', sourceId: 'default' });
      expect(out.isError ?? false).toBe(false);
      await getTelemetryWriter(engine).flush();
      const after = row(await local(), 'lookups_served').value as { recalls: number; total: number };
      expect(after.recalls).toBe(before + 1);
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

    test('archive counts come from published ledger units the caller can read', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('conversations', 'conversations') ON CONFLICT (id) DO NOTHING");
      for (const [hash, day] of [['h1', '2026-11-20'], ['h1', '2026-11-21'], ['h2', '2026-11-21']] as const) {
        const slug = 'conversations/claude-code/' + day + '/' + hash;
        await importFromContent(engine, slug, '---\ntype: conversation\ntitle: ' + slug + '\nvisibility: private\n---\n# ' + slug + '\n\nArchived.', { sourceId: 'conversations', noEmbed: true });
        await engine.setConfig('transcripts.archive.ledger.conversations.claude-code.' + hash + '.' + day, JSON.stringify({ hash: 'sha-' + hash + day, slug, complete: true }));
      }
      await engine.setConfig('transcripts.archive.ledger.conversations.codex.h3.2026-11-22', JSON.stringify({ held: { code: 'redaction_hold' } }));
      expect(row(await local(), 'conversations_archived')).toMatchObject({ status: 'measured', value: { conversations: 2, days: 2, units: 3 } });
      expect(row(await card({ token: 'bob' }), 'conversations_archived')).toMatchObject({ status: 'unavailable', code: 'out_of_scope' });
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
      const r = await call({}, broken);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('value_unavailable');
    });

    test('the card renders each status in words, and a keyless score reads N of N reachable without a key', () => {
      const text = formatValueCard({
        schema: 'gbrain.value', schema_version: 1, generated_at: '2026-11-25T00:00:00.000Z', window_days: 30, view: 'owner', state: 'degraded',
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
  test('a source with a git checkout counts the same way', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gb-value-git-'));
    execFileSync('git', ['init', '-q', repo]);
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    try {
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('notes', 'notes', $1)", [repo]);
      await importFromContent(engine, 'people/dana-example', '---\ntype: person\ntitle: Dana Example\n---\n# Dana\n\nHello.', { sourceId: 'notes', noEmbed: true });
      const c = await buildValueCard({ engine, remote: false } as unknown as OperationContext);
      expect(row(c, 'pages')).toMatchObject({ status: 'measured', value: { total: 1, by_kind: { person: 1 } } });
    } finally {
      await engine.disconnect();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('value card wiring', () => {
  test('no session-start module imports the card (no aggregate scan at session start)', () => {
    for (const f of ['src/core/context/session-start-pack.ts', 'src/core/context/session-start-sections.ts', 'src/core/context/session-start-output.ts', 'src/commands/hook.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/value\/card|ops\/value/);
    }
  });

  test('gbrain value --json on a fresh keyless brain prints the versioned card, counts a CLI recall, and the human card names the keyless score', () => {
    const gh = mkdtempSync(join(tmpdir(), 'gb-value-cli-'));
    const env = { ...process.env, GBRAIN_HOME: gh, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: '', GEMINI_API_KEY: '', DATABASE_URL: '' };
    try {
      const init = Bun.spawnSync(['bun', 'src/cli.ts', 'init', '--pglite', '--no-embedding'], { env, stdout: 'pipe', stderr: 'pipe' });
      expect(init.exitCode).toBe(0);
      expect(Bun.spawnSync(['bun', 'src/cli.ts', 'recall', 'people/nobody-example'], { env, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
      const json = Bun.spawnSync(['bun', 'src/cli.ts', 'value', '--json'], { env, stdout: 'pipe', stderr: 'pipe' });
      expect(json.exitCode).toBe(0);
      const doc = JSON.parse(json.stdout.toString()) as ValueCard;
      expect(doc).toMatchObject({ schema: 'gbrain.value', schema_version: 1, view: 'owner' });
      expect(row(doc, 'brain_score').value).toMatchObject({ keyless: true });
      expect(row(doc, 'lookups_served').value).toMatchObject({ recalls: 1 });
      const human = Bun.spawnSync(['bun', 'src/cli.ts', 'value'], { env, stdout: 'pipe', stderr: 'pipe' });
      expect(human.exitCode).toBe(0);
      expect(human.stdout.toString()).toContain('reachable without a key');
    } finally { rmSync(gh, { recursive: true, force: true }); }
  }, 120_000);
});
