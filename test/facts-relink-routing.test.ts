/**
 * #5836 — relink ends where a fresh remember would: the canonical file plus
 * page body for a bound write-through source, the page body only when
 * write-through is off, a refusal (`unfenceable`) for an unbound
 * write-through source, and the same file publication on a managed brain.
 * Every branch is followed by the extract_facts reconcile, which must find
 * nothing to change and no legacy rows. Postgres runs through
 * test/e2e/facts-relink-routing.test.ts. Synthetic data only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { runFactsRelink } from '../src/core/facts/relink.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

const backend = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? 'postgres' : 'pglite';
const home = mkdtempSync(join(tmpdir(), 'gbrain-relink-routing-'));
const repo = join(home, 'canonical');
let engine: BrainEngine;
let closeEngine: () => Promise<void> = async () => {};
const config = { engine: backend } as never;

beforeAll(async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: 'host' }, async () => {
  const fixture = await isolatedSharedSkillsEngine(backend === 'postgres' ? requirePostgresTestDatabase() : undefined);
  engine = fixture.engine; closeEngine = fixture.close;
  mkdirSync(join(repo, 'companies'), { recursive: true });
  await engine.setConfig('decide.slots.conflict.mode', 'off');
}), 120_000);

afterAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await disposePersistenceConsumer(engine); await closeEngine();
  rmSync(home, { recursive: true, force: true });
}));

async function seedEntity(slug: string, title: string, writeFile: boolean): Promise<void> {
  await engine.putPage(slug, { type: 'company', title, compiled_truth: `# ${title}\n\nA company.`, timeline: '', frontmatter: {} });
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (writeFile) writeFileSync(join(repo, `${slug}.md`), serializePageToMarkdown(snapshot!.page, snapshot!.tags));
}

async function unlinked(fact: string): Promise<number> {
  return (await engine.insertFact({ fact, kind: 'fact', entity_slug: null, visibility: 'world', source: 'chat' } as never, { source_id: 'default' })).id;
}

async function expectAdopted(id: number, slug: string): Promise<number> {
  const [row] = await engine.executeRaw<{ entity_slug: string; source_markdown_slug: string; row_num: number }>(
    'SELECT entity_slug, source_markdown_slug, row_num FROM facts WHERE id=$1', [id]);
  expect(row).toMatchObject({ entity_slug: slug, source_markdown_slug: slug });
  const page = await engine.getPage(slug, { sourceId: 'default' });
  expect(parseFactsFence(page!.compiled_truth).facts.some(f => f.rowNum === Number(row!.row_num))).toBe(true);
  const reconcile = await runExtractFacts(engine, { sourceId: 'default' });
  expect(reconcile).toMatchObject({ legacyRowsPending: 0, guardTriggered: false, factsInserted: 0, factsDeleted: 0 });
  return Number(row!.row_num);
}

const relink = () => runFactsRelink(engine, { sourceId: 'default', config, llm: false });

test(`${backend}: write-through off fences into the page body only`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo]);
  await engine.setConfig('sync.write_through', 'false');
  await seedEntity('companies/zinc-example', 'Zinc Example', false);
  const id = await unlinked('Zinc Example opened a second office');
  expect((await relink()).linked).toBe(1);
  await expectAdopted(id, 'companies/zinc-example');
  await engine.setConfig('sync.write_through', 'true');
}));

test(`${backend}: an unbound write-through source is refused as unfenceable`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await seedEntity('companies/onyx-example', 'Onyx Example', true);
  const id = await unlinked('Onyx Example hired a CFO');
  const report = await relink();
  expect(report.skipped.unfenceable).toBe(1);
  const [row] = await engine.executeRaw<{ entity_slug: string | null }>('SELECT entity_slug FROM facts WHERE id=$1', [id]);
  expect(row!.entity_slug).toBeNull();
}));

test(`${backend}: a bound write-through source writes the canonical file`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await engine.setConfig('sync.repo_path', repo);
  await claimWorktree(engine, 'default', repo);
  await seedEntity('companies/acme-example', 'Acme Example', true);
  const id = await unlinked('Acme Example raised a seed round');
  expect((await relink()).linked).toBeGreaterThanOrEqual(1);
  const rowNum = await expectAdopted(id, 'companies/acme-example');
  const file = parseFactsFence(readFileSync(join(repo, 'companies/acme-example.md'), 'utf8')).facts;
  expect(file.find(f => f.rowNum === rowNum)?.claim).toBe('Acme Example raised a seed round');
}));

test(`${backend}: remember falls back when the inferred entity's canonical file is missing`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await seedEntity('companies/quartz-example', 'Quartz Example', true);
  const { rmSync: rm } = await import('node:fs');
  rm(join(repo, 'companies/quartz-example.md'));
  const { operations } = await import('../src/core/operations.ts');
  const rememberOp = operations.find(o => o.name === 'remember')!;
  const ctx = { engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' } as any;
  const saved = await rememberOp.handler(ctx, { fact: 'Quartz Example renewed its contract', provenance: 'chat' }) as Record<string, any>;
  const outcome = saved.write_request?.outcome ?? saved;
  expect(outcome.entity_slug ?? null).toBeNull();
  expect(outcome.warnings).toEqual(['ENTITY_LINK_FAILED']);
}));

test(`${backend}: a managed brain publishes the same way through the coordinator`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await seedEntity('companies/basalt-example', 'Basalt Example', true);
  await registerLocalWriter(engine, 'cli');
  await activatePersistence(engine, { confirmQuiesced: true });
  const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
    (await tx.insertFact({ fact: 'Basalt Example signed a pilot', kind: 'fact', entity_slug: null, visibility: 'world', source: 'chat' } as never, { source_id: 'default' })).id));
  expect((await relink()).linked).toBe(1);
  const rowNum = await expectAdopted(id, 'companies/basalt-example');
  const file = parseFactsFence(readFileSync(join(repo, 'companies/basalt-example.md'), 'utf8')).facts;
  expect(file.find(f => f.rowNum === rowNum)?.claim).toBe('Basalt Example signed a pilot');
}));
