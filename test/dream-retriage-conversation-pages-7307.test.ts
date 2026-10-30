/**
 * #7307: `gbrain dream retriage` on a brain whose synthesize phase reads
 * conversation pages from the database (`dream.synthesize.conversation_pages
 * = true`, no `session_corpus_dir`). Retriage used to refuse with
 * config_error; it now triages the same transcript list synthesize does
 * (withConversationPages). Engine-backed discovery SQL, so PGLite and, with
 * DATABASE_URL, Postgres. No judge call: --dry-run reads cached verdicts only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDreamRetriage } from '../src/commands/dream-retriage.ts';
import { TRIAGE_VERSION } from '../src/core/cycle/synthesize.ts';
import { discoverConversationPages } from '../src/core/cycle/transcript-discovery.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const BODY = (n: number) => Array.from({ length: 40 }, (_, i) => `**alice-example** (10:${String(i).padStart(2, '0')}): planning item ${n}.${i} for acme-example.`).join('\n');

for (const kind of testBackends()) {
  describe(`#7307 dream retriage on conversation_pages brains (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let lines: string[];
    const orig = console.log;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'dream.%'`);
      await engine.executeRaw('DELETE FROM dream_verdicts');
      await engine.executeRaw(`DELETE FROM pages WHERE type = 'conversation'`);
      lines = [];
      console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    });
    afterEach(() => {
      console.log = orig;
      process.exitCode = 0;
    });

    test('conversation_pages=true without a corpus dir: retriage discovers the pages and reads their cached verdicts', async () => {
      await engine.setConfig('dream.synthesize.conversation_pages', 'true');
      for (const n of [1, 2]) {
        await engine.putPage(`conversations/2026-10-0${n}-session-example`, { type: 'conversation', title: `session ${n}`, compiled_truth: BODY(n) },
          { sourceId: 'default', allowEmptyOverwrite: true });
      }
      const [judged] = await discoverConversationPages(engine, { sourceId: 'default' });
      await engine.putDreamVerdict(judged!.filePath, judged!.contentHash, {
        worth_processing: true, reasons: ['seed'], score: 0.9, content_type: 'idea', segments: [], entities: [], model: TIER_DEFAULTS.utility, triage_version: TRIAGE_VERSION,
      });
      await runDreamRetriage(engine, ['--dry-run']);
      expect(process.exitCode ?? 0).toBe(0);
      expect(lines.join('\n')).toContain('[retriage] 2 discovered | 1 pass @ threshold');
      expect(lines.join('\n')).toContain('1 need triage | 0 judged, 1 cached');
    });

    test('neither a corpus dir nor conversation_pages=true still refuses with config_error naming both keys', async () => {
      const errors: string[] = [];
      const err = console.error;
      const write = process.stderr.write.bind(process.stderr);
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as never;
      try {
        await runDreamRetriage(engine, ['--dry-run']);
      } finally {
        console.error = err;
        process.stderr.write = write;
      }
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('dream.synthesize.conversation_pages');
    });
  });
}
