/**
 * GST-2462: a privacy label gbrain does not recognize (`access: personal`, a confidentiality value naming a health
 * record, free text starting "PRIVATE") is ignored with no word: the page reads like an unlabelled page to remote
 * callers and is not kept out of git by the label. Each write path (put_page, import, sync) now says so with one
 * `privacy_label_ignored` notice, and the doctor check counts such pages by value. Nothing reads differently.
 * Label values here are invented; slugs are placeholders.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { performSync } from '../src/commands/sync.ts';
import { runImport } from '../src/commands/import.ts';
import { runWaveChecks } from '../src/commands/doctor/wave-checks.ts';
import { __resetPrivateVisibilityCacheForTests, isPrivacyDerivationPrivate, isPrivatePage } from '../src/core/search/private-visibility.ts';
import { declaredDatabaseOnly } from '../src/core/persistence/git-gap.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { commitFile, withRefreshFixture } from './helpers/worktree-refresh-fixture.ts';
import { settleManagedGitEffects } from './helpers/managed-brain.ts';

const CODE = 'privacy_label_ignored';
const NOTICE_HEAD = `[gbrain notice ${CODE} kind=safety]`;
const GIT_SENTENCE = "pushed to the brain's git remote";
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const page = (slug: string, fm: string) => `---\ntype: note\ntitle: ${slug}\n${fm}\n---\n# ${slug}\n\nPlanning notes for ${slug}, kept short.\n`;

/** The label sets every write path is checked against: [frontmatter lines, notice expected]. */
const CASES: Array<[string, string, boolean]> = [
  ['personal', 'access: personal', true],
  ['health', 'confidentiality: health record (invented)', true],
  ['freetext', 'access: "PRIVATE - share with alice-example only"', true],
  ['recognized', 'access: private', false],
  ['recognized-conf', 'confidentiality: secret', false],
  ['visibility-world', 'visibility: world\naccess: personal', false],
  ['visibility-private', 'visibility: private\naccess: personal', false],
  ['unlabelled', 'status: draft', false],
];

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const spies = [spyOn(console, 'log').mockImplementation(() => {}), spyOn(console, 'error').mockImplementation(() => {}), spyOn(process.stderr, 'write').mockImplementation(() => true)];
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
}

function noticeBlocks(result: { content: Array<{ text: string }> }): string[] {
  return result.content.map(c => c.text).filter(t => t.startsWith(NOTICE_HEAD));
}

for (const kind of testBackends()) {
  describe(`privacy_label_ignored (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let managed: { engine: BrainEngine; close: () => Promise<void> } | undefined;
    const dirs: string[] = [];
    const tmp = (name: string) => { const d = mkdtempSync(join(tmpdir(), `gst2462-${name}-`)); dirs.push(d); return d; };

    beforeAll(async () => {
      const open = async (): Promise<{ engine: BrainEngine; close: () => Promise<void> }> => {
        if (kind === 'postgres') return isolatedPersistencePostgres(process.env.DATABASE_URL!);
        const pglite = new PGLiteEngine();
        await pglite.connect({ engine: 'pglite' } as never);
        await pglite.initSchema();
        return { engine: pglite, close: () => pglite.disconnect() };
      };
      ({ engine, close } = await open());
      // The managed git-source test gets its own brain, so its fixture never meets the unmanaged pages.
      managed = await open();
      // The unmanaged write paths (the managed one has its own fixture below); a fresh Postgres brain starts managed.
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      __resetPrivateVisibilityCacheForTests();
    }, 180_000);

    afterAll(async () => {
      await close?.();
      await managed?.close();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });

    test('put_page on a repo-less source: a notice for each ignored label, without the git sentence, and none otherwise', async () => {
      for (const [name, fm, expected] of CASES) {
        for (const remote of [false, true]) {
          const slug = `notes/put-${name}-${remote ? 'remote' : 'local'}`;
          const result = await quiet(() => dispatchToolCall(engine, 'put_page', { slug, content: page(slug, fm) }, { remote, sourceId: 'default', transport: 'stdio' } as never));
          expect(result.isError ?? false).toBe(false);
          const blocks = noticeBlocks(result);
          expect({ name, remote, notices: blocks.length }).toEqual({ name, remote, notices: expected ? 1 : 0 });
          if (!expected) continue;
          const [key] = fm.split(':');
          expect(blocks[0]).toContain(`Page ${slug} has ${key}:`);
          expect(blocks[0]).toContain('every remote caller that can read the source can read it');
          expect(blocks[0]).toContain('add visibility: private');
          expect(blocks[0]).toContain('next: ask_user');
          expect(blocks[0]).not.toContain(GIT_SENTENCE);
          expect(blocks[0]).not.toContain('Planning notes');
        }
      }
    }, 180_000);

    // A Postgres brain refuses writes and classic sync to a checkout source with no canonical owner (unbound-source.ts), so these
    // two run on PGLite; the managed fixture below covers put_page and sync on a git source on both engines.
    test.if(kind === 'pglite')('put_page on a source with a git checkout says the label does not keep the page out of git', async () => {
      const root = tmp('put');
      git(root, 'init', '-q');
      await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('src-put', 'src-put', $1, '{}')", [root]);
      const result = await quiet(() => dispatchToolCall(engine, 'put_page', { slug: 'notes/alice-example-plan', content: page('notes/alice-example-plan', 'access: personal') },
        { remote: false, sourceId: 'src-put', transport: 'stdio' } as never));
      const [block] = noticeBlocks(result);
      expect(block).toContain('access: "personal"');
      expect(block).toContain(GIT_SENTENCE);
    }, 120_000);

    test('import: one aggregated notice per run with counts by value and no slugs; recognized and visibility-labelled pages count nothing', async () => {
      const dir = tmp('import');
      for (const [name, fm] of CASES) writeFileSync(join(dir, `imp-${name}.md`), page(`imp-${name}`, fm));
      writeFileSync(join(dir, 'imp-personal-2.md'), page('imp-personal-2', 'access: personal'));
      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('src-import', 'src-import', '{}')");
      const result = await quiet(() => runImport(engine, [dir, '--source', 'src-import', '--no-embed']));
      expect(result.imported).toBe(CASES.length + 1);
      const notice = result.privacy_label_notice;
      expect(notice?.code).toBe(CODE);
      expect(notice?.kind).toBe('safety');
      expect(notice!.why).toContain('4 page(s) written to source src-import during this import carry');
      expect(notice!.why).toContain('access: "personal" (2 pages)');
      expect(notice!.why).toContain('confidentiality: "health record (invented)" (1 page)');
      expect(notice!.why).toContain('access: "PRIVATE - share with alice-example only" (1 page)');
      expect(notice!.why).not.toContain('imp-');
      expect(notice!.why).not.toContain(GIT_SENTENCE);
      expect(notice!.fix?.ask_user).toBe(true);
    }, 180_000);

    test.if(kind === 'pglite')('sync: one notice per run on a git source, with the git sentence', async () => {
      const root = tmp('sync');
      git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.com'); git(root, 'config', 'user.name', 'test');
      mkdirSync(join(root, 'notes'), { recursive: true });
      for (const [name, fm] of CASES) writeFileSync(join(root, 'notes', `syn-${name}.md`), page(`notes/syn-${name}`, fm));
      git(root, 'add', '.'); git(root, 'commit', '-qm', 'seed');
      await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('src-sync', 'src-sync', $1, '{}')", [root]);
      const result = await quiet(() => performSync(engine, { sourceId: 'src-sync', repoPath: root, noPull: true, noEmbed: true, noExtract: true } as never));
      const notice = result.privacy_label_notice;
      expect(notice?.code).toBe(CODE);
      expect(notice!.why).toContain('3 page(s) written to source src-sync during this sync carry');
      expect(notice!.why).toContain('access: "personal" (1 page)');
      expect(notice!.why).toContain(GIT_SENTENCE);
      expect(notice!.why).not.toContain('syn-');

      writeFileSync(join(root, 'notes', 'syn-unlabelled.md'), page('notes/syn-unlabelled', 'access: therapy notes (invented)'));
      git(root, 'commit', '-qam', 'label');
      const incremental = await quiet(() => performSync(engine, { sourceId: 'src-sync', repoPath: root, noPull: true, noEmbed: true, noExtract: true } as never));
      expect(incremental.privacy_label_notice?.why).toContain('1 page(s) written to source src-sync during this sync carry');
      expect(incremental.privacy_label_notice?.why).toContain('access: "therapy notes (invented)" (1 page)');

      writeFileSync(join(root, 'notes', 'syn-recognized.md'), page('notes/syn-recognized', 'access: private\nstatus: final'));
      git(root, 'commit', '-qam', 'edit');
      const again = await quiet(() => performSync(engine, { sourceId: 'src-sync', repoPath: root, noPull: true, noEmbed: true, noExtract: true } as never));
      expect(again.privacy_label_notice).toBeUndefined();
    }, 180_000);

    test('doctor counts the pages by value: plainly private values warn, others are information, and the fix is a read-only listing', async () => {
      const [finding] = await runWaveChecks(engine, { ids: new Set([CODE]), sourceIds: ['src-import'] });
      expect(finding?.check.name).toBe(CODE);
      const check = finding!.check;
      expect(check.status).toBe('warn');
      const values = (check.details as { values: Array<{ key: string; value: string; pages: number; plainly_private: boolean }> }).values;
      expect(values).toContainEqual({ key: 'access', value: 'personal', pages: 2, plainly_private: true });
      expect(values).toContainEqual({ key: 'confidentiality', value: 'health record (invented)', pages: 1, plainly_private: true });
      expect(values.some(v => v.value === 'private' || v.value === 'secret')).toBe(false);
      expect(check.details?.pages).toBe(4);
      expect((check.fix as { argv: string[] }).argv).toEqual(['gbrain', 'list', '--where', 'access=personal', '--json']);

      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('src-info', 'src-info', '{}')");
      await quiet(() => dispatchToolCall(engine, 'put_page', { slug: 'notes/team-plan', content: page('notes/team-plan', 'access: team-only') }, { remote: false, sourceId: 'src-info', transport: 'stdio' } as never));
      const [info] = await runWaveChecks(engine, { ids: new Set([CODE]), sourceIds: ['src-info'] });
      expect(info!.check.status).toBe('ok');
      expect(info!.check.severity).toBe('info');
      expect(info!.check.message).toContain('access: "team-only" (1)');

      await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('src-clean', 'src-clean', '{}')");
      await quiet(() => dispatchToolCall(engine, 'put_page', { slug: 'notes/clean', content: page('notes/clean', 'access: private') }, { remote: false, sourceId: 'src-clean', transport: 'stdio' } as never));
      const [clean] = await runWaveChecks(engine, { ids: new Set([CODE]), sourceIds: ['src-clean'] });
      expect(clean!.check.status).toBe('ok');
      expect(clean!.check.severity).toBeUndefined();
    }, 120_000);

    test('a managed git source: put_page and sync each carry the notice with the git sentence', async () => {
      await withRefreshFixture(managed!.engine, async f => {
        const engine = managed!.engine;
        const put = await quiet(() => dispatchToolCall(engine, 'put_page', { slug: 'notes/managed-put', content: page('notes/managed-put', 'access: personal') },
          { remote: false, sourceId: f.alpha, transport: 'stdio' } as never));
        const [block] = noticeBlocks(put);
        expect(block).toContain('Page notes/managed-put has access: "personal"');
        expect(block).toContain(GIT_SENTENCE);
        await settleManagedGitEffects(engine, f.alpha);
        commitFile(f.root, 'alpha/notes/managed-sync.md', page('notes/managed-sync', 'confidentiality: health record (invented)'));
        const result = await quiet(() => performSync(engine, { sourceId: f.alpha, noPull: true, noEmbed: true } as never));
        expect(result.privacy_label_notice?.why).toContain(`1 page(s) written to source ${f.alpha} during this sync carry`);
        expect(result.privacy_label_notice?.why).toContain('confidentiality: "health record (invented)" (1 page)');
        expect(result.privacy_label_notice?.why).toContain(GIT_SENTENCE);
      });
    }, 240_000);

    test('nothing reads differently: an ignored label still reads world and still has no database-only placement', async () => {
      const read = async (slug: string) => (await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, sourceId: 'default', transport: 'stdio' } as never));
      expect((await read('notes/put-personal-local')).isError ?? false).toBe(false);
      expect((await read('notes/put-recognized-local')).isError).toBe(true);
      const personal = { type: 'note', frontmatter: { access: 'personal' } };
      expect(isPrivatePage(personal)).toBe(false);
      expect(isPrivacyDerivationPrivate(personal)).toBe(false);
      expect(isPrivacyDerivationPrivate({ type: 'note', frontmatter: { confidentiality: 'health record (invented)' } })).toBe(false);
      expect(isPrivacyDerivationPrivate({ type: 'note', frontmatter: { access: 'private' } })).toBe(true);
      const policy = { mirror: false, databaseOnlySource: false, dbOnly: () => false, ignored: new Set<string>() } as never;
      expect(declaredDatabaseOnly({ slug: 'notes/a', ...personal }, 'notes/a.md', policy)).toBeNull();
      expect(declaredDatabaseOnly({ slug: 'notes/b', type: 'note', frontmatter: { access: 'private' } }, 'notes/b.md', policy)).not.toBeNull();
    }, 120_000);
  });
}
