/**
 * D-1 (GBRA-131, #6982): the extract_facts fence step never replaces a page's
 * database body with an older or different checkout file.
 *
 * Protects: on an unmanaged brain, a page whose database body differs from its
 * canonical file keeps both copies. With `sync.write_through` off the database
 * is the copy of record, so the unfenced rows are fenced into the database
 * body (a coordinated database-only publication that records the prior body
 * in page_versions) and the file is not touched. With write-through on, a page
 * whose file and database body differ (a newer database-only edit, a newer
 * file edit sync has not imported, or an edit that lands while the step runs)
 * is held: its rows stay unfenced, the warning names the page with
 * `file_database_drift`, neither copy changes, and the other pages of the run
 * still fence. A page whose copies agree fences as before, and the body it
 * replaces is kept in page_versions.
 * Fails when: the step plans the fence on the file and mirrors the file into
 * `pages` without comparing (the pre-fix refreshPageBody path), which drops
 * the database-only edit with no page_versions row holding it.
 * Seams: an engine proxy whose first transaction lands a concurrent edit
 * (database or file) after the step compared the copies. PGLite always,
 * Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCycle } from '../../src/core/cycle.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, snapshotItems } from './harness.ts';

const ALICE = 'people/alice-example';
const BOB = 'people/bob-example';
const DB_EDIT = 'DB-ONLY-EDIT-MARKER: a paragraph written with write-through disabled.';
const FILE_EDIT = 'FILE-ONLY-EDIT-MARKER: a paragraph saved in the editor, not yet synced.';
const LATE_EDIT = 'CONCURRENT-EDIT-MARKER: written while the fence step ran.';

interface Brain {
  engine: BrainEngine;
  root: string;
  file(slug: string): string;
  body(slug: string): Promise<string>;
  /** A database-only edit (the put_page path with write-through off, or a SQL edit): appends a paragraph to the stored body. */
  dbEdit(slug: string, paragraph: string, engine?: BrainEngine): Promise<void>;
  rows(slug: string): Promise<Array<{ fact: string; row_num: number | null }>>;
  versionsHolding(slug: string, marker: string): Promise<number>;
  unfenced(slug: string, fact: string): Promise<void>;
  cycle(engine?: BrainEngine): Promise<{ status: string; warnings: string[] }>;
}

const personBody = (title: string) => `# ${title}\n\n${title} works at Acme Example.`;

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d1-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const path = (slug: string) => join(root, `${slug}.md`);
        for (const [slug, title] of [[ALICE, 'Alice Example'], [BOB, 'Bob Example']] as const) {
          const page = await engine.putPage(slug, { type: 'person', title, compiled_truth: personBody(title) });
          await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${slug}.md`, page.id]);
          const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
          mkdirSync(dirname(path(slug)), { recursive: true });
          writeFileSync(path(slug), serializePageToMarkdown(snapshot.page, snapshot.tags));
        }
        const b: Brain = {
          engine, root,
          file: slug => readFileSync(path(slug), 'utf8'),
          body: async slug => (await engine.executeRaw<{ compiled_truth: string }>(
            "SELECT compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1", [slug]))[0]!.compiled_truth,
          async dbEdit(slug, paragraph, on = engine) {
            const page = (await on.getPage(slug, { sourceId: 'default' }))!;
            await on.putPage(slug, { type: page.type, title: page.title, compiled_truth: `${page.compiled_truth.trimEnd()}\n\n${paragraph}\n`,
              timeline: page.timeline, frontmatter: page.frontmatter }, { sourceId: 'default' } as never);
          },
          rows: async slug => (await engine.executeRaw<{ fact: string; row_num: number | null }>(
            "SELECT fact, row_num FROM facts WHERE source_id = 'default' AND entity_slug = $1 AND expired_at IS NULL ORDER BY id", [slug]))
            .map(r => ({ fact: r.fact, row_num: r.row_num === null ? null : Number(r.row_num) })),
          versionsHolding: async (slug, marker) => Number((await engine.executeRaw<{ n: number }>(
            `SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id
              WHERE p.source_id = 'default' AND p.slug = $1 AND v.compiled_truth LIKE '%' || $2 || '%'`, [slug, marker]))[0]!.n),
          async unfenced(slug, fact) {
            await engine.executeRaw(
              `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
               VALUES ('default', $1, $2, 'fact', 'private', 'medium', '2026-02-05', 'mcp:remember', 0.9)`, [slug, fact]);
          },
          async cycle(on = engine) {
            const report = await runCycle(on, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] });
            const phase = report.phases.find(p => p.phase === 'extract_facts')!;
            return { status: phase.status, warnings: ((phase.details as { warnings?: string[] })?.warnings ?? []).map(String) };
          },
        };
        await run(b);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/**
 * The engine whose first transaction after the step prepared the fence write for `file` (its `.tmp` exists, or the
 * file already carries the fence) runs `before` first: a concurrent edit landing after the step compared the copies.
 */
function editsOnceFencePrepared(engine: BrainEngine, file: string, before: () => Promise<void>): BrainEngine {
  let fired = false;
  const prepared = () => existsSync(`${file}.tmp`) || fenceClaims(readFileSync(file, 'utf8')).length > 0;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'transaction') return async (...args: unknown[]) => {
        if (!fired && prepared()) { fired = true; await before(); }
        return (target.transaction as (...a: unknown[]) => unknown).apply(target, args);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** An engine whose transactions run `edit` once, right after the body mirror (refreshPageBody) inside the transaction. */
function editsOnceAfterMirror(engine: BrainEngine, edit: () => Promise<void>): BrainEngine {
  let fired = false;
  const wrapTx = (tx: BrainEngine): BrainEngine => new Proxy(tx, {
    get(target, prop) {
      if (prop === 'refreshPageBody') return async (...args: unknown[]) => {
        const result = await (target.refreshPageBody as (...a: unknown[]) => unknown).apply(target, args);
        if (!fired) { fired = true; await edit(); }
        return result;
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) =>
        (target.transaction as (f: (tx: BrainEngine) => Promise<unknown>) => Promise<unknown>).call(target, tx => fn(wrapTx(tx)));
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const fenceClaims = (text: string) => parseFactsFence(text).facts.map(f => f.claim);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-1 extract_facts fence step and a database body newer than the file (${backend})`, () => {
    test('D-1 db-newer, write-through off: the rows are fenced into the database body, the edit survives and the file is untouched', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('sync.write_through', 'false');
        _resetWriteThroughCacheForTest();
        await b.dbEdit(ALICE, DB_EDIT);
        await b.unfenced(ALICE, 'Alice Example moved to Lisbon');
        const fileBefore = b.file(ALICE);
        const phase = await expectUnitNotAborted(() => b.cycle());
        const body = await b.body(ALICE);
        expect({ edit: body.includes(DB_EDIT), fence: fenceClaims(body) }).toEqual({ edit: true, fence: ['Alice Example moved to Lisbon'] });
        expect({ file: b.file(ALICE) === fileBefore }).toEqual({ file: true });
        expect(await b.rows(ALICE)).toEqual([{ fact: 'Alice Example moved to Lisbon', row_num: 1 }]);
        expect(await b.versionsHolding(ALICE, DB_EDIT)).toBeGreaterThan(0);
        expect(phase.warnings.filter(w => w.includes(ALICE))).toEqual([]);
      });
    }, 180_000);

    test('D-1 db-newer, write-through on: the page is held with file_database_drift, both copies stay, the other page still fences', async () => {
      await withBrain(databaseUrl, async b => {
        await b.dbEdit(ALICE, DB_EDIT);
        await b.unfenced(ALICE, 'Alice Example moved to Lisbon');
        await b.unfenced(BOB, 'Bob Example moved to Porto');
        const fileBefore = b.file(ALICE);
        const bodyBefore = await b.body(ALICE);
        const before = await snapshotItems(b.engine, 'default');
        const phase = await expectUnitNotAborted(() => b.cycle());
        expect({ body: (await b.body(ALICE)) === bodyBefore, file: b.file(ALICE) === fileBefore }).toEqual({ body: true, file: true });
        expect(await b.rows(ALICE)).toEqual([{ fact: 'Alice Example moved to Lisbon', row_num: null }]);
        const held = phase.warnings.filter(w => w.includes(`FACTS_FENCE_FAILED: ${ALICE} (file_database_drift`));
        expect({ held: held.length, fix: held.some(w => w.includes('gbrain sync --source default')) }).toEqual({ held: 1, fix: true });
        expect(await b.rows(BOB)).toEqual([{ fact: 'Bob Example moved to Porto', row_num: 1 }]);
        expect(fenceClaims(b.file(BOB))).toEqual(['Bob Example moved to Porto']);
        expectOthersUnchanged(before, await snapshotItems(b.engine, 'default'), { expectProgress: [BOB], progressFields: ['updated_at'] });
      });
    }, 180_000);

    test('D-1 file-newer, write-through on: an unimported file edit holds the page and the database body is not replaced', async () => {
      await withBrain(databaseUrl, async b => {
        const edited = b.file(ALICE).replace('works at Acme Example.', `works at Acme Example.\n\n${FILE_EDIT}`);
        writeFileSync(join(b.root, `${ALICE}.md`), edited);
        await b.unfenced(ALICE, 'Alice Example moved to Lisbon');
        const bodyBefore = await b.body(ALICE);
        const phase = await expectUnitNotAborted(() => b.cycle());
        expect({ body: (await b.body(ALICE)) === bodyBefore, file: b.file(ALICE) === edited }).toEqual({ body: true, file: true });
        expect(await b.rows(ALICE)).toEqual([{ fact: 'Alice Example moved to Lisbon', row_num: null }]);
        expect(phase.warnings.filter(w => w.includes(`FACTS_FENCE_FAILED: ${ALICE} (file_database_drift`)).length).toBe(1);
      });
    }, 180_000);

    test('D-1 agreeing copies, write-through on: the fence lands in the file and the database, and the replaced body is kept in page_versions', async () => {
      await withBrain(databaseUrl, async b => {
        await b.unfenced(ALICE, 'Alice Example moved to Lisbon');
        const bodyBefore = await b.body(ALICE);
        const versionsBefore = await b.versionsHolding(ALICE, 'works at Acme Example');
        const phase = await expectUnitNotAborted(() => b.cycle());
        expect(phase.warnings.filter(w => w.includes(ALICE))).toEqual([]);
        expect({ file: fenceClaims(b.file(ALICE)), db: fenceClaims(await b.body(ALICE)) })
          .toEqual({ file: ['Alice Example moved to Lisbon'], db: ['Alice Example moved to Lisbon'] });
        expect((await b.body(ALICE)).startsWith(bodyBefore.trimEnd())).toBe(true);
        expect(await b.versionsHolding(ALICE, 'works at Acme Example')).toBe(versionsBefore + 1);
      });
    }, 180_000);

    test('D-1 concurrent database edit after the comparison: the edit survives, the file is untouched and the page is held', async () => {
      await withBrain(databaseUrl, async b => {
        await b.unfenced(ALICE, 'Alice Example moved to Lisbon');
        const fileBefore = b.file(ALICE);
        let landed = false;
        const racing = editsOnceFencePrepared(b.engine, join(b.root, `${ALICE}.md`), async () => { await b.dbEdit(ALICE, LATE_EDIT); landed = true; });
        const phase = await expectUnitNotAborted(() => b.cycle(racing));
        expect(landed).toBe(true);
        expect({ edit: (await b.body(ALICE)).includes(LATE_EDIT), file: b.file(ALICE) === fileBefore }).toEqual({ edit: true, file: true });
        expect(await b.rows(ALICE)).toEqual([{ fact: 'Alice Example moved to Lisbon', row_num: null }]);
        expect(phase.warnings.filter(w => w.includes(`FACTS_FENCE_FAILED: ${ALICE} (file_database_drift`)).length).toBe(1);
      });
    }, 180_000);

    test('D-1 concurrent file edit after the comparison: the editor\'s bytes survive and the database body is not replaced', async () => {
      await withBrain(databaseUrl, async b => {
        await b.unfenced(ALICE, 'Alice Example moved to Lisbon');
        const bodyBefore = await b.body(ALICE);
        let edited = '';
        const racing = editsOnceFencePrepared(b.engine, join(b.root, `${ALICE}.md`), async () => {
          edited = b.file(ALICE).replace('works at Acme Example.', `works at Acme Example.\n\n${LATE_EDIT}`);
          writeFileSync(join(b.root, `${ALICE}.md`), edited);
        });
        const phase = await expectUnitNotAborted(() => b.cycle(racing));
        expect(edited).toContain(LATE_EDIT);
        expect({ file: b.file(ALICE) === edited, body: (await b.body(ALICE)) === bodyBefore }).toEqual({ file: true, body: true });
        expect(await b.rows(ALICE)).toEqual([{ fact: 'Alice Example moved to Lisbon', row_num: null }]);
        expect(phase.warnings.filter(w => w.includes(`FACTS_FENCE_FAILED: ${ALICE} (file_database_drift`)).length).toBe(1);
      });
    }, 180_000);

    test('D-1 file edit inside the fence transaction, after the body mirror: the editor\'s bytes survive, the mirror and row stamps roll back', async () => {
      await withBrain(databaseUrl, async b => {
        await b.unfenced(ALICE, 'Alice Example moved to Lisbon');
        const bodyBefore = await b.body(ALICE);
        let edited = '';
        const racing = editsOnceAfterMirror(b.engine, async () => {
          edited = b.file(ALICE).replace('works at Acme Example.', `works at Acme Example.\n\n${LATE_EDIT}`);
          writeFileSync(join(b.root, `${ALICE}.md`), edited);
        });
        const phase = await expectUnitNotAborted(() => b.cycle(racing));
        expect(edited).toContain(LATE_EDIT);
        expect({ file: b.file(ALICE) === edited, body: (await b.body(ALICE)) === bodyBefore }).toEqual({ file: true, body: true });
        expect(await b.rows(ALICE)).toEqual([{ fact: 'Alice Example moved to Lisbon', row_num: null }]);
        expect(phase.warnings.filter(w => w.includes(`FACTS_FENCE_FAILED: ${ALICE} (file_database_drift`)).length).toBe(1);
      });
    }, 180_000);

    test('D-20 a declared storage.db_only page with no file, write-through on: its rows are fenced into the database body and no file is created', async () => {
      await withBrain(databaseUrl, async b => {
        writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - meetings/\n');
        const slug = 'meetings/2026-04-03-acme-example';
        await b.engine.putPage(slug, { type: 'meeting', title: 'Acme example sync', compiled_truth: '# Acme example sync\n\nNotes.' });
        await b.unfenced(slug, 'Acme example agreed to weekly reviews');
        const phase = await expectUnitNotAborted(() => b.cycle());
        expect(phase.warnings.filter(w => w.includes(slug))).toEqual([]);
        expect(await b.rows(slug)).toEqual([{ fact: 'Acme example agreed to weekly reviews', row_num: 1 }]);
        expect(fenceClaims(await b.body(slug))).toEqual(['Acme example agreed to weekly reviews']);
        expect(existsSync(join(b.root, `${slug}.md`))).toBe(false);
      });
    }, 180_000);
  });
}
