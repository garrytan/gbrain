/**
 * GBRA-498: room-aware results. The owner's own turn in a shared room reads at the owner's scope; the harness names
 * the room (X-Gbrain-Room, request-level _meta.room, or a room argument that can only add people) and every returned
 * item carries room_access: whether the room could have read it itself, and why not.
 *
 * 1. Protects: the three rules no change may bend (a room never refuses, shortens or fails a read; with no room the
 *    answer is unchanged; nothing changes what any caller reads), the decision matching an on_behalf_of read of the
 *    same room exactly, the reason classes, the owner's exemption from may_act_for staying out of on_behalf_of,
 *    injected argument text never shrinking the harness's room, the room argument never reaching a handler or a
 *    write, the count-only audit row, and whoami advertising the feature.
 * 2. Fails when: a room drops, reorders or refuses an item; an item the room cannot read reads as readable; a room
 *    argument naming a smaller room changes a mark; the owner's room exemption lets on_behalf_of through; the audit
 *    row carries a slug; a write rejects or stores the room argument.
 * 3. Real seams: legacy tokens minted and bound by the member functions, verified by the OAuth provider, dispatched
 *    through MCP dispatch on a repo-less brain (no git checkout; folder rules in the database store); embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { operations } from '../src/core/operations.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addGroup, addMember, bindCredential } from '../src/core/access/members.ts';
import { clearOwner, setOwner } from '../src/core/access/owner.ts';
import { bindMemberSource, unbindMemberSource } from '../src/core/access/member-sources.ts';
import { setMemberLabelledOnly } from '../src/core/access/labelled-only.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { __setRoomDeadlineForTests, assessRoom, keepRoomEvidence, readRoomDeclaration, ROOM_COVERED_OPS } from '../src/core/access/room.ts';
import { EGRESS_CAP_MIN, encodedFrameBytes } from '../src/core/egress-budget.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

const SRC = 'room-team';
const PAGES = {
  open: { slug: 'notes/open-plan', fm: [] as string[] },
  quiet: { slug: 'notes/quiet-plan', fm: ['visibility: private'] },
  mine: { slug: 'notes/owner-plan', fm: ['readable_by: [owner-example]'] },
  team: { slug: 'notes/team-plan', fm: ['readable_by: [group:team-a]'] },
  folder: { slug: 'partners/owner-example/brief', fm: [] as string[] },
  derived: { slug: 'notes/derived-plan', fm: ['derived_from: [notes/owner-plan]'], type: 'concept' },
} as const;
type Key = keyof typeof PAGES;
const page = (key: Key) => ['---', 'type: ' + ('type' in PAGES[key] ? (PAGES[key] as { type: string }).type : 'note'), 'title: ' + key + ' plan', ...PAGES[key].fm, '---',
  '# ' + key + ' plan', '', 'Harbor ledger planning notes for the roadmap.'].join('\n');

type Channels = { header?: string; meta?: unknown };
type Called = { isError: boolean; text: string; json: unknown; meta: Record<string, unknown> | undefined; blocks: string[]; raw: ToolResult };

/** content[0] with every room_access key removed, so a marked answer compares with an unmarked one. */
function unmarked(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unmarked);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'room_access').map(([k, x]) => [k, unmarked(x)]));
  return v;
}
/** slug -> room_access for every top-level item (an array, or an object's pages/results list, or the object itself). */
function marks(json: unknown): Record<string, unknown> {
  const items = Array.isArray(json) ? json : json && typeof json === 'object' ? ((json as { pages?: unknown[]; results?: unknown[] }).pages ?? (json as { results?: unknown[] }).results ?? [json]) : [];
  return Object.fromEntries((items as Array<Record<string, unknown>>).filter(i => typeof i?.slug === 'string').map(i => [i.slug as string, i.room_access]));
}

for (const kind of testBackends()) {
  describe('room-aware results (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let auditDir: string;
    const tokens: Record<string, { id: string; token: string }> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const verify = async (who: string) => await provider().verifyAccessToken(tokens[who]!.token) as unknown as AuthInfo;

    async function call(who: string | null, op: string, params: Record<string, unknown>, opts: { room?: Channels; obo?: Channels } = {}): Promise<Called> {
      const auth = who ? await verify(who) : undefined;
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: who ? 'http' : 'stdio', auth, sourceId: SRC, takesHoldersAllowList: ['world'],
        ...(opts.room ? { room: { header: opts.room.header, requestMeta: opts.room.meta === undefined ? undefined : { room: opts.room.meta } } } : {}),
        ...(opts.obo ? { onBehalfOf: { header: opts.obo.header, requestMeta: opts.obo.meta === undefined ? undefined : { on_behalf_of: opts.obo.meta } } } : {}),
      });
      const text = out.content[0]!.text;
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* prose */ }
      return { isError: out.isError === true, text, json, meta: out._meta, blocks: out.content.slice(1).map(c => c.text), raw: out };
    }

    const READS: Array<[string, Record<string, unknown>]> = [
      ['search', { query: 'harbor ledger planning', match: 'keyword', limit: 20 }],
      ['list_pages', { limit: 50 }],
      ['find_pages', { pattern: 'notes/' }],
      ['get_page', { slug: PAGES.mine.slug }],
      ['get_chunks', { slug: PAGES.quiet.slug }],
      ['recall', { entity: PAGES.open.slug }],
    ];

    beforeAll(async () => {
      auditDir = mkdtempSync(join(tmpdir(), 'gbrain-room-audit-'));
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of ['owner-example', 'alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
      await addGroup(engine, 'team-a', ['bob-example', 'owner-example']);
      await setOwner(engine, 'owner-example');
      await setMemberLabelledOnly(engine, 'carol-example', true, { remote: false });
      await proposeRevision(engine, SRC, [{ id: 'owner-partners', prefix: 'partners/owner-example/', readable_by: ['member:owner-example'] }], { origin: 'cli', store: 'database' });
      for (const key of Object.keys(PAGES) as Key[]) await importFromContent(engine, PAGES[key].slug, page(key), { sourceId: SRC });
      const mint = async (name: string, binding: { member?: string; mayActFor?: string[] }, scopes = ['read', 'write']) => {
        const minted = await mintLegacyToken(engine, { name, scopes, takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = { id: minted.id, token: minted.token };
        if (binding.member || binding.mayActFor) await bindCredential(engine, { kind: 'token', id: minted.id }, binding);
        if (!binding.member) await readsUnscopedOnPurpose(engine, minted.id);
      };
      await mint('owner', { member: 'owner-example' });
      await mint('bot', { mayActFor: ['*'] });
      await mint('bob', { member: 'bob-example' });
      await mint('bob-room', { member: 'bob-example', mayActFor: ['group:team-a'] });
      await mint('plain', {});
      await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
        for (const visibility of ['world', 'private']) {
          const out = await call('owner', 'remember', { fact: 'Harbor ledger ' + visibility + ' note', entity: PAGES.open.slug, visibility, provenance: 'room test', content_origin: 'user_said' });
          expect(out.isError).toBe(false);
        }
      });
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('rule 1: a room never refuses, shortens, reorders or fails a read, whatever the room or the caller', async () => {
      const rooms: Array<[string, { room: Channels }]> = [
        ['owner, group room', { room: { header: 'group:team-a' } }],
        ['owner, guest', { room: { meta: ['guest'] } }],
        ['owner, malformed', { room: { header: 'Not Valid' } }],
        ['owner, empty', { room: { meta: [] } }],
        ['owner, null', { room: { meta: null } }],
        ['owner, unknown member', { room: { header: 'zed-example' } }],
      ];
      for (const [op, params] of READS) {
        const plain = await call('owner', op, params);
        expect({ op, isError: plain.isError }).toEqual({ op, isError: false });
        for (const [label, opts] of rooms) {
          const marked = await call('owner', op, params, opts);
          expect({ op, label, isError: marked.isError }).toEqual({ op, label, isError: false });
          expect({ op, label, body: unmarked(marked.json) }).toEqual({ op, label, body: plain.json });
        }
        for (const who of ['bob', 'plain']) {
          const base = await call(who, op, params);
          const marked = await call(who, op, params, { room: { header: 'group:team-a' } });
          expect({ op, who, isError: marked.isError, body: unmarked(marked.json) }).toEqual({ op, who, isError: base.isError, body: base.json });
        }
      }
    }, 240_000);

    test('rule 2: with no room the answer carries no room key, mark or notice', async () => {
      for (const [op, params] of READS) {
        const out = await call('owner', op, params);
        expect({ op, marked: out.text.includes('room_access'), meta: out.meta?.room, notice: out.blocks.some(b => b.includes('notice room_')) })
          .toEqual({ op, marked: false, meta: undefined, notice: false });
      }
      const defs = buildToolDefs(operations.filter(o => ROOM_COVERED_OPS.has(o.name)));
      for (const def of defs) expect({ tool: def.name, room: 'room' in def.inputSchema.properties }).toEqual({ tool: def.name, room: false });
      for (const def of buildToolDefs(operations.filter(o => ROOM_COVERED_OPS.has(o.name)), { strictParams: true })) expect({ tool: def.name, room: 'room' in def.inputSchema.properties }).toEqual({ tool: def.name, room: true });
    }, 120_000);

    test('the owner reads everything; each item says whether the room could have read it, and why not', async () => {
      const out = await call('owner', 'list_pages', { limit: 50 }, { room: { header: 'group:team-a' } });
      expect(marks(out.json)).toEqual({
        'memory/members/owner-example': { readable: false, reason: 'readers' },
        [PAGES.open.slug]: { readable: true },
        [PAGES.team.slug]: { readable: true },
        [PAGES.quiet.slug]: { readable: false, reason: 'private_label' },
        [PAGES.mine.slug]: { readable: false, reason: 'readers' },
        [PAGES.folder.slug]: { readable: false, reason: 'folder_rule' },
        [PAGES.derived.slug]: { readable: false, reason: 'derived' },
      });
      const room = out.meta?.room as Record<string, unknown>;
      expect(room).toMatchObject({ principals: ['group:team-a'], declared_by: 'harness', complete: true, counts: { items: 7, readable: 2, above: 5, unknown: 0 } });
      expect(out.blocks.find(b => b.startsWith('[gbrain notice room_above_level kind=safety]'))).toContain('Use them to do the work');
      const labelled = await call('owner', 'list_pages', { limit: 50 }, { room: { header: 'carol-example' } });
      expect(marks(labelled.json)[PAGES.open.slug]).toEqual({ readable: false, reason: 'labelled_only' });
      const facts = await call('owner', 'recall', { entity: PAGES.open.slug }, { room: { header: 'group:team-a' } });
      const rows = (facts.json as { facts: Array<{ visibility: string; room_access: unknown }> }).facts;
      expect(rows.map(f => [f.visibility, f.room_access]).sort()).toEqual([['private', { readable: false, reason: 'private_label' }], ['world', { readable: true }]]);
    }, 120_000);

    test('readable: true means exactly what an on_behalf_of read of the same room returns', async () => {
      const rooms = ['group:team-a', 'carol-example', 'guest', 'alice-example, group:team-a', 'owner-example'];
      for (const room of rooms) {
        for (const [op, params] of [['list_pages', { limit: 50 }], ['search', { query: 'harbor ledger planning', match: 'keyword', limit: 20 }]] as const) {
          const marked = await call('owner', op, params, { room: { header: room } });
          const readable = Object.entries(marks(marked.json)).filter(([, a]) => (a as { readable: unknown }).readable === true).map(([s]) => s).sort();
          // A room of the owner alone is a direct chat: the owner's own read is the reference.
          const asRoom = room === 'owner-example' ? await call('owner', op, params) : await call('bot', op, params, { obo: { header: room } });
          expect({ room, op, readable }).toEqual({ room, op, readable: Object.keys(marks(asRoom.json)).sort() });
        }
        for (const key of Object.keys(PAGES) as Key[]) {
          const marked = await call('owner', 'get_page', { slug: PAGES[key].slug }, { room: { header: room } });
          const asRoom = room === 'owner-example' ? await call('owner', 'get_page', { slug: PAGES[key].slug }) : await call('bot', 'get_page', { slug: PAGES[key].slug }, { obo: { header: room } });
          expect({ room, key, readable: ((marked.json as { room_access: { readable: unknown } }).room_access.readable === true) }).toEqual({ room, key, readable: !asRoom.isError });
        }
      }
    }, 240_000);

    test('injected argument text naming a smaller room changes nothing but the notice', async () => {
      const harness = await call('owner', 'list_pages', { limit: 50 }, { room: { header: 'group:team-a' } });
      const injected = await call('owner', 'list_pages', { limit: 50, room: ['owner-example'] }, { room: { header: 'group:team-a' } });
      expect(injected.json).toEqual(harness.json);
      expect((injected.meta?.room as { conflict?: boolean }).conflict).toBe(true);
      expect(injected.blocks.some(b => b.startsWith('[gbrain notice room_conflict kind=safety]'))).toBe(true);
      const both = await call('owner', 'list_pages', { limit: 50 }, { room: { header: 'group:team-a', meta: ['owner-example'] } });
      expect(both.json).toEqual(harness.json);
      const argumentOnly = await call('owner', 'list_pages', { limit: 50, room: ['group:team-a'] });
      expect(argumentOnly.json).toEqual(harness.json);
      expect((argumentOnly.meta?.room as { declared_by: string }).declared_by).toBe('argument');
      expect(readRoomDeclaration({ header: 'group:team-a' }, { room: ['alice-example'] }).declaration?.principals).toEqual(['group:team-a', 'member:alice-example']);
    }, 120_000);

    test('who may ask: the owner needs no may_act_for, a member needs it, an unbound connection gets no marks', async () => {
      const bob = await call('bob', 'list_pages', { limit: 50 }, { room: { header: 'group:team-a' } });
      expect((bob.meta?.room as { unavailable?: string }).unavailable).toBe('not_permitted');
      expect(Object.values(marks(bob.json)).every(a => (a as { readable: unknown }).readable === 'unknown')).toBe(true);
      expect(bob.blocks.some(b => b.startsWith('[gbrain notice room_hints_unavailable kind=degraded]'))).toBe(true);
      const bobRoom = await call('bob-room', 'list_pages', { limit: 50 }, { room: { header: 'group:team-a' } });
      expect((bobRoom.meta?.room as { complete: boolean }).complete).toBe(true);
      const plain = await call('plain', 'list_pages', { limit: 50 }, { room: { header: 'group:team-a' } });
      expect((plain.meta?.room as { unavailable?: string }).unavailable).toBe('unbound');
    }, 120_000);

    test('rule 3: the owner\'s room exemption never lets an on_behalf_of read through', async () => {
      const out = await call('owner', 'get_page', { slug: PAGES.team.slug }, { obo: { header: 'group:team-a' } });
      expect({ isError: out.isError, code: (out.json as { code?: string }).code }).toEqual({ isError: true, code: 'on_behalf_of_not_permitted' });
    }, 60_000);

    test('the room argument never reaches a handler: a write with one succeeds, stores nothing of it and marks its own fact', async () => {
      const out = await call('owner', 'remember', { fact: 'Harbor ledger room argument note', entity: PAGES.open.slug, visibility: 'world', provenance: 'room test', content_origin: 'user_said', room: ['group:team-a'] });
      expect(out.isError).toBe(false);
      expect((out.json as { room_access?: unknown }).room_access).toEqual({ readable: true });
      expect(out.meta?.room).toMatchObject({ complete: true, counts: { items: 1, readable: 1, above: 0, unknown: 0 } });
      // A write is never stamped degraded for its marks, so nobody retries a committed write.
      expect(out.meta?.degraded).toBeUndefined();
      const [row] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE fact LIKE '%room argument note%' AND context IS NULL");
      expect(row!.n).toBe(1);
    }, 60_000);

    test('the audit row counts what entered the room and never names it', async () => {
      await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
        await call('owner', 'list_pages', { limit: 50 }, { room: { header: 'group:team-a' } });
      });
      const rows = readdirSync(auditDir).filter(f => f.startsWith('access-audience')).flatMap(f => readFileSync(join(auditDir, f), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
      const marked = rows.filter(r => r.outcome === 'room_marked' && r.op === 'list_pages');
      expect(marked.length).toBeGreaterThan(0);
      expect(marked.at(-1).room).toMatchObject({ readable: 2, above: 5, unknown: 0, declared_by: 'harness', by_reason: { readers: 2, private_label: 1, folder_rule: 1, derived: 1 } });
      const text = readdirSync(auditDir).map(f => readFileSync(join(auditDir, f), 'utf8')).join('\n');
      for (const key of Object.keys(PAGES) as Key[]) expect({ key, named: text.includes(PAGES[key].slug) }).toEqual({ key, named: false });
    }, 60_000);

    test('remember and put_page mark their own result; a write the room cannot judge is unknown and never stamped degraded', async () => {
      const kept = await call('owner', 'remember', { fact: 'Harbor ledger kept note', entity: PAGES.open.slug, visibility: 'private', provenance: 'room test', content_origin: 'user_said' }, { room: { header: 'alice-example' } });
      expect(kept.isError).toBe(false);
      expect((kept.json as { room_access?: unknown }).room_access).toEqual({ readable: false, reason: 'private_label' });
      expect(kept.blocks.some(b => b.startsWith('[gbrain notice room_above_level kind=safety]'))).toBe(true);
      const put = await call('owner', 'put_page', { slug: 'notes/room-write-plan', content: '---\ntype: note\ntitle: Room write plan\nreadable_by: [owner-example]\n---\n# Room write plan\n' }, { room: { meta: ['alice-example'] } });
      expect(put.isError).toBe(false);
      expect((put.json as { room_access?: unknown }).room_access).toEqual({ readable: false, reason: 'readers' });
      const invalid = await call('owner', 'remember', { fact: 'Harbor ledger invalid-room note', entity: PAGES.open.slug, visibility: 'world', provenance: 'room test', content_origin: 'user_said' }, { room: { meta: [] } });
      expect(invalid.isError).toBe(false);
      expect((invalid.json as { room_access?: unknown }).room_access).toEqual({ readable: 'unknown', reason: 'invalid' });
      expect(invalid.blocks.some(b => b.startsWith('[gbrain notice room_hints_unavailable kind=degraded]'))).toBe(true);
      expect(invalid.meta?.degraded).toBeUndefined();
    }, 60_000);

    test('a think answer is marked at the strictest class of all its evidence, and the evidence never leaves the process', async () => {
      const { declaration } = readRoomDeclaration({ header: 'alice-example' }, {});
      const caller = { access: { owner: true, identity: ['member:owner-example'] } as never, transport: 'stdio' };
      const think = async (evidence: Parameters<typeof keepRoomEvidence>[1]) => (await assessRoom(engine, { op: 'think', result: keepRoomEvidence({ answer: 'a' }, evidence),
        declaration: declaration!, sourceId: SRC, caller })).result as { room_access: unknown };
      const open = { table: 'pages' as const, sourceId: SRC, slug: PAGES.open.slug };
      expect((await think([open])).room_access).toEqual({ readable: true });
      expect((await think([open, { table: 'pages', sourceId: SRC, slug: PAGES.mine.slug }])).room_access).toEqual({ readable: false, reason: 'readers' });
      expect((await think([open, { table: 'takes', id: 1 }])).room_access).toEqual({ readable: 'unknown', reason: 'not_identified' });
      expect((await think([open, { table: 'calibration', id: 0 }])).room_access).toEqual({ readable: 'unknown', reason: 'not_identified' });
      expect((await think([])).room_access).toEqual({ readable: 'unknown', reason: 'not_identified' });
      expect((await think(undefined)).room_access).toEqual({ readable: 'unknown', reason: 'not_identified' });
      const kept = keepRoomEvidence({ answer: 'a' }, [open]);
      expect(JSON.stringify(kept)).toBe('{"answer":"a"}');
      expect(Object.getOwnPropertySymbols({ ...kept }).length).toBe(1);
      expect(Object.getOwnPropertySymbols(structuredClone(kept)).length).toBe(0);
    }, 60_000);

    test('think through dispatch carries its evidence to the marks', async () => {
      const out = await call('owner', 'think', { question: 'harbor ledger planning' }, { room: { header: 'alice-example' } });
      expect(out.isError).toBe(false);
      const access = (out.json as { room_access?: { readable: unknown; reason?: string } }).room_access;
      // Marked from the evidence the synthesis retrieved: with none kept, the mark would be not_identified.
      expect(access?.reason).not.toBe('not_identified');
      expect(out.meta?.room).toMatchObject({ counts: { items: 1 } });
      expect(out.text).not.toContain('taint_refs');
    }, 120_000);

    test("think's graph pages keep their own source, so a same-slug page elsewhere never stands in for one the room cannot read", async () => {
      const OTHER = 'room-other';
      const ANCHOR = 'notes/anchor-plan';
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [OTHER]);
      await importFromContent(engine, ANCHOR, page('open'), { sourceId: SRC });
      await importFromContent(engine, PAGES.open.slug, page('mine'), { sourceId: OTHER });
      try {
        await engine.addLink(ANCHOR, PAGES.open.slug, 'harbor ledger link', 'mentions', 'manual', undefined, undefined, { fromSourceId: SRC, toSourceId: OTHER });
        const { runGather } = await import('../src/core/think/gather.ts');
        const gather = await runGather(engine, { question: 'harbor ledger planning', anchor: ANCHOR, sourceIds: [SRC, OTHER], remote: false });
        expect(gather.graphRefs).toContainEqual({ slug: PAGES.open.slug, sourceId: OTHER });
        const { declaration } = readRoomDeclaration({ header: 'alice-example' }, {});
        const caller = { access: { owner: true, identity: ['member:owner-example'] } as never, transport: 'stdio' };
        const evidence = gather.graphRefs!.map(r => ({ table: 'pages' as const, sourceId: r.sourceId, slug: r.slug }));
        const out = await assessRoom(engine, { op: 'think', result: keepRoomEvidence({ answer: 'a' }, evidence), declaration: declaration!, sourceId: SRC, caller });
        expect((out.result as { room_access: unknown }).room_access).toEqual({ readable: false, reason: 'readers' });
      } finally {
        await engine.executeRaw('DELETE FROM pages WHERE (source_id = $1 AND slug = $2) OR source_id = $3', [SRC, ANCHOR, OTHER]);
      }
    }, 60_000);

    test('the trusted local CLI marks the owner view; with no owner it is unbound and the fix names gbrain access owner set', async () => {
      const { declaration } = readRoomDeclaration({ requestMeta: { room: 'alice-example' } }, undefined);
      const local = { access: { owner: false, identity: [] } as never, transport: 'cli', local: true as const };
      const marked = await assessRoom(engine, { op: 'get_page', result: { slug: PAGES.mine.slug, source_id: SRC }, declaration: declaration!, sourceId: SRC, caller: local });
      expect((marked.result as { room_access: unknown }).room_access).toEqual({ readable: false, reason: 'readers' });
      await clearOwner(engine);
      try {
        const unbound = await assessRoom(engine, { op: 'get_page', result: { slug: PAGES.mine.slug, source_id: SRC }, declaration: declaration!, sourceId: SRC, caller: local });
        expect(unbound.meta.unavailable).toBe('unbound');
        expect(unbound.notices.find(n => n.code === 'room_hints_unavailable')?.fix?.argv).toEqual(['gbrain', 'access', 'owner', 'set', '<MEMBER>']);
      } finally { await setOwner(engine, 'owner-example'); }
    }, 60_000);

    test('a client that reached no marking brain marks every item unknown and writes no audit row', async () => {
      const { declaration } = readRoomDeclaration({ requestMeta: { room: 'alice-example' } }, undefined);
      const out = await assessRoom(null, { op: 'list_pages', result: [{ slug: 'a' }, { slug: 'b' }], declaration: declaration!, sourceId: SRC,
        caller: { access: {} as never, local: true }, unavailable: { reason: 'not_supported' } });
      expect((out.result as Array<{ room_access: unknown }>).map(i => i.room_access)).toEqual([{ readable: 'unknown', reason: 'not_supported' }, { readable: 'unknown', reason: 'not_supported' }]);
      expect(out.stamped.map(n => n.code)).toEqual(['room_hints_unavailable']);
    }, 30_000);

    test('rule 1 at the response cap: marks that would push a read over the cap are dropped, never the read', async () => {
      const slug = 'notes/wide-owner-plan';
      const body = Array.from({ length: 2600 }, (_, i) => 'Harbor ledger planning line ' + i + ' ' + 'x'.repeat(80)).join('\n');
      await importFromContent(engine, slug, '---\ntitle: Wide owner plan\nreadable_by: [owner-example]\n---\n' + body + '\n', { sourceId: SRC });
      await call('owner', 'get_chunks', { slug, limit: 500 });
      // Measured on a repeat call, so a notice shown once per session does not count.
      const plain = await call('owner', 'get_chunks', { slug, limit: 500 });
      expect(plain.isError).toBe(false);
      // The cap is checked before dispatch adds _meta.access, so measure the frame without it.
      const { access: _applied, ...plainMeta } = plain.raw._meta ?? {};
      const plainBytes = encodedFrameBytes({ ...plain.raw, _meta: plainMeta });
      expect(plainBytes).toBeGreaterThan(EGRESS_CAP_MIN);
      await engine.setConfig('mcp.max_result_bytes_http', String(plainBytes + 1500));
      try {
        const marked = await call('owner', 'get_chunks', { slug, limit: 500 }, { room: { header: 'group:team-a' } });
        expect(marked.isError).toBe(false);
        expect(marked.text).toBe(plain.text);
        expect(marked.meta?.room).toEqual({ complete: false, unavailable: 'response_cap' });
        expect(marked.blocks.some(b => b.startsWith('[gbrain notice room_hints_unavailable kind=degraded]') && b.includes('[reason: response_cap]'))).toBe(true);
        expect((marked.meta?.degraded as { reasons: string[] }).reasons).toContain('room_hints_unavailable');
        await engine.setConfig('mcp.max_result_bytes_http', String(plainBytes + 1));
        const bare = await call('owner', 'get_chunks', { slug, limit: 500 }, { room: { header: 'group:team-a' } });
        expect({ isError: bare.isError, text: bare.text === plain.text, room: bare.meta?.room }).toEqual({ isError: false, text: true, room: undefined });
      } finally {
        await engine.unsetConfig('mcp.max_result_bytes_http');
      }
    }, 120_000);

    test('saved facts in a search answer are marked too, in _meta.retrieval and in the block the model reads', async () => {
      const params = { query: 'harbor ledger note', match: 'keyword', limit: 20 };
      const plain = await call('owner', 'search', params);
      const plainFacts = ((plain.meta?.retrieval as { saved_facts?: Array<Record<string, unknown>> })?.saved_facts) ?? [];
      expect(plainFacts.length).toBeGreaterThan(0);
      expect(plainFacts.some(f => 'room_access' in f)).toBe(false);
      expect(plain.blocks.some(b => b.includes('; room: '))).toBe(false);
      const marked = await call('owner', 'search', params, { room: { header: 'group:team-a' } });
      expect(unmarked(marked.json)).toEqual(unmarked(plain.json));
      const facts = (marked.meta?.retrieval as { saved_facts: Array<Record<string, unknown>> }).saved_facts;
      expect(facts.map(f => f.fact)).toEqual(plainFacts.map(f => f.fact));
      for (const f of facts) expect(f.room_access).toBeDefined();
      const markOf = (text: string) => facts.find(f => String(f.fact).includes(text))?.room_access;
      expect(markOf('Harbor ledger world note')).toEqual({ readable: true });
      const block = marked.blocks.find(b => b.startsWith('Saved facts'))!;
      expect(block).toContain('Harbor ledger world note');
      expect(block).toContain('; room: readable]');
      expect((marked.meta?.room as { counts: { items: number } }).counts.items).toBe(Object.keys(marks(marked.json)).length + facts.length);
    }, 60_000);

    test('rule 1 at the deadline: when marking cannot finish in time the read goes out whole, on time, with the degraded stamp', async () => {
      const params = { query: 'harbor ledger note', match: 'keyword', limit: 20 };
      const plain = await call('owner', 'search', params);
      __setRoomDeadlineForTests({ ms: 50, delay: () => new Promise(r => setTimeout(r, 5_000)) });
      try {
        const started = Date.now();
        const late = await call('owner', 'search', params, { room: { header: 'group:team-a' } });
        expect(Date.now() - started).toBeLessThan(4_000);
        expect(late.isError).toBe(false);
        expect(unmarked(late.json)).toEqual(unmarked(plain.json));
        const items = Object.values(marks(late.json));
        expect(items.length).toBeGreaterThan(0);
        for (const a of items) expect(a).toEqual({ readable: 'unknown', reason: 'deadline' });
        expect(late.meta?.room).toMatchObject({ complete: false, unavailable: 'deadline' });
        expect(late.blocks.some(b => b.startsWith('[gbrain notice room_hints_unavailable kind=degraded]'))).toBe(true);
        expect(late.blocks.some(b => b.startsWith('[gbrain degraded:') && b.includes('room'))).toBe(true);
        expect((late.meta?.degraded as { reasons: string[] }).reasons).toContain('room_hints_unavailable');
        const facts = (late.meta?.retrieval as { saved_facts: Array<Record<string, unknown>> }).saved_facts;
        expect(facts.length).toBeGreaterThan(0);
        for (const f of facts) expect(f.room_access).toEqual({ readable: 'unknown', reason: 'deadline' });
        expect(late.blocks.find(b => b.startsWith('Saved facts'))).toContain('; room: unknown (deadline)]');
      } finally {
        __setRoomDeadlineForTests(null);
      }
    }, 60_000);

    test("a room never borrows the caller's private-pages grant: a private page stays above a one-member room", async () => {
      const owner = await verify('owner');
      const out = await dispatchToolCall(engine, 'get_page', { slug: PAGES.quiet.slug }, {
        remote: true, transport: 'http', auth: { ...owner, privatePages: { mode: 'granted_sources', sources: [SRC] } }, sourceId: SRC, takesHoldersAllowList: ['world'],
        room: { header: 'bob-example' },
      });
      expect(out.isError).toBeFalsy();
      expect((JSON.parse(out.content[0]!.text) as { room_access?: unknown }).room_access).toEqual({ readable: false, reason: 'private_label' });
    }, 60_000);

    test('a link, a timeline row and an entity card are judged on every page that gates them, not only the one they hang on', async () => {
      await engine.addLink(PAGES.open.slug, PAGES.mine.slug, 'harbor ledger link', 'mentions', 'manual', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC });
      const room = { room: { header: 'group:team-a' } };
      const links = await call('owner', 'get_backlinks', { slug: PAGES.mine.slug }, room);
      const row = (links.json as Array<Record<string, unknown>>).find(l => l.from_slug === PAGES.open.slug)!;
      expect(row.room_access).toEqual({ readable: false, reason: 'readers' });
      const grouped = await call('owner', 'get_backlinks', { slug: PAGES.mine.slug, group: 'page' }, room);
      const rows = (grouped.json as { rows: Array<Record<string, unknown>> }).rows;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.room_access).toBeDefined();
      const [open] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [SRC, PAGES.open.slug]);
      const [mine] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [SRC, PAGES.mine.slug]);
      await engine.executeRaw("INSERT INTO timeline_entries (page_id, date, summary, event_page_id) VALUES ($1, '2026-01-02', 'Harbor ledger event', $2)", [open!.id, mine!.id]);
      const timeline = await call('owner', 'get_timeline', { slug: PAGES.open.slug }, room);
      const ev = (timeline.json as Array<Record<string, unknown>>).find(e => String(e.summary).includes('Harbor ledger event'))!;
      expect(ev.room_access).toEqual({ readable: false, reason: 'readers' });
      const card = await call('owner', 'entity', { name: PAGES.open.slug }, room);
      const cardBody = (card.json as { card: { entity: Record<string, unknown>; recent_facts?: Array<Record<string, unknown>> } }).card;
      const facts = cardBody.recent_facts ?? [];
      expect(card.isError).toBe(false);
      expect(facts.length).toBeGreaterThan(0);
      for (const f of facts) expect(f.room_access).toBeDefined();
      expect(cardBody.entity.room_access).toEqual({ readable: true });
    }, 60_000);

    test("a page in the owner's personal source is above any room holding someone else, and readable to the owner alone", async () => {
      await bindMemberSource(engine, 'owner-example', SRC);
      try {
        const group = await call('owner', 'get_page', { slug: PAGES.open.slug }, { room: { header: 'group:team-a' } });
        const alone = await call('owner', 'get_page', { slug: PAGES.open.slug }, { room: { header: 'owner-example' } });
        expect(group.isError).toBe(false);
        expect(unmarked(group.json)).toEqual(unmarked(alone.json));
        expect((group.json as { room_access?: unknown }).room_access).toEqual({ readable: false, reason: 'personal_source' });
        expect((alone.json as { room_access?: unknown }).room_access).toEqual({ readable: true });
      } finally {
        await unbindMemberSource(engine, 'owner-example', SRC, { apply: true });
      }
    }, 60_000);

    test('if marking itself throws, the read still goes out whole, flagged mark_failed', async () => {
      const { declaration } = readRoomDeclaration({ header: 'group:team-a' }, {});
      const result = { slug: PAGES.open.slug, keep: () => 1 };
      const out = await assessRoom(engine, { op: 'get_page', result, declaration: declaration!, sourceId: SRC, caller: { access: {} as never } });
      expect(out.result).toBe(result);
      expect(out.meta).toMatchObject({ complete: false, unavailable: 'mark_failed' });
      expect(out.stamped.map(n => n.code)).toEqual(['room_hints_unavailable']);
    }, 30_000);

    test('whoami advertises room support', async () => {
      const out = await call('owner', 'whoami', {});
      expect((out.json as { features?: unknown }).features).toEqual({ room: true });
    }, 60_000);
  });
}
