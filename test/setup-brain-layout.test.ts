/**
 * GST-2731: \`gbrain setup <harness> --shape personal [--notes <dir>]\` (setup-brain-layout.ts).
 *
 * Authoring gate:
 *  1. Protects: the starter pages are create-only empty forms, the notes folder is
 *     read and never written, a new brain set up by an agent gets the brain_shape
 *     decision and no pages, and the layout block lives beside the brain-first block.
 *  2. Fails on: a re-run that overwrites an edited page, a byte changed in the notes
 *     folder, a page written before the shape question is answered (--yes included),
 *     an inline import of a huge folder, a company brain accepted before it exists.
 *  3. New flags on an existing command; test/setup.test.ts keeps the rest of setup.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';
import { LAYOUT_BEGIN, PERSONAL_PAGES, parseLayoutFlags, renderStarterPage, withBrainShape, brainShapeDecision } from '../src/commands/setup-brain-layout.ts';

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

const CLEAN = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };
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

  test('codex gets the block in its AGENTS.md', async () => {
    const b = box();
    const r = await setup(b, ['codex', '--shape', 'personal']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.brain_layout.block.path).toBe(join(b.home, '.codex', 'AGENTS.md'));
    expect(readFileSync(join(b.home, '.codex', 'AGENTS.md'), 'utf8')).toContain(LAYOUT_BEGIN);
  }, 120_000);

  test('--shape company is refused before anything is written', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--shape', 'company']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('later gbrain release');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
  }, 60_000);
});

describe('layout units', () => {
  test('the starter pages hold only template text', () => {
    for (const p of PERSONAL_PAGES) {
      const text = renderStarterPage(p);
      expect(text).toContain('status: stub');
      for (const line of text.split('\n').filter((l) => l.startsWith('- '))) expect(line.startsWith('- Example (delete me):')).toBe(true);
    }
  });

  test('flag validation', () => {
    const parse = (args: string[]) => parseLayoutFlags((f) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; }, (f) => args.includes(f), 'claude-code');
    expect(parse(['--notes', '/tmp'])).toContain('--shape personal');
    expect(parse(['--shape', 'personal', '--notes', 'rel/dir'])).toContain('absolute');
    expect(parse(['--shape', 'both'])).toContain('later gbrain release');
    expect(parse(['--shape', 'personal', '--notes', 'none'])).toEqual({ brain: 'personal', notes: null });
  });

  test('brain_shape joins the existing first-run bundle', () => {
    const merged = withBrainShape([{ code: 'first_run_decisions', kind: 'ask', why: 'x', user_message: 'Hi.', decisions: [] } as any], brainShapeDecision('codex', []));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.decisions!.map((d) => d.id)).toEqual(['brain_shape']);
  });
});
