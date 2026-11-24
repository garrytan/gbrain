/**
 * init's first-run decision bundle (agent operator wave G5): ONE `kind: ask`
 * notice whose decisions carry search mode, writeback (in effect off,
 * recommended salient) and the optional skills scaffold as settings in
 * effect, plus a separate `harness_wiring` install step. Pure: no engine, no
 * filesystem.
 */
import { describe, expect, test } from 'bun:test';
import { archiveLine, buildInitFirstRunNotices, setupFirstRunNotices, upkeepLine } from '../src/commands/init-first-run.ts';
import { costMatrixSentence } from '../src/core/search/mode-advice.ts';
import { renderCliNotices } from '../src/core/agent-markers.ts';
import { cliRenderContext, inertText, renderNotice } from '../src/core/agent-output.ts';
import { withEnv } from './helpers/with-env.ts';

const searchMode = { mode: 'balanced' as const, reason: 'Balanced default for a new brain.' };
const scaffold = { missing: ['cold-start', 'book-mirror'], argv: ['gbrain', 'skillpack', 'scaffold', 'cold-start', 'book-mirror'] };

describe('buildInitFirstRunNotices', () => {
  test('one notice of settings in effect: search_mode, writeback, skills_scaffold in order, relayed without waiting for an answer', () => {
    const notices = buildInitFirstRunNotices({ searchMode, writeback: true, skillsScaffold: scaffold });
    expect(notices).toHaveLength(1);
    const [bundle] = notices;
    expect(bundle).toMatchObject({ code: 'first_run_decisions', kind: 'ask' });
    expect(bundle.decisions!.map(d => d.id)).toEqual(['search_mode', 'writeback', 'skills_scaffold']);
    expect(bundle.user_message).toBe(
      'gbrain is installed. In effect: search mode balanced; agents save only what you ask them to remember, until you turn on automatic saving '
      + '(salient is recommended: durable facts you state, saved with provenance). '
      + `${costMatrixSentence()} Nothing needs an answer now; tell me any time if you want to change any of these, and I'll apply it.`,
    );
    expect(bundle.user_message).not.toContain("Reply 'defaults'");
    expect(bundle.why).toContain('do not hold the install open');
  });

  test('connecting the agent is its own install step, never a setting in the ask (Garry G, GST-2719)', () => {
    const config = { engine: 'pglite', database_path: '/tmp/gbrain-example.pglite' } as never;
    const notices = buildInitFirstRunNotices({ searchMode, writeback: true, config });
    expect(notices.map(n => n.code)).toEqual(['harness_wiring', 'first_run_decisions']);
    expect(notices[1].decisions!.map(d => d.id)).not.toContain('harness_wiring');
    const [wiring] = notices;
    expect(wiring.kind).toBe('info');
  });

  test('with no agent detected, the wiring fix stays the user step readiness gave, and the why does not promise a command', async () => {
    const markers = { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, CODEX_CI: undefined, OPENCODE: undefined, OPENCODE_PID: undefined };
    await withEnv(markers, async () => {
      const config = { engine: 'pglite', database_path: '/tmp/gbrain-example.pglite' } as never;
      const [wiring] = buildInitFirstRunNotices({ searchMode, writeback: true, config });
      expect(wiring.code).toBe('harness_wiring');
      expect(wiring.fix!.argv).toBeUndefined();
      expect(wiring.fix!.actor).toBe('user');
      expect(wiring.fix!.consent).toEqual(['persistent_install']);
      expect(wiring.fix!.user_message).toBeTruthy();
      expect(wiring.why).not.toContain('The fix names the command');
      expect(wiring.why).toContain(wiring.fix!.user_message!);
    });
  });

  test('nothing paid turns on from the first-run settings: writeback in effect off, keyless upkeep pays for nothing', () => {
    const [bundle] = buildInitFirstRunNotices({ searchMode: { mode: 'conservative', reason: 'No chat key.' }, writeback: true, upkeep: { embedding: false } });
    expect(bundle.decisions!.find(d => d.id === 'writeback')!.default).toBe('off');
    expect(bundle.decisions!.find(d => d.id === 'search_mode')!.default).toBe('conservative');
    expect(bundle.user_message).toContain('Nothing is deleted or paid for without you');
    expect(bundle.why).toContain('Nothing paid turns on from these settings without a key the user supplied');
  });

  test('writeback is in effect off and recommends salient; every option applies through config set', () => {
    const writeback = buildInitFirstRunNotices({ writeback: true })[0].decisions!.find(d => d.id === 'writeback')!;
    expect(writeback.default).toBe('off');
    expect(writeback.default_reason).toContain('salient is recommended');
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

describe('the upkeep line (GBRA-438)', () => {
  test('rides the bundle last as a setting in effect: the plan\'s wording, default on, off through config set', () => {
    const [bundle] = buildInitFirstRunNotices({ searchMode, upkeep: { embedding: false } });
    expect(bundle.decisions!.map(d => d.id)).toEqual(['search_mode', 'upkeep']);
    const upkeep = bundle.decisions!.find(d => d.id === 'upkeep')!;
    expect(upkeep.question).toBe(
      "Upkeep: free upkeep runs on its own while your agent's gbrain session is open. Nothing is deleted or paid for without you. "
      + 'Turn off: gbrain config set maintenance.auto false. Optional schedule: gbrain maintain --schedule.',
    );
    expect(upkeep.question).not.toContain('?');
    expect(upkeep.default).toBe('on');
    expect(upkeep.options.find(o => o.id === 'on')!.argv).toBeUndefined();
    expect(upkeep.options.find(o => o.id === 'off')!.argv).toEqual(['gbrain', 'config', 'set', 'maintenance.auto', 'false']);
    expect(bundle.user_message).toContain(upkeepLine(false));
  });

  test('a keyed brain\'s line names the one capped paid step', () => {
    expect(upkeepLine(true)).toContain('the only paid step is embedding new text, capped at $1 a day (maintenance.embed_daily_usd)');
    expect(upkeepLine(true)).not.toContain('paid for without you');
  });

  test('upkeep alone never opens a bundle', () => {
    expect(buildInitFirstRunNotices({ writeback: false, skillsScaffold: null, upkeep: { embedding: false } })).toEqual([]);
  });

  test('setup states it once in the settings it relays, never as a question', () => {
    const [bundle] = buildInitFirstRunNotices({ searchMode, upkeep: { embedding: false } });
    const [n] = setupFirstRunNotices([{ ...bundle, contract_version: 1 }], 'Claude Code');
    expect(n.user_message!.split(upkeepLine(false)).length).toBe(2);
    expect(n.user_message).toContain("Nothing needs an answer now");
    const [alone] = setupFirstRunNotices([{ ...bundle, decisions: bundle.decisions!.filter(d => d.id === 'upkeep'), contract_version: 1 }], 'Claude Code');
    expect(alone.user_message).toBe(`gbrain is set up and Claude Code is wired, so memory works now. Report back (Wakeshift): off. gbrain wakeshift enable turns it on. ${upkeepLine(false)} Nothing needs an answer now; tell me any time if you want to change any of these, and I'll apply it.`);
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
      + 'until you turn on automatic saving (salient is recommended: durable facts you state, saved with provenance). '
      + 'Report back (Wakeshift): off. gbrain wakeshift enable turns it on. '
      + `${costMatrixSentence()} Nothing needs an answer now; tell me any time if you want to change any of these, and I'll apply it.`,
    );
    expect(n.user_message).not.toContain("Reply 'defaults'");
    expect(n.why).toContain('in the reply that reports this install');
    expect(n.why).toContain('do not hold the install open');
  });

  test('a Codex setup prices the matrix with OpenAI models, not Claude ones', () => {
    const [n] = setupFirstRunNotices(fromInit({ searchMode }), 'Codex');
    const mode = n.decisions!.find(d => d.id === 'search_mode')!;
    for (const text of [n.user_message!, mode.question]) {
      expect(text).not.toContain('Haiku');
      expect(text).toContain('GPT-5.6 Luna / GPT-5.6 Terra / GPT-5.6 Sol');
    }
  });

  test('the search-mode matrix still reaches the user and every option keeps its command', () => {
    const [n] = setupFirstRunNotices(fromInit({ searchMode }), 'Claude Code');
    expect(n.user_message).toContain(costMatrixSentence());
    const mode = n.decisions!.find(d => d.id === 'search_mode')!;
    expect(mode.options.map(o => o.argv)).toEqual(['conservative', 'balanced', 'tokenmax'].map(m => ['gbrain', 'config', 'set', 'search.mode', m]));
    expect(n.user_message).not.toContain('automatic saving');
  });

  test('every harness gets the Report back (Wakeshift) row: off by default, on once reporting back is published', () => {
    for (const harness of ['Claude Code', 'Codex']) {
      const [off] = setupFirstRunNotices(fromInit({ searchMode }), harness);
      expect(off.user_message).toContain('Report back (Wakeshift): off. gbrain wakeshift enable turns it on.');
      const [on] = setupFirstRunNotices(fromInit({ searchMode }), harness, { reportBack: true });
      expect(on.user_message).toContain('Report back (Wakeshift): on. gbrain wakeshift disable turns it off.');
      expect(on.user_message).not.toContain('Report back (Wakeshift): off');
    }
  });

  test('nothing left to relay → no notice; foreign or missing notices are ignored', () => {
    expect(setupFirstRunNotices([{ code: 'first_run_decisions', kind: 'ask', why: 'x', decisions: [wiring] }], 'Claude Code')).toEqual([]);
    expect(setupFirstRunNotices([{ code: 'other', kind: 'info', why: 'x' }, null], 'Claude Code')).toEqual([]);
    expect(setupFirstRunNotices([], 'Claude Code')).toEqual([]);
  });
});

describe('the conversation archive line (GST-2768)', () => {
  test('a personal brain: on, what is archived and where, nothing leaves a keyless machine, and the off command', () => {
    const [bundle] = buildInitFirstRunNotices({ searchMode, upkeep: { embedding: false }, archive: { state: 'on', embedding: false } });
    expect(bundle.decisions!.map(d => d.id)).toEqual(['search_mode', 'upkeep', 'conversation_archive']);
    const archive = bundle.decisions!.find(d => d.id === 'conversation_archive')!;
    expect(archive.question).toBe(archiveLine('on', false));
    expect(archive.question).toContain('Conversation archive: on.');
    expect(archive.question).toContain('conversations source');
    expect(archive.question).toContain('nothing leaves this machine');
    expect(archive.question).toContain('gbrain transcripts archive off');
    expect(archive.default).toBe('on');
    expect(archive.options.find(o => o.id === 'off')!.argv).toEqual(['gbrain', 'transcripts', 'archive', 'off']);
    expect(archiveLine('on', true)).toContain('gbrain embed --held --dry-run');
  });

  test('a shared brain is offered it with the on command, default off', () => {
    const [bundle] = buildInitFirstRunNotices({ searchMode, archive: { state: 'offered', embedding: false } });
    const archive = bundle.decisions!.find(d => d.id === 'conversation_archive')!;
    expect(archive.question).toBe(archiveLine('offered', false));
    expect(archive.question).toContain('gbrain transcripts archive on');
    expect(archive.default).toBe('off');
    expect(archive.options.find(o => o.id === 'on')!.argv).toEqual(['gbrain', 'transcripts', 'archive', 'on']);
  });

  test('the archive line alone never opens a bundle', () => {
    expect(buildInitFirstRunNotices({ archive: { state: 'on', embedding: false } })).toEqual([]);
  });

  test('setup relays it once in the settings in effect, never as a question', () => {
    const [bundle] = buildInitFirstRunNotices({ searchMode, archive: { state: 'on', embedding: false } });
    const [n] = setupFirstRunNotices([{ ...bundle, contract_version: 1 }], 'Codex');
    expect(n.user_message!.split(archiveLine('on', false)).length).toBe(2);
    expect(n.user_message).toContain('Nothing needs an answer now');
  });
});

describe('the [SHOW USER] relay of the first-run summary', () => {
  const showUser = (block: string) => block.split('[SHOW USER]\n')[1]!.split('\n[/SHOW USER]')[0]!;

  test('setup and init relay the whole summary, through to "Nothing needs an answer now", never cut mid-text', () => {
    const inputs = { searchMode: { mode: 'conservative' as const, reason: 'No chat key.' }, writeback: true, upkeep: { embedding: false }, archive: { state: 'on' as const, embedding: false } };
    const [initBundle] = buildInitFirstRunNotices(inputs);
    for (const harness of ['Claude Code', 'Codex']) {
      const [n] = setupFirstRunNotices([{ ...initBundle, contract_version: 1 }], harness, { reportBack: false });
      expect(n.user_message!.length).toBeGreaterThan(1_000);
      const { stdout } = renderCliNotices([renderNotice(n, cliRenderContext())], { json: false, tty: false });
      const relayed = showUser(stdout!);
      expect(relayed).toBe(inertText(n.user_message!, Number.MAX_SAFE_INTEGER));
      expect(relayed.endsWith("Nothing needs an answer now; tell me any time if you want to change any of these, and I'll apply it.")).toBe(true);
    }
    const { stdout } = renderCliNotices([renderNotice(initBundle, cliRenderContext())], { json: false, tty: false });
    expect(showUser(stdout!).endsWith("and I'll apply it.")).toBe(true);
  });
});

