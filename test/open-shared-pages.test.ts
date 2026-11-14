/**
 * GST-2670 (GBRA-502): pages every member's key can read on a brain that serves several people.
 *
 * 1. Protects: a brain that serves several people says how many pages no rule or readable_by restricts, per folder,
 *    in the access serves several preview and receipt, gbrain access serves, doctor (open_shared_pages) and
 *    post-upgrade, with the labelling commands (owner first in every reader list) and an opt-in --labelled-only flag.
 *    A one-person brain, and one pinned to access.serves one, runs no query and prints nothing new. The count writes
 *    nothing, never depends on who asks, and a failed count never stops setup.
 * 2. Fails when: the count differs from what a member key lists, depends on the caller record, counts labelled-only
 *    members or the owner as readers, misses DM, chat, conversation or mail types, double-counts the people folders
 *    this run covers, throws out of the preview, writes anything, or runs on a one-person brain.
 * 3. Existing coverage: setup-serves-several.test.ts (members, rules, keys, proof), access-labelled-only.test.ts (the grant).
 * 4. Real seams: PGLite repo-less (Postgres when DATABASE_URL is set); member keys verified by the serve --http verifier
 *    and dispatched remote=true.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { labelSeveral, receiptLines, receiptOk, servesStatus } from '../src/commands/access-serves.ts';
import { servesLines } from '../src/commands/setup-serves.ts';
import { openPages, readOpenPages, printOpenPagesUpgradeNotice } from '../src/core/access/open-pages.ts';
import { SENSITIVE_PAGE_TYPES } from '../src/core/grants/shared-exposure.ts';
import { openSharedPagesEntry } from '../src/commands/doctor/checks/open-shared-pages.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { setMemberLabelledOnly } from '../src/core/access/labelled-only.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const ROSTER = ['alice-example', 'bob-example'];
const fm = (type: string, extra = '') => `---\ntype: ${type}\ntitle: t\n${extra}---\n# t\n\nHarbor ledger body.\n`;
const PAGES: Array<[string, string]> = [
  ['notes/world-topic', fm('note')],
  ['chats/dm-1', fm('dm')],
  ['emails/thread-1', fm('email')],
  ['chats/export-1', fm('conversation')],
  ['meetings/standup', fm('meeting')],
  ['root-page', fm('note')],
  ['labelled/secret', fm('note', 'readable_by: [alice-example]\n')],
  ['private/diary', fm('note', 'visibility: private\n')],
  ['people/alice-example/plan', fm('note')],
  ['people/bob-example/plan', fm('note')],
];
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tempDir = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };

/** Counts the queries over the pages table (the open-pages count is one). */
function spyPages(engine: BrainEngine): { count: () => number; restore: () => void } {
  const own = Object.prototype.hasOwnProperty.call(engine, 'executeRaw');
  const original = engine.executeRaw;
  let n = 0;
  (engine as any).executeRaw = function (this: BrainEngine, sql: string, params?: unknown[]) { if (/FROM pages p\b/.test(sql) && /folder/.test(sql)) n++; return original.call(this, sql, params as never); };
  return { count: () => n, restore: () => { if (own) (engine as any).executeRaw = original; else delete (engine as any).executeRaw; } };
}

async function stateHash(engine: BrainEngine): Promise<string> {
  const rows = await Promise.all([
    engine.executeRaw("SELECT slug, source_id, frontmatter::text AS f FROM pages ORDER BY source_id, slug"),
    engine.executeRaw("SELECT source_id, rule_id FROM access_rules ORDER BY 1, 2"),
    engine.executeRaw("SELECT key, value FROM config WHERE key NOT LIKE 'doctor.%' ORDER BY key"),
    engine.executeRaw("SELECT id, labelled_only, disabled_at FROM access_members ORDER BY id"),
  ]);
  return JSON.stringify(rows);
}

for (const kind of testBackends()) {
  describe(`open pages on a brain that serves several people (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    const label = (roster: string[], apply = true, opts: { labelledOnly?: boolean } = {}) =>
      withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(engine, roster, 'default', apply, true, opts));
    const doctor = async (remote = false) => (await openSharedPagesEntry.run({ engine, remote } as unknown as DoctorContext) as Array<Record<string, any>>)[0]!;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    async function listedAs(member: string): Promise<string[]> {
      const token = readFileSync(join(home, '.gbrain', 'member-keys', `${member}.key`), 'utf8').trim();
      const auth = await provider().verifyAccessToken(token) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, 'list_pages', { limit: 100 }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'], ...(localFederated ? { localFederatedSourceIds: localFederated } : {}) });
      return (JSON.parse(out.content[0]!.text) as Array<{ slug: string }>).map(p => p.slug).sort();
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      home = tempDir('gbrain-open-pages-');
      for (const [slug, text] of PAGES) await importFromContent(engine, slug, text, { sourceId: 'default', noEmbed: true });
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('sensitive types cover DMs, chat exports, conversations and mail, not meetings', () => {
      for (const t of ['dm', 'slack-dm-day', 'email', 'email-digest', 'conversation', 'chat']) expect(SENSITIVE_PAGE_TYPES).toContain(t);
      expect(SENSITIVE_PAGE_TYPES).not.toContain('meeting');
    });

    test('a one-person brain runs no count and says nothing new', async () => {
      const spy = spyPages(engine);
      try {
        expect(await doctor()).toMatchObject({ name: 'open_shared_pages', status: 'ok', readiness_state: 'not_applicable' });
        const logs: string[] = [];
        const log = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
        try { await printOpenPagesUpgradeNotice(engine); } finally { console.log = log; }
        expect(logs).toEqual([]);
        expect(spy.count()).toBe(0);
      } finally { spy.restore(); }
    }, 60_000);

    test('a brain pinned to access.serves one with two enabled members runs no count either', async () => {
      await addMember(engine, 'pin-a-example'); await addMember(engine, 'pin-b-example');
      await engine.setConfig('access.serves', 'one');
      const spy = spyPages(engine);
      try {
        expect(await doctor()).toMatchObject({ status: 'ok', readiness_state: 'not_applicable' });
        const logs: string[] = [];
        const log = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
        try { await printOpenPagesUpgradeNotice(engine); } finally { console.log = log; }
        expect(logs).toEqual([]);
        expect(spy.count()).toBe(0);
      } finally { spy.restore(); await engine.unsetConfig('access.serves'); }
      await engine.executeRaw("UPDATE access_members SET disabled_at = now() WHERE id IN ('pin-a-example', 'pin-b-example')");
    }, 60_000);

    test('the preview counts open pages per folder, leaves out the people folders this run covers, and writes nothing', async () => {
      const before = await stateHash(engine);
      const r = await label(ROSTER, false);
      expect(r.applied).toBe(false);
      expect(r.open_pages).toMatchObject({ total: 6, sensitive: 3, private: 1, members: { reading: 2, counted: 2 } });
      const folders = Object.fromEntries(r.open_pages!.folders.map(f => [f.folder, [f.pages, f.sensitive]]));
      expect(folders).toEqual({ chats: [2, 2], emails: [1, 1], notes: [1, 0], meetings: [1, 0], '(root)': [1, 0] });
      expect(await stateHash(engine)).toBe(before);
      const text = receiptLines(r).join('\n');
      expect(text).toContain('The keys of 2 of 2 members can read 6 pages');
      expect(text).toContain('--labelled-only');
    }, 60_000);

    test('after apply the receipt carries the same count, the exit verdict is unchanged, and it matches what a member key lists', async () => {
      const r = await label(ROSTER);
      expect(r.error).toBeUndefined();
      expect(receiptOk(r)).toBe(true);
      expect(r.open_pages).toMatchObject({ total: 6, sensitive: 3 });
      const listed = await listedAs('bob-example');
      expect(listed.filter(s => s !== 'people/bob-example/plan')).toEqual(['chats/dm-1', 'chats/export-1', 'emails/thread-1', 'meetings/standup', 'notes/world-topic', 'root-page']);
    }, 60_000);

    test('the count is the same whoever asks: no caller, a member, a labelled-only member and the owner', async () => {
      const base = (await openPages(engine)).total;
      const as = (access: Record<string, unknown>) => withCallerAccess(access as never, () => openPages(engine));
      expect((await as({ identity: ['member:alice-example'] })).total).toBe(base);
      expect((await as({ identity: ['member:alice-example'], labelledOnly: true })).total).toBe(base);
      expect((await as({ identity: ['member:alice-example'], owner: true, lineage: true, ownerReadsRestricted: true })).total).toBe(base);
    }, 60_000);

    test('doctor warns while DM, chat or mail pages are open; remote callers get totals only; nothing is written', async () => {
      const before = await stateHash(engine);
      const c = await doctor();
      expect(c).toMatchObject({ name: 'open_shared_pages', status: 'warn' });
      expect(c.details.open_pages.total).toBe(6);
      expect(c.fix.ask_user).toBe(true);
      expect(c.fix.argv.slice(0, 3)).toEqual(['gbrain', 'list', '--type']);
      expect(c.fix.argv.join(' ')).not.toContain('<');
      const remote = await doctor(true);
      expect(JSON.stringify(remote.details)).not.toMatch(/chats|emails|notes|meetings/);
      expect(remote.details).toMatchObject({ total: 6, sensitive: 3 });
      expect(await stateHash(engine)).toBe(before);
    }, 60_000);

    test('post-upgrade prints the list while sensitive pages are open', async () => {
      const logs: string[] = [];
      const log = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
      try { await printOpenPagesUpgradeNotice(engine); } finally { console.log = log; }
      expect(logs.join('\n')).toContain('chats/');
    }, 60_000);

    test('with an owner set, every printed reader list starts with the owner, and the flags exist', async () => {
      await setOwner(engine, 'alice-example');
      const text = receiptLines(await label(ROSTER, false)).join('\n');
      const lists = [...text.matchAll(/--readers (\S+)/g)].map(m => m[1]!);
      expect(lists.length).toBeGreaterThan(0);
      for (const l of lists) expect(l.startsWith('alice-example,')).toBe(true);
      expect(CLI_FLAG_REGISTRY.access).toContain('--labelled-only');
      expect(CLI_FLAG_REGISTRY.repair).toEqual(expect.arrayContaining(['--slugs-file', '--readers']));
      expect(CLI_FLAG_REGISTRY.access).toContain('--no-open-pages');
    }, 60_000);

    test('the printed --labelled-only command leaves out the owner, so running it is not BLOCKED', async () => {
      const text = receiptLines(await label(ROSTER, false)).join('\n');
      const command = text.match(/gbrain access serves several --members (\S+) --labelled-only --yes/);
      expect(command?.[1]).toBe('bob-example');
      const rerun = await label(command![1]!.split(','), false, { labelledOnly: true });
      expect(rerun.members.every(m => m.action !== 'blocked')).toBe(true);
    }, 60_000);

    test('a member already labelled-only keeps that mark on a re-run without the flag and gets no open-pages tail', async () => {
      const proof = [{ member: 'bob-example', own: 1, leaked: [] }];
      const open = await label(ROSTER, false);
      expect(servesLines({ mode: 'several', receipt: open, proof } as never, false).join('\n')).toContain('can also read open pages');
      await setMemberLabelledOnly(engine, 'bob-example', true, { remote: false });
      try {
        const r = await label(ROSTER, false);
        expect(r.members.find(m => m.id === 'bob-example')).toMatchObject({ labelled_only: 'keep' });
        expect(servesLines({ mode: 'several', receipt: r, proof } as never, false).join('\n')).not.toContain('can also read open pages');
        expect(receiptLines(r).join('\n')).not.toContain('--labelled-only --yes');
      } finally { await setMemberLabelledOnly(engine, 'bob-example', false, { remote: false }); }
    }, 60_000);

    test('gbrain access serves counts on a several-person brain unless --no-open-pages (the setup child) skips it', async () => {
      const spy = spyPages(engine);
      try {
        expect((await servesStatus(engine, { openPages: false })).open_pages).toBeUndefined();
        expect(spy.count()).toBe(0);
        expect((await servesStatus(engine)).open_pages?.total).toBeGreaterThan(0);
        expect(spy.count()).toBe(1);
      } finally { spy.restore(); }
    }, 60_000);

    test('the owner and labelled-only members are never counted as readers', async () => {
      const r1 = await openPages(engine);
      expect(r1.members).toEqual({ reading: 1, counted: 1 });
      await setMemberLabelledOnly(engine, 'bob-example', true, { remote: false });
      const r2 = await openPages(engine);
      expect(r2.members).toEqual({ reading: 0, counted: 1 });
      await setMemberLabelledOnly(engine, 'bob-example', false, { remote: false });
    }, 60_000);

    test('--labelled-only marks the roster, refuses the owner before writing, and is idempotent', async () => {
      const blocked = await label(['alice-example', 'bob-example'], true, { labelledOnly: true });
      expect(blocked.applied).toBe(false);
      expect(blocked.members.find(m => m.id === 'alice-example')).toMatchObject({ action: 'blocked' });
      expect((await engine.executeRaw<{ labelled_only: boolean }>("SELECT labelled_only FROM access_members WHERE id = 'bob-example'"))[0]!.labelled_only).toBe(false);
      const r = await label(['bob-example'], true, { labelledOnly: true });
      expect(r.error).toBeUndefined();
      expect(r.members[0]).toMatchObject({ id: 'bob-example', labelled_only: 'set' });
      expect((await engine.executeRaw<{ labelled_only: boolean }>("SELECT labelled_only FROM access_members WHERE id = 'bob-example'"))[0]!.labelled_only).toBe(true);
      expect((await label(['bob-example'], true, { labelledOnly: true })).members[0]).toMatchObject({ labelled_only: 'keep' });
      expect(r.open_pages!.members.reading).toBe(0);
      await setMemberLabelledOnly(engine, 'bob-example', false, { remote: false });
    }, 60_000);

    test('a derived page whose origin names its readers is not counted, like a member key does not list it', async () => {
      await importFromContent(engine, 'labelled/origin', fm('note', 'readable_by: [alice-example]\n'), { sourceId: 'default', noEmbed: true });
      await importFromContent(engine, 'atoms/fact-1', fm('atom', 'derived_from: [labelled/origin]\n'), { sourceId: 'default', noEmbed: true });
      try {
        expect(await listedAs('bob-example')).not.toContain('atoms/fact-1');
        expect((await openPages(engine)).folders.find(f => f.folder === 'atoms')).toBeUndefined();
      } finally {
        await engine.executeRaw("DELETE FROM pages WHERE slug IN ('labelled/origin', 'atoms/fact-1')");
      }
    }, 60_000);

    test('relaxed remote privacy counts the private pages a member key then lists', async () => {
      const before = await openPages(engine);
      expect(before.private).toBeGreaterThan(0);
      await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
        expect(await listedAs('bob-example')).toContain('private/diary');
        const relaxed = await openPages(engine);
        expect(relaxed.private).toBe(0);
        expect(relaxed.total).toBe(before.total + before.private);
      });
    }, 60_000);

    test('a member bound through config mcp.stdio_member counts as reading, with no key', async () => {
      await addMember(engine, 'carol-example');
      const before = await openPages(engine);
      await engine.setConfig('mcp.stdio_member', 'carol-example');
      try {
        const r = await openPages(engine);
        expect(r.members).toEqual({ reading: before.members.reading + 1, counted: before.members.counted });
      } finally {
        await engine.unsetConfig('mcp.stdio_member');
        await engine.executeRaw("UPDATE access_members SET disabled_at = now() WHERE id = 'carol-example'");
      }
    }, 60_000);

    test('with no member key reading anything, the open pages are still counted and doctor reports information', async () => {
      await setMemberLabelledOnly(engine, 'bob-example', true, { remote: false });
      try {
        const r = await openPages(engine);
        expect(r.members.reading).toBe(0);
        expect(r.total).toBeGreaterThan(0);
        expect(r.sensitive).toBeGreaterThan(0);
        expect(await doctor()).toMatchObject({ status: 'ok', severity: 'info' });
        expect(receiptLines(await label(['bob-example'], false)).join('\n')).toContain("No member's key reads");
      } finally { await setMemberLabelledOnly(engine, 'bob-example', false, { remote: false }); }
    }, 60_000);

    test('labelling a page lowers the count by that page', async () => {
      const before = (await openPages(engine)).total;
      await importFromContent(engine, 'chats/dm-1', fm('dm', 'readable_by: [alice-example, bob-example]\n'), { sourceId: 'default', noEmbed: true });
      expect((await openPages(engine)).total).toBe(before - 1);
    }, 60_000);

    test('a failed count is reported, never thrown: the preview, the receipt verdict and doctor go on', async () => {
      const original = engine.executeRaw;
      (engine as any).executeRaw = function (this: BrainEngine, sql: string, params?: unknown[]) { return /gbrain_access_state_unreadable\(\) AS unreadable/.test(sql) ? Promise.resolve([{ unreadable: true }]) : original.call(this, sql, params as never); };
      try {
        const r = await label(['bob-example'], false);
        expect(r.open_pages).toBeNull();
        expect(r.open_pages_error).toMatchObject({ code: 'open_pages_unknown' });
        expect(receiptOk(r)).toBe(true);
        expect(receiptLines(r).join('\n')).toContain('count unknown');
        expect((await readOpenPages(engine)).open_pages).toBeNull();
        expect((await doctor()).status).toBe('warn');
      } finally { delete (engine as any).executeRaw; }
    }, 60_000);

    test('doctor reports information, not a warning, once only non-sensitive pages are open', async () => {
      for (const slug of ['chats/export-1', 'emails/thread-1']) await importFromContent(engine, slug, fm(slug.startsWith('emails') ? 'email' : 'conversation', 'readable_by: [bob-example]\n'), { sourceId: 'default', noEmbed: true });
      const c = await doctor();
      expect(c).toMatchObject({ status: 'ok', severity: 'info' });
      expect(c.details.open_pages.sensitive).toBe(0);
    }, 60_000);
  });
}
