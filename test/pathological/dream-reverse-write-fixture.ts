/**
 * Shared fixture for the dream reverse-write probes (GBRA-131 D-7 synthesize, D-8 patterns, #6982): a brain whose
 * source checkout is a temp directory, one dream output page imported twice (the second import is the child's write,
 * which keeps the first in page_versions), and the reverse-write under test run against it.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted } from './harness.ts';

export type ReverseWrite = (engine: BrainEngine, brainDir: string, refs: Array<{ slug: string; source_id: string }>,
  nativeSourceId?: string, signal?: AbortSignal, held?: string[]) => Promise<number>;

const SOURCE = 'default';
export const DREAM_SLUG = 'wiki/originals/ideas/alice-example-idea';
const V1 = 'FIRST-RUN-MARKER: Alice Example prefers small launches.';
const V2 = 'CHILD-WRITE-MARKER: Alice Example now ships weekly at acme-example.';
const FILE_EDIT = 'FILE-ONLY-EDIT-MARKER: a paragraph saved in the editor, not yet synced.';
const LATE_EDIT = 'CONCURRENT-EDIT-MARKER: written while the reverse-write ran.';
const page = (body: string) => `---\ntype: note\ntitle: Alice Example idea\n---\n# Alice Example idea\n\n${body}\n`;

interface Brain {
  engine: BrainEngine;
  root: string;
  file(path?: string): string;
  path: string;
  body(): Promise<string>;
  /** The first run's file: the page as it was before the child's write. */
  writeFirstRunFile(extra?: string): string;
  run(engine?: BrainEngine): Promise<{ written: number; held: string[] }>;
}

async function withBrain(databaseUrl: string | undefined, reverseWrite: ReverseWrite, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-dream-rw-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await importFromContent(engine, DREAM_SLUG, page(V1), { noEmbed: true, sourceId: SOURCE });
        const first = (await engine.readPageSnapshot(DREAM_SLUG, { sourceId: SOURCE }))!;
        const firstRunFile = serializePageToMarkdown(first.page, first.tags);
        await importFromContent(engine, DREAM_SLUG, page(`${V1}\n\n${V2}`), { noEmbed: true, sourceId: SOURCE });
        const path = join(root, `${DREAM_SLUG}.md`);
        const b: Brain = {
          engine, root, path,
          file: (p = path) => readFileSync(p, 'utf8'),
          body: async () => (await engine.executeRaw<{ compiled_truth: string }>(
            'SELECT compiled_truth FROM pages WHERE source_id = $1 AND slug = $2', [SOURCE, DREAM_SLUG]))[0]!.compiled_truth,
          writeFirstRunFile(extra) {
            const bytes = extra ? firstRunFile.replace(V1, `${V1}\n\n${extra}`) : firstRunFile;
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, bytes);
            return bytes;
          },
          async run(on = engine) {
            const held: string[] = [];
            const written = await reverseWrite(on, root, [{ slug: DREAM_SLUG, source_id: SOURCE }], SOURCE, undefined, held);
            return { written, held };
          },
        };
        await run(b);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** The engine that runs `after` once the reverse-write has read the page history it compares the file with. */
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

const heldFor = (held: string[]) => held.filter(h => h.startsWith(`${DREAM_SLUG} (file_database_drift`));

/** The reverse-write cases every dream phase's writer must pass, on one engine arm (from `pathologicalArms()`). */
export function reverseWriteCases(id: string, phase: string, reverseWrite: ReverseWrite, { backend, databaseUrl }: { backend: string; databaseUrl: string | undefined }): void {
  describe(`${id} ${phase} reverse-write and a file that differs from the database (${backend})`, () => {
    test(`${id} file-newer: an unimported file edit is kept, the page is held with file_database_drift and the database is untouched`, async () => {
      await withBrain(databaseUrl, reverseWrite, async b => {
        const edited = b.writeFirstRunFile(FILE_EDIT);
        const bodyBefore = await b.body();
        const result = await expectUnitNotAborted(() => b.run());
        const held = heldFor(result.held);
        expect({ written: result.written, held: held.length, fix: held.some(h => h.includes('gbrain sync --source default')) })
          .toEqual({ written: 0, held: 1, fix: true });
        expect({ file: b.file() === edited, body: (await b.body()) === bodyBefore }).toEqual({ file: true, body: true });
      });
    }, 180_000);

    test(`${id} db-newer: a file the child's write replaced (kept in page_versions) is rewritten with the new body`, async () => {
      await withBrain(databaseUrl, reverseWrite, async b => {
        b.writeFirstRunFile();
        const result = await expectUnitNotAborted(() => b.run());
        expect({ written: result.written, held: result.held }).toEqual({ written: 1, held: [] });
        expect({ v1: b.file().includes(V1), v2: b.file().includes(V2) }).toEqual({ v1: true, v2: true });
      });
    }, 180_000);

    test(`${id} write-through off: no file is written or replaced`, async () => {
      await withBrain(databaseUrl, reverseWrite, async b => {
        await b.engine.setConfig('sync.write_through', 'false');
        _resetWriteThroughCacheForTest();
        const before = b.writeFirstRunFile();
        const result = await expectUnitNotAborted(() => b.run());
        expect({ written: result.written, held: result.held, file: b.file() === before }).toEqual({ written: 0, held: [], file: true });
      });
    }, 180_000);

    test(`${id} storage.db_only: a page in a db_only directory gets no file`, async () => {
      await withBrain(databaseUrl, reverseWrite, async b => {
        writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - wiki/originals\n');
        const result = await expectUnitNotAborted(() => b.run());
        expect({ written: result.written, file: existsSync(b.path) }).toEqual({ written: 0, file: false });
      });
    }, 180_000);

    test(`${id} recorded source_path: the file of record is written and no slug-named twin appears`, async () => {
      await withBrain(databaseUrl, reverseWrite, async b => {
        await b.engine.executeRaw('UPDATE pages SET source_path = $1 WHERE source_id = $2 AND slug = $3', ['Ideas/Alice Example idea.md', SOURCE, DREAM_SLUG]);
        const recorded = join(b.root, 'Ideas/Alice Example idea.md');
        const result = await expectUnitNotAborted(() => b.run());
        expect({ written: result.written, recorded: existsSync(recorded) && b.file(recorded).includes(V2), twin: existsSync(b.path) })
          .toEqual({ written: 1, recorded: true, twin: false });
      });
    }, 180_000);

    test(`${id} concurrent file edit after the comparison: the editor's bytes survive and the page is held`, async () => {
      await withBrain(databaseUrl, reverseWrite, async b => {
        b.writeFirstRunFile();
        const edited = `${b.file()}\n${LATE_EDIT}\n`;
        const racing = editsAfterComparison(b.engine, () => writeFileSync(b.path, edited));
        const result = await expectUnitNotAborted(() => b.run(racing));
        expect({ written: result.written, held: heldFor(result.held).length, file: b.file() === edited }).toEqual({ written: 0, held: 1, file: true });
      });
    }, 180_000);

    test(`${id} file edit while the replacement is staged: the editor's bytes survive, the staged file is removed and the page is held`, async () => {
      await withBrain(databaseUrl, reverseWrite, async b => {
        b.writeFirstRunFile();
        const edited = `${b.file()}\n${LATE_EDIT}\n`;
        const realWrite = fs.writeFileSync;
        let landed = false;
        const staging = spyOn(fs, 'writeFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
          if (!landed && String(path).startsWith(`${b.path}.`) && String(path).endsWith('.tmp')) { realWrite(b.path, edited); landed = true; }
          return (realWrite as (...a: unknown[]) => void)(path, ...rest);
        }) as typeof fs.writeFileSync);
        let result: { written: number; held: string[] };
        try { result = await expectUnitNotAborted(() => b.run()); } finally { staging.mockRestore(); }
        expect(landed).toBe(true);
        expect({ written: result.written, held: heldFor(result.held).length, file: b.file() === edited,
          staged: readdirSync(dirname(b.path)).filter(name => name.endsWith('.tmp')) }).toEqual({ written: 0, held: 1, file: true, staged: [] });
      });
    }, 180_000);

    test(`${id} control, no file yet: the page's file is written`, async () => {
      await withBrain(databaseUrl, reverseWrite, async b => {
        const result = await expectUnitNotAborted(() => b.run());
        expect({ written: result.written, held: result.held, v2: existsSync(b.path) && b.file().includes(V2) }).toEqual({ written: 1, held: [], v2: true });
      });
    }, 180_000);
  });
}
