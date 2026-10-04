/**
 * init's first-run decision bundle (agent operator wave G5): ONE `kind: ask`
 * notice whose decisions carry search mode, writeback (recommended salient),
 * harness wiring and the optional skills scaffold, with one user_message
 * offering 'defaults'. Pure: no engine, no filesystem.
 */
import { describe, expect, test } from 'bun:test';
import { buildInitFirstRunNotices } from '../src/commands/init-first-run.ts';

const searchMode = { mode: 'balanced' as const, reason: 'Balanced default for a new brain.' };
const scaffold = { missing: ['cold-start', 'book-mirror'], argv: ['gbrain', 'skillpack', 'scaffold', 'cold-start', 'book-mirror'] };

describe('buildInitFirstRunNotices', () => {
  test('one ask notice: search_mode, writeback, skills_scaffold in order, one defaults relay', () => {
    const notices = buildInitFirstRunNotices({ searchMode, writeback: true, skillsScaffold: scaffold });
    expect(notices).toHaveLength(1);
    const [bundle] = notices;
    expect(bundle).toMatchObject({ code: 'first_run_decisions', kind: 'ask' });
    expect(bundle.decisions!.map(d => d.id)).toEqual(['search_mode', 'writeback', 'skills_scaffold']);
    expect(bundle.user_message).toBe(
      "gbrain is installed. Reply 'defaults' to keep the recommended settings (search_mode: balanced; writeback: salient; skills_scaffold: skip), or tell me what to change.",
    );
  });

  test('writeback recommends salient; every option applies through config set', () => {
    const writeback = buildInitFirstRunNotices({ writeback: true })[0].decisions!.find(d => d.id === 'writeback')!;
    expect(writeback.default).toBe('salient');
    expect(writeback.options.map(o => o.id)).toEqual(['salient', 'all', 'off']);
    for (const o of writeback.options) expect(o.argv).toEqual(['gbrain', 'config', 'set', 'memory.auto_writeback', o.id]);
  });

  test('skills_scaffold is optional: default skip, the scaffold option carries the argv', () => {
    const decision = buildInitFirstRunNotices({ skillsScaffold: scaffold })[0].decisions!.find(d => d.id === 'skills_scaffold')!;
    expect(decision.default).toBe('skip');
    expect(decision.options.find(o => o.id === 'scaffold')!.argv).toEqual(scaffold.argv);
    expect(decision.options.find(o => o.id === 'skip')!.argv).toBeUndefined();
    expect(decision.question).toContain('cold-start, book-mirror');
  });

  test('no writeback ask and no missing skills → those decisions are omitted', () => {
    const ids = buildInitFirstRunNotices({ searchMode, writeback: false, skillsScaffold: null })[0].decisions!.map(d => d.id);
    expect(ids).toEqual(['search_mode']);
    expect(buildInitFirstRunNotices({ writeback: false, skillsScaffold: { missing: [], argv: [] } })).toEqual([]);
  });

  test('no decision saves a fact: nothing in the bundle runs remember', () => {
    const [bundle] = buildInitFirstRunNotices({ searchMode, writeback: true, skillsScaffold: scaffold });
    const argvs = bundle.decisions!.flatMap(d => d.options.map(o => o.argv ?? []));
    expect(argvs.some(a => a.includes('remember'))).toBe(false);
  });
});
