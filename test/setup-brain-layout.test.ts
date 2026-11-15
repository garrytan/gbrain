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
 *  3. New flags on an existing command; test/setup.test.ts keeps the rest of setup.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';
import { COMPANY_PAGES, LAYOUT_BEGIN, PERSONAL_PAGES, parseLayoutFlags, renderStarterPage, withBrainShape, brainShapeDecision, renderLayoutBlock, layoutNotices, applyBrainLayout, countNotes } from '../src/commands/setup-brain-layout.ts';

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
    const put = Bun.spawnSync([b.bin, 'put', 'me/facts', '--force'], { stdin: new TextEncoder().encode(edited), stdout: 'pipe', stderr: 'pipe', env: Object.fromEntries(Object.entries({ ...process.env, ...envOf(b) }).filter(([, v]) => v !== undefined)) as Record<string, string> });
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
