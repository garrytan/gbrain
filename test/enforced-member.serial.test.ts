/**
 * GST-2476 G2: enforced member mode (GBRAIN_ENFORCED_MEMBER) as real CLI subprocesses against a repo-less brain on
 * disk (PGLite, and Postgres when DATABASE_URL is set).
 *
 * 1. Protects: under the mode every read-filtered command shows no slug, title, body, fact or count of a page the member
 *    cannot read (another member's readers, visibility: private, a folder rule it does not satisfy, another member's
 *    personal source); every refused class, an unknown member, an empty value and the owner id refuse with the exact
 *    first line; hook succeeds silently; writes refuse a page the member cannot read and every label change, and an
 *    allowed write lands exactly as a trusted local write (an owner-bound key reads it); unset changes nothing.
 * 2. Fails when: any of those reads names a hidden page, a refusal prints anything else first or exits 0, a write
 *    reaches a hidden page or changes a label, a mode write lands member-private, or the variable unset changes output.
 * 3. Existing coverage: test/access-as.serial.test.ts (--as, which keeps ctx.remote false and is refused here).
 * 4. Real seams: src/cli.ts and src/cli/main.ts dispatch, MCP dispatch as the member's stdio server, local writes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { OPERATION_CLASSES } from '../src/cli/enforced-member-classes.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const CLI = join(resolve(import.meta.dir, '..'), 'src', 'cli.ts');
const MEMBER = 'alice-example';
const OWNER = 'owner-example';
const FIRST = (who: string, command: string) => 'gbrain: refused under GBRAIN_ENFORCED_MEMBER=' + who + ': ' + command + ' [GBRAIN_ENFORCED_REFUSED]';
const NOTICE = 'gbrain: results limited to what GBRAIN_ENFORCED_MEMBER=' + MEMBER + ' may read';
const REMEMBER_FIRST = 'gbrain: refused under GBRAIN_ENFORCED_MEMBER=' + MEMBER + ': remember saves a fact only with --entity <slug of a page you can read>; nothing was saved [GBRAIN_ENFORCED_REFUSED]';
const WRITES_OFF_FIRST = 'gbrain: refused under GBRAIN_ENFORCED_MEMBER=' + MEMBER + ': writes are off for members on this brain; nothing was saved [GBRAIN_ENFORCED_REFUSED]';
const REMEMBER_RETRY = 'Retry: gbrain remember "<one fact>" --entity <exact slug of a page you can read, from gbrain find or gbrain search> --provenance "<where you learned it>"';

const PAGES = {
  open: { slug: 'notes/open-example', title: 'Open example plan', canary: 'canaryemopen', fm: {} as Record<string, unknown>, source: 'default' },
  mine: { slug: 'notes/alice-example-plan', title: 'Alice example plan', canary: 'canaryemmine', fm: { readable_by: [MEMBER] }, source: 'default' },
  team: { slug: 'team-a/roadmap-example', title: 'Team a roadmap', canary: 'canaryemteam', fm: {}, source: 'default' },
  other: { slug: 'notes/bob-example-plan', title: 'Bob example secret', canary: 'canaryemother', fm: { readable_by: ['bob-example'] }, source: 'default' },
  priv: { slug: 'notes/quiet-example', title: 'Quiet example memo', canary: 'canaryempriv', fm: { visibility: 'private' }, source: 'default' },
  folder: { slug: 'team-b/budget-example', title: 'Team b budget', canary: 'canaryemfolder', fm: {}, source: 'default' },
  personal: { slug: 'notes/dm-example', title: 'Direct example thread', canary: 'canaryempersonal', fm: {}, source: 'bob-dm' },
} as const;
type Key = keyof typeof PAGES;
const VISIBLE: Key[] = ['open', 'mine', 'team'];
const HIDDEN: Key[] = ['other', 'priv', 'folder', 'personal'];
const HIDDEN_FACT = 'canaryemfacthidden';
const OPEN_FACT = 'canaryemfactopen';
const HIDDEN_MARKS = [...HIDDEN.flatMap(k => [PAGES[k].slug, PAGES[k].title, PAGES[k].canary]), HIDDEN_FACT];

/** Every read-class operation with arguments, so a read op added to the allow-list without a row here fails. */
const READS: Array<[op: string, args: string[]]> = [
  ['search', ['search', 'harbor ledger', '--json']],
  ['query', ['query', 'harbor ledger', '--no-expand', '--json']],
  ['search_exact', ['search', '--exact', 'harbor', '--json']],
  ['list_pages', ['list', '--json']],
  ['find_pages', ['find', 'notes/*', '--json']],
  ['get_page', ['get', PAGES.open.slug]],
  ['get_backlinks', ['backlinks', PAGES.open.slug, '--json']],
  ['get_timeline', ['timeline', PAGES.open.slug, '--json']],
  ['get_links', ['links', PAGES.open.slug, '--json']],
  ['get_tags', ['tags', PAGES.open.slug]],
  ['get_versions', ['history', PAGES.open.slug]],
  ['get_stats', ['stats', '--by', 'type', '--json']],
  ['whoami', ['whoami', '--json']],
  ['entity', ['entity', PAGES.open.slug, '--json']],
  ['whois', ['whois', 'Bob example', '--json']],
  ['traverse_graph', ['graph', PAGES.open.slug, '--json']],
];
/** recall (a CLI-only read): its facts arms and its page arm. */
const RECALLS: string[][] = [
  ['recall', PAGES.open.slug, '--json'],
  ['recall', PAGES.other.slug, '--json'],
  ['recall', '--since', '30d', '--json'],
  ['recall', '--question', 'harbor ledger canary', '--json'],
  ['recall', '--query', 'harbor ledger', '--json'],
];

test('every read-class operation has a no-trace row', () => {
  const classified = Object.entries(OPERATION_CLASSES).filter(([, c]) => c === 'read').map(([op]) => op).sort();
  expect([...new Set(READS.map(([op]) => op))].sort()).toEqual(classified);
});

for (const kind of testBackends()) {
  describe('enforced member mode (' + kind + ', repo-less)', () => {
    let root: string, home: string;
    let config: Record<string, unknown>;
    let closePg: (() => Promise<void>) | null = null;
    let ownerToken = '';

    function env(extra: Record<string, string | undefined>): Record<string, string> {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
      for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'GBRAIN_ENFORCED_MEMBER']) delete out[k];
      const merged: Record<string, string | undefined> = { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_CLI_SOCKET: '0', ...extra };
      return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as Record<string, string>;
    }
    async function cli(args: string[], opts: { member?: string | null; stdin?: string } = {}) {
      const member = opts.member === undefined ? MEMBER : opts.member;
      const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: env({ GBRAIN_ENFORCED_MEMBER: member ?? undefined }),
        stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]), stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, exitCode };
    }
    async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
      const engine = await createEngine(config as never);
      await engine.connect(config as never);
      try { return await run(engine); } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    }
    const leaks = (text: string) => HIDDEN_MARKS.filter(m => text.toLowerCase().includes(m.toLowerCase()));

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'gb-enforced-'));
      home = join(root, 'home');
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        await pg.engine.disconnect();
        config = { engine: 'postgres', database_url: pg.databaseUrl };
        closePg = pg.close;
      } else {
        config = { engine: 'pglite', database_path: join(root, 'db') };
      }
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
      await withBrain(async engine => {
        if (kind === 'pglite') await engine.initSchema();
        await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('bob-dm', 'bob-dm', '{\"federated\": true}'::jsonb) ON CONFLICT (id) DO NOTHING");
        for (const id of [MEMBER, 'bob-example', OWNER]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
        await engine.executeRaw("INSERT INTO access_groups (id) VALUES ('team-a'), ('team-b') ON CONFLICT DO NOTHING");
        await engine.executeRaw("INSERT INTO access_group_members (group_id, member_id) VALUES ('team-a', $1), ('team-b', 'bob-example')", [MEMBER]);
        await engine.executeRaw("INSERT INTO access_member_sources (member_id, source_id) VALUES ('bob-example', 'bob-dm')");
        await proposeRevision(engine, 'default', [
          { id: 'team-a', prefix: 'team-a/', readable_by: ['group:team-a'] },
          { id: 'team-b', prefix: 'team-b/', readable_by: ['group:team-b'] },
        ] as never, { origin: 'cli', store: 'database' } as never);
        for (const key of Object.keys(PAGES) as Key[]) {
          const p = PAGES[key];
          const fm = Object.entries(p.fm).map(([k, v]) => k + ': ' + JSON.stringify(v)).join('\n');
          await importFromContent(engine, p.slug, '---\ntype: note\ntitle: ' + JSON.stringify(p.title) + '\n' + (fm ? fm + '\n' : '') + '---\n# ' + p.title + '\n\nHarbor ledger planning notes ' + p.canary + ' for the roadmap.\n', { sourceId: p.source, noEmbed: true });
        }
        await engine.addLink(PAGES.open.slug, PAGES.other.slug, 'see the secret plan', 'mentions');
        await engine.addLink(PAGES.other.slug, PAGES.open.slug, 'back to open', 'mentions');
        await engine.addTimelineEntry(PAGES.other.slug, { date: '2026-01-02', summary: 'Hidden event ' + HIDDEN_FACT } as never, { sourceId: 'default' });
        await engine.insertFact({ fact: 'Harbor ledger fact ' + HIDDEN_FACT, entity_slug: PAGES.other.slug, visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
        await engine.insertFact({ fact: 'Harbor ledger fact ' + OPEN_FACT, entity_slug: PAGES.open.slug, visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
        const minted = await mintLegacyToken(engine, { name: 'owner-key', scopes: ['read'], takesHolders: ['world'] } as never);
        ownerToken = minted.token;
        await bindCredential(engine, { kind: 'token', id: minted.id }, { member: OWNER });
        await setOwner(engine, OWNER);
      });
    }, 240_000);

    afterAll(async () => {
      rmSync(root, { recursive: true, force: true });
      await closePg?.();
    }, 60_000);

    test('fixture control: the trusted CLI (variable unset) reads the hidden pages', async () => {
      const r = await cli(['list', '--json'], { member: null });
      expect(r.exitCode).toBe(0);
      for (const key of ['other', 'priv', 'folder'] as Key[]) expect(r.stdout).toContain(PAGES[key].slug);
      const personal = await cli(['get', PAGES.personal.slug, '--source', 'bob-dm'], { member: null });
      expect(personal.stdout).toContain(PAGES.personal.canary);
      const search = await cli(['search', 'harbor ledger', '--json'], { member: null });
      expect(search.stdout).toContain(PAGES.other.slug);
    }, 120_000);

    test("another member's personal source is out of scope for reads and writes", async () => {
      const cases: Array<[string[], string, string | undefined]> = [
        [['list', '--source', 'bob-dm'], 'list', undefined],
        [['get', PAGES.personal.slug, '--source', 'bob-dm'], 'get', undefined],
        [['search', 'harbor ledger', '--source', 'bob-dm'], 'search', undefined],
        [['put', 'notes/alice-example-dm', '--source', 'bob-dm'], 'put', '---\ntype: note\ntitle: X\n---\n# X\n\nBody.\n'],
      ];
      for (const [args, command, stdin] of cases) {
        const r = await cli(args, { stdin });
        expect({ args: args.join(' '), exit: r.exitCode, first: r.stderr.split('\n')[0], leaks: leaks(r.stdout + r.stderr) }).toEqual({ args: args.join(' '), exit: 3, first: FIRST(MEMBER, command), leaks: [] });
      }
    }, 300_000);

    test('every read-filtered command shows no trace of a page the member cannot read, and prints the constant line', async () => {
      for (const [op, args] of READS) {
        const r = await cli(args);
        expect({ op, leaks: leaks(r.stdout + r.stderr), exit: r.exitCode, notice: r.stderr.includes(NOTICE), withheld: r.stderr.includes('output is withheld') })
          .toEqual({ op, leaks: [], exit: 0, notice: true, withheld: false });
        if (['search', 'search_exact', 'list_pages', 'find_pages'].includes(op)) expect({ op, open: r.stdout.includes(PAGES.open.slug) }).toEqual({ op, open: true });
      }
    }, 600_000);

    test('visible pages still read under the mode', async () => {
      const list = await cli(['list', '--json']);
      for (const key of VISIBLE) expect({ key, seen: list.stdout.includes(PAGES[key].slug) }).toEqual({ key, seen: true });
      const stats = await cli(['stats', '--by', 'type', '--json']);
      expect(JSON.parse(stats.stdout).total_pages).toBe(VISIBLE.length);
      const get = await cli(['get', PAGES.mine.slug]);
      expect(get.stdout).toContain(PAGES.mine.canary);
    }, 240_000);

    test('recall shows no hidden fact or page on its facts arms and its page arm', async () => {
      for (const args of RECALLS) {
        const r = await cli(args);
        expect({ args: args.join(' '), leaks: leaks(r.stdout + r.stderr), notice: r.stderr.includes(NOTICE) }).toEqual({ args: args.join(' '), leaks: [], notice: true });
      }
      const open = await cli(['recall', PAGES.open.slug, '--json']);
      expect(open.stdout).toContain(OPEN_FACT);
    }, 300_000);

    test('a hidden page reads exactly like a missing one', async () => {
      const missing = await cli(['get', 'notes/never-written-example']);
      for (const key of HIDDEN) {
        const r = await cli(['get', PAGES[key].slug]);
        const norm = (t: string) => t.split(PAGES[key].slug).join('<slug>').split('notes/never-written-example').join('<slug>');
        expect({ key, exit: r.exitCode, out: norm(r.stdout), err: norm(r.stderr) }).toEqual({ key, exit: missing.exitCode, out: norm(missing.stdout), err: norm(missing.stderr) });
      }
    }, 240_000);

    test('each refused class refuses with the exact first line, exit 3', async () => {
      const cases: Array<[string[], string]> = [
        [['config', 'show'], 'config'], [['doctor', '--fix'], 'doctor'], [['call', 'get_page', '{}'], 'call'], [['serve'], 'serve'],
        [['sources', 'list'], 'sources list'], [['sources', 'status'], 'sources status'], [['sync', 'status'], 'sync status'],
        [['auth', 'list'], 'auth'], [['access', 'member', 'list'], 'access'], [['search', 'modes'], 'search modes'],
        [['stats', '--json'], 'stats'], [['get', PAGES.open.slug, '--as', MEMBER], 'get'], [['context-pack', 'harbor'], 'context-pack'],
        [['put-pages'], 'put-pages'], [['status'], 'status'], [['jobs', 'list'], 'jobs'],
        [['upgrade'], 'upgrade'], [['autopilot', 'status'], 'autopilot'], [['repair', 'frontmatter'], 'repair'], [['delete', PAGES.open.slug], 'delete'],
        [['reindex'], 'reindex'], [['embed', '--stale'], 'embed'], [['dream'], 'dream'], [['write-requests'], 'write-requests'],
        [['sources', 'writer', 'status'], 'sources writer'], [['recall', '--since-last-run', '--json'], 'recall'],
        [['access', 'owner', 'reads-restricted', 'on'], 'access'], [['access', 'rule', 'add', '--slug', PAGES.open.slug, '--readers', MEMBER], 'access'],
        [['repair', 'visibility', '--slug', PAGES.open.slug], 'repair'], [['trust', 'backfill', '--label-lowerings'], 'trust'],
      ];
      for (const [args, command] of cases) {
        const r = await cli(args);
        expect({ args: args.join(' '), exit: r.exitCode, first: r.stderr.split('\n')[0] }).toEqual({ args: args.join(' '), exit: 3, first: FIRST(MEMBER, command) });
        expect(r.stderr).toContain('Recovery: do not retry here; nothing was changed.');
        expect(r.stderr).toContain('docs/guides/enforced-member.md#refused');
      }
    }, 600_000);

    test('an unknown member, an empty value and the owner id refuse every read', async () => {
      for (const [who, label] of [['nobody-example', 'nobody-example'], ['', ''], [OWNER, OWNER], ['Not Valid!', '<invalid>']] as const) {
        for (const args of [['search', 'harbor ledger'], ['list'], ['recall', PAGES.open.slug]]) {
          const r = await cli(args, { member: who });
          expect({ who, args: args[0], exit: r.exitCode, first: r.stderr.split('\n')[0], out: r.stdout }).toEqual({ who, args: args[0], exit: 3, first: FIRST(label, args[0]!), out: '' });
        }
      }
    }, 600_000);

    test('hook succeeds silently: nothing on stdout, the constant line, exit 0', async () => {
      for (const event of ['session-start', 'user-prompt']) {
        const r = await cli(['hook', event]);
        expect({ event, exit: r.exitCode, out: r.stdout, err: r.stderr }).toEqual({ event, exit: 0, out: '', err: NOTICE + '\n' });
      }
    }, 120_000);

    test('writes refuse a hidden target and every label change', async () => {
      const page = (title: string, fm = '') => '---\ntype: note\ntitle: ' + title + '\n' + fm + '---\n# ' + title + '\n\nBody text.\n';
      const refused: Array<[string[], string, string | undefined]> = [
        [['put', PAGES.other.slug], 'put', page('Overwrite')],
        [['put', PAGES.folder.slug], 'put', page('Overwrite')],
        [['put', 'team-b/new-example'], 'put', page('New under rule')],
        [['put', 'notes/labelled-example'], 'put', page('Labelled', 'readable_by: [alice-example]\n')],
        [['put', 'notes/private-new-example'], 'put', page('Private new', 'visibility: private\n')],
        [['put', PAGES.open.slug], 'put', page('Open example plan', 'visibility: private\n')],
        [['link', PAGES.open.slug, PAGES.other.slug], 'link', undefined],
        [['tag', PAGES.priv.slug, 'x'], 'tag', undefined],
        [['remember', 'A fact', '--entity', PAGES.open.slug, '--provenance', 'test', '--visibility', 'private'], 'remember', undefined],
      ];
      for (const [args, command, stdin] of refused) {
        const r = await cli(args, { stdin });
        expect({ args: args.join(' '), exit: r.exitCode, first: r.stderr.split('\n')[0] }).toEqual({ args: args.join(' '), exit: 3, first: FIRST(MEMBER, command) });
        expect(r.stderr.toLowerCase()).not.toContain('exists');
      }
      for (const args of [['remember', 'A fact', '--provenance', 'test'], ['remember', 'A fact', '--entity', PAGES.other.slug, '--provenance', 'test'], ['remember', 'A fact', '--entity', 'Notes/Open-Example', '--provenance', 'test']]) {
        const r = await cli(args);
        const lines = r.stderr.split('\n');
        expect({ args: args.join(' '), exit: r.exitCode, first: lines[0], second: lines[1], out: r.stdout }).toEqual({ args: args.join(' '), exit: 3, first: REMEMBER_FIRST, second: REMEMBER_RETRY, out: '' });
        expect(r.stderr).toContain('Recovery: nothing was saved, so retrying with --entity is safe.');
        expect(r.stderr.toLowerCase()).not.toContain('exists');
      }
      await withBrain(async engine => {
        const rows = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE fact = 'A fact'");
        expect(rows[0]!.n).toBe(0);
      });
      const control = await cli(['get', PAGES.other.slug], { member: null });
      expect(control.stdout).toContain(PAGES.other.canary);
    }, 600_000);

    test('an allowed write lands as a trusted local write, readable by an owner-bound key', async () => {
      const put = await cli(['put', 'notes/alice-example-draft'], { stdin: '---\ntype: note\ntitle: Alice draft\n---\n# Alice draft\n\nDraft canaryemdraft.\n' });
      expect({ exit: put.exitCode, err: put.exitCode === 0 ? '' : put.stderr }).toEqual({ exit: 0, err: '' });
      const remember = await cli(['remember', 'Harbor ledger fact canaryemremember', '--entity', PAGES.open.slug, '--provenance', 'test turn']);
      expect({ exit: remember.exitCode, err: remember.exitCode === 0 ? '' : remember.stderr }).toEqual({ exit: 0, err: '' });
      await withBrain(async engine => {
        const [row] = await engine.executeRaw<{ frontmatter: unknown }>("SELECT frontmatter FROM pages WHERE slug = 'notes/alice-example-draft'");
        const fm = (typeof row!.frontmatter === 'string' ? JSON.parse(row!.frontmatter) : row!.frontmatter) as Record<string, unknown>;
        expect(fm.readable_by).toBeUndefined();
        expect(fm.visibility).toBeUndefined();
        const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
        const auth = await provider.verifyAccessToken(ownerToken) as unknown as AuthInfo;
        const call = async (op: string, params: Record<string, unknown>) => (await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] })).content.map(c => c.text).join('\n');
        expect(await call('get_page', { slug: 'notes/alice-example-draft' })).toContain('canaryemdraft');
        expect(await call('recall', { entity: PAGES.open.slug })).toContain('canaryemremember');
      });
    }, 300_000);

    test("write-request reads the member's own receipts; any other id answers exactly as an unknown one", async () => {
      const body = '---\ntype: note\ntitle: Receipt example\n---\n# Receipt example\n\nBody.\n';
      const own = await cli(['put', 'notes/alice-example-receipt', '--json'], { stdin: body });
      expect(own.exitCode).toBe(0);
      const ownId = JSON.parse(own.stdout).request_id as string;
      const other = await cli(['put', 'notes/owner-example-receipt', '--json'], { member: null, stdin: body });
      const otherId = JSON.parse(other.stdout).request_id as string;
      expect({ ownId: typeof ownId, otherId: typeof otherId, same: ownId === otherId }).toEqual({ ownId: 'string', otherId: 'string', same: false });
      expect((await cli(['write-request', otherId], { member: null })).exitCode).toBe(0);
      for (const json of [false, true]) {
        const flag = json ? ['--json'] : [];
        const mine = await cli(['write-request', ownId, ...flag]);
        expect({ json, exit: mine.exitCode, id: mine.stdout.includes(ownId) }).toEqual({ json, exit: 0, id: true });
        const unknown = await cli(['write-request', crypto.randomUUID(), ...flag]);
        expect(unknown.exitCode).not.toBe(0);
        for (const id of [otherId, otherId.toUpperCase(), 'not-a-request-id']) {
          const r = await cli(['write-request', id, ...flag]);
          expect({ json, id, exit: r.exitCode, out: r.stdout, err: r.stderr }).toEqual({ json, id, exit: unknown.exitCode, out: unknown.stdout, err: unknown.stderr });
          expect((r.stdout + r.stderr).toLowerCase()).not.toContain('exists');
          expect(r.stdout + r.stderr).not.toContain('owner-example-receipt');
        }
      }
    }, 300_000);

    test('doctor under the mode prints only check names, statuses and counts', async () => {
      const trusted = await cli(['doctor', '--json'], { member: null });
      const r = await cli(['doctor', '--json']);
      expect({ exit: r.exitCode, leaks: leaks(r.stdout + r.stderr) }).toEqual({ exit: trusted.exitCode, leaks: [] });
      for (const mark of ['bob-dm', 'team-b', 'notes/']) expect({ mark, seen: (r.stdout + r.stderr).includes(mark) }).toEqual({ mark, seen: false });
      const report = JSON.parse(r.stdout) as { status: string; checks: Array<Record<string, string>>; counts: Record<string, number> };
      expect(Object.keys(report).sort()).toEqual(['checks', 'counts', 'status']);
      expect(report.checks.length).toBe((JSON.parse(trusted.stdout).checks as unknown[]).length);
      for (const c of report.checks) expect({ keys: Object.keys(c).sort(), name: /^[a-z0-9_]+$/.test(c.name!), status: /^[a-z0-9_]+$/.test(c.status!) }).toEqual({ keys: ['name', 'status'], name: true, status: true });
      expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBe(report.checks.length);
      expect(r.stderr).toBe('gbrain: doctor shows check names, statuses and counts only under GBRAIN_ENFORCED_MEMBER\n');
      const plain = await cli(['doctor']);
      const lines = plain.stdout.trim().split('\n');
      expect(lines.slice(0, -1).every(l => /^[a-z0-9_]+ [a-z0-9_]+$/.test(l))).toBe(true);
      expect(leaks(plain.stdout + plain.stderr)).toEqual([]);
    }, 300_000);

    test('sync and sources refresh take only their listed flags and a source the member reads', async () => {
      const other = join(root, 'other-checkout');
      mkdirSync(join(other, 'notes'), { recursive: true });
      writeFileSync(join(other, 'notes', 'other-diary.md'), '---\ntype: note\ntitle: Other diary canaryemdiary\n---\n# Other diary\n\nBody canaryemdiary.\n');
      const before = await withBrain(engine => engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages'));
      const cases: Array<[string[], string]> = [
        [['sync', '--repo', other, '--no-pull', '--no-embed'], 'sync'], [['sync', '--source', 'default', '--repo', other, '--no-pull'], 'sync'],
        [['sync', '--all'], 'sync'], [['sync', '--source', 'default', '--full'], 'sync'], [['sync', '--watch'], 'sync'],
        [['sync', '--source', 'default', '--include-gitignored'], 'sync'], [['sync', 'unblock', '--source', 'default'], 'sync'],
        [['sync', '--source', 'bob-dm', '--no-pull'], 'sync'], [['sync', '--source', 'nosuch-example', '--no-pull'], 'sync'],
        [['sources', 'refresh', 'bob-dm'], 'sources refresh'], [['sources', 'refresh', 'nosuch-example'], 'sources refresh'],
        [['sources', 'refresh', 'default', '--resume'], 'sources refresh'],
      ];
      for (const [args, command] of cases) {
        const r = await cli(args);
        expect({ args: args.join(' '), exit: r.exitCode, first: r.stderr.split('\n')[0], out: r.stdout }).toEqual({ args: args.join(' '), exit: 3, first: FIRST(MEMBER, command), out: '' });
      }
      const hidden = await cli(['sync', '--source', 'bob-dm', '--no-pull']);
      const unknown = await cli(['sync', '--source', 'nosuch-example', '--no-pull']);
      expect(unknown.stderr).toBe(hidden.stderr);
      await withBrain(async engine => {
        const after = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
        expect(after[0]!.n).toBe(before[0]!.n);
        const src = await engine.executeRaw<{ id: string; local_path: string | null }>("SELECT id, local_path FROM sources WHERE id IN ('default', 'bob-dm') ORDER BY id");
        expect(src.map(s => s.local_path)).toEqual([null, null]);
      });
    }, 600_000);

    test('remember --replaces is refused, for any id', async () => {
      const ids = await withBrain(engine => engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE fact LIKE '%' || $1", [HIDDEN_FACT]));
      const runs = [];
      for (const id of [String(ids[0]!.id), '99999']) {
        const r = await cli(['remember', 'Replacement fact', '--entity', PAGES.open.slug, '--provenance', 'test', '--replaces', id]);
        expect({ id, exit: r.exitCode, first: r.stderr.split('\n')[0], leaks: leaks(r.stdout + r.stderr) }).toEqual({ id, exit: 3, first: FIRST(MEMBER, 'remember'), leaks: [] });
        runs.push(r.stderr);
      }
      expect(runs[0]).toBe(runs[1]);
      await withBrain(async engine => {
        const rows = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE superseded_by IS NOT NULL OR fact = 'Replacement fact'");
        expect(rows[0]!.n).toBe(0);
      });
    }, 300_000);

    test('timeline-add refuses a gbrain fence in its summary, detail or source', async () => {
      const takes = '<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|\n| 1 | Injected take canaryemtake | take | owner-example | 0.9 | 2026-01 | test |\n<!--- gbrain:takes:end -->';
      const facts = '<!-- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Injected canaryeminj | fact | 0.9 | private | high | 2026-01-05 |  | x |  |\n<!-- gbrain:facts:end -->';
      for (const args of [
        ['timeline-add', PAGES.open.slug, '2026-01-03', 'Event summary', '--detail', '\n' + takes + '\n'],
        ['timeline-add', PAGES.open.slug, '2026-01-04', 'Event two', '--detail', '\n' + facts + '\n'],
        ['timeline-add', PAGES.open.slug, '2026-01-05', 'Event three <!--- gbrain:takes:begin -->'],
        ['timeline-add', PAGES.open.slug, '2026-01-06', 'Event four', '--source', '<!---gbrain:facts:end -->'],
      ]) {
        const r = await cli(args);
        expect({ date: args[2], exit: r.exitCode, first: r.stderr.split('\n')[0] }).toEqual({ date: args[2], exit: 3, first: FIRST(MEMBER, 'timeline-add') });
      }
      const plain = await cli(['timeline-add', PAGES.open.slug, '2026-01-07', 'A plain event']);
      expect({ exit: plain.exitCode, err: plain.exitCode === 0 ? '' : plain.stderr }).toEqual({ exit: 0, err: '' });
      await withBrain(async engine => {
        const t = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM takes WHERE claim LIKE '%canaryemtake%'");
        const f = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE fact LIKE '%canaryeminj%'");
        const e = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM timeline_entries WHERE summary LIKE 'Event%'");
        expect({ takes: t[0]!.n, facts: f[0]!.n, entries: e[0]!.n }).toEqual({ takes: 0, facts: 0, entries: 0 });
      });
    }, 300_000);

    test('--help: a refused command refuses, an allowed one prints its static help and runs nothing', async () => {
      const mountPath = join(root, 'help-mount');
      const refused: Array<[string[], string]> = [
        [['creds', 'list', '--json', '--help'], 'creds'], [['google', 'status', '--json', '--help'], 'google'],
        [['mounts', 'add', 'help-mount', '--path', mountPath, '--engine', 'pglite', '--db-path', join(root, 'help.db'), '--help'], 'mounts'],
        [['sources', 'list', '--json', '--help'], 'sources list'], [['sync', 'status', '--help'], 'sync status'], [['config', 'show', '--help'], 'config'],
        [['friction', 'log', '--kind', 'friction', '--message', 'x', '--help'], 'friction'],
      ];
      for (const [args, command] of refused) {
        const r = await cli(args);
        expect({ args: args[0], exit: r.exitCode, first: r.stderr.split('\n')[0] }).toEqual({ args: args[0], exit: 3, first: FIRST(MEMBER, command) });
      }
      for (const args of [['sync', '--help'], ['sync', '--json', '--help'], ['doctor', '--help'], ['recall', '--since', '30d', '--help'], ['search', '--help'], ['remember', '--help']]) {
        const r = await cli(args);
        expect({ args: args.join(' '), exit: r.exitCode, ran: /withheld|results limited|doctor shows/.test(r.stderr), help: /gbrain|Usage/i.test(r.stdout + r.stderr) })
          .toEqual({ args: args.join(' '), exit: 0, ran: false, help: true });
      }
      const { existsSync } = await import('node:fs');
      expect({ mount: existsSync(mountPath), db: existsSync(join(root, 'help.db')) }).toEqual({ mount: false, db: false });
    }, 300_000);

    test('entity prints no mention coverage count under the mode', async () => {
      const trusted = JSON.parse((await cli(['entity', PAGES.open.slug, '--json'], { member: null })).stdout);
      expect(typeof trusted.card?.coverage?.pending_pages).toBe('number');
      const r = await cli(['entity', PAGES.open.slug, '--json']);
      const card = JSON.parse(r.stdout).card;
      expect({ exit: r.exitCode, coverage: typeof card.coverage, pending: card.coverage?.pending_pages, counted: /\d+ page\(s\) have not been scanned/.test(r.stdout + r.stderr) })
        .toEqual({ exit: 0, coverage: 'object', pending: undefined, counted: false });
      const human = await cli(['entity', PAGES.open.slug]);
      expect({ exit: human.exitCode, pending: /page\(s\) pending/.test(human.stdout) }).toEqual({ exit: 0, pending: false });
    }, 300_000);

    test('--source on a read carries the scope like a remote credential; an unknown source refuses like a hidden one', async () => {
      await withBrain(async engine => {
        await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('team-src', 'team-src') ON CONFLICT DO NOTHING");
        await importFromContent(engine, 'notes/team-src-page', '---\ntype: note\ntitle: Team source page\n---\n# Team source page\n\nHarbor team body canaryemteamsrc.\n', { sourceId: 'team-src', noEmbed: true });
      });
      for (const args of [['get', 'notes/team-src-page', '--source', 'team-src'], ['list', '--source', 'team-src', '--json'], ['search', 'harbor team', '--source', 'team-src', '--json']]) {
        const r = await cli(args);
        expect({ args: args[0], exit: r.exitCode, seen: /team-src-page|canaryemteamsrc/.test(r.stdout), nudge: /sole non-default|routing to source/.test(r.stderr) })
          .toEqual({ args: args[0], exit: 0, seen: true, nudge: false });
      }
      const hidden = await cli(['get', 'notes/never-written-example', '--source', 'bob-dm']);
      for (const args of [['get', 'notes/never-written-example', '--source', 'nosuch-example'], ['get', 'notes/never-written-example', '--source-id', 'nosuch-example']]) {
        const r = await cli(args);
        expect({ args: args.join(' '), exit: r.exitCode, err: r.stderr, out: r.stdout }).toEqual({ args: args.join(' '), exit: hidden.exitCode, err: hidden.stderr, out: hidden.stdout });
      }
      expect(hidden.exitCode).toBe(3);
    }, 300_000);

    test("entity text_mentions lists a visible page that names the entity and leaves a hidden one out", async () => {
      const page = (slug: string, type: string, title: string, fm: string, body: string) =>
        '---\ntype: ' + type + '\ntitle: ' + JSON.stringify(title) + '\n' + fm + '---\n# ' + title + '\n\n' + body + '\n';
      await withBrain(async engine => {
        await importFromContent(engine, 'people/carol-example', page('people/carol-example', 'person', 'Carol Example', '', 'A person page.'), { sourceId: 'default', noEmbed: true });
        await importFromContent(engine, 'notes/bob-carol-memo', page('notes/bob-carol-memo', 'note', 'Bob memo canaryemtmhidden', 'readable_by: [bob-example]\n', 'Met Carol Example about the canaryemtmhidden plan.'), { sourceId: 'default', noEmbed: true });
        await importFromContent(engine, 'notes/open-carol-memo', page('notes/open-carol-memo', 'note', 'Open memo canaryemtmopen', '', 'Met Carol Example about the open plan.'), { sourceId: 'default', noEmbed: true });
      });
      const marks = ['notes/bob-carol-memo', 'Bob memo canaryemtmhidden', 'canaryemtmhidden'];
      const trusted = JSON.parse((await cli(['entity', 'Carol Example', '--json'], { member: null })).stdout);
      expect({ control: trusted.card?.text_mentions?.pages?.map((x: { slug: string }) => x.slug).sort() }).toEqual({ control: ['notes/bob-carol-memo', 'notes/open-carol-memo'] });
      const r = await cli(['entity', 'Carol Example', '--json']);
      const tm = JSON.parse(r.stdout).card?.text_mentions;
      expect({ exit: r.exitCode, slugs: tm?.pages?.map((x: { slug: string }) => x.slug), total: tm?.total, leaks: marks.filter(m => (r.stdout + r.stderr).includes(m)) })
        .toEqual({ exit: 0, slugs: ['notes/open-carol-memo'], total: 1, leaks: [] });
      const human = await cli(['entity', 'Carol Example']);
      expect({ exit: human.exitCode, open: human.stdout.includes('notes/open-carol-memo'), count: /text of 1 other page/.test(human.stdout), leaks: marks.filter(m => (human.stdout + human.stderr).includes(m)) })
        .toEqual({ exit: 0, open: true, count: true, leaks: [] });
    }, 300_000);

    test('access.enforced_member_writes refuse: every member write refuses before any lookup, reads and the trusted CLI are unchanged', async () => {
      const KEY = 'access.enforced_member_writes';
      const setKey = async (value: string) => {
        const r = await cli(['config', 'set', KEY, value], { member: null });
        expect({ value, exit: r.exitCode, err: r.exitCode === 0 ? '' : r.stderr }).toEqual({ value, exit: 0, err: '' });
      };
      const page = (title: string, fm = '') => '---\ntype: note\ntitle: ' + JSON.stringify(title) + '\n' + fm + '---\n# ' + title + '\n\nHarbor ledger planning notes for the roadmap.\n';
      const writes: Array<[string[], string | undefined]> = [
        [['put', 'notes/writes-off-new-example'], page('Writes off new')],
        [['put', PAGES.open.slug], page(PAGES.open.title)],
        [['put', PAGES.other.slug], page(PAGES.other.title, 'readable_by: ["bob-example"]\n')],
        [['link', PAGES.open.slug, PAGES.team.slug], undefined],
        [['unlink', PAGES.open.slug, PAGES.other.slug], undefined],
        [['tag', PAGES.open.slug, 'writes-off-tag'], undefined],
        [['untag', PAGES.open.slug, 'writes-off-tag'], undefined],
        [['timeline-add', PAGES.open.slug, '2026-02-01', 'Writes off event'], undefined],
        [['remember', 'Writes off fact canaryemwritesoff', '--entity', PAGES.open.slug, '--provenance', 'test turn'], undefined],
      ];
      const counts = () => withBrain(async engine => {
        const out: Record<string, number> = {};
        for (const table of ['pages', 'links', 'tags', 'timeline_entries', 'facts']) out[table] = (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM ' + table))[0]!.n;
        out.content = (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE compiled_truth LIKE '%' || $1 || '%'", [PAGES.open.canary]))[0]!.n;
        return out;
      });
      const reads: string[][] = [['list', '--json'], ['get', PAGES.open.slug], ['search', 'harbor ledger', '--json'], ['recall', PAGES.open.slug, '--json'], ['stats', '--by', 'type', '--json']];
      const readAll = async () => {
        const out: Array<{ args: string; exit: number; out: string; notice: boolean }> = [];
        for (const args of reads) { const r = await cli(args); out.push({ args: args.join(' '), exit: r.exitCode, out: r.stdout, notice: r.stderr.includes(NOTICE) }); }
        return out;
      };
      const checkedReads = await readAll();
      const before = await counts();
      try {
        await setKey('refuse');
        expect(await readAll()).toEqual(checkedReads);
        const texts = new Set<string>();
        for (const [args, stdin] of writes) {
          const r = await cli(args, { stdin });
          const first = r.stderr.split('\n')[0];
          expect({ args: args.join(' '), exit: r.exitCode, first, out: r.stdout, leaks: leaks(r.stdout + r.stderr) })
            .toEqual({ args: args.join(' '), exit: 3, first: WRITES_OFF_FIRST, out: '', leaks: [] });
          texts.add(r.stderr);
        }
        expect(texts.size).toBe(1);
        const [text] = [...texts];
        expect(text).toContain('Recovery: nothing was saved');
        expect(text).toContain('Why: This brain turned off member writes under this mode');
        expect(text).toContain('brain owner');
        for (const slug of ['notes/writes-off-new-example', PAGES.open.slug, PAGES.other.slug, 'notes', 'harbor']) expect({ slug, named: text!.includes(slug) }).toEqual({ slug, named: false });
        const json = await cli(['put', 'notes/writes-off-new-example', '--json'], { stdin: page('Writes off new') });
        expect({ exit: json.exitCode, envelope: json.stdout.includes('enforced_member_refused'), reason: /"reason":\s*"writes_off"/.test(json.stdout) })
          .toEqual({ exit: 3, envelope: true, reason: true });
        const receipt = await cli(['write-request', crypto.randomUUID()]);
        expect(receipt.stderr).not.toContain(WRITES_OFF_FIRST);
        expect(await counts()).toEqual(before);
        for (const value of ['chekced', 'REFUSE ']) {
          await setKey(value);
          const r = await cli(['tag', PAGES.open.slug, 'writes-off-tag']);
          expect({ value, exit: r.exitCode, first: r.stderr.split('\n')[0], why: r.stderr.includes('turned off member writes') }).toEqual({ value, exit: 3, first: WRITES_OFF_FIRST, why: true });
        }
        await setKey('refuse_pages');
        for (const [args, stdin] of writes) {
          const r = await cli(args, { stdin });
          expect({ args: args.join(' '), exit: r.exitCode, first: r.stderr.split('\n')[0], why: r.stderr.includes('Why: This brain turned off member page writes under this mode') })
            .toEqual({ args: args.join(' '), exit: 3, first: WRITES_OFF_FIRST, why: true });
        }
        expect(await readAll()).toEqual(checkedReads);
        expect(await counts()).toEqual(before);
        await setKey('refuse');
        for (const [args, stdin] of writes.filter(([a]) => a[0] !== 'put' || a[1] === 'notes/writes-off-new-example')) {
          const r = await cli(args, { member: null, stdin });
          expect({ args: args.join(' '), exit: r.exitCode, err: r.exitCode === 0 ? '' : r.stderr }).toEqual({ args: args.join(' '), exit: 0, err: '' });
        }
        const after = await counts();
        expect({ pages: after.pages, facts: after.facts, timeline: after.timeline_entries }).toEqual({ pages: before.pages + 1, facts: before.facts + 1, timeline: before.timeline_entries + 1 });
        await setKey('checked');
        const allowed = await cli(['tag', PAGES.open.slug, 'writes-checked-tag']);
        expect({ exit: allowed.exitCode, err: allowed.exitCode === 0 ? '' : allowed.stderr }).toEqual({ exit: 0, err: '' });
        const hidden = await cli(['put', PAGES.other.slug], { stdin: page('Overwrite') });
        expect({ exit: hidden.exitCode, first: hidden.stderr.split('\n')[0] }).toEqual({ exit: 3, first: FIRST(MEMBER, 'put') });
      } finally {
        await withBrain(engine => engine.executeRaw('DELETE FROM config WHERE key = $1', [KEY]));
      }
    }, 900_000);

    test('variable unset: output is unchanged', async () => {
      for (const args of [['list', '--json'], ['get', PAGES.other.slug], ['stats', '--json']]) {
        const a = await cli(args, { member: null });
        const b = await cli(args, { member: null });
        expect({ args: args[0], exit: a.exitCode, out: a.stdout }).toEqual({ args: args[0], exit: b.exitCode, out: b.stdout });
        expect(a.stderr).not.toContain('GBRAIN_ENFORCED_MEMBER');
      }
    }, 300_000);
  });
}

for (const kind of testBackends()) {
  describe('enforced member mode: git commit-push and sync (' + kind + ')', () => {
    let root: string, home: string, checkout: string;
    let config: Record<string, unknown>;
    let closePg: (() => Promise<void>) | null = null;

    function env(member: string | null): Record<string, string> {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
      for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY', 'GBRAIN_ENFORCED_MEMBER']) delete out[k];
      return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_CLI_SOCKET: '0',
        GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid', ...(member === null ? {} : { GBRAIN_ENFORCED_MEMBER: member }) };
    }
    async function cli(args: string[], member: string | null = MEMBER) {
      const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: checkout, env: env(member), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, exitCode };
    }
    const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { env: env(null), stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    const note = (title: string, fm = '') => '---\ntype: note\ntitle: ' + title + '\n' + fm + '---\n# ' + title + '\n\nHarbor notes.\n';

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'gb-enforced-git-'));
      home = join(root, 'home');
      checkout = join(root, 'checkout');
      const remote = join(root, 'remote.git');
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
      execFileSync('git', ['clone', '-q', remote, checkout], { stdio: 'ignore' });
      mkdirSync(join(checkout, 'notes'), { recursive: true });
      writeFileSync(join(checkout, 'notes', 'open-git.md'), note('Open git'));
      writeFileSync(join(checkout, 'notes', 'bob-git.md'), note('Bob git', 'readable_by: [bob-example]\n'));
      git('checkout', '-q', '-b', 'main');
      git('add', '-A');
      git('commit', '-qm', 'synthetic content');
      git('push', '-q', 'origin', 'main');
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        await pg.engine.disconnect();
        config = { engine: 'postgres', database_url: pg.databaseUrl };
        closePg = pg.close;
      } else {
        config = { engine: 'pglite', database_path: join(root, 'db') };
      }
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
      const engine = await createEngine(config as never);
      await engine.connect(config as never);
      try {
        if (kind === 'pglite') await engine.initSchema();
        for (const id of [MEMBER, 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
        await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('repo-src', 'repo-src', $1)", [checkout]);
      } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
      const synced = await cli(['sync', '--source', 'repo-src', '--no-pull', '--no-embed'], null);
      expect({ exit: synced.exitCode, err: synced.exitCode === 0 ? '' : synced.stderr }).toEqual({ exit: 0, err: '' });
    }, 300_000);

    afterAll(async () => {
      rmSync(root, { recursive: true, force: true });
      await closePg?.();
    }, 60_000);

    test('commit-push refuses a hidden file, a label change, a policy file and the refused modes', async () => {
      writeFileSync(join(checkout, 'notes', 'bob-git.md'), note('Bob git', 'readable_by: [bob-example]\n') + 'More.\n');
      writeFileSync(join(checkout, 'notes', 'open-git.md'), note('Open git', 'visibility: private\n'));
      mkdirSync(join(checkout, '.gbrain'), { recursive: true });
      writeFileSync(join(checkout, '.gbrain', 'access.yml'), 'rules: []\n');
      const cases: string[][] = [
        ['git', 'commit-push', '--path', checkout, '-m', 'x', '--', 'notes/bob-git.md'],
        ['git', 'commit-push', '--path', checkout, '-m', 'x', '--', 'notes/open-git.md'],
        ['git', 'commit-push', '--path', checkout, '-m', 'x', '--', 'notes'],
        ['git', 'commit-push', '--path', checkout, '-m', 'x', '--', '.gbrain/access.yml'],
        ['git', 'commit-push', '--path', checkout, '--pending'],
        ['git', 'commit-push', '--path', checkout, '--push-only'],
        ['git', 'guard', '--install'],
      ];
      for (const args of cases) {
        const r = await cli(args);
        const command = args[1] === 'guard' ? 'git guard' : 'git commit-push';
        expect({ args: args.slice(-1)[0], exit: r.exitCode, first: r.stderr.split('\n')[0] }).toEqual({ args: args.slice(-1)[0], exit: 3, first: FIRST(MEMBER, command) });
      }
      expect(git('status', '--porcelain')).toContain('notes/bob-git.md');
      git('checkout', '-q', '--', 'notes');
      rmSync(join(checkout, '.gbrain'), { recursive: true, force: true });
    }, 300_000);

    test('commit-push of a readable new file and --pull run with their output withheld', async () => {
      writeFileSync(join(checkout, 'notes', 'alice-git.md'), note('Alice git'));
      const r = await cli(['git', 'commit-push', '--path', checkout, '-m', 'alice note', '--', 'notes/alice-git.md']);
      expect({ exit: r.exitCode, out: r.stdout, err: r.stderr }).toEqual({ exit: 0, out: '', err: 'gbrain: git commit-push finished; its output is withheld under GBRAIN_ENFORCED_MEMBER\n' });
      expect(git('log', '--format=%s', '-1').trim()).toBe('alice note');
      const pull = await cli(['git', 'commit-push', '--path', checkout, '--pull']);
      expect({ exit: pull.exitCode, out: pull.stdout, err: pull.stderr }).toEqual({ exit: 0, out: '', err: 'gbrain: git commit-push finished; its output is withheld under GBRAIN_ENFORCED_MEMBER\n' });
    }, 300_000);

    test('access.enforced_member_writes: refuse closes named-path commit-push, refuse_pages keeps it; --pull, --dry-run and sync run under both', async () => {
      const setKey = async (value: string) => {
        const r = await cli(['config', 'set', 'access.enforced_member_writes', value], null);
        expect({ value, exit: r.exitCode, err: r.exitCode === 0 ? '' : r.stderr }).toEqual({ value, exit: 0, err: '' });
      };
      const WITHHELD = (command: string) => 'gbrain: ' + command + ' finished; its output is withheld under GBRAIN_ENFORCED_MEMBER\n';
      const stillRuns = async (mode: string) => {
        const pull = await cli(['git', 'commit-push', '--path', checkout, '--pull']);
        expect({ mode, exit: pull.exitCode, out: pull.stdout, err: pull.stderr }).toEqual({ mode, exit: 0, out: '', err: WITHHELD('git commit-push') });
        const dry = await cli(['git', 'commit-push', '--path', checkout, '--dry-run', '-m', 'dry', '--', 'notes/alice-git-mode.md']);
        expect({ mode, exit: dry.exitCode, out: dry.stdout, err: dry.stderr }).toEqual({ mode, exit: 0, out: '', err: WITHHELD('git commit-push') });
        const sync = await cli(['sync', '--source', 'repo-src', '--no-pull', '--no-embed']);
        expect({ mode, exit: sync.exitCode, out: sync.stdout, err: sync.stderr }).toEqual({ mode, exit: 0, out: '', err: WITHHELD('sync') });
      };
      try {
        writeFileSync(join(checkout, 'notes', 'alice-git-mode.md'), note('Alice git mode'));
        await setKey('refuse');
        const headBefore = git('rev-parse', 'HEAD').trim();
        const texts = new Set<string>();
        for (const path of ['notes/alice-git-mode.md', 'notes/bob-git.md', 'notes/never-written-git.md']) {
          const r = await cli(['git', 'commit-push', '--path', checkout, '-m', 'x', '--', path]);
          expect({ path, exit: r.exitCode, first: r.stderr.split('\n')[0], out: r.stdout }).toEqual({ path, exit: 3, first: WRITES_OFF_FIRST, out: '' });
          texts.add(r.stderr);
        }
        expect(texts.size).toBe(1);
        expect([...texts][0]).toContain('turned off member writes');
        expect(git('rev-parse', 'HEAD').trim()).toBe(headBefore);
        await stillRuns('refuse');
        await setKey('refuse_pages');
        const r = await cli(['git', 'commit-push', '--path', checkout, '-m', 'alice note under refuse_pages', '--', 'notes/alice-git-mode.md']);
        expect({ exit: r.exitCode, out: r.stdout, err: r.stderr }).toEqual({ exit: 0, out: '', err: WITHHELD('git commit-push') });
        expect(git('log', '--format=%s', '-1').trim()).toBe('alice note under refuse_pages');
        const hidden = await cli(['git', 'commit-push', '--path', checkout, '-m', 'x', '--', 'notes/bob-git.md']);
        expect({ exit: hidden.exitCode, first: hidden.stderr.split('\n')[0] }).toEqual({ exit: 3, first: FIRST(MEMBER, 'git commit-push') });
        await stillRuns('refuse_pages');
      } finally {
        const engine = await createEngine(config as never);
        await engine.connect(config as never);
        try { await engine.executeRaw("DELETE FROM config WHERE key = 'access.enforced_member_writes'"); } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
      }
    }, 300_000);

    test('sync runs with its output withheld; sync status is refused', async () => {
      const r = await cli(['sync', '--source', 'repo-src', '--no-pull', '--no-embed']);
      expect({ exit: r.exitCode, out: r.stdout, err: r.stderr }).toEqual({ exit: 0, out: '', err: 'gbrain: sync finished; its output is withheld under GBRAIN_ENFORCED_MEMBER\n' });
      const json = await cli(['sync', '--source', 'repo-src', '--no-pull', '--no-embed', '--json']);
      expect({ exit: json.exitCode, out: json.stdout, err: json.stderr }).toEqual({ exit: 0, out: '', err: 'gbrain: sync finished; its output is withheld under GBRAIN_ENFORCED_MEMBER\n' });
      for (const args of [['sync', '--source', 'repo-src', '--repo', root, '--no-pull'], ['sync', '--repo', checkout], ['sync', '--source', 'repo-src', '--reset-checkpoint']]) {
        const refused = await cli(args);
        expect({ args: args.join(' '), exit: refused.exitCode, first: refused.stderr.split('\n')[0] }).toEqual({ args: args.join(' '), exit: 3, first: FIRST(MEMBER, 'sync') });
      }
      const status = await cli(['sync', 'status', '--source', 'repo-src']);
      expect({ exit: status.exitCode, first: status.stderr.split('\n')[0] }).toEqual({ exit: 3, first: FIRST(MEMBER, 'sync status') });
    }, 300_000);
  });
}
