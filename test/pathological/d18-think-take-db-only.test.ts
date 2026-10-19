/**
 * D-18 (GBRA-131, #6982): `think --take --anchor` never creates a takes-only
 * file for a database-only page or appends to a file older than the database,
 * and the take keeps the trust tier of its synthesis inputs.
 *
 * Protects: `persistTakeFromSynthesis` keeps the md-first addTakeToPage
 * writer, which inserts the take at the synthesis-derived trust tier. Before
 * it writes, a page whose file is not canonical (`sync.write_through` off, a
 * declared `storage.db_only` directory), a page with no file, and a file whose
 * body differs from the database outside the takes section (a newer database
 * edit, or an unimported file edit) are refused
 * (`TAKE_WRITE_FAILED: mirror_unavailable`) with both copies unchanged.
 * Agreeing copies get the take in the file and the database, and a second
 * take before sync imports the first still lands. A take derived from an
 * `external_untrusted` page is written at `external_untrusted` with its input
 * edge, and when recording the edge fails the take is still at that tier and
 * reported written. On a source with a canonical owner the legacy writer is
 * refused and nothing is written.
 * Fails when: a missing file is read as an empty body and a takes-only file is
 * written that the next sync imports over the page, a stale file is appended
 * to, or the take is inserted under the ordinary agent channel and lowered in
 * a later transaction (a failed lowering leaves it over-trusted and reported
 * as not written).
 * Seams: a test trigger on derivation_inputs fails the lineage transaction.
 * PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { maintenanceTransaction } from '../../src/core/persistence/attribution.ts';
import { claimWorktree, managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { parseTakesFence } from '../../src/core/takes-fence.ts';
import { persistTakeFromSynthesis } from '../../src/core/think/persist-take.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const ALICE = 'people/alice-example';
const BODY = '# Alice Example\n\nDB-BODY-MARKER: Alice Example works at Acme Example.';
const ANSWER = { answer: '- Alice Example is the strongest operator at Acme Example.\n\nDetail.', synthesisOk: true };
const CLAIM = 'Alice Example is the strongest operator at Acme Example.';

interface Brain {
  engine: BrainEngine;
  root: string;
  path: string;
  file(): string | null;
  body(): Promise<string>;
  takes(): Promise<string[]>;
  take(taintSlug?: string): ReturnType<typeof persistTakeFromSynthesis>;
  tier(): Promise<string | undefined>;
}

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>, opts: { bound?: boolean } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d18-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await engine.setConfig('sync.repo_path', root);
        if (opts.bound) await claimWorktree(engine, 'default', root);
        await engine.putPage(ALICE, { type: 'person', title: 'Alice Example', compiled_truth: BODY });
        const path = join(root, `${ALICE}.md`);
        await run({
          engine, root, path,
          file: () => existsSync(path) ? readFileSync(path, 'utf8') : null,
          body: async () => (await engine.executeRaw<{ compiled_truth: string }>(
            "SELECT compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1", [ALICE]))[0]!.compiled_truth,
          takes: async () => (await engine.executeRaw<{ claim: string }>(
            "SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = 'default' AND p.slug = $1 ORDER BY t.row_num", [ALICE])).map(r => r.claim),
          take: (taintSlug?: string) => persistTakeFromSynthesis(engine,
            { ...ANSWER, ...(taintSlug ? { taint_refs: [{ table: 'pages', sourceId: 'default', slug: taintSlug }] } : {}) } as never,
            { anchor: ALICE, sourceId: 'default' }),
          tier: async () => (await engine.executeRaw<{ trust_tier: string }>(
            "SELECT t.trust_tier FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = 'default' AND p.slug = $1", [ALICE]))[0]?.trust_tier,
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function fileFromDatabase(b: Brain): Promise<string> {
  await b.engine.executeRaw("UPDATE pages SET source_path = $1 WHERE source_id = 'default' AND slug = $2", [`${ALICE}.md`, ALICE]);
  const snapshot = (await b.engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!;
  const bytes = serializePageToMarkdown(snapshot.page, snapshot.tags);
  mkdirSync(dirname(b.path), { recursive: true });
  writeFileSync(b.path, bytes);
  return bytes;
}

const fenceClaims = (text: string) => parseTakesFence(text).takes.map(t => t.claim);
const refused = (r: { warnings: string[] }) => r.warnings.some(w => w.startsWith('TAKE_WRITE_FAILED: mirror_unavailable'));

async function externalPage(b: Brain): Promise<number> {
  const page = await maintenanceTransaction(b.engine, tx => tx.putPage('notes/external-example', { type: 'note', title: 'External example',
    compiled_truth: 'An imported third-party note about Acme Example.' }, { sourceId: 'default' }), { tier: 'external_untrusted', origin: { channel: 'test' } });
  return Number(page.id);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-18 think --take on a database-only, drifted or tainted page (${backend})`, () => {
    test('D-18 write-through off: refused, no file is created and the database is unchanged', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('sync.write_through', 'false');
        _resetWriteThroughCacheForTest();
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, refused: refused(r), file: b.file(), body: await b.body(), takes: await b.takes() })
          .toEqual({ row: null, refused: true, file: null, body: BODY, takes: [] });
      });
    }, 180_000);

    test('D-18 storage.db_only page: refused, no file is created and the database is unchanged', async () => {
      await withBrain(databaseUrl, async b => {
        writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - people/\n');
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, refused: refused(r), file: b.file(), body: await b.body(), takes: await b.takes() })
          .toEqual({ row: null, refused: true, file: null, body: BODY, takes: [] });
      });
    }, 180_000);

    test('D-18 write-through on, page with no file: refused, no takes-only file is created and the body is unchanged', async () => {
      await withBrain(databaseUrl, async b => {
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, refused: refused(r), file: b.file(), body: await b.body(), takes: await b.takes() })
          .toEqual({ row: null, refused: true, file: null, body: BODY, takes: [] });
      });
    }, 180_000);

    test('D-18 db-newer: a stale file is not appended to; refused and both copies stay', async () => {
      await withBrain(databaseUrl, async b => {
        const stale = await fileFromDatabase(b);
        await b.engine.putPage(ALICE, { type: 'person', title: 'Alice Example', compiled_truth: `${BODY}\n\nDB-NEWER-MARKER: edited with write-through off.` });
        const bodyBefore = await b.body();
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, refused: r.warnings.some(w => w.includes('file_database_drift')), file: b.file() === stale, body: (await b.body()) === bodyBefore, takes: await b.takes() })
          .toEqual({ row: null, refused: true, file: true, body: true, takes: [] });
      });
    }, 180_000);

    test('D-18 file-newer: an unimported file edit is refused and both copies stay', async () => {
      await withBrain(databaseUrl, async b => {
        const edited = (await fileFromDatabase(b)).replace('works at Acme Example.', 'works at Acme Example.\n\nFILE-ONLY-EDIT-MARKER.');
        writeFileSync(b.path, edited);
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, refused: r.warnings.some(w => w.includes('file_database_drift')), file: b.file() === edited, body: await b.body(), takes: await b.takes() })
          .toEqual({ row: null, refused: true, file: true, body: BODY, takes: [] });
      });
    }, 180_000);

    test('D-18 a second take before sync imports the first lands after it', async () => {
      await withBrain(databaseUrl, async b => {
        await fileFromDatabase(b);
        const first = await expectUnitNotAborted(() => b.take());
        const second = await expectUnitNotAborted(() => persistTakeFromSynthesis(b.engine,
          { answer: 'Acme Example ships monthly.', synthesisOk: true }, { anchor: ALICE, sourceId: 'default' }));
        expect({ rows: [first.take_row, second.take_row], warnings: [...first.warnings, ...second.warnings], file: fenceClaims(b.file()!), body: await b.body() })
          .toEqual({ rows: [1, 2], warnings: [], file: [CLAIM, 'Acme Example ships monthly.'], body: BODY });
      });
    }, 180_000);

    test('D-18 agreeing copies: the take lands in the file and the database with the body kept', async () => {
      await withBrain(databaseUrl, async b => {
        await fileFromDatabase(b);
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, warnings: r.warnings, path: r.path, file: fenceClaims(b.file()!), fileKept: b.file()!.includes('DB-BODY-MARKER'), takes: await b.takes() })
          .toEqual({ row: 1, warnings: [], path: b.path, file: [CLAIM], fileKept: true, takes: [CLAIM] });
      });
    }, 180_000);

    test('D-18 claimed source: the legacy writer is refused and nothing is written', async () => {
      await withBrain(databaseUrl, async b => {
        const bytes = await fileFromDatabase(b);
        const r = await expectUnitNotAborted(() => b.take());
        expect({ row: r.take_row, failed: r.warnings.some(w => w.startsWith('TAKE_WRITE_FAILED')), file: b.file() === bytes, body: await b.body(), takes: await b.takes() })
          .toEqual({ row: null, failed: true, file: true, body: BODY, takes: [] });
      }, { bound: true });
    }, 180_000);

    test('D-18 tainted input: the take is written at external_untrusted with its input edge', async () => {
      await withBrain(databaseUrl, async b => {
        await fileFromDatabase(b);
        const input = await externalPage(b);
        const r = await expectUnitNotAborted(() => b.take('notes/external-example'));
        const edges = await b.engine.executeRaw<{ input_id: string }>(
          "SELECT d.input_id FROM derivation_inputs d JOIN takes t ON d.derived_table = 'takes' AND d.derived_id = t.id::text JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 AND d.input_table = 'pages'", [ALICE]);
        expect({ row: r.take_row, warnings: r.warnings, tier: await b.tier(), edges: edges.map(e => Number(e.input_id)) })
          .toEqual({ row: 1, warnings: [], tier: 'external_untrusted', edges: [input] });
      });
    }, 180_000);

    test('D-18 tainted input, lineage failure: the take is still external_untrusted and reported written', async () => {
      await withBrain(databaseUrl, async b => {
        await fileFromDatabase(b);
        await externalPage(b);
        await b.engine.executeRaw("CREATE OR REPLACE FUNCTION d18_fail_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'd18 lineage seam'; END $$");
        await b.engine.executeRaw('CREATE TRIGGER d18_fail_lineage BEFORE INSERT ON derivation_inputs FOR EACH ROW EXECUTE FUNCTION d18_fail_lineage()');
        try {
          const r = await expectUnitNotAborted(() => b.take('notes/external-example'));
          expect({ row: r.take_row, lineage: r.warnings.some(w => w.startsWith('TAKE_LINEAGE_WARNING')), tier: await b.tier(), takes: await b.takes() })
            .toEqual({ row: 1, lineage: true, tier: 'external_untrusted', takes: [CLAIM] });
        } finally {
          await b.engine.executeRaw('DROP TRIGGER IF EXISTS d18_fail_lineage ON derivation_inputs');
        }
      });
    }, 180_000);
  });
}
