/**
 * GST-2731: `gbrain setup <harness> --shape personal` end to end (setup-brain-layout.ts): the brain_shape decision, create-only
 * starter pages, a notes folder read and never written, and the layout block.
 * Split from test/setup-brain-layout.test.ts (GST-4082).
 * Shared fixture: test/helpers/setup-brain-layout-box.ts. The authoring gate for the whole suite is in test/setup-brain-layout.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupBoxes, box, setup, gbrain, claudeMd, envOf, notesDir, treeHash } from './helpers/setup-brain-layout-box.ts';
import { LAYOUT_BEGIN } from '../src/commands/setup-brain-layout.ts';

afterAll(cleanupBoxes);

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
    expect(r.stderr + r.stdout).toContain('pass personal, company, both, household or none');
    expect(existsSync(join(b.home, '.claude.json'))).toBe(false);
  }, 60_000);
});
