/**
 * D-14 (GBRA-131, #6982): `brainstorm --save` / `lsd --save` (and a
 * `--resume` that reuses the slug) never overwrites a saved idea's file that
 * holds content the database lacks.
 *
 * Protects: `persistSavedIdea` checks the page's file before it imports
 * anything. A hand edit to a saved idea's file that sync has not imported,
 * or an unindexed file at a new idea's path, refuses the save: neither copy
 * changes, no page is created, and the message names the page with
 * `file_database_drift` and the sync fix (exit 1, nothing persisted). A file
 * edit landing after the check is kept (the file write is bound to the bytes
 * checked) and the message says so. Re-saving over an unedited file, or over
 * a file the database has since replaced (its prior body kept in
 * page_versions), writes both copies.
 * Fails when: the save imports and calls writePageThrough with no check (the
 * pre-fix path), overwriting the user's edit.
 * The content carries `source_kind` in its frontmatter as the CLI writes it.
 * Seams: an engine proxy whose first transaction (the import's) lands the
 * concurrent edit. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatSaveOutcome, persistSavedIdea } from '../../src/commands/brainstorm.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const SLUG = 'wiki/ideas/2026-10-18-lsd-why-acme-example-nonce01';
const FILE_EDIT = 'FILE-ONLY-EDIT-MARKER: notes added in the editor, not yet synced.';
const LATE_EDIT = 'CONCURRENT-EDIT-MARKER: saved while the idea was being saved.';
const idea = (text: string) => serializeMarkdown({ mode: 'lsd', question: 'why acme-example', source_kind: 'lsd' }, `# LSD: why acme-example\n\n${text}`, '',
  { type: 'note', title: 'LSD: why acme-example', tags: [] });

interface Brain {
  engine: BrainEngine;
  path: string;
  file(): string;
  body(): Promise<string | null>;
  save(text: string, on?: BrainEngine): ReturnType<typeof persistSavedIdea>;
  versionsHolding(marker: string): Promise<number>;
}

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d14-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const path = join(root, `${SLUG}.md`);
        await run({
          engine, path,
          file: () => readFileSync(path, 'utf8'),
          body: async () => (await engine.executeRaw<{ compiled_truth: string }>(
            "SELECT compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1", [SLUG]))[0]?.compiled_truth ?? null,
          save: (text, on = engine) => persistSavedIdea(on, { slug: SLUG, content: idea(text), provenanceVia: 'lsd' }),
          versionsHolding: async marker => Number((await engine.executeRaw<{ n: number }>(
            `SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id
              WHERE p.source_id = 'default' AND p.slug = $1 AND v.compiled_truth LIKE '%' || $2 || '%'`, [SLUG, marker]))[0]!.n),
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** The engine whose first transaction (the import's) runs `before` first. */
function editsAtFirstTransaction(engine: BrainEngine, before: () => void): { engine: BrainEngine; fired(): boolean } {
  let fired = false;
  const proxy = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'transaction') return async (...args: unknown[]) => {
        if (!fired) { fired = true; before(); }
        return (target.transaction as (...a: unknown[]) => unknown).apply(target, args);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine: proxy, fired: () => fired };
}

const refusedForDrift = (outcome: Awaited<ReturnType<typeof persistSavedIdea>>) => {
  const message = formatSaveOutcome(outcome, { profileLabel: 'lsd', slug: SLUG });
  return { exit: message.exitCode, named: message.stderr.some(l => l.includes(`${SLUG} (file_database_drift`) && l.includes('gbrain sync --source default')) };
};

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-14 brainstorm save and a file the database does not hold (${backend})`, () => {
    test('D-14 file-newer (resume after a hand edit): the save is refused and both copies stay', async () => {
      await withBrain(databaseUrl, async b => {
        expect((await b.save('First run ideas.')).writeThrough.written).toBe(true);
        const edited = b.file().replace('First run ideas.', `First run ideas.\n\n${FILE_EDIT}`);
        writeFileSync(b.path, edited);
        const bodyBefore = await b.body();
        const outcome = await expectUnitNotAborted(() => b.save('Resumed run ideas.'));
        expect({ file: b.file() === edited, body: (await b.body()) === bodyBefore, saved: outcome.dbSaved, ...refusedForDrift(outcome) })
          .toEqual({ file: true, body: true, saved: false, exit: 1, named: true });
      });
    }, 180_000);

    test('D-14 unindexed file at a new idea\'s path: the save is refused, the file keeps its bytes and no page is created', async () => {
      await withBrain(databaseUrl, async b => {
        mkdirSync(dirname(b.path), { recursive: true });
        const unindexed = '# Notes by alice-example\n\nNever imported.\n';
        writeFileSync(b.path, unindexed);
        const outcome = await expectUnitNotAborted(() => b.save('First run ideas.'));
        expect({ file: b.file() === unindexed, body: await b.body(), ...refusedForDrift(outcome) }).toEqual({ file: true, body: null, exit: 1, named: true });
      });
    }, 180_000);

    test('D-14 concurrent file edit after the check: the editor\'s bytes survive and the message says the file was kept', async () => {
      await withBrain(databaseUrl, async b => {
        await b.save('First run ideas.');
        let edited = '';
        const racing = editsAtFirstTransaction(b.engine, () => {
          edited = b.file().replace('First run ideas.', `First run ideas.\n\n${LATE_EDIT}`);
          writeFileSync(b.path, edited);
        });
        const outcome = await expectUnitNotAborted(() => b.save('Resumed run ideas.', racing.engine));
        const message = formatSaveOutcome(outcome, { profileLabel: 'lsd', slug: SLUG });
        expect({ fired: racing.fired(), file: b.file() === edited, late: edited.includes(LATE_EDIT), db: (await b.body())?.includes('Resumed run ideas.'),
          skipped: outcome.writeThrough.skipped, said: message.stdout?.includes('file_changed') })
          .toEqual({ fired: true, file: true, late: true, db: true, skipped: 'file_changed', said: true });
      });
    }, 180_000);

    test('D-14 db-newer: a file holding the database\'s previous body is rewritten, and the replaced database body is versioned', async () => {
      await withBrain(databaseUrl, async b => {
        await b.save('First run ideas.');
        const current = b.file();
        await importFromContent(b.engine, SLUG, current.replace('First run ideas.', 'First run ideas.\n\nDB-NEWER-MARKER: edited in the database.'), { noEmbed: true });
        const outcome = await expectUnitNotAborted(() => b.save('Resumed run ideas.'));
        expect({ written: outcome.writeThrough.written, file: b.file().includes('Resumed run ideas.'), db: (await b.body())?.includes('Resumed run ideas.') })
          .toEqual({ written: true, file: true, db: true });
        expect(await b.versionsHolding('DB-NEWER-MARKER')).toBeGreaterThan(0);
      });
    }, 180_000);

    test('D-14 control: re-saving over an unedited file writes both copies', async () => {
      await withBrain(databaseUrl, async b => {
        await b.save('First run ideas.');
        const outcome = await expectUnitNotAborted(() => b.save('Resumed run ideas.'));
        expect({ written: outcome.writeThrough.written, file: b.file().includes('Resumed run ideas.'), db: (await b.body())?.includes('Resumed run ideas.'),
          exit: formatSaveOutcome(outcome, { profileLabel: 'lsd', slug: SLUG }).exitCode })
          .toEqual({ written: true, file: true, db: true, exit: 0 });
      });
    }, 180_000);
  });
}
