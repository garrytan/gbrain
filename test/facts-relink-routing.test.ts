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
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { runFactsRelink } from '../src/core/facts/relink.ts';
import { applyExplicitRelink, previewExplicitRelink } from '../src/core/facts/relink-explicit.ts';
import { runFactsCommand } from '../src/commands/facts.ts';
import { digest } from '../src/core/persistence/digest.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite, withWriteTrust } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
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
  await seedEntity('companies/cobalt.example', 'Cobalt Example', true);
  await registerLocalWriter(engine, 'cli');
  await activatePersistence(engine, { confirmQuiesced: true });
  const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => withWriteTrust(tx, {
    tier: 'external_untrusted', origin: { channel: 'derive:facts_backstop' },
  }, async () => (await tx.insertFact({
    fact: 'Basalt Example signed a pilot', kind: 'fact', entity_slug: null, visibility: 'private', source: 'chat',
    claim_metric: 'deal_value', claim_value: 42, claim_unit: 'USD',
    valid_from: new Date('2026-01-01T12:08:23.885Z'), valid_until: new Date('2099-01-02T12:08:23.123Z'),
  }, { source_id: 'default' })).id), TEST_WRITE_ATTRIBUTION));
  expect((await relink()).linked).toBe(1);
  const rowNum = await expectAdopted(id, 'companies/basalt-example');
  const file = parseFactsFence(readFileSync(join(repo, 'companies/basalt-example.md'), 'utf8')).facts;
  expect(file.find(f => f.rowNum === rowNum)).toMatchObject({
    claim: 'Basalt Example signed a pilot', visibility: 'private', source: 'chat',
    claimMetric: 'deal_value', claimValue: 42, claimUnit: 'USD',
    validFrom: '2026-01-01T12:08:23.885Z', validUntil: '2099-01-02T12:08:23.123Z',
  });
  const [projected] = await engine.executeRaw('SELECT write_origin, trust_tier, valid_from, valid_until FROM facts WHERE id=$1', [id]);
  expect(projected).toMatchObject({
    write_origin: { channel: 'derive:facts_backstop' }, trust_tier: 'external_untrusted',
    valid_from: new Date('2026-01-01T12:08:23.885Z'), valid_until: new Date('2099-01-02T12:08:23.123Z'),
  });
}));

test(`${backend}: explicit relink publishes one private fact by ID and replays its receipt`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'companies/cobalt.example';
  const claim = 'Verify the restore before bringing the test service back.';
  const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => withWriteTrust(tx, {
    tier: 'external_untrusted', origin: { channel: 'derive:facts_backstop' },
  }, async () => (await tx.insertFact({ fact: claim, kind: 'event', visibility: 'private', entity_slug: null,
    source: 'mcp:put_page', valid_from: new Date('2026-01-01T12:08:23.885Z') }, { source_id: 'default' })).id), TEST_WRITE_ATTRIBUTION));
  const sql = 'SELECT id, entity_slug, visibility, source, created_at, write_origin, trust_tier, valid_from FROM facts WHERE id=$1';
  const [before] = await engine.executeRaw(sql, [id]);
  const file = join(repo, `${slug}.md`);
  const original = readFileSync(file, 'utf8');
  const planPath = join(home, 'cobalt-relink.json');
  const previewArgs = ['relink', '--source', 'default', '--fact-id', String(id), '--entity', slug, '--evidence', 'verified synthetic source', '--dry-run', '--plan-out', planPath];
  expect(await runFactsCommand(engine, previewArgs, config, 'default')).toBe(0);
  await expect(runFactsCommand(engine, previewArgs, config, 'default')).rejects.toMatchObject({ code: 'invalid_params' });
  const saved = JSON.parse(readFileSync(planPath, 'utf8'));
  expect(await engine.executeRaw(sql, [id])).toEqual([before]);
  expect(readFileSync(file, 'utf8')).toBe(original);
  await expect(applyExplicitRelink(engine, config, 'other', saved)).rejects.toMatchObject({ code: 'invalid_params' });
  expect(await runFactsCommand(engine, ['relink', '--apply-plan', planPath], config, 'default')).toBe(0);
  const result = await applyExplicitRelink(engine, config, 'default', saved);
  expect(result).toMatchObject({ ok: true, outcome: { linked: [{ id, row_num: 1 }], queued: 0 }, requestId: expect.any(String) });
  expect(await applyExplicitRelink(engine, config, 'default', saved)).toEqual(result);
  const altered = { ...saved.plan, pin: { ...saved.plan.pin, evidenceHash: digest('A different source was verified.') } };
  await expect(applyExplicitRelink(engine, config, 'default', { plan: altered, checksum: digest(altered) })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  expect(await engine.executeRaw(sql, [id])).toEqual([{ ...before, entity_slug: slug }]);
  expect(parseFactsFence(readFileSync(file, 'utf8')).facts).toMatchObject([{ claim, visibility: 'private', validFrom: '2026-01-01T12:08:23.885Z' }]);
  const chunks = await engine.getChunks(slug, { sourceId: 'default' });
  expect(chunks.map(chunk => chunk.chunk_text).join('\n')).not.toContain(claim);
  expect(readFileSync(file, 'utf8')).not.toContain('verified synthetic source');
  const [receipts] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE operation='relink_fact_by_id' AND slug=$1 AND state='committed'", [slug]);
  expect(receipts?.n).toBe(1);
  const [gitEffects] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects e
    JOIN persistence_requests r ON r.id=e.request_id WHERE r.slug=$1 AND r.operation='relink_fact_by_id' AND e.kind='git'`, [slug]);
  expect(gitEffects?.n).toBe(0);
}));

test(`${backend}: explicit relink refuses a changed fact preimage`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'companies/cobalt.example';
  const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
    (await tx.insertFact({ fact: 'Use separate recovery fixtures.', kind: 'fact', visibility: 'private', entity_slug: null, source: 'chat' }, { source_id: 'default' })).id, TEST_WRITE_ATTRIBUTION));
  const saved = await previewExplicitRelink(engine, 'default', slug, id, 'verified synthetic source');
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw('UPDATE facts SET created_at=created_at-interval \'1 second\' WHERE id=$1', [id]), TEST_WRITE_ATTRIBUTION));
  await expect(applyExplicitRelink(engine, config, 'default', saved)).rejects.toMatchObject({ code: 'revision_conflict', writeRequest: { request_id: expect.any(String) } });
  const [fact] = await engine.executeRaw('SELECT entity_slug FROM facts WHERE id=$1', [id]);
  expect(fact).toEqual({ entity_slug: null });
}));

test(`${backend}: explicit relink respects the original speaker attribution`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const attributed_to of ['assistant', 'other'] as const) {
    const { id } = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
      tx.insertFact({ fact: 'Record the original speaker.', kind: 'fact', visibility: 'private', entity_slug: null,
        source: 'chat', attributed_to }, { source_id: 'default' }), TEST_WRITE_ATTRIBUTION));
    await expect(previewExplicitRelink(engine, 'default', 'companies/cobalt.example', id, 'verified synthetic source')).rejects.toThrow('not_user_attributed');
  }
}));

test(`${backend}: explicit relink rejects private facts on a Git-canonical source and a stale destination revision`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'companies/cobalt.example';
  const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
    (await tx.insertFact({ fact: 'Keep a distinct restore fixture.', kind: 'fact', visibility: 'private', entity_slug: null, source: 'chat' }, { source_id: 'default' })).id, TEST_WRITE_ATTRIBUTION));
  const saved = await previewExplicitRelink(engine, 'default', slug, id, 'verified synthetic source');
  await engine.executeRaw("UPDATE sources SET config=config || '{\"canonical\":\"git\"}'::jsonb WHERE id='default'");
  try {
    await expect(previewExplicitRelink(engine, 'default', slug, id, 'verified synthetic source')).rejects.toMatchObject({ code: 'permission_denied' });
  } finally {
    await engine.executeRaw("UPDATE sources SET config=config-'canonical' WHERE id='default'");
  }
  execFileSync('git', ['init', '--quiet', repo]);
  try {
    await expect(previewExplicitRelink(engine, 'default', slug, id, 'verified synthetic source')).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(applyExplicitRelink(engine, config, 'default', saved)).rejects.toMatchObject({ code: 'permission_denied', writeRequest: { request_id: expect.any(String) } });
  } finally {
    rmSync(join(repo, '.git'), { force: true, recursive: true });
  }
  const currentPlan = await previewExplicitRelink(engine, 'default', slug, id, 'verified synthetic source');
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
    "UPDATE pages SET title='Cobalt Example, revised' WHERE source_id='default' AND slug=$1", [slug]), TEST_WRITE_ATTRIBUTION));
  await expect(applyExplicitRelink(engine, config, 'default', currentPlan)).rejects.toMatchObject({ code: 'revision_conflict', writeRequest: { request_id: expect.any(String) } });
  const [fact] = await engine.executeRaw('SELECT entity_slug FROM facts WHERE id=$1', [id]);
  expect(fact).toEqual({ entity_slug: null });
}));

test(`${backend}: explicit relink cannot report success when the target write deduplicates to another page`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'companies/dedup-target';
  const claim = 'Use a checksum to identify each recovery fixture.';
  const title = 'Recovery Fixture';
  const body = 'Test company.';
  const fm = { id: 'synthetic-shared-id' };
  const from = '2026-01-01T12:08:23.885Z';
  const matching = upsertFactRow(body, { rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium',
    source: 'chat', context: 'entity relinked by operator', validFrom: from }).body;
  const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.putPage(slug, { title, type: 'company', compiled_truth: body, timeline: '', frontmatter: fm });
    const { parseMarkdown } = await import('../src/core/markdown.ts');
    const rendered = parseMarkdown(serializePageToMarkdown({ title, type: 'company', compiled_truth: matching, timeline: '', frontmatter: fm } as never, []), 'companies/dedup-twin');
    await tx.putPage('companies/dedup-twin', { title, type: 'company', compiled_truth: rendered.compiled_truth, timeline: '', frontmatter: fm });
    return (await tx.insertFact({ fact: claim, entity_slug: null, visibility: 'world', kind: 'fact', source: 'chat', valid_from: new Date(from) }, { source_id: 'default' })).id;
  }, TEST_WRITE_ATTRIBUTION));
  for (const target of [slug, 'companies/dedup-twin']) {
    const snapshot = (await engine.readPageSnapshot(target, { sourceId: 'default' }))!;
    writeFileSync(join(repo, `${target}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
  }
  const saved = await previewExplicitRelink(engine, 'default', slug, id, 'verified synthetic source');
  await expect(applyExplicitRelink(engine, config, 'default', saved)).rejects.toMatchObject({ code: 'revision_conflict', message: 'The exact target would not publish the selected fact.', writeRequest: { request_id: expect.any(String) } });
  const [fact] = await engine.executeRaw('SELECT entity_slug FROM facts WHERE id=$1', [id]);
  expect(fact).toEqual({ entity_slug: null });
  expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe(body);
}));
