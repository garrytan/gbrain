/**
 * init's first-run decision bundle (agent operator wave G5): ONE `kind: ask`
 * notice whose decisions carry search mode, writeback (recommended salient),
 * harness wiring and the optional skills scaffold, with one user_message
 * offering 'defaults'. Pure: no engine, no filesystem.
 */
import { describe, expect, test } from 'bun:test';
import { buildInitFirstRunNotices, setupFirstRunNotices } from '../src/commands/init-first-run.ts';
import { costMatrixSentence } from '../src/core/search/mode-advice.ts';

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

describe('setupFirstRunNotices (gbrain setup <harness>)', () => {
  const wiring = { id: 'harness_wiring', question: 'Which agent app should get gbrain memory?', options: [{ id: 'wire', label: 'wire' }, { id: 'skip', label: 'skip' }], default: 'wire', default_reason: 'detected' };
  const fromInit = (inputs: Parameters<typeof buildInitFirstRunNotices>[0]) => {
    const [bundle] = buildInitFirstRunNotices(inputs);
    return [{ ...bundle, decisions: [...bundle.decisions!, wiring], contract_version: 1 }];
  };

  test('drops harness_wiring (setup just wired it) and keeps the rest of the bundle', () => {
    const [n] = setupFirstRunNotices(fromInit({ searchMode, writeback: true, skillsScaffold: scaffold }), 'Claude Code');
    expect(n).toMatchObject({ code: 'first_run_decisions', kind: 'ask' });
    expect(n.decisions!.map(d => d.id)).toEqual(['search_mode', 'writeback', 'skills_scaffold']);
  });

  test('frames the bundle as settings in effect, relayed in the install reply, never a reply-to-continue question', () => {
    const [n] = setupFirstRunNotices(fromInit({ searchMode, writeback: true }), 'Claude Code');
    expect(n.user_message).toBe(
      'gbrain is set up and Claude Code is wired, so memory works now. In effect: search mode balanced; agents save only what you ask them to remember, '
      + 'until you turn on automatic saving (gbrain recommends salient: durable facts you state, saved with provenance). '
      + `${costMatrixSentence()} Nothing needs an answer now; tell me any time if you want to change any of these, and I'll apply it.`,
    );
    expect(n.user_message).not.toContain("Reply 'defaults'");
    expect(n.why).toContain('in the reply that reports this install');
    expect(n.why).toContain('do not hold the install open');
  });

  test('the search-mode matrix still reaches the user and every option keeps its command', () => {
    const [n] = setupFirstRunNotices(fromInit({ searchMode }), 'Claude Code');
    expect(n.user_message).toContain(costMatrixSentence());
    const mode = n.decisions!.find(d => d.id === 'search_mode')!;
    expect(mode.options.map(o => o.argv)).toEqual(['conservative', 'balanced', 'tokenmax'].map(m => ['gbrain', 'config', 'set', 'search.mode', m]));
    expect(n.user_message).not.toContain('automatic saving');
  });

  test('nothing left to relay → no notice; foreign or missing notices are ignored', () => {
    expect(setupFirstRunNotices([{ code: 'first_run_decisions', kind: 'ask', why: 'x', decisions: [wiring] }], 'Claude Code')).toEqual([]);
    expect(setupFirstRunNotices([{ code: 'other', kind: 'info', why: 'x' }, null], 'Claude Code')).toEqual([]);
    expect(setupFirstRunNotices([], 'Claude Code')).toEqual([]);
  });
});
