/**
 * D-5 (GBRA-131, #6982): the phantom redirect never mirrors the canonical
 * page's file over a differing database body.
 *
 * Protects: on an unmanaged brain, redirecting a phantom (`alice`) into its
 * canonical page (`people/alice-example`) keeps both copies of the canonical.
 * With `sync.write_through` on, a canonical whose file and database body
 * differ (a newer database-only edit, a newer file edit sync has not
 * imported, or an edit that lands while the redirect runs) holds the phantom:
 * the pass reports `file_database_drift` naming the canonical with its fix,
 * neither copy changes and the phantom stays live. With write-through off the
 * database is the copy of record: the phantom's rows merge into the
 * canonical's database body (the prior body kept in page_versions) and no file
 * is written. A canonical whose copies agree takes the rows in both copies and
 * the body it replaces is kept in page_versions.
 * Fails when: the redirect appends to the canonical file and mirrors the whole
 * file over the database body without comparing (the pre-fix refreshPageBody
 * path), which drops the database-only edit with no page_versions row; or when
 * the file is compared only before the transaction's database work, so a save
 * inside it is renamed over.
 * Seams: an engine proxy whose first transaction after the redirect prepared
 * the canonical write lands a concurrent edit (database or file), and one that
 * saves the canonical file from inside that transaction, after the redirect's
 * row lock and page_versions read. PGLite always, Postgres when DATABASE_URL
 * is set.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runPhantomRedirectPass, type PhantomPassResult } from '../../src/core/cycle/phantom-redirect.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const SOURCE = 'default';
const CANONICAL = 'people/alice-example';
const PHANTOM = 'alice';
const CLAIM = 'Founded acme-example';
const DB_EDIT = 'DB-ONLY-EDIT-MARKER: a paragraph written with write-through disabled.';
const FILE_EDIT = 'FILE-ONLY-EDIT-MARKER: a paragraph saved in the editor, not yet synced.';
const LATE_EDIT = 'CONCURRENT-EDIT-MARKER: written while the redirect ran.';
const CANONICAL_BODY = '# Alice Example\n\nAlice Example works at acme-example.\n';
const PHANTOM_BODY = `# alice\n\n## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${CLAIM} | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |
<!--- gbrain:facts:end -->
`;

interface Brain {
  engine: BrainEngine;
  root: string;
  path(slug: string): string;
  file(slug: string): string;
  body(slug: string): Promise<string>;
  live(slug: string): Promise<boolean>;
  dbEdit(slug: string, paragraph: string): Promise<void>;
  versionsHolding(slug: string, marker: string): Promise<number>;
  pass(engine?: BrainEngine): Promise<PhantomPassResult>;
}

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d5-'));
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: join(home, 'audit'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const path = (slug: string) => join(root, `${slug}.md`);
        for (const [slug, title, body] of [[CANONICAL, 'Alice Example', CANONICAL_BODY], [PHANTOM, 'alice', PHANTOM_BODY]] as const) {
          const page = await engine.putPage(slug, { type: 'person', title, compiled_truth: body, timeline: '', frontmatter: {} });
          await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${slug}.md`, page.id]);
          mkdirSync(dirname(path(slug)), { recursive: true });
          writeFileSync(path(slug), body);
        }
        const b: Brain = {
          engine, root, path,
          file: slug => readFileSync(path(slug), 'utf8'),
          body: async slug => (await engine.executeRaw<{ compiled_truth: string }>(
            'SELECT compiled_truth FROM pages WHERE source_id = $1 AND slug = $2', [SOURCE, slug]))[0]!.compiled_truth,
          live: async slug => (await engine.executeRaw<{ live: boolean }>(
            'SELECT deleted_at IS NULL AS live FROM pages WHERE source_id = $1 AND slug = $2', [SOURCE, slug]))[0]?.live === true,
          async dbEdit(slug, paragraph) {
            const page = (await engine.getPage(slug, { sourceId: SOURCE }))!;
            await engine.putPage(slug, { type: page.type, title: page.title, compiled_truth: `${page.compiled_truth.trimEnd()}\n\n${paragraph}\n`,
              timeline: page.timeline, frontmatter: page.frontmatter }, { sourceId: SOURCE });
          },
          versionsHolding: async (slug, marker) => Number((await engine.executeRaw<{ n: number }>(
            `SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id
              WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth LIKE '%' || $3 || '%'`, [SOURCE, slug, marker]))[0]!.n),
          pass: (on = engine) => runPhantomRedirectPass(on, root, SOURCE, false),
        };
        await run(b);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const claims = (text: string) => parseFactsFence(text).facts.map(f => f.claim);
const heldFor = (result: PhantomPassResult, slug: string) => result.held.filter(h => h.startsWith(`${slug} (file_database_drift`));

/**
 * The engine whose first transaction after the redirect prepared the canonical write (its `.tmp` exists, or the file
 * already carries the phantom's row) runs `before` first: a concurrent edit landing after the redirect compared.
 */
function editsOnceCanonicalPrepared(engine: BrainEngine, file: string, before: () => Promise<void>): BrainEngine {
  let fired = false;
  const prepared = () => existsSync(`${file}.tmp`) || claims(readFileSync(file, 'utf8')).includes(CLAIM);
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

/**
 * The engine whose first transaction after the redirect staged the canonical `.tmp` runs `during` inside that
 * transaction, when it first saves a page version: an edit that lands after the redirect's database work began.
 */
function editsInsideCanonicalTransaction(engine: BrainEngine, file: string, during: () => void): BrainEngine {
  let fired = false;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'transaction') return async <T>(fn: (tx: BrainEngine) => Promise<T>) => {
        if (fired || !existsSync(`${file}.tmp`)) return target.transaction(fn);
        fired = true;
        return target.transaction(async tx => {
          const createVersion = tx.createVersion;
          tx.createVersion = async (...args) => { during(); return createVersion.apply(tx, args); };
          try { return await fn(tx); } finally { tx.createVersion = createVersion; }
        });
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-5 phantom redirect and a canonical database body that differs from its file (${backend})`, () => {
    test('D-5 db-newer, write-through on: the phantom is held with file_database_drift and both canonical copies stay', async () => {
      await withBrain(databaseUrl, async b => {
        await b.dbEdit(CANONICAL, DB_EDIT);
        const [fileBefore, bodyBefore, phantomFile] = [b.file(CANONICAL), await b.body(CANONICAL), b.file(PHANTOM)];
        const result = await expectUnitNotAborted(() => b.pass());
        expect({ redirected: result.redirected, drift: result.skipped_drift }).toEqual({ redirected: 0, drift: 1 });
        const held = heldFor(result, CANONICAL);
        expect({ held: held.length, fix: held.some(h => h.includes('gbrain sync --source default')) }).toEqual({ held: 1, fix: true });
        expect({ body: (await b.body(CANONICAL)) === bodyBefore, file: b.file(CANONICAL) === fileBefore }).toEqual({ body: true, file: true });
        expect({ phantomLive: await b.live(PHANTOM), phantomFile: b.file(PHANTOM) === phantomFile }).toEqual({ phantomLive: true, phantomFile: true });
      });
    }, 180_000);

    test('D-5 file-newer, write-through on: an unimported canonical file edit holds the phantom and the database body is not replaced', async () => {
      await withBrain(databaseUrl, async b => {
        const edited = `${CANONICAL_BODY}\n${FILE_EDIT}\n`;
        writeFileSync(b.path(CANONICAL), edited);
        const bodyBefore = await b.body(CANONICAL);
        const result = await expectUnitNotAborted(() => b.pass());
        expect({ body: (await b.body(CANONICAL)) === bodyBefore, file: b.file(CANONICAL) === edited }).toEqual({ body: true, file: true });
        expect(await b.live(PHANTOM)).toBe(true);
        expect({ redirected: result.redirected, held: heldFor(result, CANONICAL).length }).toEqual({ redirected: 0, held: 1 });
      });
    }, 180_000);

    test('D-5 db-newer, write-through off: the rows merge into the database body, the edit survives and no file changes', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('sync.write_through', 'false');
        _resetWriteThroughCacheForTest();
        await b.dbEdit(CANONICAL, DB_EDIT);
        const [canonicalFile, phantomFile] = [b.file(CANONICAL), b.file(PHANTOM)];
        const result = await expectUnitNotAborted(() => b.pass());
        const body = await b.body(CANONICAL);
        expect({ edit: body.includes(DB_EDIT), fence: claims(body) }).toEqual({ edit: true, fence: [CLAIM] });
        expect({ canonicalFile: b.file(CANONICAL) === canonicalFile, phantomFile: existsSync(b.path(PHANTOM)) && b.file(PHANTOM) === phantomFile })
          .toEqual({ canonicalFile: true, phantomFile: true });
        expect(await b.versionsHolding(CANONICAL, DB_EDIT)).toBeGreaterThan(0);
        expect(await b.live(PHANTOM)).toBe(false);
        expect({ redirected: result.redirected, held: result.held }).toEqual({ redirected: 1, held: [] });
      });
    }, 180_000);

    test('D-5 agreeing copies, write-through on: the rows land in the canonical file and database, and the replaced body is kept in page_versions', async () => {
      await withBrain(databaseUrl, async b => {
        const versionsBefore = await b.versionsHolding(CANONICAL, 'works at acme-example');
        const result = await expectUnitNotAborted(() => b.pass());
        expect({ file: claims(b.file(CANONICAL)), db: claims(await b.body(CANONICAL)) }).toEqual({ file: [CLAIM], db: [CLAIM] });
        expect(await b.versionsHolding(CANONICAL, 'works at acme-example')).toBe(versionsBefore + 1);
        expect({ redirected: result.redirected, held: result.held }).toEqual({ redirected: 1, held: [] });
        expect({ phantomLive: await b.live(PHANTOM), phantomFile: existsSync(b.path(PHANTOM)) }).toEqual({ phantomLive: false, phantomFile: false });
      });
    }, 180_000);

    test('D-5 concurrent database edit after the comparison: the edit survives, the canonical file is untouched and the phantom is held', async () => {
      await withBrain(databaseUrl, async b => {
        const fileBefore = b.file(CANONICAL);
        let landed = false;
        const racing = editsOnceCanonicalPrepared(b.engine, b.path(CANONICAL), async () => { await b.dbEdit(CANONICAL, LATE_EDIT); landed = true; });
        const result = await expectUnitNotAborted(() => b.pass(racing));
        expect(landed).toBe(true);
        expect({ edit: (await b.body(CANONICAL)).includes(LATE_EDIT), file: b.file(CANONICAL) === fileBefore, tmp: existsSync(`${b.path(CANONICAL)}.tmp`) })
          .toEqual({ edit: true, file: true, tmp: false });
        expect({ redirected: result.redirected, held: heldFor(result, CANONICAL).length, phantomLive: await b.live(PHANTOM) })
          .toEqual({ redirected: 0, held: 1, phantomLive: true });
      });
    }, 180_000);

    test('D-5 concurrent file edit after the comparison: the editor\'s bytes survive and the database body is not replaced', async () => {
      await withBrain(databaseUrl, async b => {
        const bodyBefore = await b.body(CANONICAL);
        const edited = `${CANONICAL_BODY}\n${LATE_EDIT}\n`;
        let landed = false;
        const racing = editsOnceCanonicalPrepared(b.engine, b.path(CANONICAL), async () => { writeFileSync(b.path(CANONICAL), edited); landed = true; });
        const result = await expectUnitNotAborted(() => b.pass(racing));
        expect(landed).toBe(true);
        expect({ file: b.file(CANONICAL) === edited, body: (await b.body(CANONICAL)) === bodyBefore }).toEqual({ file: true, body: true });
        expect({ redirected: result.redirected, held: heldFor(result, CANONICAL).length, phantomLive: await b.live(PHANTOM) })
          .toEqual({ redirected: 0, held: 1, phantomLive: true });
      });
    }, 180_000);

    test('D-5 file edit inside the redirect\'s transaction: the editor\'s bytes survive, the transaction rolls back and the phantom is held', async () => {
      await withBrain(databaseUrl, async b => {
        const [bodyBefore, versionsBefore] = [await b.body(CANONICAL), await b.versionsHolding(CANONICAL, 'works at acme-example')];
        const edited = `${CANONICAL_BODY}\n${LATE_EDIT}\n`;
        let landed = false;
        const racing = editsInsideCanonicalTransaction(b.engine, b.path(CANONICAL), () => { writeFileSync(b.path(CANONICAL), edited); landed = true; });
        const result = await expectUnitNotAborted(() => b.pass(racing));
        expect(landed).toBe(true);
        expect({ file: b.file(CANONICAL) === edited, tmp: existsSync(`${b.path(CANONICAL)}.tmp`) }).toEqual({ file: true, tmp: false });
        expect({ body: (await b.body(CANONICAL)) === bodyBefore, versions: await b.versionsHolding(CANONICAL, 'works at acme-example') })
          .toEqual({ body: true, versions: versionsBefore });
        expect({ redirected: result.redirected, held: heldFor(result, CANONICAL).length, phantomLive: await b.live(PHANTOM) })
          .toEqual({ redirected: 0, held: 1, phantomLive: true });
      });
    }, 180_000);
  });
}
