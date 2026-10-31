/**
 * #8073 (dream reverse-write): the dream reverse-write (`writeDreamPageFile`, `removeDreamPageFile`,
 * `reverseWriteDreamRefs`: synthesize, patterns, the cycle summary, generation repair) commits the files it writes into
 * a source that is a Git checkout, so the checkout never collects untracked or modified dream files.
 *
 * Protects: a reverse-write of several pages lands as one commit naming exactly their files; the cycle summary's file and
 * a retired dream page's file removal each commit; `git status` stays clean. A commit the checkout refuses (a
 * pre-commit hook here) rolls each file back (removed, or its prior bytes) and reports the page with a
 * `write_through_failed` hold. A checkout carrying a canonical owner marker commits through commit-push's
 * named-paths-only path. A declared `storage.db_only` directory gets no file and no commit; a repo-less source
 * (no local_path, no brain directory) gets no file; a directory that is not a Git checkout keeps its files.
 * Fails when: a reverse-write leaves its file uncommitted (the pre-fix path) or leaves a file behind after a refused
 * commit.
 * Seams: none; the dream outputs are imported pages, rendered as the database holds them (serializePageToMarkdown). PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDreamPageFile, reverseWriteDreamRefs, writeDreamPageFile } from '../../src/core/cycle/derived-write-through.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from '../pathological/harness.ts';

type Layout = 'git' | 'plain' | 'none';
const SOURCE = 'default';
const IDEA = 'wiki/originals/ideas/alice-example-idea';
const PLAN = 'wiki/originals/ideas/acme-example-plan';
const SUMMARY = 'dream-cycle-summaries/2026-09-07';

interface Brain {
  engine: BrainEngine;
  root: string;
  brainDir: string;
  git(...args: string[]): string;
  path(slug: string): string;
  reverseWrite(slugs: string[]): Promise<{ written: number; held: string[] }>;
}

const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n# ${title}\n\n${body}\n`;

async function withBrain(databaseUrl: string | undefined, layout: Layout, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-8073-dream-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (layout === 'git') {
          git('init', '-q');
          git('config', 'user.name', 'Example Writer');
          git('config', 'user.email', 'writer@example.invalid');
          writeFileSync(join(root, 'README.md'), '# source-a\n');
          git('add', 'README.md');
          git('commit', '-qm', 'init');
        }
        if (layout !== 'none') await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [root, SOURCE]);
        for (const [slug, title] of [[IDEA, 'Alice Example idea'], [PLAN, 'Acme Example plan'], [SUMMARY, 'Dream cycle summary']] as const) {
          await importFromContent(engine, slug, page(title, `${title} body.`), { noEmbed: true, sourceId: SOURCE });
        }
        const brainDir = layout === 'none' ? '' : root;
        await run({
          engine, root, brainDir, git,
          path: slug => join(root, `${slug}.md`),
          async reverseWrite(slugs) {
            const held: string[] = [];
            const written = await reverseWriteDreamRefs(engine, brainDir, slugs.map(slug => ({ slug, source_id: SOURCE })),
              { phase: 'synthesize', nativeSourceId: SOURCE, render: (p, tags) => serializePageToMarkdown(p, tags), held });
            return { written, held };
          },
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const commitCount = (b: Brain) => Number(b.git('rev-list', '--count', 'HEAD'));
const lastCommitPaths = (b: Brain) => b.git('show', '--no-renames', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
const dirty = (b: Brain) => b.git('status', '--porcelain', '--untracked-files=all');
const filesUnder = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);
const failedHolds = (held: string[], slug: string) => held.filter(h => h.startsWith(`${slug} (write_through_failed`));

function refuseCommits(b: Brain): void {
  const hook = join(b.root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "refused by policy" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`#8073 dream reverse-write commits its files (${backend})`, () => {
    test('a reverse-write of several pages lands as one commit naming exactly their files, and the checkout stays clean', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        const before = commitCount(b);
        const result = await b.reverseWrite([IDEA, PLAN]);
        expect({ written: result.written, held: result.held, dirty: dirty(b) }).toEqual({ written: 2, held: [], dirty: '' });
        expect({ commits: commitCount(b) - before, paths: lastCommitPaths(b) }).toEqual({ commits: 1, paths: [`${PLAN}.md`, `${IDEA}.md`].sort() });
      });
    }, 180_000);

    test('the cycle summary file write commits, and a retired dream page\'s file removal commits', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        const summary = await writeDreamPageFile(b.engine, b.brainDir, SUMMARY, SOURCE, { nativeSourceId: SOURCE, markdown: serializePageToMarkdown((await b.engine.getPage(SUMMARY, { sourceId: SOURCE }))!, []) });
        expect({ written: summary.written, paths: lastCommitPaths(b), dirty: dirty(b) }).toEqual({ written: true, paths: [`${SUMMARY}.md`], dirty: '' });
        await b.reverseWrite([IDEA]);
        const before = commitCount(b);
        const removed = await removeDreamPageFile(b.engine, b.brainDir, IDEA, SOURCE, SOURCE);
        expect({ removed: removed.removed, file: existsSync(b.path(IDEA)), dirty: dirty(b), commits: commitCount(b) - before, tracked: b.git('ls-files', '--', `${IDEA}.md`) })
          .toEqual({ removed: true, file: false, dirty: '', commits: 1, tracked: '' });
      });
    }, 180_000);

    test('a refused commit rolls every file back and holds each page with write_through_failed', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        await b.reverseWrite([PLAN]);
        const planBefore = readFileSync(b.path(PLAN), 'utf8');
        await importFromContent(b.engine, PLAN, page('Acme Example plan', 'Acme Example plan body, revised by the dream.'), { noEmbed: true, sourceId: SOURCE });
        refuseCommits(b);
        const head = b.git('rev-parse', 'HEAD');
        const result = await b.reverseWrite([IDEA, PLAN]);
        expect({ written: result.written, idea: failedHolds(result.held, IDEA).length, plan: failedHolds(result.held, PLAN).length })
          .toEqual({ written: 0, idea: 1, plan: 1 });
        expect({ head: b.git('rev-parse', 'HEAD'), dirty: dirty(b), idea: existsSync(b.path(IDEA)), plan: readFileSync(b.path(PLAN), 'utf8') === planBefore })
          .toEqual({ head, dirty: '', idea: false, plan: true });
        const summary = await writeDreamPageFile(b.engine, b.brainDir, SUMMARY, SOURCE, { nativeSourceId: SOURCE, markdown: 'summary' });
        expect({ written: summary.written, held: failedHolds(!summary.written && summary.held ? [summary.held] : [], SUMMARY).length, file: existsSync(b.path(SUMMARY)), dirty: dirty(b) })
          .toEqual({ written: false, held: 1, file: false, dirty: '' });
      });
    }, 180_000);

    test('a checkout carrying a canonical owner marker commits through the named-paths-only path', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        appendFileSync(join(b.root, '.git', 'info', 'exclude'), '.gbrain-owner.json\n');
        writeFileSync(join(b.root, '.gbrain-owner.json'), '{}\n');
        const before = commitCount(b);
        const result = await b.reverseWrite([IDEA]);
        expect({ written: result.written, held: result.held, dirty: dirty(b), commits: commitCount(b) - before, paths: lastCommitPaths(b) })
          .toEqual({ written: 1, held: [], dirty: '', commits: 1, paths: [`${IDEA}.md`] });
      });
    }, 180_000);

    test('storage.db_only: no file and no commit', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - wiki/originals\n');
        b.git('add', 'gbrain.yml');
        b.git('commit', '-qm', 'storage tiers');
        const head = b.git('rev-parse', 'HEAD');
        const result = await b.reverseWrite([IDEA]);
        expect({ written: result.written, head: b.git('rev-parse', 'HEAD'), dirty: dirty(b), file: existsSync(b.path(IDEA)) })
          .toEqual({ written: 0, head, dirty: '', file: false });
      });
    }, 180_000);

    test('repo-less source (no local_path, no brain directory): no file anywhere, the database stays the record', async () => {
      await withBrain(databaseUrl, 'none', async b => {
        const result = await b.reverseWrite([IDEA, PLAN]);
        expect({ written: result.written, held: result.held, files: filesUnder(b.root), page: (await b.engine.getPage(IDEA, { sourceId: SOURCE }))?.slug })
          .toEqual({ written: 0, held: [], files: [], page: IDEA });
      });
    }, 180_000);

    test('a local_path that is not a Git checkout keeps its files (there is no commit to make)', async () => {
      await withBrain(databaseUrl, 'plain', async b => {
        const result = await b.reverseWrite([IDEA]);
        expect({ written: result.written, held: result.held, file: existsSync(b.path(IDEA)) }).toEqual({ written: 1, held: [], file: true });
      });
    }, 180_000);
  });
}
