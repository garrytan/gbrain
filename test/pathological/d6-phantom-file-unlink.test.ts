/**
 * D-6 (GBRA-131, #6982): the phantom redirect never removes a phantom's file
 * that holds content its database row lacks.
 *
 * Protects: on an unmanaged brain with `sync.write_through` on, a phantom
 * (`alice`) whose checkout file differs from its database row anywhere (prose,
 * timeline or frontmatter, not only the facts fence) is held: the pass reports
 * `file_database_drift` naming the phantom with its fix, nothing is redirected
 * and the file keeps its bytes. A file that changes after the comparison is
 * re-read before the unlink and kept, and the pass reports it. With
 * write-through off the database is the copy of record and the redirect never
 * removes the file. A phantom whose file agrees with its row is removed as
 * before.
 * Fails when: the redirect unlinks the phantom's file after the fence-only
 * drift check (fenceDbDrift), without comparing the rest of the file or
 * re-reading it before the unlink.
 * Seams: an engine proxy that edits the phantom's file inside the transaction
 * that soft-deletes the phantom (after the comparison, before the unlink).
 * PGLite always, Postgres when DATABASE_URL is set.
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
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d6-'));
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

/** The engine whose transaction soft-deleting the phantom runs `before` first: an edit landing after the comparison, before the unlink. */
function editsBeforePhantomDelete(engine: BrainEngine, before: () => Promise<void>): BrainEngine {
  let fired = false;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(new Proxy(tx, {
        get(inner, key) {
          if (key === 'softDeletePage') return async (slug: string, opts: unknown) => {
            if (!fired && slug === PHANTOM) { fired = true; await before(); }
            return inner.softDeletePage(slug, opts as never);
          };
          const value = Reflect.get(inner, key, inner);
          return typeof value === 'function' ? value.bind(inner) : value;
        },
      })));
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-6 phantom redirect and a phantom file that differs from its database row (${backend})`, () => {
    test('D-6 file-newer prose: the phantom is held with file_database_drift, its file keeps its bytes and nothing moves', async () => {
      await withBrain(databaseUrl, async b => {
        const edited = `${PHANTOM_BODY}\n${FILE_EDIT}\n`;
        writeFileSync(b.path(PHANTOM), edited);
        const [canonicalFile, canonicalBody] = [b.file(CANONICAL), await b.body(CANONICAL)];
        const result = await expectUnitNotAborted(() => b.pass());
        expect({ phantomFile: existsSync(b.path(PHANTOM)) && b.file(PHANTOM) === edited, phantomLive: await b.live(PHANTOM) }).toEqual({ phantomFile: true, phantomLive: true });
        const held = heldFor(result, PHANTOM);
        expect({ redirected: result.redirected, held: held.length, fix: held.some(h => h.includes('gbrain sync --source default')) })
          .toEqual({ redirected: 0, held: 1, fix: true });
        expect({ canonicalFile: b.file(CANONICAL) === canonicalFile, canonicalBody: (await b.body(CANONICAL)) === canonicalBody })
          .toEqual({ canonicalFile: true, canonicalBody: true });
      });
    }, 180_000);

    test('D-6 file-newer frontmatter: a key only the file carries holds the phantom and keeps the file', async () => {
      await withBrain(databaseUrl, async b => {
        const edited = `---\naliases: [alice-ex]\n---\n${PHANTOM_BODY}`;
        writeFileSync(b.path(PHANTOM), edited);
        const result = await expectUnitNotAborted(() => b.pass());
        expect({ phantomFile: existsSync(b.path(PHANTOM)) && b.file(PHANTOM) === edited, phantomLive: await b.live(PHANTOM) }).toEqual({ phantomFile: true, phantomLive: true });
        expect({ redirected: result.redirected, held: heldFor(result, PHANTOM).length }).toEqual({ redirected: 0, held: 1 });
      });
    }, 180_000);

    test('D-6 write-through off: the phantom is redirected in the database and its file is never removed', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('sync.write_through', 'false');
        _resetWriteThroughCacheForTest();
        const phantomFile = b.file(PHANTOM);
        const result = await expectUnitNotAborted(() => b.pass());
        expect({ phantomFile: existsSync(b.path(PHANTOM)) && b.file(PHANTOM) === phantomFile, phantomLive: await b.live(PHANTOM) })
          .toEqual({ phantomFile: true, phantomLive: false });
        expect(claims(await b.body(CANONICAL))).toEqual([CLAIM]);
        expect({ redirected: result.redirected, held: result.held }).toEqual({ redirected: 1, held: [] });
      });
    }, 180_000);

    test('D-6 concurrent phantom file edit after the comparison: the redirect lands, the edited file is kept and reported', async () => {
      await withBrain(databaseUrl, async b => {
        const edited = `${PHANTOM_BODY}\n${LATE_EDIT}\n`;
        let landed = false;
        const racing = editsBeforePhantomDelete(b.engine, async () => { writeFileSync(b.path(PHANTOM), edited); landed = true; });
        const result = await expectUnitNotAborted(() => b.pass(racing));
        expect(landed).toBe(true);
        expect({ phantomFile: existsSync(b.path(PHANTOM)) && b.file(PHANTOM) === edited }).toEqual({ phantomFile: true });
        expect({ redirected: result.redirected, held: heldFor(result, PHANTOM).length }).toEqual({ redirected: 1, held: 1 });
      });
    }, 180_000);

    test('D-6 agreeing copies: the phantom is redirected and its file is removed', async () => {
      await withBrain(databaseUrl, async b => {
        const result = await expectUnitNotAborted(() => b.pass());
        expect({ phantomFile: existsSync(b.path(PHANTOM)), phantomLive: await b.live(PHANTOM) }).toEqual({ phantomFile: false, phantomLive: false });
        expect({ file: claims(b.file(CANONICAL)), db: claims(await b.body(CANONICAL)) }).toEqual({ file: [CLAIM], db: [CLAIM] });
        expect({ redirected: result.redirected, held: result.held }).toEqual({ redirected: 1, held: [] });
      });
    }, 180_000);
  });
}
