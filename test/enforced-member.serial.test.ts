/**
 * GST-2476 G2: enforced member mode (GBRAIN_ENFORCED_MEMBER) as real CLI subprocesses against a repo-less brain on
 * disk (PGLite, and Postgres when DATABASE_URL is set): reads and refusals. Writes live in
 * test/enforced-member-writes.serial.test.ts and access.enforced_member_writes in
 * test/enforced-member-writes-setting.serial.test.ts; each file seeds its own brain (test/helpers/enforced-member-brain.ts).
 *
 * 1. Protects: under the mode every read-filtered command shows no slug, title, body, fact or count of a page the member
 *    cannot read (another member's readers, visibility: private, a folder rule it does not satisfy, another member's
 *    personal source); every refused class, an unknown member, an empty value and the owner id refuse with the exact
 *    first line; hook succeeds silently; doctor prints only names, statuses and counts; unset changes nothing.
 * 2. Fails when: any of those reads names a hidden page, a refusal prints anything else first or exits 0, or the
 *    variable unset changes output.
 * 3. Existing coverage: test/access-as.serial.test.ts (--as, which keeps ctx.remote false and is refused here).
 * 4. Real seams: src/cli.ts and src/cli/main.ts dispatch, local reads.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATION_CLASSES } from '../src/cli/enforced-member-classes.ts';
import { testBackends } from './helpers/test-backends.ts';
import { enforcedMemberBrain, FIRST, HIDDEN, HIDDEN_FACT, leaks, MEMBER, NOTICE, OPEN_FACT, OWNER, PAGES, VISIBLE, type Key } from './helpers/enforced-member-brain.ts';

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
    const brain = enforcedMemberBrain(kind);
    const { cli, withBrain } = brain;

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
      const other = join(brain.root, 'other-checkout');
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

    test('--help: a refused command refuses, an allowed one prints its static help and runs nothing', async () => {
      const mountPath = join(brain.root, 'help-mount');
      const refused: Array<[string[], string]> = [
        [['creds', 'list', '--json', '--help'], 'creds'], [['google', 'status', '--json', '--help'], 'google'],
        [['mounts', 'add', 'help-mount', '--path', mountPath, '--engine', 'pglite', '--db-path', join(brain.root, 'help.db'), '--help'], 'mounts'],
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
      expect({ mount: existsSync(mountPath), db: existsSync(join(brain.root, 'help.db')) }).toEqual({ mount: false, db: false });
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

    // A failed lookup read is not a miss: under the mode, `entity` still says so (the degraded marker survives the in-process
    // dispatch) and GBRAIN_FAIL_ON_EMPTY=1 does not turn it into exit 12. Fails one real read of the CLI with a preload.
    test('entity: a failed lookup read carries the marker and is not exit 12', async () => {
      if (kind !== 'pglite') return; // the preload patches PGlite; the marker path is engine-agnostic
      const fault = { preload: join(import.meta.dir, 'helpers', 'pglite-sql-fault-preload.ts'), env: { GBRAIN_FAIL_ON_EMPTY: '1', GBRAIN_TEST_FAIL_SQL: 'lower\\(title\\) = \\$2' } };
      const failed = await brain.cli(['entity', 'Nobody Example', '--json'], fault);
      const out = JSON.parse(failed.stdout);
      expect({ exit: failed.exitCode, found: out.found, degraded: out.degraded }).toEqual({ exit: 0, found: false, degraded: { reasons: ['entity_lookup_failed'] } });
      expect(failed.stdout).not.toContain('injected_entity_lookup'); // the raw read error stays on the operator's stderr only
      const healthy = await brain.cli(['entity', 'Nobody Example', '--json'], { env: { GBRAIN_FAIL_ON_EMPTY: '1' } });
      expect({ exit: healthy.exitCode, found: JSON.parse(healthy.stdout).found, degraded: JSON.parse(healthy.stdout).degraded }).toEqual({ exit: 12, found: false, degraded: undefined });
    }, 300_000);

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
