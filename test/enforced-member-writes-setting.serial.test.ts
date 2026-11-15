/**
 * GST-2476 G2: enforced member mode (GBRAIN_ENFORCED_MEMBER) as real CLI subprocesses against a repo-less brain on
 * disk (PGLite, and Postgres when DATABASE_URL is set): the access.enforced_member_writes key. Each file of the
 * enforced member suites seeds its own brain (test/helpers/enforced-member-brain.ts).
 *
 * 1. Protects: refuse turns every member write away before any lookup with one constant text, refuse_pages turns page
 *    writes away, checked restores the per-page check; member reads and the trusted CLI are unchanged under each.
 * 2. Fails when: a member write lands or names a slug under refuse, a read changes, or a trusted write is refused.
 * 3. Existing coverage: test/enforced-member-writes-off.test.ts (the key's parsing, in process).
 * 4. Real seams: src/cli.ts dispatch, gbrain config set, local writes.
 */
import { describe, expect, test } from 'bun:test';
import { testBackends } from './helpers/test-backends.ts';
import { enforcedMemberBrain, FIRST, leaks, MEMBER, NOTICE, PAGES, WRITES_OFF_FIRST } from './helpers/enforced-member-brain.ts';

for (const kind of testBackends()) {
  describe('enforced member mode: access.enforced_member_writes (' + kind + ', repo-less)', () => {
    const brain = enforcedMemberBrain(kind);
    const { cli, withBrain } = brain;

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
  });
}
