/** #6686: managed fact appends must see a legacy fence below the timeline sentinel.
 * Real journal/coordinator publication on PGLite and optional Postgres, no providers.
 * The remember/extract_facts × body/timeline/quoted cases and the replacement case are from PR #6689 (Contributed by @javieraldape).
 * Serial: configures the process-global gateway and persistence consumer registry.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { parseFactsFence, upsertFactRow, FACTS_FENCE_BEGIN } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { prepareManagedFactsMutation } from '../src/core/persistence/facts-prepare.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const config = { embedding_disabled: true };
const claim = 'Private historical preference';
const fresh = 'Prefers asynchronous weekly reports';
const biography = 'Synthetic biography with preserved prose.';
const history = '## Timeline\n\n- 2026-10-01: Preserved historical event.';
const oldFence = upsertFactRow('', { rowNum: 7, claim, kind: 'preference', visibility: 'private', confidence: 1, notability: 'medium', source: 'fixture' }).body;

beforeAll(async () => {
  configureGateway({ ...config, env: {} });
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine);
    } else {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close;
    }
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway();
});

async function fixture(engine: BrainEngine, section: 'body' | 'timeline' | 'quoted') {
  const sourceId = `timeline-facts-${randomUUID()}`;
  const slug = 'people/example';
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  const quoted = `\n\n\`\`\`markdown\n${oldFence}\n\`\`\``;
  await engine.putPage(slug, { type: 'person', title: 'Example', compiled_truth: biography + (section === 'body' ? `\n\n${oldFence}` : ''),
    timeline: history + (section === 'timeline' ? `\n\n${oldFence}` : section === 'quoted' ? quoted : ''),
    frontmatter: { private_metadata: 'preserved fixture' } }, { sourceId });
  await engine.addTag(slug, 'preserved-tag', { sourceId });
  let oldId: number | undefined;
  if (section !== 'quoted') {
    oldId = (await engine.insertFacts([{ fact: claim, entity_slug: slug, source_markdown_slug: slug, row_num: 7,
      kind: 'preference', visibility: 'private', source: 'fixture', confidence: 1 }], { source_id: sourceId })).ids[0];
  }
  await registerLocalWriter(engine, 'cli');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const ctx: OperationContext = { engine, sourceId, config: { ...config, engine: engine.kind }, remote: false,
    dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  return { sourceId, slug, ctx, oldId };
}

async function extract(engine: BrainEngine, f: Awaited<ReturnType<typeof fixture>>) {
  await disposePersistenceConsumer(engine);
  const snapshot = (await engine.readPageSnapshot(f.slug, { sourceId: f.sourceId }))!;
  const authority = await submissionAuthority(f.ctx, 'extract_facts', f.sourceId, snapshot.sourceIncarnation, f.slug);
  const intent = { kind: 'managed_facts_entity', batchKey: randomUUID(), inputDigest: randomUUID(), expected_revision: snapshot.revision,
    facts: [{ fact: fresh, entity_slug: f.slug, source: 'fixture extraction', kind: 'preference', visibility: 'world', confidence: 1,
      valid_from: '2026-10-14T00:00:00.000Z', valid_until: null, embedding: null }] };
  const row = await admitWrite(engine, { principal: authority.principal, operation: 'extract_facts', sourceId: f.sourceId,
    sourceIncarnation: snapshot.sourceIncarnation, slug: f.slug, pageId: snapshot.page.id, callerIntent: intent, intent, authority, requestId: randomUUID() });
  const claimed = (await claimNextWrite(engine, localHostId()))!;
  expect(claimed.id).toBe(row.id);
  const result = await publishMutation(engine, claimed, await prepareManagedFactsMutation(engine, claimed, f.ctx.config), localHostId());
  expect(result.state).toBe('committed');
  expect((await getWriteRequestById(engine, row.id))?.outcome).toMatchObject({ inserted: 1, fenced: true });
}

async function assertPage(engine: BrainEngine, f: Awaited<ReturnType<typeof fixture>>, section: 'body' | 'timeline' | 'quoted', supersedes = false) {
  const snapshot = (await engine.readPageSnapshot(f.slug, { sourceId: f.sourceId }))!;
  const page = snapshot.page;
  expect(page.compiled_truth).toContain(biography);
  expect(page.timeline).toContain(history);
  expect(page.frontmatter.private_metadata).toBe('preserved fixture');
  expect(snapshot.tags).toEqual(['preserved-tag']);
  const content = serializePageToMarkdown(page, snapshot.tags);
  const facts = parseFactsFence(content);
  expect(facts.warnings).toEqual([]);
  expect(facts.facts.map(row => row.claim)).toEqual(section === 'quoted' ? [fresh] : [claim, fresh]);
  const selected = section === 'timeline' ? page.timeline : page.compiled_truth;
  expect(parseFactsFence(selected).facts).toHaveLength(section === 'quoted' ? 1 : 2);
  if (section === 'timeline') expect(page.compiled_truth).toBe(biography);
  if (section === 'quoted') expect(page.timeline).toContain(oldFence);
  else expect(content.split(FACTS_FENCE_BEGIN)).toHaveLength(2);
  const rows = await engine.executeRaw<{ fact: string; row_num: number; expired: boolean }>(
    'SELECT fact,row_num,expired_at IS NOT NULL AS expired FROM facts WHERE source_id=$1 ORDER BY row_num', [f.sourceId]);
  expect(rows.map(row => row.fact)).toEqual(section === 'quoted' ? [fresh] : [claim, fresh]);
  if (section !== 'quoted') {
    expect(rows.map(row => Number(row.row_num))).toEqual([7, 8]);
    expect(facts.facts[0].active).toBe(!supersedes);
    expect(rows[0].expired).toBe(supersedes);
  }
  expect((await engine.getChunks(f.slug, { sourceId: f.sourceId })).map(c => c.chunk_text).join('\n')).not.toContain(claim);
}

for (const writer of ['remember', 'extract_facts'] as const) {
  describe(`${writer} preserves canonical timeline facts`, () => {
    for (const section of ['timeline', 'body', 'quoted'] as const) {
      test(`appends without splitting the ${section} fence or losing private history`, async () => {
        for (const engine of engines) {
          const f = await fixture(engine, section);
          try {
            if (writer === 'remember') {
              const params = { fact: fresh, provenance: 'fixture', entity: f.slug, request_id: randomUUID() };
              const receipt = await submitRememberMutation(f.ctx, params, 30_000);
              expect(receipt.state).toBe('committed');
              await disposePersistenceConsumer(engine);
              expect(await submitRememberMutation(f.ctx, params)).toEqual(receipt);
            } else await extract(engine, f);
            await assertPage(engine, f, section);
          } finally { await disposePersistenceConsumer(engine); }
        }
      }, 120_000);
    }
  });
}
test('caller replacement strikes the old timeline row and preserves row identity', async () => {
  for (const engine of engines) {
    const f = await fixture(engine, 'timeline');
    try {
      const receipt = await submitRememberMutation(f.ctx, { fact: fresh, provenance: 'fixture', entity: f.slug,
        visibility: 'private', replaces: String(f.oldId), request_id: randomUUID() }, 30_000);
      expect(receipt.state).toBe('committed');
      await assertPage(engine, f, 'timeline', true);
    } finally { await disposePersistenceConsumer(engine); }
  }
}, 120_000);

test('a timeline-only page whose index holds rows beyond its fence numbers the new row past both (#6541 shape)', async () => {
  for (const engine of engines) {
    const f = await fixture(engine, 'timeline');
    try {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.insertFacts([{ fact: 'Indexed outside the fence', entity_slug: f.slug, source_markdown_slug: f.slug, row_num: 9,
        kind: 'fact', visibility: 'world', source: 'fixture', confidence: 1 }], { source_id: f.sourceId });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const before = (await engine.readPageSnapshot(f.slug, { sourceId: f.sourceId }))!.page;
      const receipt = await submitRememberMutation(f.ctx, { fact: fresh, provenance: 'fixture', entity: f.slug, request_id: randomUUID() }, 30_000);
      expect(receipt.state).toBe('committed');
      const page = (await engine.readPageSnapshot(f.slug, { sourceId: f.sourceId }))!.page;
      expect(page.compiled_truth).toBe(before.compiled_truth);
      expect(parseFactsFence(page.compiled_truth).facts).toEqual([]);
      expect(parseFactsFence(page.timeline).facts.map(row => [row.rowNum, row.claim])).toEqual([[7, claim], [10, fresh]]);
      expect(page.timeline.startsWith(history)).toBe(true);
    } finally { await disposePersistenceConsumer(engine); }
  }
}, 120_000);

test('on a split page, a replacement strikes the old row in the timeline fence that holds it', async () => {
  for (const engine of engines) {
    const f = await fixture(engine, 'timeline');
    try {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const above = upsertFactRow('', { rowNum: 8, claim: 'Added above by an older writer', kind: 'fact', visibility: 'world', confidence: 1, notability: 'medium', source: 'fixture' }).body;
      const snapshot = (await engine.readPageSnapshot(f.slug, { sourceId: f.sourceId }))!;
      await engine.putPage(f.slug, { type: 'person', title: 'Example', compiled_truth: `${biography}\n\n${above}`, timeline: snapshot.page.timeline,
        frontmatter: snapshot.page.frontmatter }, { sourceId: f.sourceId });
      await engine.insertFacts([{ fact: 'Added above by an older writer', entity_slug: f.slug, source_markdown_slug: f.slug, row_num: 8,
        kind: 'fact', visibility: 'world', source: 'fixture', confidence: 1 }], { source_id: f.sourceId });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const receipt = await submitRememberMutation(f.ctx, { fact: fresh, provenance: 'fixture', entity: f.slug,
        visibility: 'private', replaces: String(f.oldId), request_id: randomUUID() }, 30_000);
      expect(receipt.state).toBe('committed');
      const page = (await engine.readPageSnapshot(f.slug, { sourceId: f.sourceId }))!.page;
      const struck = parseFactsFence(page.timeline).facts.find(row => row.rowNum === 7)!;
      expect([struck.active, struck.supersededBy]).toEqual([false, 9]);
      expect(parseFactsFence(page.compiled_truth).facts.map(row => [row.rowNum, row.claim])).toEqual([[8, 'Added above by an older writer'], [9, fresh]]);
    } finally { await disposePersistenceConsumer(engine); }
  }
}, 120_000);
