/**
 * #6048: the sweep has no request id for a corpus window, so its managed facts
 * batch is keyed by the window text. When the canonical file check refused an
 * entity request, every later sweep used to replay that stored refusal, and the
 * window (and every window after it) never ingested.
 *
 * 1. Protects: once every refused page passes the file check again, the
 *    retained facts are admitted as a follow-up batch, with no new extraction,
 *    at the page's current revision and never wider than the current default
 *    visibility; committed siblings are reported, not re-admitted; at most
 *    three follow-ups per window.
 * 2. Fails when: the refusal replays forever, a follow-up is admitted while the
 *    page still drifts, beside a refusal of another kind, for a refused request
 *    that kept no facts or belongs to other input, or past the cap.
 * 3. managed-sweep-corpus-windows.test.ts covers windows that commit.
 * 4. Seams: gateway test transports and the persistence fault hook.
 *
 * Runs on PGLite; also on Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { prepareManagedFactsSession } from '../src/core/persistence/facts-maintenance.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { CORPUS_INGESTED_SUFFIX, runMaintenanceSweep } from '../src/core/sweep.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';

const KEYED: CapabilityReport = { embeddings: { available: false }, extraction: { available: true, provider: 'anthropic' }, search: 'keyword-only', mode: 'keyed' };
const COMPLETE = '__managed_facts_complete__';
const COMPANY = { slug: 'companies/widget-co', title: 'Widget Co', type: 'company' };
const PERSON = { slug: 'people/charlie-example', title: 'Charlie Example', type: 'person' };

const engines: BrainEngine[] = [];
const dbDir = mkdtempSync(join(tmpdir(), 'gbrain-refused-window-db-'));
let closePostgres: (() => Promise<void>) | undefined;
let extractions = 0;
let named: Array<typeof COMPANY> = [];

beforeAll(async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    extractions++;
    const facts = named.map(entity => ({ fact: `${entity.title} ships the example roadmap`, kind: 'fact', entity: entity.slug, confidence: 0.9, notability: 'high' }));
    return { text: JSON.stringify({ facts }), blocks: [], stopReason: 'end', model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
      usage: { input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 } };
  });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map((value, i) => {
    const vector = Array(1536).fill(0);
    vector[(value.length * 7 + i) % 1536] = 1;
    return vector;
  }) })) as never);
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dbDir });
      await engine.initSchema();
      engines.push(engine);
    } else {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engines.push(isolated.engine);
      closePostgres = isolated.close;
    }
  }
}, 120_000);

afterAll(async () => {
  installFaultHook(undefined);
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dbDir, { recursive: true, force: true });
});

const transcript = () => toCorpusText([
  { role: 'user', text: 'Planning notes for the example roadmap. '.repeat(40) },
  { role: 'assistant', text: 'Summary of the example roadmap discussion. '.repeat(40) },
]);

/** A managed source holding committed entity pages, with one corpus transcript whose window refers to `named`. */
async function refusedWindow(engine: BrainEngine, dir: string, pages: Array<typeof COMPANY>, drifted: Array<typeof COMPANY>) {
  const root = join(dir, 'checkout'); mkdirSync(root);
  const corpusDir = join(dir, 'sessions'); mkdirSync(corpusDir);
  const sourceId = `refused-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  for (const [key, value] of [['sync.write_through', 'true'], ['facts.extraction_enabled', 'true'], ['dream.synthesize.session_corpus_dir', corpusDir],
    ['facts.default_visibility', 'world']]) await engine.setConfig(key, value);
  await claimWorktree(engine, sourceId, root);
  const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
    dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  for (const page of pages) {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: page.slug, request_id: randomUUID(),
      content: `---\ntitle: ${page.title}\ntype: ${page.type}\n---\n# ${page.title}\n` } });
  }
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const fileOf = (page: typeof COMPANY) => join(root, `${page.slug}.md`);
  const pristine = new Map(pages.map(page => [page.slug, readFileSync(fileOf(page))]));
  const drift = (page: typeof COMPANY) => appendFileSync(fileOf(page), '\nA local edit nobody imported.\n');
  const repair = (page: typeof COMPANY) => writeFileSync(fileOf(page), pristine.get(page.slug)!);
  for (const page of drifted) drift(page);
  const sessionFile = join(corpusDir, 'example-session.txt');
  writeFileSync(sessionFile, transcript());
  const logs: string[] = [];
  const quiet = () => waitFor(async () => (await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')`, [sourceId]))[0].n === 0,
  { timeoutMs: 30_000, label: 'fact requests settled' });
  const sweep = async () => {
    const report = await runMaintenanceSweep(engine, { sourceId, capabilities: KEYED, budgetMs: 120_000, log: line => logs.push(line) });
    await quiet();
    return report.corpusIngested;
  };
  const journal = () => engine.executeRaw<{ slug: string; state: string; error_code: string | null }>(
    `SELECT slug, state, error_code FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence`, [sourceId])
    .then(rows => rows.map(row => `${row.slug}:${row.state}${row.error_code ? `:${row.error_code}` : ''}`));
  const facts = () => engine.executeRaw<{ entity: string; visibility: string }>(
    `SELECT entity_slug AS entity, visibility FROM facts WHERE source_id=$1 AND source='sweep:corpus' AND expired_at IS NULL ORDER BY entity_slug`, [sourceId])
    .then(rows => rows.map(row => `${row.entity}:${row.visibility}`));
  return { sourceId, ctx, logs, sessionFile, drift, repair, sweep, journal, facts, quiet };
}

async function onEachEngine(label: string, body: (engine: BrainEngine, dir: string) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), `gbrain-refused-window-${label}-`));
    extractions = 0;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, () => body(engine, dir));
    } finally {
      installFaultHook(undefined);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const refusedFirstPass = [`${COMPANY.slug}:conflict:source_changed`, `${PERSON.slug}:committed`, `${COMPLETE}:conflict:revision_conflict`];

describe('a sweep window refused by the canonical file check (#6048)', () => {
  test('stays refused while the page drifts, then publishes its retained facts once the file is repaired', async () => {
    named = [COMPANY, PERSON];
    await onEachEngine('repair', async (engine, dir) => {
      const w = await refusedWindow(engine, dir, [COMPANY, PERSON], [COMPANY]);
      expect(await w.sweep()).toBe(0);
      expect(await w.journal()).toEqual(refusedFirstPass);
      expect(await w.sweep()).toBe(0);
      expect(await w.journal()).toEqual(refusedFirstPass);

      w.repair(COMPANY);
      await submitRememberMutation(w.ctx, { fact: 'Widget Co moved offices', entity: COMPANY.slug, provenance: 'test', visibility: 'private' }, 10_000);
      await w.quiet();
      await engine.setConfig('facts.default_visibility', 'private');
      expect(await w.sweep()).toBe(1);
      expect(extractions).toBe(1);
      expect(await w.journal()).toEqual([...refusedFirstPass, `${COMPANY.slug}:committed`, `${COMPLETE}:committed`]);
      expect(await w.facts()).toEqual([`${COMPANY.slug}:private`, `${PERSON.slug}:world`]);
      const ingested = JSON.parse(readFileSync(w.sessionFile + CORPUS_INGESTED_SUFFIX, 'utf8'));
      expect(ingested.facts_inserted).toBe(2);

      expect(await w.sweep()).toBe(0);
      expect((await w.journal()).length).toBe(refusedFirstPass.length + 2);
    });
  }, 180_000);

  test('a page whose publication keeps refusing gets three follow-ups, then the refusal stands', async () => {
    named = [COMPANY];
    await onEachEngine('cap', async (engine, dir) => {
      const w = await refusedWindow(engine, dir, [COMPANY], [COMPANY]);
      expect(await w.sweep()).toBe(0);
      installFaultHook((point, detail) => {
        if (point === 'consumer:prepared' && detail.operation === 'extract_facts' && detail.sourceId === w.sourceId) w.drift(COMPANY);
      });
      for (let followUps = 1; followUps <= 3; followUps++) {
        w.repair(COMPANY);
        expect(await w.sweep()).toBe(0);
        expect((await w.journal()).length).toBe(2 * (followUps + 1));
        expect((await w.journal()).slice(-2)).toEqual([`${COMPANY.slug}:conflict:source_changed`, `${COMPLETE}:conflict:revision_conflict`]);
      }
      installFaultHook(undefined);
      w.repair(COMPANY);
      expect(await w.sweep()).toBe(0);
      expect((await w.journal()).length).toBe(8);
      expect(extractions).toBe(1);
      expect(await w.facts()).toEqual([]);
    });
  }, 180_000);

  test('a refusal of another kind beside the file refusal admits no follow-up', async () => {
    named = [COMPANY, PERSON];
    await onEachEngine('mixed', async (engine, dir) => {
      const w = await refusedWindow(engine, dir, [COMPANY, PERSON], [COMPANY, PERSON]);
      expect(await w.sweep()).toBe(0);
      await engine.executeRaw(`UPDATE persistence_requests SET error_code='revision_conflict' WHERE source_id=$1 AND slug=$2`, [w.sourceId, PERSON.slug]);
      const before = await w.journal();
      expect(before).toEqual([`${COMPANY.slug}:conflict:source_changed`, `${PERSON.slug}:conflict:revision_conflict`, `${COMPLETE}:conflict:revision_conflict`]);
      w.repair(COMPANY); w.repair(PERSON);
      expect(await w.sweep()).toBe(0);
      expect(await w.journal()).toEqual(before);
      expect(await w.facts()).toEqual([]);
    });
  }, 180_000);

  test('a refused request without retained facts, or carrying other input, admits no follow-up', async () => {
    named = [COMPANY];
    for (const tamper of [`intent - 'facts'`, `jsonb_set(intent, '{inputDigest}', '"example-foreign-digest"')`]) {
      await onEachEngine('retained', async (engine, dir) => {
        const w = await refusedWindow(engine, dir, [COMPANY], [COMPANY]);
        expect(await w.sweep()).toBe(0);
        await engine.executeRaw(`UPDATE persistence_requests SET intent = ${tamper} WHERE source_id=$1 AND slug=$2`, [w.sourceId, COMPANY.slug]);
        w.repair(COMPANY);
        expect(await w.sweep()).toBe(0);
        expect(await w.journal()).toEqual([`${COMPANY.slug}:conflict:source_changed`, `${COMPLETE}:conflict:revision_conflict`]);
        expect(await w.facts()).toEqual([]);
      });
    }
  }, 180_000);

  test('a writer grant narrowed since the refusal admits no follow-up', async () => {
    named = [COMPANY, PERSON];
    for (const narrowed of [`'{slugPrefixes}', '["people/"]'`, `'{operations}', '["put_page"]'`]) {
      await onEachEngine('narrowed', async (engine, dir) => {
        const w = await refusedWindow(engine, dir, [COMPANY, PERSON], [COMPANY]);
        expect(await w.sweep()).toBe(0);
        const [writer] = await engine.executeRaw<{ id: string }>(`SELECT principal_id AS id FROM persistence_requests
          WHERE source_id=$1 AND slug=$2 AND principal_kind='local_cli' LIMIT 1`, [w.sourceId, COMPANY.slug]);
        const [{ ceiling }] = await engine.executeRaw<{ ceiling: string }>('SELECT grant_ceiling::text AS ceiling FROM persistence_local_writers WHERE id=$1::uuid', [writer.id]);
        await engine.executeRaw(`UPDATE persistence_local_writers SET grant_ceiling = jsonb_set(grant_ceiling, ${narrowed}) WHERE id=$1::uuid`, [writer.id]);
        try {
          const factsBefore = await w.facts();
          w.repair(COMPANY);
          expect(await w.sweep()).toBe(0);
          expect(await w.journal()).toEqual(refusedFirstPass);
          expect(await w.facts()).toEqual(factsBefore);
          expect(w.logs.join('\n')).toMatch(/grant|unconfined/);
        } finally {
          await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1::uuid', [writer.id, ceiling]);
        }
      });
    }
  }, 180_000);

  test('only an input-keyed extraction that asked for it is marked for follow-ups', async () => {
    named = [COMPANY];
    await onEachEngine('session', async (engine, dir) => {
      const w = await refusedWindow(engine, dir, [COMPANY], []);
      const base = { engine, sourceId: w.sourceId, source: 'sweep:corpus', sessionId: 'example-session', operationContext: w.ctx } as unknown as FactsBackstopCtx;
      const marked = async (extra: Partial<FactsBackstopCtx>) =>
        (await prepareManagedFactsSession({ ...base, ...extra }, { turnText: transcript() } as never))?.fileRefusalRetry;
      expect(await marked({ reAdmitFileRefusals: true })).toBe(true);
      expect(await marked({})).toBe(false);
      expect(await marked({ reAdmitFileRefusals: true, requestId: randomUUID() })).toBe(false);
    });
  }, 180_000);
});
