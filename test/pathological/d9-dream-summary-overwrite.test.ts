/**
 * D-9 (GBRA-131, #6982): a repeat synthesize run on the same date never
 * replaces the dream summary page's database body or file without a trace.
 *
 * Protects: `writeSummaryPage` keeps the summary body it replaces in
 * page_versions (the raw putPage it uses keeps none), writes the summary file
 * only when the file holds nothing the database lacks (it equals the live page
 * or one of its page_versions rows) and returns the `file_database_drift` entry
 * otherwise, binds the write to the bytes it compared, and writes no file with
 * `sync.write_through` off.
 * Fails when: the summary is replaced with putPage and writeFileSync with no
 * comparison and no page_versions row (the pre-fix path), which drops a
 * database-only edit and an unimported file edit.
 * Seams: an engine proxy that edits the file once the write has read the page
 * history it compares against. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __testing } from '../../src/core/cycle/synthesize.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const SOURCE = 'default';
const SUMMARY = 'dream-cycle-summaries/2026-10-18';
const DATE = '2026-10-18';
const FIRST = ['wiki/originals/ideas/alice-example-first'];
const SECOND = ['wiki/originals/ideas/alice-example-first', 'wiki/originals/ideas/acme-example-second'];
const DB_EDIT = 'DB-ONLY-EDIT-MARKER: a note added to the summary with write-through disabled.';
const FILE_EDIT = 'FILE-ONLY-EDIT-MARKER: a note saved in the editor, not yet synced.';
const LATE_EDIT = 'CONCURRENT-EDIT-MARKER: written while the summary was written.';

type SummaryWriter = (engine: BrainEngine, brainDir: string, slug: string, date: string, written: string[],
  children: Array<{ jobId: number; status: string }>, sourceId?: string) => Promise<string | undefined>;
const writeSummaryPage = (__testing as unknown as { writeSummaryPage: SummaryWriter }).writeSummaryPage;

interface Brain {
  engine: BrainEngine;
  path: string;
  file(): string;
  body(): Promise<string>;
  versionsHolding(marker: string): Promise<number>;
  run(slugs: string[], engine?: BrainEngine): Promise<string | undefined>;
}

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d9-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const path = join(root, `${SUMMARY}.md`);
        const b: Brain = {
          engine, path,
          file: () => readFileSync(path, 'utf8'),
          body: async () => (await engine.executeRaw<{ compiled_truth: string }>(
            'SELECT compiled_truth FROM pages WHERE source_id = $1 AND slug = $2', [SOURCE, SUMMARY]))[0]!.compiled_truth,
          versionsHolding: async marker => Number((await engine.executeRaw<{ n: number }>(
            `SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id
              WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth LIKE '%' || $3 || '%'`, [SOURCE, SUMMARY, marker]))[0]!.n),
          run: (slugs, on = engine) => writeSummaryPage(on, root, SUMMARY, DATE, slugs, [{ jobId: 1, status: 'completed' }], SOURCE),
        };
        await run(b);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** The engine that runs `after` once the summary write has read the page history it compares the file with. */
function editsAfterComparison(engine: BrainEngine, after: () => void): BrainEngine {
  let fired = false;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') return async (sql: string, ...rest: unknown[]) => {
        const rows = await (target.executeRaw as (...a: unknown[]) => Promise<unknown>).call(target, sql, ...rest);
        if (!fired && /UNION ALL[\s\S]*page_versions/.test(sql)) { fired = true; after(); }
        return rows;
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const drift = (held: string | undefined) => held?.startsWith(`${SUMMARY} (file_database_drift`) === true;

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-9 dream summary rewritten by a repeat run on the same date (${backend})`, () => {
    test('D-9 file-newer: an unimported summary file edit is kept and reported; the replaced database body is kept in page_versions', async () => {
      await withBrain(databaseUrl, async b => {
        await b.run(FIRST);
        const edited = b.file().replace('**Pages written:** 1.', `**Pages written:** 1.\n\n${FILE_EDIT}`);
        writeFileSync(b.path, edited);
        const held = await expectUnitNotAborted(() => b.run(SECOND));
        expect({ drift: drift(held), fix: held?.includes('gbrain sync --source default') }).toEqual({ drift: true, fix: true });
        expect({ file: b.file() === edited, body: (await b.body()).includes('acme-example-second') }).toEqual({ file: true, body: true });
        expect(await b.versionsHolding('**Pages written:** 1.')).toBeGreaterThan(0);
      });
    }, 180_000);

    test('D-9 db-newer: a database-only summary edit is kept in page_versions, and the file it never reached is not replaced blind', async () => {
      await withBrain(databaseUrl, async b => {
        await b.run(FIRST);
        const fileBefore = b.file();
        const page = (await b.engine.getPage(SUMMARY, { sourceId: SOURCE }))!;
        await b.engine.putPage(SUMMARY, { type: page.type, title: page.title, compiled_truth: `${page.compiled_truth}\n\n${DB_EDIT}\n`,
          timeline: page.timeline, frontmatter: page.frontmatter }, { sourceId: SOURCE });
        const held = await expectUnitNotAborted(() => b.run(SECOND));
        expect(await b.versionsHolding(DB_EDIT)).toBeGreaterThan(0);
        expect({ drift: drift(held), file: b.file() === fileBefore }).toEqual({ drift: true, file: true });
      });
    }, 180_000);

    test('D-9 write-through off: the database row is replaced (prior body versioned) and the file is not written', async () => {
      await withBrain(databaseUrl, async b => {
        await b.run(FIRST);
        const fileBefore = b.file();
        await b.engine.setConfig('sync.write_through', 'false');
        _resetWriteThroughCacheForTest();
        const held = await expectUnitNotAborted(() => b.run(SECOND));
        expect({ held, file: b.file() === fileBefore, body: (await b.body()).includes('acme-example-second') }).toEqual({ held: undefined, file: true, body: true });
        expect(await b.versionsHolding('**Pages written:** 1.')).toBeGreaterThan(0);
      });
    }, 180_000);

    test('D-9 concurrent file edit after the comparison: the editor\'s bytes survive and the summary file is reported', async () => {
      await withBrain(databaseUrl, async b => {
        await b.run(FIRST);
        const edited = `${b.file()}\n${LATE_EDIT}\n`;
        const held = await expectUnitNotAborted(() => b.run(SECOND, editsAfterComparison(b.engine, () => writeFileSync(b.path, edited))));
        expect({ drift: drift(held), file: b.file() === edited }).toEqual({ drift: true, file: true });
      });
    }, 180_000);

    test('D-9 control, agreeing copies: the repeat run rewrites the file and keeps the replaced body in page_versions', async () => {
      await withBrain(databaseUrl, async b => {
        await b.run(FIRST);
        const versionsBefore = await b.versionsHolding('**Pages written:** 1.');
        const held = await expectUnitNotAborted(() => b.run(SECOND));
        expect({ held, file: b.file().includes('acme-example-second') }).toEqual({ held: undefined, file: true });
        expect(await b.versionsHolding('**Pages written:** 1.')).toBe(versionsBefore + 1);
      });
    }, 180_000);
  });
}
