/** #capture-policy: exercise both writers with synthetic source-scoped PGLite pages. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsPipeline } from '../src/core/facts/backstop.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import { checkPageCap, readPageCap } from '../src/core/facts/page-cap.ts';
let engine: PGLiteEngine;
let home: string;
const company = 'companies/acme-example';
const person = 'people/alice-example';
let claim = '';
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
beforeEach(async () => {
  await disposePersistenceConsumer(engine); await resetPgliteState(engine);
  home = mkdtempSync(join(process.cwd(), '.capture-policy-test-'));
  await engine.setConfig('facts.extraction_model', 'openai:gpt-4o-mini');
  configureGateway({ env: { OPENAI_API_KEY: 'test' } });
  __setChatTransportForTests(async () => ({ text: JSON.stringify({ facts: [{ fact: claim, entity: company, kind: 'fact', notability: 'medium', confidence: 1 }] }), blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' }));
  for (const [slug, type, title] of [[company, 'company', 'Acme Example'], [person, 'person', 'Alice Example'], ['projects/sunrise', 'project', 'Project Sunrise']]) {
    await engine.putPage(slug!, { type: type!, title: title!, compiled_truth: 'Synthetic entity.' }, { sourceId: 'default' });
    if (slug === 'projects/sunrise') await engine.setPageAliases(slug, 'default', ['project sunrise']);
    const path = join(home, `${slug}.md`); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\ntype: ${type}\ntitle: ${title}\n---\nSynthetic entity.\n`);
  }
});
afterEach(async () => { await disposePersistenceConsumer(engine); __setChatTransportForTests(null); resetGateway(); rmSync(home, { recursive: true, force: true }); });
afterAll(async () => { await engine.disconnect(); });
async function run(managed = false) {
  if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return withEnv({ GBRAIN_HOME: home }, () => runFactsPipeline(`Synthetic source turn: ${claim}`, { engine, config: { engine: 'pglite', embedding_disabled: true }, sourceId: 'default', source: 'mcp:extract_facts', sessionId: null, remote: false }));
}
for (const mode of ['off', 'shadow', 'on']) test(`filter ${mode} preserves or drops at admission`, async () => {
  claim = 'Meeting tomorrow at 3pm'; await engine.setConfig('facts.capture_filter', mode);
  const result = await run();
  expect(result.inserted).toBe(mode === 'on' ? 0 : 1);
  if (mode !== 'off') expect(result[mode === 'on' ? 'filtered' : 'would_filter']).toBe(1);
});
for (const managed of [false, true]) for (const mode of ['off', 'shadow', 'on']) test(`routing ${mode}, managed=${managed}`, async () => {
  claim = 'Alice Example prefers written progress reports'; await engine.setConfig('facts.capture_routing', mode);
  const result = await run(managed);
  expect(result.inserted).toBe(1);
  if (mode !== 'off') expect(result[mode === 'on' ? 'rerouted' : 'would_reroute']).toBe(1);
  const [row] = await engine.executeRaw<{ entity_slug: string; context: string | null }>('SELECT entity_slug,context FROM facts WHERE id=$1', [result.fact_ids[0]]);
  expect(row?.entity_slug).toBe(mode === 'on' ? person : company);
  if (mode === 'on') expect(row?.context).toContain(`routed from ${company}`);
}, 60_000);
test('legacy cap refuses without fence or index changes and permits replacement', async () => {
  await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [home, 'default']);
  await engine.setConfig('facts.page_cap.warn_rows', '1'); await engine.setConfig('facts.page_cap.max_rows', '2');
  const target = { sourceId: 'default', slug: company, localPath: home, resolutionSource: 'exact_page' as const };
  const fact = (text: string) => ({ fact: text, kind: 'fact' as const, notability: 'medium' as const, source: 'fixture', visibility: 'private' as const, embedding: null, sessionId: null });
  await withEnv({ GBRAIN_HOME: home }, async () => {
    expect((await writeFactsToFence(engine, target, [fact('First synthetic claim')])).inserted).toBe(1);
    expect((await writeFactsToFence(engine, target, [fact('Second synthetic claim')])).inserted).toBe(1);
    const before = readFileSync(join(home, `${company}.md`), 'utf8');
    expect((await writeFactsToFence(engine, target, [fact('Third synthetic claim')])).capped).toBe(1);
    expect(readFileSync(join(home, `${company}.md`), 'utf8')).toBe(before);
    const rows = await engine.executeRaw('SELECT id FROM facts WHERE source_markdown_slug=$1', [company]);
    expect(rows.length).toBe(parseFactsFence(before).facts.length);
    expect((await engine.executeRaw("SELECT id FROM ingest_log WHERE summary LIKE 'page_cap:%'")).length).toBeGreaterThan(0);
    expect((await writeFactsToFence(engine, target, [{ ...fact('Replacement synthetic claim'), replacesExisting: true }])).inserted).toBe(1);
  });
});
test('managed cap refuses automatic appends without DB-only rows', async () => {
  await engine.setConfig('facts.page_cap.warn_rows', '1'); await engine.setConfig('facts.page_cap.max_rows', '1');
  claim = 'Acme Example has an annual planning process'; expect((await run(true)).inserted).toBe(1);
  claim = 'Acme Example has a different review process'; const result = await run();
  expect(result.inserted).toBe(0); expect(result.capped).toBe(1);
  const page = await engine.getPage(company, { sourceId: 'default' });
  const rows = await engine.executeRaw('SELECT id FROM facts WHERE entity_slug=$1', [company]);
  expect(rows.length).toBe(1); expect(parseFactsFence(page!.compiled_truth).facts.length).toBe(1);
}, 60_000);
test('caps validate and zero disables', async () => {
  expect(await checkPageCap(engine, 'default', company, 5000)).toBe(true);
  await engine.setConfig('facts.page_cap.warn_rows', '10'); await engine.setConfig('facts.page_cap.max_rows', '5');
  expect(readPageCap(engine)).rejects.toThrow('at least');
});

for (const managed of [false, true]) test(`withdrawn broad claim cannot reroute, managed=${managed}`, async () => {
  claim = 'Alice Example prefers monthly written reports';
  await engine.setConfig('facts.capture_routing', 'on');
  await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES('default','private',$1,gbrain_fact_fingerprint($2))", [company, claim]);
  const result = await run(managed);
  expect(result.inserted).toBe(0); expect(result.withdrawn_skipped).toBe(1);
  expect(await engine.executeRaw('SELECT id FROM facts')).toHaveLength(0);
}, 60_000);
for (const managed of [false, true]) test(`remember bypasses filter, reports cap, and permits replaces; managed=${managed}`, async () => {
  const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');
  if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await engine.setConfig('facts.capture_filter', 'on');
  await engine.setConfig('facts.page_cap.max_rows', '1');
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const call = async (fact: string, extra: Record<string, unknown> = {}) => {
      const result = await dispatchToolCall(engine, 'remember', { fact, entity: person, provenance: 'synthetic fixture', ...extra }, { remote: false });
      return { error: result.isError === true, body: JSON.parse(result.content[0]!.text!) };
    };
    const first = await call('Meeting tomorrow at 3pm'); expect(first.error).toBe(false);
    const capped = await call('Meeting Friday at 4pm'); expect(capped.error).toBe(true);
    expect(JSON.stringify(capped.body)).toContain('facts.page_cap.max_rows');
    const replacement = await call('Meeting Monday at 5pm', { replaces: first.body.id });
    expect(replacement.error).toBe(false); expect(replacement.body.status).toBe('superseded');
    const page = await engine.getPage(person, { sourceId: 'default' });
    expect(parseFactsFence(page!.compiled_truth).facts.length).toBe(2);
    const indexed = await engine.executeRaw('SELECT id FROM facts WHERE source_markdown_slug=$1', [person]);
    expect(indexed.length).toBe(2);
  });
}, 60_000);

test('managed routing publishes the specific project fence and replays its routing count', async () => {
  claim = 'Project Sunrise has an independent release process';
  await engine.setConfig('facts.capture_routing', 'on');
  const first = await run(true);
  expect(first.rerouted).toBe(1);
  const [row] = await engine.executeRaw<{ entity_slug: string; source_markdown_slug: string }>('SELECT entity_slug,source_markdown_slug FROM facts WHERE id=$1', [first.fact_ids[0]]);
  expect(row).toMatchObject({ entity_slug: 'projects/sunrise', source_markdown_slug: 'projects/sunrise' });
  const replay = await run();
  expect(replay.rerouted).toBe(1); expect(replay.fact_ids).toEqual(first.fact_ids);
}, 60_000);
