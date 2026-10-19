/**
 * D-10 (GBRA-131, #6982): the opt-in atom write-through never replaces a
 * checkout file that holds content the database lacks.
 *
 * Protects: with `cycle.extract_atoms.write_through` on, `extract_atoms`
 * writes an atom's file only when the file is absent or holds nothing the
 * database lacks (it equals the atom or one of its recent page_versions rows,
 * the state before the database write being published). A hand edit to an
 * atom's file that sync has not imported, alone or next to a newer database
 * extraction, and an unindexed file sitting at the path of an atom the
 * enable-time backfill would write, are kept byte for byte with the database
 * body unchanged; the phase warns and names the page in
 * `details.file_holds` with `file_database_drift` and the sync fix. An edit
 * landing after the comparison is kept too (the write is bound to the bytes
 * compared). A file that is the database's previous version is rewritten.
 * Fails when: the hook calls writePageThrough with no expectedFileBytes (the
 * pre-fix path), or the backfill treats source_path IS NULL as "no file".
 * Seams: the phase's `_transcripts` / `_chat` test inputs (no paid call), and
 * an engine proxy whose first url-clone source read once the new extraction
 * is complete (inside writePageThrough, after the comparison) lands a
 * concurrent file edit. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const FILE_EDIT = 'FILE-ONLY-EDIT-MARKER: a line added in the editor, not yet synced.';
const LATE_EDIT = 'CONCURRENT-EDIT-MARKER: saved while the phase ran.';
const UNINDEXED = '# Notes by alice-example\n\nA file nobody imported, at the atom path.\n';

interface Brain {
  engine: BrainEngine;
  path(slug: string): string;
  file(slug: string): string;
  body(slug: string): Promise<string>;
  atoms(): Promise<string[]>;
  extract(titles: string[], hash: string, opts?: { engine?: BrainEngine; bodySuffix?: string })
    : Promise<{ status: string; holds: string[] }>;
}

const chat = (titles: string[], bodySuffix: string) => async (_o: ChatOpts): Promise<ChatResult> => {
  const text = JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `${title} body.${bodySuffix}` })));
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  };
};

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d10-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: root });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const path = (slug: string) => join(root, `${slug}.md`);
        await run({
          engine, path,
          file: slug => readFileSync(path(slug), 'utf8'),
          body: async slug => (await engine.executeRaw<{ compiled_truth: string }>(
            "SELECT compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1", [slug]))[0]!.compiled_truth,
          atoms: async () => (await engine.executeRaw<{ slug: string }>(
            "SELECT slug FROM pages WHERE type = 'atom' AND deleted_at IS NULL ORDER BY slug")).map(r => r.slug),
          async extract(titles, hash, opts = {}) {
            const result = await runPhaseExtractAtoms(opts.engine ?? engine, {
              _transcripts: titles.length ? [{ filePath: '/fake/2026-09-07-meeting.txt', content: 'content', contentHash: hash }] : [],
              _pages: [], _chat: chat(titles, opts.bodySuffix ?? ''),
            });
            return { status: result.status, holds: ((result.details as { file_holds?: string[] }).file_holds ?? []).map(String) };
          },
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/**
 * The engine whose first url-clone source read (the one writePageThrough makes before it writes) once `slug`'s new
 * extraction is complete (its body carries `marker` and its source_hash is final) runs `before` first.
 */
function editsBeforeWrite(engine: BrainEngine, slug: string, marker: string, before: () => void): { engine: BrainEngine; fired(): boolean } {
  let fired = false;
  const complete = async () => (await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id = 'default' AND slug = $1 AND compiled_truth LIKE '%' || $2 || '%'
       AND frontmatter->>'source_hash' NOT LIKE 'pending:%'`, [slug, marker]))[0]!.n > 0;
  const proxy = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') return async (sql: string, ...rest: unknown[]) => {
        if (!fired && sql.includes('SELECT local_path, config FROM sources') && await complete()) { fired = true; before(); }
        return (target.executeRaw as (...a: unknown[]) => unknown).apply(target, [sql, ...rest]);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine: proxy, fired: () => fired };
}

const holdFor = (holds: string[], slug: string) => holds.filter(h => h.startsWith(`${slug} (file_database_drift`));

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-10 atom write-through and a checkout file the database does not hold (${backend})`, () => {
    test('D-10 control: a new atom is written, and a file holding the previous version is rewritten when the database is newer', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('cycle.extract_atoms.write_through', 'true');
        const first = await expectUnitNotAborted(() => b.extract(['Renders vs proof'], 'hash-one'));
        const [slug] = await b.atoms();
        expect({ status: first.status, holds: first.holds, body: b.file(slug!).includes('Renders vs proof body.') })
          .toEqual({ status: 'ok', holds: [], body: true });
        const second = await expectUnitNotAborted(() => b.extract(['Renders vs proof'], 'hash-two', { bodySuffix: ' DB-NEWER-MARKER.' }));
        expect({ holds: second.holds, file: b.file(slug!).includes('DB-NEWER-MARKER'), db: (await b.body(slug!)).includes('DB-NEWER-MARKER') })
          .toEqual({ holds: [], file: true, db: true });
      });
    }, 180_000);

    test('D-10 file-newer: a hand edit to the atom file is kept and the page is held with file_database_drift', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('cycle.extract_atoms.write_through', 'true');
        await b.extract(['Renders vs proof'], 'hash-one');
        const [slug] = await b.atoms();
        const edited = b.file(slug!).replace('Renders vs proof body.', `Renders vs proof body.\n\n${FILE_EDIT}`);
        writeFileSync(b.path(slug!), edited);
        const bodyBefore = await b.body(slug!);
        const phase = await expectUnitNotAborted(() => b.extract(['Renders vs proof'], 'hash-two'));
        expect({ file: b.file(slug!) === edited, body: (await b.body(slug!)) === bodyBefore }).toEqual({ file: true, body: true });
        const held = holdFor(phase.holds, slug!);
        expect({ status: phase.status, held: held.length, fix: held.some(h => h.includes('gbrain sync --source default')) })
          .toEqual({ status: 'warn', held: 1, fix: true });
      });
    }, 180_000);

    test('D-10 both changed: a newer database extraction does not replace the hand-edited file; both copies stay', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('cycle.extract_atoms.write_through', 'true');
        await b.extract(['Renders vs proof'], 'hash-one');
        const [slug] = await b.atoms();
        const edited = b.file(slug!).replace('Renders vs proof body.', `Renders vs proof body.\n\n${FILE_EDIT}`);
        writeFileSync(b.path(slug!), edited);
        const phase = await expectUnitNotAborted(() => b.extract(['Renders vs proof'], 'hash-two', { bodySuffix: ' DB-NEWER-MARKER.' }));
        expect({ file: b.file(slug!) === edited, db: (await b.body(slug!)).includes('DB-NEWER-MARKER') }).toEqual({ file: true, db: true });
        expect(holdFor(phase.holds, slug!).length).toBe(1);
      });
    }, 180_000);

    test('D-10 backfill: an unindexed file at a generated atom\'s path is kept when the key is enabled', async () => {
      await withBrain(databaseUrl, async b => {
        await b.extract(['Renders vs proof'], 'hash-one');
        const [slug] = await b.atoms();
        expect(existsSync(b.path(slug!))).toBe(false);
        mkdirSync(dirname(b.path(slug!)), { recursive: true });
        writeFileSync(b.path(slug!), UNINDEXED);
        const bodyBefore = await b.body(slug!);
        await b.engine.setConfig('cycle.extract_atoms.write_through', 'true');
        const phase = await expectUnitNotAborted(() => b.extract([], 'unused'));
        expect({ file: b.file(slug!) === UNINDEXED, body: (await b.body(slug!)) === bodyBefore }).toEqual({ file: true, body: true });
        expect({ status: phase.status, held: holdFor(phase.holds, slug!).length }).toEqual({ status: 'warn', held: 1 });
      });
    }, 180_000);

    test('D-10 concurrent file edit after the comparison: the editor\'s bytes survive and the page is held', async () => {
      await withBrain(databaseUrl, async b => {
        await b.engine.setConfig('cycle.extract_atoms.write_through', 'true');
        await b.extract(['Renders vs proof'], 'hash-one');
        const [slug] = await b.atoms();
        let edited = '';
        const racing = editsBeforeWrite(b.engine, slug!, 'DB-NEWER-MARKER', () => {
          edited = b.file(slug!).replace('Renders vs proof body.', `Renders vs proof body.\n\n${LATE_EDIT}`);
          writeFileSync(b.path(slug!), edited);
        });
        const phase = await expectUnitNotAborted(() => b.extract(['Renders vs proof'], 'hash-two', { engine: racing.engine, bodySuffix: ' DB-NEWER-MARKER.' }));
        expect({ fired: racing.fired(), file: b.file(slug!) === edited, late: edited.includes(LATE_EDIT) }).toEqual({ fired: true, file: true, late: true });
        expect((await b.body(slug!)).includes('DB-NEWER-MARKER')).toBe(true);
        expect(holdFor(phase.holds, slug!).length).toBe(1);
      });
    }, 180_000);
  });
}
