/**
 * `gbrain setup <harness> --shape company --transcripts <dir>` end to end (setup-brain-layout.ts): each call imported once,
 * redacted, into the company source (repo-less and git-backed), with readers never wider than the source.
 * Split from test/setup-brain-layout.test.ts (GST-4082); the member cases are in test/setup-brain-layout-transcripts-members.test.ts.
 * Shared fixture: test/helpers/setup-brain-layout-box.ts. The authoring gate for the whole suite is in test/setup-brain-layout.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupBoxes, box, setup, gbrain, treeHash, plantedToken, callsDir, CALL_SLUGS, callPages } from './helpers/setup-brain-layout-box.ts';

afterAll(cleanupBoxes);

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

});
