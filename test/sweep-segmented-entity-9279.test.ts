/**
 * #9279: captured session windows whose facts land on an entity page stored in segments.
 *
 * 1. Protects: a corpus window whose extracted facts resolve to a segmented entity page (named by the extractor, or
 *    inferred from a mention, which is how most conversation facts arrive) commits them onto the page's ## Facts
 *    table and the session file counts as extracted, on a managed Git source and on a repo-less brain; a refusal that
 *    retrying cannot change (page_body_segmented) stops its window after the one paid attempt instead of five, retention
 *    keeps the file it holds and doctor counts it; a window an older build stopped on that refusal is extracted by the
 *    first sweep on a new build, with no command.
 * 2. Fails when: subject inference reads the whole body of a segmented page to check its fence (the getters throw
 *    page_body_segmented after the model call), a deterministic refusal is paid for again on the same build, retention
 *    deletes a held file at the un-ingested ceiling, or a stopped window waits for a hand-run retry after the upgrade.
 * 3. Real seams: the maintenance sweep and its corpus window runner, the managed persistence consumer, a page imported
 *    large enough to be stored in segments, gateway test transports, PGLite and Postgres (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { opError } from '../src/core/ops/contract.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { invokeAI } from '../src/core/ai/invocation-guard.ts';
import { CORPUS_INGESTED_SUFFIX, runMaintenanceSweep } from '../src/core/sweep.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { CORPUS_FAILURE_SUFFIX, CORPUS_UNINGESTED_RETENTION_FACTOR, CORPUS_WINDOW_FAILURE_CAP, corpusBacklog, gcCorpusTurnFiles, readCorpusFailure } from '../src/core/context/corpus-segments.ts';
import { corpusFailureGate, corpusFileStat, corpusFrontierKey, runCorpusWindows } from '../src/core/context/corpus-windows.ts';
import { buildMemoryWritebackCheck } from '../src/commands/doctor/checks/memory-writeback.ts';
import { VERSION } from '../src/version.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { spoolPath } from './helpers/corpus-spool.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const KEYED: CapabilityReport = { embeddings: { available: false }, extraction: { available: true, provider: 'anthropic' }, search: 'keyword-only', mode: 'keyed' };
const PERSON = { slug: 'people/alice-example', title: 'Alice Example' };
const NAMED = 'Alice Example ships the example roadmap';
const INFERRED = 'Alice Example will send the deck by Friday';
const DIMS = 1536;
/** Fence rows on the entity page: about 1.5 MB, over the 1 MiB inline bound, so it is stored in segments. */
const FENCE_ROWS = 4000;
const TEST_MS = 240_000;
const SETTLE_MS = 30_000;
const SWEEP_BUDGET_MS = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

let extractions = 0;
const usage = { input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 };

function entityPage(): string {
  const rows = Array.from({ length: FENCE_ROWS }, (_, i) => '| ' + (i + 1) + ' | Alice Example noted item ' + i + ' of the example roadmap, one of a long run of notes kept on this page over the years, with a longer tail of words that makes each row of the table wider so the page grows past the inline bound | fact | 0.9 | world | medium | 2026-01-01 |  | meetings/2026-01-0' + (i % 9 + 1) + ' | a context note that adds some more length to this row ' + i + ' |');
  return '---\ntitle: ' + PERSON.title + '\ntype: person\n---\n# ' + PERSON.title + '\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n'
    + '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
    + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n'
    + rows.join('\n') + '\n<!--- gbrain:facts:end -->\n';
}

const transcript = () => toCorpusText([
  { role: 'user', text: 'Planning notes with Alice Example about the example roadmap. '.repeat(40) },
  { role: 'assistant', text: 'Summary of the example roadmap discussion. '.repeat(40) },
]);

beforeAll(() => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    extractions++;
    const facts = [
      { fact: NAMED, kind: 'fact', entity: PERSON.slug, confidence: 0.9, notability: 'high' },
      { fact: INFERRED, kind: 'commitment', entity: null, confidence: 0.9, notability: 'high' },
    ];
    return { text: JSON.stringify({ facts }), blocks: [], stopReason: 'end', model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic', usage };
  });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : 0))) })) as never);
});

afterAll(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});

for (const kind of testBackends()) {
  describe('corpus sweep onto a segmented entity page (' + kind + ', #9279)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const dirs: string[] = [];

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, TEST_MS);

    afterAll(async () => {
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await close?.();
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }, TEST_MS);

    /** A source (managed Git checkout, or none) holding the segmented entity page, with one captured session file. */
    async function brain(dir: string, mode: 'git' | 'repoless') {
      const root = join(dir, 'checkout'); mkdirSync(root);
      const corpusDir = join(dir, 'sessions'); mkdirSync(corpusDir);
      const sourceId = 'source-' + randomUUID().slice(0, 8);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, mode === 'git' ? root : null]);
      for (const [key, value] of [['sync.write_through', 'true'], ['facts.extraction_enabled', 'true'], ['dream.synthesize.session_corpus_dir', corpusDir],
        ['facts.default_visibility', 'world']]) await engine.setConfig(key, value);
      if (mode === 'git') await claimWorktree(engine, sourceId, root);
      const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
        dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: PERSON.slug, request_id: randomUUID(), content: entityPage() } });
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const sessionFile = spoolPath(corpusDir, 'example-session.txt', sourceId);
      writeFileSync(sessionFile, transcript());
      const logs: string[] = [];
      const sweep = async () => {
        const report = await runMaintenanceSweep(engine, { sourceId, capabilities: KEYED, budgetMs: SWEEP_BUDGET_MS, log: line => logs.push(line) });
        await waitFor(async () => (await engine.executeRaw<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')`, [sourceId]))[0].n === 0,
        { timeoutMs: SETTLE_MS, label: 'fact requests settled' });
        return report.corpusIngested;
      };
      const facts = () => engine.executeRaw<{ fact: string; slug: string; fenced: boolean }>(
        `SELECT fact, source_markdown_slug AS slug, row_num IS NOT NULL AS fenced FROM facts WHERE source_id=$1 AND source='sweep:corpus' ORDER BY fact`, [sourceId]);
      const storage = async () => (await engine.executeRaw<{ s: string }>('SELECT body_storage AS s FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, PERSON.slug]))[0]?.s;
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
      return { dir, corpusDir, sourceId, incarnation, sessionFile, logs, sweep, facts, storage };
    }

    /** One test's brain under its own GBRAIN_HOME (the worktree owner's host identity lives there). */
    async function withBrain(mode: 'git' | 'repoless', body: (b: Awaited<ReturnType<typeof brain>>) => Promise<void>) {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-9279-'));
      dirs.push(dir);
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        try { await body(await brain(dir, mode)); } finally {
          await disposePersistenceConsumer(engine);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        }
      });
    }

    for (const mode of ['git', 'repoless'] as const) {
      test('a window whose named and inferred facts land on the segmented page commits them, fenced, in one paid call (' + mode + ')', async () => {
        extractions = 0;
        await withBrain(mode, async b => {
          expect(await b.storage()).toBe('segmented');
          expect(await b.sweep()).toBe(1);
          expect(b.logs.join('\n')).not.toContain('page_body_segmented');
          expect(extractions).toBe(1);
          expect(existsSync(b.sessionFile + CORPUS_INGESTED_SUFFIX)).toBe(true);
          expect(existsSync(b.sessionFile + CORPUS_FAILURE_SUFFIX)).toBe(false);
          expect(await b.facts()).toEqual([
            { fact: NAMED, slug: PERSON.slug, fenced: true },
            { fact: INFERRED, slug: PERSON.slug, fenced: true },
          ]);
          expect(await b.storage()).toBe('segmented');
          expect(await b.sweep()).toBe(0);
          expect(extractions).toBe(1);
      });
      }, TEST_MS);
    }

    test('a window an older build stopped on page_body_segmented is extracted by the first sweep after the upgrade, with no command', async () => {
      extractions = 0;
      await withBrain('repoless', async b => {
        const key = await corpusFrontierKey(b.sessionFile, 'example-session.txt');
        writeFileSync(b.sessionFile + CORPUS_FAILURE_SUFFIX, JSON.stringify({ version: 1, key, source_incarnation: b.incarnation, count: CORPUS_WINDOW_FAILURE_CAP,
          first_at: Date.now() - DAY_MS, last_at: Date.now() - DAY_MS, last_code: 'page_body_segmented', fingerprint: null, rearmed: false }) + '\n');
        expect(await b.sweep()).toBe(1);
        expect(extractions).toBe(1);
        expect(existsSync(b.sessionFile + CORPUS_FAILURE_SUFFIX)).toBe(false);
        expect((await b.facts()).map(f => f.fact)).toEqual([NAMED, INFERRED]);
      });
    }, TEST_MS);

    test('retention keeps a file held by a deterministic refusal and doctor counts it; an ordinary stopped file still goes', async () => {
      await withBrain('repoless', async b => {
        const old = (Date.now() - (RETENTION_DAYS * CORPUS_UNINGESTED_RETENTION_FACTOR + 1) * DAY_MS) / 1000;
        const record = (code: string) => JSON.stringify({ version: 1, key: 'k@0', source_incarnation: b.incarnation, count: CORPUS_WINDOW_FAILURE_CAP,
          first_at: 1, last_at: 1, last_code: code, fingerprint: null, rearmed: false, build: VERSION }) + '\n';
        const held = spoolPath(b.corpusDir, 'held-session.txt', b.sourceId);
        const ordinary = spoolPath(b.corpusDir, 'ordinary-session.txt', b.sourceId);
        for (const [file, code] of [[held, 'page_body_segmented'], [ordinary, 'provider_error']] as const) {
          writeFileSync(file, transcript());
          writeFileSync(file + CORPUS_FAILURE_SUFFIX, record(code));
          utimesSync(file, old, old);
        }
        const check = await buildMemoryWritebackCheck(engine);
        expect(check.details).toMatchObject({ corpus_failed_windows: { stopped: 2, held: 1 } });
        expect(corpusBacklog(join(b.corpusDir, 'sourced'), RETENTION_DAYS * DAY_MS)).toMatchObject({ pastRetention: 2, held: 1 });
        expect(check.message).toContain('1 of them stopped at once on a refusal that retrying cannot change');
        gcCorpusTurnFiles(join(b.corpusDir, 'sourced'), RETENTION_DAYS * DAY_MS);
        expect(existsSync(held)).toBe(true);
        expect(existsSync(ordinary)).toBe(false);
      });
    }, TEST_MS);
  });
}

describe('a deterministic refusal after the model call (#9279)', () => {
  test('stops its window after the one paid attempt on this build, and runs once on another build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-9279-windows-'));
    try {
      const full = join(dir, 'refused-session.txt');
      writeFileSync(full, transcript());
      let paid = 0;
      const run = async () => runCorpusWindows({
        full, raw: readFileSync(full, 'utf8'), fileStat: corpusFileStat((await import('node:fs')).statSync(full)), maxWindows: 1,
        overBudget: () => false, signal: new AbortController().signal, failures: { fingerprint: null },
        extract: async () => {
          await invokeAI({ operation: 'extract', model: 'anthropic:test', kind: 'chat' }, async () => { paid++; return 'facts'; }, () => null);
          throw opError('page_body_segmented', 'The entity page is stored in segments.', 'Retrying refuses the same way.');
        },
      }).catch((e: unknown) => e);
      await run();
      expect(paid).toBe(1);
      const record = readCorpusFailure(full)!;
      expect(record).toMatchObject({ count: CORPUS_WINDOW_FAILURE_CAP, last_code: 'page_body_segmented', build: VERSION });
      expect(await run()).toMatchObject({ status: 'dead_lettered' });
      expect(paid).toBe(1);
      expect(corpusFailureGate({ ...record, build: '0.0.0.1' }, record.key, null, null, Date.now())).toBe('run');
      expect(corpusFailureGate({ ...record, last_code: 'provider_error' }, record.key, null, null, Date.now())).toBe('dead_lettered');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, TEST_MS);

  async function retryHeld(error: () => Error) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-9279-retry-'));
    const full = join(dir, 'held-session.txt');
    writeFileSync(full, transcript());
    const key = await corpusFrontierKey(full, 'held-session.txt');
    writeFileSync(full + CORPUS_FAILURE_SUFFIX, JSON.stringify({ version: 1, key, source_incarnation: null, count: CORPUS_WINDOW_FAILURE_CAP,
      first_at: 1, last_at: 1, last_code: 'page_body_segmented', fingerprint: null, rearmed: false, build: '0.0.0.1' }) + '\n');
    let paid = 0;
    await runCorpusWindows({
      full, raw: readFileSync(full, 'utf8'), fileStat: corpusFileStat((await import('node:fs')).statSync(full)), maxWindows: 1,
      overBudget: () => false, signal: new AbortController().signal, failures: { fingerprint: null },
      extract: async () => {
        await invokeAI({ operation: 'extract', model: 'anthropic:test', kind: 'chat' }, async () => { paid++; return 'facts'; }, () => null);
        throw error();
      },
    }).catch((e: unknown) => e);
    return { dir, paid, record: readCorpusFailure(full)! };
  }

  test('retries a held window automatically once, not on every later build', async () => {
    const { dir, paid, record } = await retryHeld(() => opError('page_body_segmented', 'The entity page is stored in segments.', 'Retrying refuses the same way.'));
    try {
      expect(paid).toBe(1);
      expect(record).toMatchObject({ count: CORPUS_WINDOW_FAILURE_CAP + 1, last_code: 'page_body_segmented', build: VERSION, upgrade_retried: true });
      expect(corpusFailureGate({ ...record, build: '0.0.0.2' }, record.key, null, null, Date.now())).toBe('dead_lettered');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, TEST_MS);

  test('a transient failure on that retry starts a fresh count instead of stopping the window for good', async () => {
    const { dir, paid, record } = await retryHeld(() => opError('unavailable', 'The provider timed out.', 'Retry later.'));
    try {
      expect(paid).toBe(1);
      expect(record).toMatchObject({ count: 1, last_code: 'unavailable', upgrade_retried: true, held: true });
      expect(corpusFailureGate(record, record.key, null, null, Date.now())).toBe('run');
      const full = join(dir, 'held-session.txt');
      const old = (Date.now() - (RETENTION_DAYS * CORPUS_UNINGESTED_RETENTION_FACTOR + 1) * DAY_MS) / 1000;
      utimesSync(full, old, old);
      gcCorpusTurnFiles(dir, RETENTION_DAYS * DAY_MS);
      expect(existsSync(full)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, TEST_MS);
});
