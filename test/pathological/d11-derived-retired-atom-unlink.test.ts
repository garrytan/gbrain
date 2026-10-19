/**
 * D-11 (GBRA-131, #6982): retiring a generated atom never unlinks a checkout
 * file that holds content the database lacks, or a file outside gbrain's
 * write targets.
 *
 * Protects: with `cycle.extract_atoms.write_through` on, an atom
 * `extract_atoms` retires loses its file only when the retired page (or one
 * of its page_versions rows) holds everything in it. A hand edit to the
 * retired atom's file is kept byte for byte, the phase warns and names the
 * page in `details.file_holds` with `file_database_drift`, and the other
 * atoms of the run are still written. A file in a declared `storage.db_only`
 * directory (which the writer never writes) is not removed. An edit landing
 * after the comparison is kept (the unlink rechecks the bytes compared under
 * the source filesystem lock). A file that is the retired page is removed.
 * Fails when: the retirement hook calls deletePageThrough with no content
 * check and no storage filter (the pre-fix path).
 * Seams: the phase's `_transcripts` / `_chat` test inputs (no paid call), and
 * an engine proxy whose first url-clone source read once the old atom is
 * retired and the new atom's file is written (deletePageThrough's, after the
 * comparison) lands the edit. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const FILE_EDIT = 'FILE-ONLY-EDIT-MARKER: a line added in the editor, not yet synced.';
const LATE_EDIT = 'CONCURRENT-EDIT-MARKER: saved while the retirement ran.';

interface Brain {
  engine: BrainEngine;
  root: string;
  path(slug: string): string;
  file(slug: string): string;
  atoms(live: boolean): Promise<string[]>;
  extract(titles: string[], hash: string, on?: BrainEngine): Promise<{ status: string; holds: string[] }>;
}

const chat = (titles: string[]) => async (_o: ChatOpts): Promise<ChatResult> => {
  const text = JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `${title} body.` })));
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  };
};

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d11-'));
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
        await engine.setConfig('cycle.extract_atoms.write_through', 'true');
        const path = (slug: string) => join(root, `${slug}.md`);
        await run({
          engine, root, path,
          file: slug => readFileSync(path(slug), 'utf8'),
          atoms: async live => (await engine.executeRaw<{ slug: string }>(
            "SELECT slug FROM pages WHERE type = 'atom' AND (deleted_at IS NULL) = $1 ORDER BY slug", [live])).map(r => r.slug),
          async extract(titles, hash, on = engine) {
            const result = await runPhaseExtractAtoms(on, {
              _transcripts: [{ filePath: '/fake/2026-09-07-meeting.txt', content: 'content', contentHash: hash }], _pages: [], _chat: chat(titles),
            });
            return { status: result.status, holds: ((result.details as { file_holds?: string[] }).file_holds ?? []).map(String) };
          },
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/**
 * The engine whose first url-clone source read once `retired` is retired and every live atom's file exists (the read
 * deletePageThrough makes before it unlinks) runs `before` first.
 */
function editsBeforeUnlink(engine: BrainEngine, retired: string, path: (slug: string) => string, before: () => void): { engine: BrainEngine; fired(): boolean } {
  let fired = false;
  const ready = async () => {
    const rows = await engine.executeRaw<{ slug: string; deleted: boolean }>(
      "SELECT slug, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id = 'default' AND type = 'atom'");
    return rows.some(r => r.slug === retired && r.deleted) && rows.filter(r => !r.deleted).every(r => existsSync(path(r.slug)));
  };
  const proxy = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') return async (sql: string, ...rest: unknown[]) => {
        if (!fired && sql.includes('SELECT local_path, config FROM sources') && await ready()) { fired = true; before(); }
        return (target.executeRaw as (...a: unknown[]) => unknown).apply(target, [sql, ...rest]);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine: proxy, fired: () => fired };
}

const holdFor = (holds: string[], slug: string) => holds.filter(h => h.startsWith(`${slug} (file_database_drift`) && h.includes('was not removed'));

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-11 retired atom files and a checkout file the database does not hold (${backend})`, () => {
    test('D-11 control: a retired atom whose file is the retired page loses its file', async () => {
      await withBrain(databaseUrl, async b => {
        await b.extract(['Renders vs proof'], 'hash-one');
        const [old] = await b.atoms(true);
        expect(existsSync(b.path(old!))).toBe(true);
        const phase = await expectUnitNotAborted(() => b.extract(['A different lesson'], 'hash-two'));
        expect({ retired: await b.atoms(false), file: existsSync(b.path(old!)), holds: phase.holds }).toEqual({ retired: [old!], file: false, holds: [] });
      });
    }, 180_000);

    test('D-11 file-newer: a hand edit to a retired atom\'s file is kept, held with file_database_drift, and the new atom is still written', async () => {
      await withBrain(databaseUrl, async b => {
        await b.extract(['Renders vs proof'], 'hash-one');
        const [old] = await b.atoms(true);
        const edited = b.file(old!).replace('Renders vs proof body.', `Renders vs proof body.\n\n${FILE_EDIT}`);
        writeFileSync(b.path(old!), edited);
        const phase = await expectUnitNotAborted(() => b.extract(['A different lesson'], 'hash-two'));
        const [current] = await b.atoms(true);
        expect({ retired: await b.atoms(false), file: existsSync(b.path(old!)) && b.file(old!) === edited, current: existsSync(b.path(current!)) })
          .toEqual({ retired: [old!], file: true, current: true });
        const held = holdFor(phase.holds, old!);
        expect({ status: phase.status, held: held.length, fix: held.some(h => h.includes('gbrain sync --source default')) })
          .toEqual({ status: 'warn', held: 1, fix: true });
      });
    }, 180_000);

    test('D-11 storage.db_only: a file in a db_only directory is never removed by retirement', async () => {
      await withBrain(databaseUrl, async b => {
        writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - atoms/\n');
        await b.extract(['Renders vs proof'], 'hash-one');
        const [old] = await b.atoms(true);
        expect(existsSync(b.path(old!))).toBe(false);
        mkdirSync(join(b.path(old!), '..'), { recursive: true });
        const local = '# Renders vs proof\n\nA local copy kept in the db_only directory.\n';
        writeFileSync(b.path(old!), local);
        await expectUnitNotAborted(() => b.extract(['A different lesson'], 'hash-two'));
        expect({ retired: await b.atoms(false), file: existsSync(b.path(old!)) && b.file(old!) === local }).toEqual({ retired: [old!], file: true });
      });
    }, 180_000);

    test('D-11 concurrent file edit after the comparison: the editor\'s bytes survive and the page is held', async () => {
      await withBrain(databaseUrl, async b => {
        await b.extract(['Renders vs proof'], 'hash-one');
        const [old] = await b.atoms(true);
        let edited = '';
        const racing = editsBeforeUnlink(b.engine, old!, b.path, () => {
          edited = b.file(old!).replace('Renders vs proof body.', `Renders vs proof body.\n\n${LATE_EDIT}`);
          writeFileSync(b.path(old!), edited);
        });
        const phase = await expectUnitNotAborted(() => b.extract(['A different lesson'], 'hash-two', racing.engine));
        expect({ fired: racing.fired(), file: existsSync(b.path(old!)) && b.file(old!) === edited, late: edited.includes(LATE_EDIT) })
          .toEqual({ fired: true, file: true, late: true });
        expect(holdFor(phase.holds, old!).length).toBe(1);
      });
    }, 180_000);
  });
}
