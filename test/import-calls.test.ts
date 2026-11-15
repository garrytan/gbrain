/**
 * GST-2731 (GBRA-529 PR 3): `gbrain import <dir> --calls` (src/commands/import-calls.ts), the opt-in text mode for
 * exported call and meeting transcripts.
 *
 * Authoring gate:
 *  1. Protects: each .txt/.md call file becomes one page named from its date and title, its words kept, every
 *     credential redacted by the archive's transcript redaction before anything is stored, no readable_by of its
 *     own, keyword-only and out of the facts backstop; a rerun writes nothing again.
 *  2. Fails on: a planted credential in a stored page, a call imported twice, a changed file overwriting its page,
 *     a --prefix value read as the import folder, a page written under conversations/.
 *  3. A new mode on an existing command; test/setup-brain-layout.test.ts covers it through gbrain setup.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { callPageFor, listCallFiles } from '../src/commands/import-calls.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
const plantedToken = (): string => 'github' + '_pat_' + randomBytes(24).toString('hex');
const MTIME = new Date(2026, 0, 15, 12).getTime();

describe('call pages', () => {
  test('date and title come from a dated file name, else the first line, else the modified day', () => {
    const named = callPageFor('2026-03-04 acme-example renewal.txt', 'Alice: hello\n', MTIME, 'company/calls', []);
    expect(named).toMatchObject({ slug: 'company/calls/2026-03-04-acme-example-renewal', title: 'acme example renewal', date: '2026-03-04', date_from: 'file_name' });
    const line = callPageFor('q1/notes.md', '# Weekly sync 2026-02-01\n\nAlice: hi\n', MTIME, 'company/calls', []);
    expect(line).toMatchObject({ slug: 'company/calls/2026-02-01-weekly-sync', title: 'Weekly sync', date: '2026-02-01', date_from: 'first_line' });
    const neither = callPageFor('kickoff.txt', 'Kickoff with acme-example\nBob: hi\n', MTIME, 'calls', []);
    expect(neither).toMatchObject({ slug: 'calls/2026-01-15-kickoff-with-acme-example', date: '2026-01-15', date_from: 'modified' });
    expect(callPageFor('2026-13-45 odd.txt', 'Odd call\n', MTIME, 'calls', []).date_from).toBe('modified');
    const fm = callPageFor('call.md', '---\nfrom: export\n---\nStandup 2026-05-06\nhi\n', MTIME, 'calls', []);
    expect(fm).toMatchObject({ date: '2026-05-06', title: 'Standup' });
  });

  test('the words are kept, credentials are redacted, structure lines are neutral, and the page names no readers', () => {
    const token = plantedToken();
    const page = callPageFor('2026-03-04 sync.txt', `Alice: we agreed on annual billing.\nBob: my key is ${token} ok\n## Timeline\n`, MTIME, 'calls', []);
    expect(page.content).toContain('Alice: we agreed on annual billing.');
    expect(page.content).not.toContain(token);
    expect(page.content).toContain('Bob: my key is <REDACTED:github_pat> ok');
    expect(page.redactions).toBe(1);
    expect(page.content).toContain('\n\\## Timeline');
    expect(page.content).toContain('\nfacts_backstop: false\n');
    expect(page.content).toContain('\ntype: meeting\n');
    expect(page.content).not.toContain('readable_by');
    expect(callPageFor('2026-03-04 sync.txt', `Alice: we agreed on annual billing.\nBob: my key is ${token} ok\n## Timeline\n`, MTIME, 'calls', []).hash).toBe(page.hash);
  });

  test('only .txt and .md files are listed; dot entries and symlinks are skipped', () => {
    const dir = temp('gbrain-calls-list-');
    mkdirSync(join(dir, 'sub'));
    mkdirSync(join(dir, '.hidden'));
    for (const f of ['a.txt', 'sub/b.md', '.hidden/c.txt', '.d.txt', 'e.pdf']) writeFileSync(join(dir, f), 'x\n');
    symlinkSync(join(dir, 'a.txt'), join(dir, 'link.txt'));
    expect(listCallFiles(dir)).toEqual([join(dir, 'a.txt'), join(dir, 'sub', 'b.md')]);
  });
});

describe('gbrain import --calls', () => {
  test('imports each call once, never overwrites a changed one, and reads --prefix before the folder', async () => {
    const root = temp('gbrain-calls-cli-');
    const home = join(root, 'home');
    mkdirSync(home);
    const env = { HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
    expect((await runCli(['init', '--pglite', '--no-embedding', '--json'], { env })).exitCode).toBe(0);
    const calls = join(root, 'calls');
    mkdirSync(calls);
    const token = plantedToken();
    const renewal = join(calls, '2026-03-04 acme-example renewal.txt');
    writeFileSync(renewal, `Alice: annual billing.\nBob: key ${token}\n`);
    const kickoff = join(calls, 'kickoff.txt');
    writeFileSync(kickoff, 'Kickoff with acme-example\nBob: onboarding first.\n');
    utimesSync(kickoff, new Date(MTIME), new Date(MTIME));
    const run = async () => {
      const r = await runCli(['import', '--calls', '--prefix', 'company/calls', calls, '--no-embed', '--json'], { env });
      return { ...r, doc: JSON.parse(r.stdout) };
    };
    const first = await run();
    expect(first.exitCode).toBe(0);
    expect(first.doc).toMatchObject({ mode: 'calls', source_id: 'default', prefix: 'company/calls', total_files: 2, imported: 2, errors: 0, redactions: 1 });
    expect(first.doc.pages.map((p: any) => p.slug).sort()).toEqual(['company/calls/2026-01-15-kickoff-with-acme-example', 'company/calls/2026-03-04-acme-example-renewal']);
    const stored = await runCli(['get', 'company/calls/2026-03-04-acme-example-renewal'], { env });
    expect(stored.stdout).toContain('Alice: annual billing.');
    expect(stored.stdout).toContain('<REDACTED:github_pat>');
    expect(stored.stdout).not.toContain(token);

    const second = await run();
    expect(second.doc).toMatchObject({ imported: 0, unchanged: 2, kept: 0, errors: 0 });

    writeFileSync(renewal, 'Alice: a corrected export.\n');
    const third = await run();
    expect(third.doc).toMatchObject({ imported: 0, unchanged: 1, kept: 1, errors: 0 });
    expect((await runCli(['get', 'company/calls/2026-03-04-acme-example-renewal'], { env })).stdout).toContain('Alice: annual billing.');
    const listed = JSON.parse((await runCli(['list', '--json'], { env })).stdout) as Array<{ slug: string }>;
    expect(listed.some((p) => p.slug.startsWith('conversations/'))).toBe(false);
  }, 240_000);
});
