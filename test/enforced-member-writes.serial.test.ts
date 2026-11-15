/**
 * GST-2476 G2: enforced member mode (GBRAIN_ENFORCED_MEMBER) as real CLI subprocesses against a repo-less brain on
 * disk (PGLite, and Postgres when DATABASE_URL is set): writes, and git commit-push and sync on a repo brain. Reads and
 * refusals live in test/enforced-member.serial.test.ts; each file seeds its own brain.
 *
 * 1. Protects: writes refuse a page the member cannot read and every label change, and an allowed write lands exactly
 *    as a trusted local write (an owner-bound key reads it); write-request shows only the member's own receipts;
 *    timeline-add refuses a gbrain fence; --source reads carry the scope; entity mentions leave a hidden page out;
 *    commit-push refuses a hidden file, a label change and a policy file.
 * 2. Fails when: a write reaches a hidden page or changes a label, a mode write lands member-private, another
 *    member's receipt is distinguishable from an unknown id, or commit-push commits a refused path.
 * 3. Existing coverage: test/enforced-member.serial.test.ts (reads), test/enforced-member-writes-off.test.ts (the key).
 * 4. Real seams: src/cli.ts dispatch, local writes, MCP dispatch as an owner-bound key, a real git remote.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { CLI, enforcedMemberBrain, FIRST, MEMBER, PAGES, REMEMBER_FIRST, REMEMBER_RETRY, WRITES_OFF_FIRST } from './helpers/enforced-member-brain.ts';

for (const kind of testBackends()) {
  describe('enforced member mode: writes (' + kind + ', repo-less)', () => {
    const brain = enforcedMemberBrain(kind);
    const { cli, withBrain } = brain;

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
        const auth = await provider.verifyAccessToken(brain.ownerToken) as unknown as AuthInfo;
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
