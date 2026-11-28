/**
 * GST-2731: \`gbrain setup <harness> --shape personal|company|both [--notes <dir>] [--docs <dir>] [--team]\` (setup-brain-layout.ts).
 *
 * Authoring gate:
 *  1. Protects: the starter pages are create-only empty forms, the notes and docs
 *     folders are read and never written, a new brain set up by an agent gets the
 *     brain_shape decision and no pages, the layout block lives beside the brain-first
 *     block, and the company source joins default search only on a one-person brain.
 *  2. Fails on: a re-run that overwrites an edited page, a byte changed in the notes
 *     or docs folder, a page written before the shape question is answered (--yes
 *     included), an inline import of a huge folder, a company source federated on a
 *     shared brain, anything created for the company part with --team.
 *     --transcripts (PR 3): a call imported twice, a planted credential stored, a call page readable more widely
 *     than its source, a call page under conversations/, a missing archive line.
 *  3. New flags on an existing command; test/setup-claude-install.test.ts covers the Claude Code install.
 *
 * This file holds the in-process units. The gbrain setup runs are split by shape so no file fills a CI shard on its own
 * (GST-4082): test/setup-brain-layout-personal.test.ts, -company.test.ts, -transcripts.test.ts and
 * -transcripts-members.test.ts, with their fixture in test/helpers/setup-brain-layout-box.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupBoxes, roots } from './helpers/setup-brain-layout-box.ts';
import { COMPANY_PAGES, PERSONAL_PAGES, parseLayoutFlags, renderStarterPage, withBrainShape, brainShapeDecision, renderLayoutBlock, layoutNotices, applyBrainLayout, countNotes, askBrainShape, describeLayout, callEgress } from '../src/commands/setup-brain-layout.ts';

afterAll(cleanupBoxes);

describe('layout units', () => {
  test('the starter pages hold only template text', () => {
    for (const p of [...PERSONAL_PAGES, ...COMPANY_PAGES]) {
      const text = renderStarterPage(p);
      expect(text).toContain('status: stub');
      for (const line of text.split('\n').filter((l) => l.startsWith('- '))) expect(line.startsWith('- Example (delete me):')).toBe(true);
    }
  });

  test('flag validation', () => {
    const parse = (args: string[]) => parseLayoutFlags((f) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; }, (f) => args.includes(f), 'claude-code');
    expect(parse(['--notes', '/tmp'])).toContain('--shape personal or both');
    expect(parse(['--shape', 'personal', '--notes', 'rel/dir'])).toContain('absolute');
    expect(parse(['--shape', 'personal', '--docs', '/tmp'])).toContain('--shape company or both');
    expect(parse(['--shape', 'personal', '--team'])).toContain('need --shape company or both');
    expect(parse(['--shape', 'company', '--team', '--solo'])).toContain('do not go together');
    expect(parse(['--shape', 'company', '--team', '--docs', '/tmp'])).toContain('--solo');
    expect(parse(['--shape', 'both'])).toEqual({ brain: 'both' });
    expect(parse(['--shape', 'company', '--team'])).toEqual({ brain: 'company', team: true });
    expect(parse(['--shape', 'both', '--notes', 'none', '--docs', '/tmp'])).toEqual({ brain: 'both', notes: null, docs: '/tmp' });
    expect(parse(['--shape', 'personal', '--notes', 'none'])).toEqual({ brain: 'personal', notes: null });
  });

  test('brain_shape joins the existing first-run bundle', () => {
    const merged = withBrainShape([{ code: 'first_run_decisions', kind: 'ask', why: 'x', user_message: 'Hi.', decisions: [] } as any], brainShapeDecision('codex', []));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.decisions!.map((d) => d.id)).toEqual(['brain_shape']);
  });

  test('a project-scope run keeps --scope project in every command it hands out', () => {
    const argvs = (scope?: 'user' | 'project') => {
      const d = brainShapeDecision('claude-code', ['/notes'], scope);
      const failed = { shape: 'personal', pages: [{ slug: 'me/facts', action: 'failed', detail: 'locked' }], notes: null, block: null, check: { ok: true, query: null, detail: '' }, next_question: null } as any;
      return [...d.options.filter((o) => o.argv).map((o) => o.argv!), ...layoutNotices(failed, 'claude-code', scope).map((n) => n.fix!.argv!)];
    };
    for (const argv of argvs('project')) expect(argv.slice(0, 5)).toEqual(['gbrain', 'setup', 'claude-code', '--scope', 'project']);
    for (const argv of argvs()) expect(argv).not.toContain('--scope');
    expect(renderLayoutBlock('claude-code', 'project')).toContain('Remove: gbrain setup claude-code --scope project --shape none');
    expect(renderLayoutBlock('claude-code')).toContain('Remove: gbrain setup claude-code --shape none');
  });

  test('a pinned source rides every command and child the layout runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-layout-src-'));
    roots.push(root);
    writeFileSync(join(root, 'a.md'), '# A\n');
    const calls: string[][] = [];
    const o = applyBrainLayout({ harness: 'claude-code', source: 'private', launcher: 'gbrain', instructionsPath: null, flags: { brain: 'personal', notes: root, dryRun: false },
      run: (argv) => { calls.push(argv); return { code: 0, stdout: '[]', stderr: '' }; } })!;
    expect(o.notes!.argv).toEqual(['gbrain', 'import', root, '--no-embed', '--source', 'private']);
    expect(brainShapeDecision('claude-code', [], 'user', 'private').options.find((x) => x.id === 'personal')!.argv).toEqual(['gbrain', 'setup', 'claude-code', '--source', 'private', '--shape', 'personal']);
    expect(renderLayoutBlock('claude-code', 'user', 'private')).toContain('Remove: gbrain setup claude-code --source private --shape none');
  });

  test('a starter page is written only when get says page_not_found', () => {
    const calls: string[][] = [];
    const o = applyBrainLayout({ harness: 'claude-code', launcher: 'gbrain', instructionsPath: null, flags: { brain: 'personal', notes: null, dryRun: false },
      run: (argv) => { calls.push(argv); return argv[1] === 'get' ? { code: 1, stdout: '{"code":"file_held"}', stderr: 'Error [file_held]: held' } : { code: 0, stdout: '', stderr: '' }; } })!;
    expect(o.pages.map((p) => p.action)).toEqual(['failed', 'failed', 'failed']);
    expect(calls.some((c) => c[1] === 'put')).toBe(false);
    const wrote = applyBrainLayout({ harness: 'claude-code', launcher: 'gbrain', instructionsPath: null, flags: { brain: 'personal', notes: null, dryRun: false },
      run: (argv) => (argv[1] === 'get' ? { code: 1, stdout: '{"code":"page_not_found"}', stderr: '' } : { code: 0, stdout: '', stderr: '' }) })!;
    expect(wrote.pages.map((p) => p.action)).toEqual(['write', 'write', 'write']);
  });

  test('a rerun handed out after a --team run keeps --team', () => {
    const o = (company: any) => ({ shape: 'both', pages: [{ slug: 'me/facts', source: null, action: 'failed', detail: 'busy' }], notes: null, docs: null, company, block: null, check: { ok: true, query: null, detail: '' }, next_question: null }) as any;
    const fix = (company: any) => layoutNotices(o(company), 'claude-code').find((n) => n.code === 'brain_layout_pages_pending')!.fix!;
    expect(fix({ source: 'company', action: 'team', federated: null, root: null }).argv).toEqual(['gbrain', 'setup', 'claude-code', '--shape', 'both', '--team']);
    expect(fix(null).argv).toEqual(['gbrain', 'setup', 'claude-code', '--shape', 'both']);
  });

  test('a company folder that is not an empty folder is never adopted, and the block and the fix say so', () => {
    for (const occupy of [(p: string) => { mkdirSync(p); writeFileSync(join(p, 'mine.md'), '# Mine\n'); }, (p: string) => writeFileSync(p, 'a file\n')]) {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-layout-occupied-'));
      roots.push(root);
      occupy(join(root, 'company'));
      const instructions = join(root, 'CLAUDE.md');
      const calls: string[][] = [];
      const o = applyBrainLayout({ harness: 'claude-code', launcher: 'gbrain', instructionsPath: instructions, flags: { brain: 'both', notes: null, docs: null, dryRun: false },
        run: (argv) => {
          calls.push(argv);
          if (argv[1] === 'sources') return { code: 0, stdout: JSON.stringify({ sources: [{ id: 'default', local_path: join(root, 'default'), federated: true }] }), stderr: '' };
          return argv[1] === 'get' ? { code: 1, stdout: '{"code":"page_not_found"}', stderr: '' } : { code: 0, stdout: '', stderr: '' };
        } })!;
      expect(o.company!.action).toBe('failed');
      expect(calls.some((c) => c[1] === 'sources' && c[2] === 'add')).toBe(false);
      expect(o.pages.map((p) => p.slug)).toEqual(PERSONAL_PAGES.map((p) => p.slug));
      const block = readFileSync(instructions, 'utf8');
      expect(block).toContain('me/facts');
      expect(block).not.toContain('company/facts');
      const fix = layoutNotices(o, 'claude-code').find((n) => n.code === 'brain_layout_pages_pending')!.fix!;
      expect(fix.ask_user).toBe(true);
      expect(fix.user_message).toContain(join(root, 'company'));
    }
  });

  test('requested company imports are failed imports, not skipped, when the company source cannot be set up', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-layout-blocked-'));
    roots.push(root);
    mkdirSync(join(root, 'company'));
    writeFileSync(join(root, 'company', 'mine.md'), '# Mine\n');
    const docs = join(root, 'docs');
    const calls = join(root, 'calls');
    mkdirSync(docs);
    mkdirSync(calls);
    const o = applyBrainLayout({ harness: 'claude-code', launcher: 'gbrain', instructionsPath: null, flags: { brain: 'company', docs, transcripts: calls, dryRun: false },
      run: (argv) => {
        if (argv[1] === 'sources') return { code: 0, stdout: JSON.stringify({ sources: [{ id: 'default', local_path: join(root, 'default'), federated: true }] }), stderr: '' };
        return argv[1] === 'get' ? { code: 1, stdout: '{"code":"page_not_found"}', stderr: '' } : { code: 0, stdout: '', stderr: '' };
      } })!;
    expect(o.company!.action).toBe('failed');
    expect(o.docs).toMatchObject({ dir: docs, action: 'failed' });
    expect(o.docs!.detail).toContain('company source could not be set up');
    expect(o.transcripts).toMatchObject({ dir: calls, action: 'failed' });
  });

  test('personal pages land before the company source exists, and either sources add reply reads as federated', () => {
    for (const reply of [{ federated: true }, { config: { federated: true } }]) {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-layout-order-'));
      roots.push(root);
      const calls: string[][] = [];
      const o = applyBrainLayout({ harness: 'claude-code', launcher: 'gbrain', instructionsPath: null, flags: { brain: 'both', notes: null, docs: null, dryRun: false },
        run: (argv) => {
          calls.push(argv);
          if (argv[1] === 'sources' && argv[2] === 'list') return { code: 0, stdout: JSON.stringify({ sources: [{ id: 'default', local_path: join(root, 'default'), federated: true }] }), stderr: '' };
          if (argv[1] === 'sources' && argv[2] === 'add') return { code: 0, stdout: JSON.stringify({ id: 'company', ...reply }), stderr: '' };
          return argv[1] === 'get' ? { code: 1, stdout: '{"code":"page_not_found"}', stderr: '' } : { code: 0, stdout: '', stderr: '' };
        } })!;
      const added = calls.findIndex((c) => c[1] === 'sources' && c[2] === 'add');
      for (const p of PERSONAL_PAGES) expect(calls.findIndex((c) => c[1] === 'put' && c[2] === p.slug)).toBeLessThan(added);
      expect(o.company!.federated).toBe(true);
    }
  });

  test('the notes count does not follow symlinked folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-layout-loop-'));
    roots.push(root);
    symlinkSync(root, join(root, 'loop-a'));
    symlinkSync(root, join(root, 'loop-b'));
    writeFileSync(join(root, 'n.md'), '# N\n');
    expect(countNotes(root)).toEqual({ count: 1, first: join(root, 'n.md') });
  });
});

describe('transcripts units', () => {
  test('--transcripts needs a local company shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-layout-calls-flag-'));
    roots.push(dir);
    const parse = (args: string[]) => parseLayoutFlags((f) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; }, (f) => args.includes(f), 'claude-code');
    expect(parse(['--shape', 'personal', '--transcripts', dir])).toContain('--shape company or both');
    expect(parse(['--transcripts', dir])).toContain('--shape company or both');
    expect(parse(['--shape', 'company', '--team', '--transcripts', dir])).toContain('drop --transcripts or use --solo');
    expect(parse(['--shape', 'both', '--transcripts', dir])).toEqual({ brain: 'both', transcripts: dir });
    expect(parse(['--shape', 'company', '--transcripts', 'none'])).toEqual({ brain: 'company', transcripts: null });
  });

  test('a call folder over the inline limit is handed to the agent as the import command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-layout-calls-bulk-'));
    roots.push(dir);
    for (let i = 0; i < 501; i++) writeFileSync(join(dir, `call-${i}.txt`), 'hello\n');
    const calls: string[][] = [];
    const o = applyBrainLayout({ harness: 'claude-code', launcher: 'gbrain', instructionsPath: null, flags: { brain: 'company', transcripts: dir, dryRun: false },
      run: (argv) => {
        calls.push(argv);
        if (argv[1] === 'sources') return { code: 0, stdout: JSON.stringify({ sources: [{ id: 'company', local_path: '/c', federated: true }] }), stderr: '' };
        return argv[1] === 'get' ? { code: 0, stdout: '{}', stderr: '' } : { code: 0, stdout: '{}', stderr: '' };
      } })!;
    expect(o.transcripts).toMatchObject({ action: 'deferred', files: 501 });
    expect(calls.some((c) => c[1] === 'import')).toBe(false);
    const n = layoutNotices(o, 'claude-code').find((x) => x.code === 'brain_layout_import_pending')!;
    expect(n.why).toContain('more than 500 call files');
    expect(n.fix!.argv).toEqual(['gbrain', 'import', dir, '--calls', '--prefix', 'company/calls', '--no-embed', '--source', 'company']);
  });

  test('with a chat model key, the call line says extraction can send call text to the chat provider; without one, nothing leaves', () => {
    const chronicleOn = { name: 'auto_chronicle', details: { enabled: true, chat_available: true, daily_limit: 25 } };
    const atomsOn = { name: 'extract_atoms_backlog', details: { pack_declares_phase: true } };
    expect(callEgress([chronicleOn, atomsOn])).toEqual({ leaves: true,
      detail: 'with a chat model key set, event extraction (auto_chronicle, at most 25 page(s) a day) and atom extraction (within cycle.extract_atoms.budget_usd) can send call text to your chat provider, within the limits you set; embedding waits for your approval' });
    expect(callEgress([{ name: 'auto_chronicle', details: { enabled: false } }, atomsOn]).detail).toStartWith('with a chat model key set, atom extraction (within cycle.extract_atoms.budget_usd) can send');
    const keyless = { name: 'auto_chronicle', details: { enabled: true, chat_available: false, daily_limit: 25 } };
    expect(callEgress([keyless, atomsOn])).toEqual({ leaves: false, detail: 'nothing; no extraction reads call pages here, and embedding waits for your approval' });
    expect(callEgress([{ name: 'auto_chronicle', details: { enabled: false } }, { name: 'extract_atoms_backlog', details: { pack_declares_phase: false } }]).leaves).toBe(false);
    const unchecked = { leaves: null, detail: 'could not be checked; gbrain doctor --only auto_chronicle,extract_atoms_backlog shows it' };
    expect(callEgress([])).toEqual(unchecked);
    expect(callEgress([{ name: 'transcript_archive_freshness', details: { enabled: true } }, chronicleOn])).toEqual(unchecked);
  });

  test('the human report names who reads the call pages and what the archive is doing', () => {
    const o = { shape: 'company', pages: [], notes: null, docs: null, company: null, block: null, check: { ok: true, query: null, detail: 'nothing to check' }, next_question: null,
      transcripts: { dir: '/calls', files: 2, action: 'imported', argv: [], imported: 2, unchanged: 0, kept: 0, redactions: 1, readers: { members: 'every_source_reader', serves: 'one', detail: 'everyone who can read source company (this brain serves one person)' },
        egress: { leaves: true, detail: 'with a chat model key set, atom extraction (within cycle.extract_atoms.budget_usd) can send call text to your chat provider, within the limits you set; embedding waits for your approval' } },
      archive: { state: 'offered', detail: 'offered, not on: this brain may serve more than one person (gbrain transcripts archive on turns it on)' } } as any;
    const lines = describeLayout(o, false);
    expect(lines).toContain('           readable by: everyone who can read source company (this brain serves one person)');
    expect(lines).toContain('           what leaves this machine: with a chat model key set, atom extraction (within cycle.extract_atoms.budget_usd) can send call text to your chat provider, within the limits you set; embedding waits for your approval');
    expect(lines.find((l) => l.startsWith('  calls '))).toContain('2 new, 0 unchanged, 0 kept, 1 credential(s) redacted');
    expect(lines).toContain('  archive  conversation archive offered, not on: this brain may serve more than one person (gbrain transcripts archive on turns it on)');
    const scoped = { ...o, transcripts: { ...o.transcripts, readers: undefined, calls: [
      { slug: 'company/calls/2026-03-05-hiring-debrief', readers: ['owner-example', 'alice-example'], unmatched: ['dave-example'] },
      { slug: 'company/calls/2026-02-01-weekly-sync', readers: ['owner-example'], unmatched: [] }] } };
    const kept = describeLayout(scoped, false);
    expect(kept).toContain('           each kept to the people on it (the owner reads every call):');
    expect(kept).toContain('             company/calls/2026-03-05-hiring-debrief  owner-example, alice-example');
    expect(kept).toContain('                 not matched: "dave-example". To add a reader: gbrain repair visibility --source company --slug company/calls/2026-03-05-hiring-debrief --readers owner-example,alice-example,<member>');
    expect(kept).toContain('             company/calls/2026-02-01-weekly-sync  owner-example (no other attendee matched a member)');
    expect(kept.some((l) => l.includes('readable by'))).toBe(false);
    const open = describeLayout({ ...o, transcripts: { ...o.transcripts, not_scoped: { reason: 'stdio_unbound', why: 'New calls were imported open.', command: 'gbrain setup claude-code --stdio-member owner-example' } } }, false);
    expect(open).toContain('           calls kept open, as before: New calls were imported open. Run: gbrain setup claude-code --stdio-member owner-example');
  });

  test('at a terminal, a local company brain asks for a call-transcript folder after the docs folder', async () => {
    const docs = mkdtempSync(join(tmpdir(), 'gbrain-layout-ask-docs-'));
    const calls = mkdtempSync(join(tmpdir(), 'gbrain-layout-ask-calls-'));
    roots.push(docs, calls);
    const answering = (answers: string[]) => {
      const prompts: string[] = [];
      return { prompts, read: async ({ prompt }: { prompt: string }) => { prompts.push(prompt); const a = answers.shift(); return a === undefined ? { kind: 'eof' as const } : { kind: 'line' as const, text: a }; } };
    };
    const solo = answering(['2', '1', docs, calls]);
    expect(await askBrainShape([], solo.read as any)).toEqual({ brain: 'company', team: false, docs, transcripts: calls });
    expect(solo.prompts[3]).toContain('call transcripts');
    const team = answering(['3', '', '2']);
    expect(await askBrainShape([], team.read as any)).toEqual({ brain: 'both', notes: null, team: true });
    expect(team.prompts.some((p) => p.includes('call transcripts'))).toBe(false);
  });

  test('the facts starter pages carry type: facts and the block names the facts convention', () => {
    expect(renderStarterPage(PERSONAL_PAGES.find((p) => p.slug === 'me/facts')!)).toContain('\ntype: facts\n');
    expect(renderStarterPage(COMPANY_PAGES.find((p) => p.slug === 'company/facts')!)).toContain('\ntype: facts\n');
    expect(renderStarterPage(COMPANY_PAGES.find((p) => p.slug === 'company/decisions')!)).not.toContain('type:');
    expect(renderLayoutBlock('claude-code', 'user', null, 'both')).toContain('A page with type: facts holds one dated line per fact: quote only its dated lines');
  });
});
