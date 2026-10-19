/**
 * D-15 / A-55 (GBRA-131, #6982): full sync only restores absent checkout files.
 * Protects: ignored or untracked file bytes survive re-export, whether the
 * database or file is newer; one failed restore is reported without stopping
 * healthy siblings, while a run-scoped failure still stops the run.
 * Fails when: re-export omits expectedFileBytes or ignores failed results.
 * Existing coverage restores an absent file, never an ignored edited one.
 * Seams: a real full sync and an engine proxy that edits after rendering starts
 * or fails one read. No production-only seam. PGLite always, Postgres with URL.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performFullSync } from '../../src/commands/sync/full.ts';
import { withHumanLineSink } from '../../src/core/console-prefix.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { gitExec } from '../helpers/git-exec.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { segmentPage } from '../helpers/segmented-chunks-fixture.ts';
import { segmentedPageState } from '../helpers/segmented-page.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const ALICE = 'memories/alice-example';
const BOB = 'memories/bob-example';

async function withBrain(databaseUrl: string | undefined, run: (b: {
  engine: BrainEngine; root: string; file(slug: string): string;
  body(slug: string): Promise<string>; rendered(slug: string): Promise<string>;
  sync(on?: BrainEngine): Promise<string[]>;
}) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d15-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'brain');
        mkdirSync(join(root, 'memories'), { recursive: true });
        gitExec('git init', root);
        gitExec('git config user.email test@example.invalid && git config user.name "Test Fixture"', root);
        writeFileSync(join(root, '.gitignore'), 'memories/\n');
        gitExec('git add .gitignore && git commit -m fixture', root);
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await engine.setConfig('sync.repo_path', root);
        for (const slug of [ALICE, BOB]) {
          const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nOriginal synthetic note.` });
          await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${slug}.md`, page.id]);
        }
        await run({
          engine, root, file: slug => join(root, `${slug}.md`),
          body: async slug => (await engine.executeRaw<{ compiled_truth: string }>(
            "SELECT compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1", [slug]))[0]!.compiled_truth,
          rendered: async slug => {
            const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
            return serializePageToMarkdown(snapshot.page, snapshot.tags);
          },
          async sync(on = engine) {
            const lines: string[] = [];
            await withHumanLineSink(line => lines.push(line), () => performFullSync(on,
              { gitContextRoot: root, syncScopeRoot: root, anchorPath: root, slugRootMode: 'source-root' },
              gitExec('git rev-parse HEAD', root).trim(), { sourceId: 'default', noEmbed: true, noPull: true }));
            return lines;
          },
        });
      } finally { await close(); }
    });
  } finally { _resetWriteThroughCacheForTest(); rmSync(home, { recursive: true, force: true }); }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-15 full-sync DB-only file restore (${backend})`, () => {
    for (const newer of ['database', 'file', 'neither'] as const) {
      test(`D-15 ${newer} newer: an existing ignored file is held and an absent sibling is restored`, async () => {
        await withBrain(databaseUrl, async b => {
          const original = await b.rendered(ALICE);
          if (newer === 'database') await b.engine.putPage(ALICE, { type: 'note', title: ALICE, compiled_truth: '# Database-only newer edit\n\nPreserve this body.' });
          const file = newer === 'file' ? `${original}\nUnimported file-only edit.\n` : original;
          writeFileSync(b.file(ALICE), file);
          const body = await b.body(ALICE);
          const sibling = await b.rendered(BOB);
          const lines = await expectUnitNotAborted(() => b.sync());
          expect({ file: readFileSync(b.file(ALICE), 'utf8'), body: await b.body(ALICE) }).toEqual({ file, body });
          expect(readFileSync(b.file(BOB), 'utf8')).toBe(sibling);
          expect(lines.some(line => line.includes(ALICE) && line.includes('file_database_drift') && line.includes('gbrain sync --source default'))).toBe(true);
          expect(lines.some(line => line.includes('1 re-export failure'))).toBe(true);
        });
      }, 180_000);
    }

    test('D-15 write-through off: database-only pages never materialize files', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('sync.write_through', 'false');
        _resetWriteThroughCacheForTest();
        const edit = '# Unsynced file-only edit\n';
        writeFileSync(b.file(ALICE), edit);
        const bodies = [await b.body(ALICE), await b.body(BOB)];
        await expectUnitNotAborted(() => b.sync());
        expect([await b.body(ALICE), await b.body(BOB)]).toEqual(bodies);
        expect(readFileSync(b.file(ALICE), 'utf8')).toBe(edit);
        expect(existsSync(b.file(BOB))).toBe(false);
      });
    }, 180_000);

    test('D-15 segmented pages are held without mutation while inline siblings restore', async () => {
      await withBrain(databaseUrl, async b => {
        const fixture = await segmentPage(b.engine, ALICE, { generation: 1,
          occurrences: [{ id: 1, byteStart: 0, genFrom: 1, chunks: [{ text: 'Synthetic segmented body.' }] }] });
        const before = await segmentedPageState(b.engine, fixture.pageId);
        const lines = await expectUnitNotAborted(() => b.sync());
        expect(await segmentedPageState(b.engine, fixture.pageId)).toEqual(before);
        expect(existsSync(b.file(ALICE))).toBe(false);
        expect(readFileSync(b.file(BOB), 'utf8')).toBe(await b.rendered(BOB));
        expect(lines.some(line => line.includes(ALICE) && line.includes('page_body_segmented'))).toBe(true);
      });
    }, 180_000);

    test('D-15 an editor creates the destination after enumeration: exact bytes survive', async () => {
      await withBrain(databaseUrl, async b => {
        const body = await b.body(ALICE);
        const edit = '# Concurrent file-only edit\n\nPreserve these exact bytes.\n';
        let landed = false;
        const racing = new Proxy(b.engine, {
          get(target, prop) {
            if (prop === 'getTags') return async (...args: Parameters<BrainEngine['getTags']>) => {
              if (args[0] === ALICE && !landed) { landed = true; writeFileSync(b.file(ALICE), edit); }
              return target.getTags(...args);
            };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const lines = await expectUnitNotAborted(() => b.sync(racing));
        expect(landed).toBe(true);
        expect({ file: readFileSync(b.file(ALICE), 'utf8'), body: await b.body(ALICE) }).toEqual({ file: edit, body });
        expect(lines.some(line => line.includes(ALICE) && line.includes('file_database_drift'))).toBe(true);
        expect(existsSync(b.file(BOB))).toBe(true);
      });
    }, 180_000);

    test('A-55 one failed render is counted and named, and the next page still re-exports', async () => {
      await withBrain(databaseUrl, async b => {
        const body = await b.body(ALICE);
        const sibling = await b.rendered(BOB);
        const failing = new Proxy(b.engine, {
          get(target, prop) {
            if (prop === 'getPage') return async (...args: Parameters<BrainEngine['getPage']>) => {
              if (args[0] === ALICE) throw new Error('Synthetic page render failure');
              return target.getPage(...args);
            };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const lines = await expectUnitNotAborted(() => b.sync(failing));
        expect({ body: await b.body(ALICE), file: existsSync(b.file(ALICE)) }).toEqual({ body, file: false });
        expect(readFileSync(b.file(BOB), 'utf8')).toBe(sibling);
        expect(lines.some(line => line.includes(ALICE) && line.includes('internal') && line.includes('gbrain sync --source default'))).toBe(true);
        expect(lines.some(line => line.includes('1 re-export failure'))).toBe(true);
      });
    }, 180_000);

    test('D-15 a run-scoped connection failure is not silently treated as a failed item', async () => {
      await withBrain(databaseUrl, async b => {
        const failing = new Proxy(b.engine, {
          get(target, prop) {
            if (prop === 'getPage') return async () => { throw new Error('Connection terminated unexpectedly'); };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const before = await b.body(ALICE);
        await expect(b.sync(failing)).rejects.toThrow('Connection terminated unexpectedly');
        expect({ body: await b.body(ALICE), file: existsSync(b.file(ALICE)), sibling: existsSync(b.file(BOB)) })
          .toEqual({ body: before, file: false, sibling: false });
      });
    }, 180_000);
  });
}
