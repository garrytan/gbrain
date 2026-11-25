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
 *  3. New flags on an existing command; test/setup.test.ts keeps the rest of setup.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult, envWithoutDatabaseUrl } from './helpers/cli-spawn.ts';
import { COMPANY_PAGES, LAYOUT_BEGIN, PERSONAL_PAGES, parseLayoutFlags, renderStarterPage, withBrainShape, brainShapeDecision, renderLayoutBlock, layoutNotices, applyBrainLayout, countNotes, askBrainShape, describeLayout, callEgress } from '../src/commands/setup-brain-layout.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; bin: string }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-layout-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, bin };
}

const CLEAN = { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };
const envOf = (b: Box) => ({ ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home });

async function setup(b: Box, args: string[]): Promise<CliResult & { doc: any }> {
  const r = await runCli(['setup', ...args, '--json', '--gbrain-bin', b.bin], { env: envOf(b) });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
const gbrain = (b: Box, args: string[]) => runCli(args, { env: envOf(b) });
const claudeMd = (b: Box) => join(b.home, '.claude', 'CLAUDE.md');

function notesDir(b: Box, extra = 0): string {
  const dir = join(b.root, 'notes');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'pricing.md'), '# Pricing thoughts\n\nCharge per seat, not per query.\n');
  writeFileSync(join(dir, 'sub', 'hiring.md'), '---\ntitle: Hiring notes\n---\nHire slowly.\n');
  for (let i = 0; i < extra; i++) writeFileSync(join(dir, `bulk-${i}.md`), `# Bulk ${i}\n`);
  return dir;
}
function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true }).sort((a, z) => a.name.localeCompare(z.name))) {
      const p = join(d, n.name);
      h.update(p);
      if (n.isDirectory()) walk(p); else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

describe('setup --shape personal', () => {
  test('a new brain set up by an agent gets the brain_shape decision and no pages, --yes included', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--yes']);
    expect(r.exitCode).toBe(0);
    const bundle = r.doc.notices.find((n: any) => n.code === 'first_run_decisions');
    const shape = bundle.decisions.find((d: any) => d.id === 'brain_shape');
    expect(shape.default).toBe('none');
    expect(shape.options.find((o: any) => o.id === 'personal').argv).toEqual(['gbrain', 'setup', 'claude-code', '--shape', 'personal']);
    expect(r.doc.brain_layout).toBeUndefined();
    expect((await gbrain(b, ['get', 'me/facts', '--json'])).exitCode).not.toBe(0);
    expect(readFileSync(claudeMd(b), 'utf8')).not.toContain(LAYOUT_BEGIN);
  }, 120_000);

  test('writes the stubs create-only, imports notes read only, and search finds a note', async () => {
    const b = box();
    const notes = notesDir(b);
    const before = treeHash(notes);
    const r = await setup(b, ['claude-code', '--shape', 'personal', '--notes', notes]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.pages.map((p: any) => p.action)).toEqual(['write', 'write', 'write']);
    expect(r.doc.brain_layout.notes).toMatchObject({ action: 'imported', files: 2 });
    expect(r.doc.brain_layout.check.ok).toBe(true);
    expect(r.doc.brain_layout.next_question).toContain('Pricing thoughts');
    expect(r.doc.notices.some((n: any) => n.decisions?.some((d: any) => d.id === 'brain_shape'))).toBe(false);
    expect(treeHash(notes)).toBe(before);
    expect(readFileSync(claudeMd(b), 'utf8')).toContain(LAYOUT_BEGIN);
    const facts = await gbrain(b, ['get', 'me/facts']);
    expect(facts.stdout).toContain('status: stub');

    const edited = '---\ntitle: Facts about me\n---\n# Facts about me\n\n- 2026-11-15: I like tea. Source: I said so.\n';
    const put = Bun.spawnSync([b.bin, 'put', 'me/facts', '--force'], { stdin: new TextEncoder().encode(edited), stdout: 'pipe', stderr: 'pipe', env: Object.fromEntries(Object.entries({ ...envWithoutDatabaseUrl(), ...envOf(b) }).filter(([, v]) => v !== undefined)) as Record<string, string> });
    expect(put.exitCode).toBe(0);
    const again = await setup(b, ['claude-code', '--shape', 'personal']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.brain_layout.pages.map((p: any) => p.action)).toEqual(['keep', 'keep', 'keep']);
    expect(again.doc.brain_layout.block.action).toBe('keep');
    expect((await gbrain(b, ['get', 'me/facts'])).stdout).toContain('I like tea');

    const none = await setup(b, ['claude-code', '--shape', 'none']);
    expect(none.exitCode).toBe(0);
    expect(none.doc.brain_layout.block.action).toBe('remove');
    expect(readFileSync(claudeMd(b), 'utf8')).not.toContain(LAYOUT_BEGIN);
    expect((await gbrain(b, ['get', 'me/facts'])).stdout).toContain('I like tea');
  }, 240_000);

  test('a folder over the inline limit is handed to the agent as a command', async () => {
    const b = box();
    const notes = notesDir(b, 500);
    const r = await setup(b, ['claude-code', '--shape', 'personal', '--notes', notes]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.notes.action).toBe('deferred');
    const n = r.doc.notices.find((x: any) => x.code === 'brain_layout_import_pending');
    expect(n.fix.argv.slice(0, 4)).toEqual(['gbrain', 'import', notes, '--no-embed']);
    expect(r.doc.brain_layout.pages.every((p: any) => p.action === 'write')).toBe(true);
  }, 180_000);

  test('a requested notes import that fails exits non-zero with the failure on stderr and one JSON document, keeping the wiring', async () => {
    const b = box();
    const notes = join(b.root, 'notes-mixed');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'good.md'), '---\ntype: note\ntitle: Acme pricing\n---\n# Acme pricing\n\nThe starter plan stays free.\n');
    writeFileSync(join(notes, 'bad.md'), '---\ntitle: [unclosed\n  bad: : :\n---\nbody\n');
    const r = await setup(b, ['claude-code', '--shape', 'personal', '--notes', notes]);
    expect(r.doc).not.toBeNull();
    expect(r.doc.brain_layout.notes.action).toBe('failed');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(`the notes import of ${notes} failed`);
    expect(r.doc.state).toBeTruthy();
    expect(readFileSync(claudeMd(b), 'utf8')).toContain(LAYOUT_BEGIN);
  }, 240_000);

  test('an unreadable notes folder is a failed import, never "0 files imported"', async () => {
    const b = box();
    const notes = join(b.root, 'notes-locked');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'a.md'), '# Locked\n');
    chmodSync(notes, 0o000);
    try {
      const r = await setup(b, ['claude-code', '--shape', 'personal', '--notes', notes]);
      expect(r.doc.brain_layout.notes).toMatchObject({ action: 'failed' });
      expect(r.doc.brain_layout.notes.detail).toContain('cannot read');
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain(`the notes import of ${notes} failed`);
    } finally {
      chmodSync(notes, 0o755);
    }
  }, 240_000);

  test('--no-instructions writes the pages and no layout block', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--shape', 'personal', '--no-instructions']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.block).toBeNull();
    expect(r.doc.brain_layout.pages.every((p: any) => p.action === 'write')).toBe(true);
    expect(existsSync(claudeMd(b)) ? readFileSync(claudeMd(b), 'utf8') : '').not.toContain(LAYOUT_BEGIN);
  }, 120_000);

  test('--no-instructions after a personal layout takes the layout block out too', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--shape', 'personal'])).exitCode).toBe(0);
    expect(readFileSync(claudeMd(b), 'utf8')).toContain(LAYOUT_BEGIN);
    const off = await setup(b, ['claude-code', '--no-instructions']);
    expect(off.exitCode).toBe(0);
    expect(off.doc.brain_layout.block.action).toBe('remove');
    expect(readFileSync(claudeMd(b), 'utf8')).not.toContain(LAYOUT_BEGIN);
  }, 180_000);

  test('codex gets the block in its AGENTS.md', async () => {
    const b = box();
    const r = await setup(b, ['codex', '--shape', 'personal']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.block.path).toBe(join(b.home, '.codex', 'AGENTS.md'));
    expect(readFileSync(join(b.home, '.codex', 'AGENTS.md'), 'utf8')).toContain(LAYOUT_BEGIN);
  }, 120_000);

  test('an unknown shape is refused before anything is written', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--shape', 'team']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('pass personal, company, both or none');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
  }, 60_000);
});

function docsDir(b: Box): string {
  const dir = join(b.root, 'company-docs');
  mkdirSync(join(dir, 'pricing'), { recursive: true });
  writeFileSync(join(dir, 'pricing', 'q3.md'), '# Q3 pricing review\n\nWe moved the team plan to annual billing.\n');
  writeFileSync(join(dir, 'onboarding.md'), '# Onboarding playbook\n\nSend the welcome email first.\n');
  return dir;
}
const sourceIds = async (b: Box): Promise<any[]> => JSON.parse((await gbrain(b, ['sources', 'list', '--json'])).stdout).sources;

describe('setup --shape company', () => {
  test('a one-person brain gets a company source in default search, its pages, and the docs read only', async () => {
    const b = box();
    const docs = docsDir(b);
    const before = treeHash(docs);
    const r = await setup(b, ['claude-code', '--shape', 'company', '--docs', docs]);
    expect(r.exitCode).toBe(0);
    const layout = r.doc.brain_layout;
    expect(layout.company).toMatchObject({ source: 'company', action: 'created', federated: true });
    expect(layout.company.root.startsWith(join(b.home, '.gbrain'))).toBe(true);
    expect(layout.pages.map((p: any) => [p.slug, p.source, p.action])).toEqual(COMPANY_PAGES.map((p) => [p.slug, 'company', 'write']));
    expect(layout.docs).toMatchObject({ action: 'imported', files: 2 });
    expect(layout.check).toMatchObject({ ok: true, query: 'Onboarding playbook' });
    expect(layout.check.detail).toContain('default search');
    expect(layout.next_question).toContain('what did we decide about Onboarding playbook');
    expect(r.doc.notices.some((n: any) => n.code === 'source_not_in_default_search')).toBe(false);
    expect(treeHash(docs)).toBe(before);
    const md = readFileSync(claudeMd(b), 'utf8');
    expect(md).toContain('company/decisions');
    expect(md).not.toContain('me/facts');
    expect((await gbrain(b, ['get', 'company/facts', '--source', 'company'])).stdout).toContain('status: stub');
    const again = await setup(b, ['claude-code', '--shape', 'company']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.brain_layout.company.action).toBe('kept');
    expect(again.doc.brain_layout.pages.every((p: any) => p.action === 'keep')).toBe(true);
  }, 240_000);

  test('a brain declared shared keeps the company source out of default search and asks the user', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--shape', 'personal'])).exitCode).toBe(0);
    expect((await gbrain(b, ['config', 'set', 'brain.audience', 'shared'])).exitCode).toBe(0);
    const docs = docsDir(b);
    const r = await setup(b, ['claude-code', '--shape', 'both', '--docs', docs]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.company).toMatchObject({ action: 'created', federated: false });
    expect((await sourceIds(b)).find((s) => s.id === 'company').federated).toBe(false);
    const n = r.doc.notices.find((x: any) => x.code === 'source_not_in_default_search');
    expect(n.fix.next).toBe('ask_user');
    expect(n.fix.argv.slice(0, 4)).toEqual(['gbrain', 'sources', 'federate', 'company']);
    expect(r.doc.brain_layout.check.detail).toContain('search of the company source');
    const md = readFileSync(claudeMd(b), 'utf8');
    expect(md).toContain('me/facts');
    expect(md).toContain('company/decisions');
  }, 300_000);

  test('--team writes the personal part, creates nothing for the company part and prints the route', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--shape', 'both', '--team']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.company).toMatchObject({ action: 'team' });
    expect(r.doc.brain_layout.pages.map((p: any) => p.slug)).toEqual(['me/facts', 'me/voice', 'me/how-i-decide']);
    expect((await sourceIds(b)).some((s) => s.id === 'company')).toBe(false);
    expect(r.doc.notices.find((x: any) => x.code === 'brain_layout_team_next').user_message).toContain('gbrain access serves several');
    const md = readFileSync(claudeMd(b), 'utf8');
    expect(md).toContain('me/facts');
    expect(md).not.toContain('company/decisions');
  }, 180_000);
});

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

const plantedToken = (): string => 'github' + '_pat_' + randomBytes(24).toString('hex');
function callsDir(b: Box, token: string): string {
  const dir = join(b.root, 'call-exports');
  mkdirSync(join(dir, 'q1'), { recursive: true });
  writeFileSync(join(dir, '2026-03-04 acme-example renewal.txt'), `Alice: we agreed to move acme-example to annual billing.\nBob: the deploy key is ${token} for the record.\n`);
  writeFileSync(join(dir, 'q1', 'weekly-sync.md'), '# Weekly sync 2026-02-01\n\nAlice: pricing stays at 20 dollars per seat.\n');
  const undated = join(dir, 'kickoff.txt');
  writeFileSync(undated, 'Kickoff with acme-example\nBob: the first milestone is onboarding.\n');
  utimesSync(undated, new Date(2026, 0, 15, 12), new Date(2026, 0, 15, 12));
  writeFileSync(join(dir, 'slides.pdf'), 'not a call');
  return dir;
}
const CALL_SLUGS = ['company/calls/2026-03-04-acme-example-renewal', 'company/calls/2026-02-01-weekly-sync', 'company/calls/2026-01-15-kickoff-with-acme-example'];
const callPages = async (b: Box): Promise<string[]> => {
  const r = await gbrain(b, ['list', '--source', 'company', '--json']);
  return (JSON.parse(r.stdout) as Array<{ slug: string }>).map((p) => p.slug).filter((s) => s.startsWith('company/calls/')).sort();
};

describe('setup --transcripts', () => {
  test('a repo-less brain imports each call once into the company source, redacted, with the source readers and the archive line', async () => {
    const b = box();
    const token = plantedToken();
    const calls = callsDir(b, token);
    const before = treeHash(calls);
    const r = await setup(b, ['claude-code', '--shape', 'company', '--transcripts', calls]);
    expect(r.exitCode).toBe(0);
    const t = r.doc.brain_layout.transcripts;
    expect(t).toMatchObject({ action: 'imported', files: 3, imported: 3, unchanged: 0, kept: 0 });
    expect(t.argv).toEqual(['gbrain', 'import', calls, '--calls', '--prefix', 'company/calls', '--no-embed', '--source', 'company']);
    expect(t.redactions).toBeGreaterThanOrEqual(1);
    expect(t.readers).toEqual({ members: 'every_source_reader', serves: 'one', detail: 'everyone who can read source company (this brain serves one person)' });
    expect(t.egress).toEqual({ leaves: false, detail: 'nothing; no extraction reads call pages here, and embedding waits for your approval' });
    expect(r.doc.brain_layout.archive.state).toBe('on');
    expect(r.doc.brain_layout.archive.detail).toContain('call transcripts are separate');
    expect(await callPages(b)).toEqual([...CALL_SLUGS].sort());
    const page = await gbrain(b, ['get', CALL_SLUGS[0]!, '--source', 'company']);
    expect(page.exitCode).toBe(0);
    expect(page.stdout).toContain('Alice: we agreed to move acme-example to annual billing.');
    expect(page.stdout).not.toContain(token);
    expect(page.stdout).toContain('<REDACTED:github_pat>');
    expect(page.stdout).not.toContain('readable_by');
    expect(page.stdout).toContain('facts_backstop: false');
    expect((await gbrain(b, ['get', 'company/facts', '--source', 'company'])).stdout).toContain('type: facts');
    expect(treeHash(calls)).toBe(before);

    const again = await setup(b, ['claude-code', '--shape', 'company', '--transcripts', calls]);
    expect(again.exitCode).toBe(0);
    expect(again.doc.brain_layout.transcripts).toMatchObject({ action: 'imported', imported: 0, unchanged: 3, kept: 0 });
    expect(await callPages(b)).toEqual([...CALL_SLUGS].sort());
  }, 300_000);

  test('a git-backed company source gets the call files in its working tree, redacted', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const repo = join(b.root, 'company-repo');
    mkdirSync(repo);
    execSync('git init -q && git config user.email t@example.com && git config user.name t && echo "# Company" > README.md && git add README.md && git commit -qm init', { cwd: repo });
    expect((await gbrain(b, ['sources', 'add', 'company', '--path', repo, '--json'])).exitCode).toBe(0);
    const token = plantedToken();
    const r = await setup(b, ['claude-code', '--shape', 'company', '--transcripts', callsDir(b, token)]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.company).toMatchObject({ action: 'kept', root: repo });
    expect(r.doc.brain_layout.transcripts).toMatchObject({ action: 'imported', imported: 3 });
    const file = readFileSync(join(repo, 'company', 'calls', '2026-03-04-acme-example-renewal.md'), 'utf8');
    expect(file).toContain('<REDACTED:github_pat>');
    expect(file).not.toContain(token);
    expect(file).not.toContain('readable_by');
    expect((await gbrain(b, ['get', CALL_SLUGS[0]!, '--source', 'company'])).stdout).not.toContain(token);
  }, 300_000);

  test('on a shared brain the call pages get the company source rules as their readers, never wider', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--shape', 'company'])).exitCode).toBe(0);
    expect((await gbrain(b, ['access', 'serves', 'several', '--members', 'alice-example,bob-example', '--yes', '--json'])).exitCode).toBe(0);
    expect((await gbrain(b, ['access', 'rule', 'add', '--prefix', 'company/calls/', '--readers', 'alice-example', '--source', 'company', '--yes', '--json'])).exitCode).toBe(0);
    const r = await setup(b, ['claude-code', '--shape', 'company', '--stdio-member', 'alice-example', '--transcripts', callsDir(b, plantedToken())]);
    expect(r.exitCode).toBe(0);
    const t = r.doc.brain_layout.transcripts;
    expect(t.imported).toBe(3);
    expect(t.readers.members).toEqual(['alice-example']);
    expect(t.readers.serves).toBe('several');
    expect(t.readers.detail).toStartWith('alice-example only (access rules on source company cover company/calls/; this brain serves several people');
    for (const slug of CALL_SLUGS) {
      const who = JSON.parse((await gbrain(b, ['access', 'who-can-read', slug, '--source', 'company', '--json'])).stdout).pages[0];
      expect(who.readers).toBeNull();
      expect(who.members).toEqual(['alice-example']);
    }
  }, 300_000);

  test('GBRA-585: a company setup whose member keys do not read company says no member key setup minted reads the calls yet', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example', '--shape', 'company'])).exitCode).toBe(0);
    for (const m of ['alice-example', 'bob-example']) expect((await gbrain(b, ['auth', 'rescope', '--token', `member-${m}`, '--sources', 'default'])).exitCode).toBe(0);
    const r = await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example', '--shape', 'company', '--no-stdio-member', '--transcripts', callsDir(b, plantedToken())]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.company).toMatchObject({ action: 'kept', federated: false });
    expect(r.doc.brain_layout.transcripts.calls).toBeUndefined();
    expect(r.doc.brain_layout.transcripts.not_scoped).toMatchObject({ reason: 'stdio_unbound' });
    expect(r.doc.brain_layout.transcripts.not_scoped.command).toContain('--stdio-member');
    expect(r.doc.serves.regrant).toBeUndefined();
    const t = r.doc.brain_layout.transcripts;
    expect(t.imported).toBe(3);
    expect(t.readers).toMatchObject({ members: 'every_source_reader', serves: 'several' });
    expect(t.readers.detail).toStartWith('no member key setup minted reads them yet: source company is not federated');
    expect(t.readers.detail).toContain('gbrain sources federate company');
    expect(t.readers.detail).toContain('this brain serves several people: alice-example, bob-example');
    expect(t.readers.detail).not.toContain('every member key gbrain setup minted');
  }, 300_000);

  test('GST-2904: a company setup for several people ties its own entry to the owner and keeps each call to the owner and its attendees; the archive says why it is on', async () => {
    const b = box();
    const calls = callsDir(b, plantedToken());
    writeFileSync(join(calls, '2026-03-05 hiring debrief.md'), 'Attendees: alice-example, dave-example\n\nAlice: the staff engineer range is set.\n');
    const r = await setup(b, ['claude-code', '--serves', 'several', '--members', 'alice-example,bob-example', '--shape', 'company', '--transcripts', calls]);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.company).toMatchObject({ action: 'created', federated: false });
    expect(r.doc.serves.engine).toContain('gbrain migrate --to postgres');
    const t = r.doc.brain_layout.transcripts;
    const owner = r.doc.target.stdio_member;
    expect(owner).toBe(r.doc.serves.stdio.member);
    expect(r.doc.serves.owner_from).toBe('login');
    expect(r.doc.serves.brain_serves).toBe('several');
    expect(t.imported).toBe(4);
    expect(t.not_scoped).toBeUndefined();
    expect(t.readers).toBeUndefined();
    expect(t.calls).toContainEqual({ slug: 'company/calls/2026-03-05-hiring-debrief', readers: [owner, 'alice-example'], unmatched: ['dave-example'] });
    for (const slug of CALL_SLUGS) expect(t.calls).toContainEqual({ slug, readers: [owner], unmatched: [] });
    const reads = async (member: string, slug: string) => (await gbrain(b, ['get', slug, '--source', 'company', '--as', member])).exitCode === 0;
    expect(await reads('alice-example', 'company/calls/2026-03-05-hiring-debrief')).toBe(true);
    expect(await reads('bob-example', 'company/calls/2026-03-05-hiring-debrief')).toBe(false);
    expect((await gbrain(b, ['get', 'company/calls/2026-03-05-hiring-debrief', '--source', 'company'])).exitCode).toBe(0);
    expect(r.doc.serves.regrant.keys.map((k: any) => [k.member, k.adds])).toEqual([['alice-example', ['company']], ['bob-example', ['company']]]);
    const archive = r.doc.brain_layout.archive;
    expect(archive.state).toBe('on');
    expect(archive.detail).toStartWith('on for now: this brain serves several people');
    expect(archive.detail).toContain('gbrain config set brain.audience shared');
    const status = await gbrain(b, ['transcripts', 'archive', 'status']);
    expect(status.stdout).toContain('conversation archive: on');
    expect(status.stdout).toContain('  why: on for now: this brain serves several people');
    const doctor = JSON.parse((await gbrain(b, ['doctor', '--only', 'transcript_archive_freshness', '--json'])).stdout);
    const check = doctor.checks.find((c: any) => c.name === 'transcript_archive_freshness');
    expect(check.message).toContain('Conversation archive is on (on for now: this brain serves several people');
    expect(check.details).toMatchObject({ enabled: true, enabled_by: 'default', serves_several: true });
    const help = await gbrain(b, ['transcripts', '--help']);
    expect(help.stdout).not.toContain('off unless turned on');
  }, 300_000);
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
