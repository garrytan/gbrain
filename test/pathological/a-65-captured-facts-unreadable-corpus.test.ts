/**
 * GBRA-130 A-65: `gbrain repair captured-facts` classifies paste-only capture facts by reading the session corpus.
 * A corpus file or directory it could not read was skipped silently: the walk's `readdirSync` and the paste
 * check's `readFileSync` swallowed the error, so a session whose only paste-holding file was unreadable counted as
 * `not_suspect` (its fact looked cleared) and the preview said nothing about the files it never read.
 *
 * The preview now counts them (`residuals.unreadable_corpus_files`), lists each one, and a session with an unreadable
 * file that shows no paste is `unclassifiable`, never `not_suspect`. Readable sessions classify as before.
 * Uses 000-mode files; skipped when the suite runs as root (root reads them anyway). PGLite; Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runRepairCommand } from '../../src/commands/repair.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const ACME = 'companies/acme-example';
const PASTE = '[user]\nCan you summarize this email?\n<pasted_content id="7">\nAcme Example raised a Series B round led by Fund Alpha at a forty million valuation.\n</pasted_content id="7">\n\n[assistant]\nSure.';
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

interface Preview { results: Array<{ residuals: Record<string, number>; listing?: Array<{ item: string; class: string; detail?: string }> }> }

async function preview(engine: BrainEngine): Promise<Preview> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, ['captured-facts', '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as Preview;
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`A-65 unreadable session corpus in repair captured-facts (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const base = mkdtempSync(join(tmpdir(), 'gbrain-a65-'));
    beforeAll(async () => {
      if (databaseUrl) {
        ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => {
      for (const path of [join(base, 'corpus', 'sess-locked.txt'), join(base, 'corpus', 'locked-dir')]) { try { chmodSync(path, 0o700); } catch { /* absent */ } }
      await close?.();
      rmSync(base, { recursive: true, force: true });
    });

    test.skipIf(asRoot)('A-65 item: an unreadable corpus file or directory is counted and listed, and its session is unclassifiable, not cleared; readable sessions still classify', async () => {
      const claude = join(base, 'claude');
      mkdirSync(join(claude, 'projects', '-home-user-work'), { recursive: true });
      const corpus = join(base, 'corpus');
      mkdirSync(join(corpus, 'locked-dir'), { recursive: true });
      writeFileSync(join(corpus, 'sess-paste.txt'), PASTE);
      writeFileSync(join(corpus, 'sess-locked.txt'), PASTE);
      writeFileSync(join(corpus, 'locked-dir', 'sess-hidden.txt'), PASTE);
      chmodSync(join(corpus, 'sess-locked.txt'), 0o000);
      chmodSync(join(corpus, 'locked-dir'), 0o000);
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
      await engine.putPage(ACME, { type: 'company', title: 'Acme Example', compiled_truth: '# Acme Example' });
      for (const [session, fact] of [['sess-paste', 'Acme Example raised a Series B round led by Fund Alpha'], ['sess-locked', 'Fund Alpha valued Acme Example at forty million']]) {
        await engine.insertFact({ fact, entity_slug: ACME, kind: 'fact', visibility: 'private', source: 'sweep:corpus', source_session: `sweep:corpus:${session}.txt` }, { source_id: 'default' });
      }
      await withEnv({ CLAUDE_CONFIG_DIR: claude }, async () => {
        const result = (await preview(engine)).results[0]!;
        expect(result.residuals).toMatchObject({ ambiguous: 1, unclassifiable: 1, not_suspect: 0, unreadable_corpus_files: 2 });
        const unreadable = (result.listing ?? []).filter(entry => entry.class === 'unreadable_corpus_file').map(entry => entry.item).sort();
        expect(unreadable).toEqual(['locked-dir', 'sess-locked.txt']);
        expect((result.listing ?? []).filter(entry => entry.class === 'ambiguous').map(entry => entry.detail)).toEqual([expect.stringContaining('session sess-paste')]);
      });
    }, 120_000);
  });
}
