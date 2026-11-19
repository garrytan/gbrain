/**
 * #9738: `gbrain forget` withdraws one fact per run. Given several ids it used to withdraw the first, print success,
 * exit 0 and leave the rest active without a word. It now refuses before touching anything when more than one fact id
 * is given, so no id is skipped silently. A number that is the value of a flag (--reason 42) is not a fact id.
 *
 * In-process against PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { runForget } from '../src/commands/recall.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'people/alice-example';
const CLAIMS = ['Alice founded acme-example', 'Alice lives in Lisbon', 'Alice prefers tea'];

for (const kind of testBackends()) {
  describe(`#9738 gbrain forget takes one fact id (${kind})`, () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-forget-one-id-'));
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let ids: number[];

    async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string; code: number }> {
      const out: string[] = [], err: string[] = [];
      const o = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
      const consoleError = console.error;
      console.error = (...parts: unknown[]) => { err.push(parts.map(String).join(' ') + '\n'); };
      _resetCliExitVerdictForTests();
      let code: number;
      try { await withEnv({ GBRAIN_HOME: home }, fn); } finally {
        process.stdout.write = o; process.stderr.write = e; console.error = consoleError;
        code = currentExitCode();
        _resetCliExitVerdictForTests();
        process.exitCode = 0;
      }
      return { out: out.join(''), err: err.join(''), code };
    }
    const active = async () => (await engine.executeRaw<{ id: number }>(
      'SELECT id FROM facts WHERE entity_slug=$1 AND expired_at IS NULL ORDER BY id', [SLUG])).map(r => Number(r.id));

    beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      await registerLocalWriter(engine, 'cli');
      const rows = CLAIMS.map((claim, i) => `| ${i + 1} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`).join('\n');
      await importFromContent(engine, SLUG, `---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->\n`, { noEmbed: true, sourceId: 'default' });
      await runExtractFacts(engine, { slugs: [SLUG] });
      ids = await active();
      expect(ids).toHaveLength(3);
    }), 120_000);
    afterAll(async () => { await close(); rmSync(home, { recursive: true, force: true }); });

    test('several ids are refused with a clear message, and no fact is withdrawn', async () => {
      const run = await capture(() => runForget(engine, ids.map(String)));
      expect(run.code).not.toBe(0);
      expect(run.out).not.toContain('Forgot fact');
      expect(run.err).toContain('one fact id');
      expect(await active()).toEqual(ids);
    });

    test('the purge form refuses several ids too', async () => {
      const run = await capture(() => runForget(engine, [String(ids[0]), String(ids[1]), '--purge', '--dry-run']));
      expect(run.code).not.toBe(0);
      expect(run.err + run.out).toContain('one fact id');
      expect(await active()).toEqual(ids);
    });

    test('a numeric flag value before or after the id is not taken for the purge target', async () => {
      for (const argv of [[String(ids[0]), '--purge', '--dry-run', '--json', '--reason-scan-limit', String(ids[1])],
        ['--purge', '--dry-run', '--json', '--reason-scan-limit', String(ids[1]), String(ids[0])]]) {
        const run = await capture(() => runForget(engine, argv));
        expect(run.code).toBe(0);
        expect(JSON.parse(run.out)).toMatchObject({ fact_id: ids[0] });
      }
      expect(await active()).toEqual(ids);
    });

    test('one id with a numeric --reason still forgets that one fact', async () => {
      const run = await capture(() => runForget(engine, ['--reason', String(ids[1]), String(ids[0])]));
      expect(run.code).toBe(0);
      expect(run.out).toContain(`Forgot fact id=${ids[0]}`);
      expect(await active()).toEqual(ids.slice(1));
    });
  });
}
