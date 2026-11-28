/**
 * GST-4069 (L1, C1): the source a setup run lays out the brain in, and the history question of a company-pinned run.
 *
 * 1. Protects: a Codex re-run pinned only by its receipt writes its starter pages in the receipt's source; a run pinned
 *    to the company source on a one-person brain that holds pages asks the history question with those pages counted,
 *    and the run it suggests keeps --shape company, so following it works.
 * 2. Fails when: the layout step uses the default source while the harness reads the receipt's, or the company-pinned
 *    preview fails on the not-yet-added company source (unknown_source) or suggests a run without --shape company.
 * 3. Existing coverage: setup-serves-gst4043.test.ts (company-pinned labelling on a brain with no history).
 * 4. Real seams: `bun src/cli.ts setup` spawned against a temp HOME / GBRAIN_HOME with a PGLite brain.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { box, gbrain, removeTempDirs, ROSTER } from './helpers/setup-serves-box.ts';

afterAll(removeTempDirs);

describe('setup source and history notes (GST-4069)', () => {
  test('L1: a Codex re-run pinned only by its receipt writes its starter pages in the receipt source', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gbrain(b, ['sources', 'add', 'source-a'])).exitCode).toBe(0);
    const first = await gbrain(b, ['setup', 'codex', '--json', '--gbrain-bin', b.bin], { GBRAIN_SOURCE: 'source-a' });
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    const again = await gbrain(b, ['setup', 'codex', '--shape', 'personal', '--dry-run', '--json', '--gbrain-bin', b.bin]);
    expect(again.exitCode, again.stdout + again.stderr).toBe(0);
    const doc = JSON.parse(again.stdout);
    expect(doc.target.source).toMatchObject({ id: 'source-a', from: 'receipt' });
    expect(doc.brain_layout.pages.length).toBeGreaterThan(0);
    expect(doc.brain_layout.pages.map((p: any) => p.source)).toEqual(doc.brain_layout.pages.map(() => 'source-a'));
  }, 480_000);

  test('C1: a company-pinned run on a one-person brain with pages asks the history question with them counted, and its suggestion works', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gbrain(b, ['put', 'notes/world-topic', '--content', '---\ntitle: world topic\n---\n# world topic\n\nHarbor ledger notes.\n'])).exitCode).toBe(0);
    const r = await gbrain(b, ['setup', 'claude-code', '--shape', 'company', '--serves', 'several', '--members', ROSTER.join(','), '--json', '--gbrain-bin', b.bin], { GBRAIN_SOURCE: 'company' });
    expect(r.exitCode).not.toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.code).toBe('setup_history_choice_required');
    expect(doc.message).toMatch(/holds \d+ page\(s\) no rule or readable_by restricts/);
    expect(doc.message).not.toContain('could not count');
    expect(doc.fix.argv).toEqual(expect.arrayContaining(['--shape', 'company', '--source', 'company', '--labelled-only']));
    const followed = await gbrain(b, [...doc.fix.argv.slice(1), '--json', '--gbrain-bin', b.bin]);
    expect(followed.exitCode, followed.stdout + followed.stderr).toBe(0);
    expect(JSON.parse(followed.stdout).serves.receipt.source_id).toBe('company');
  }, 480_000);
});
