/** capture-policy PR: exercise both writers with synthetic source-scoped PGLite pages. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  home = mkdtempSync(join(tmpdir(), 'capture-policy-test-'));
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
for (const managed of [false, true]) for (const mode of ['off', 'shadow', 'on']) test(`filter ${mode}, managed=${managed} preserves or drops at admission`, async () => {
  claim = 'Meeting scheduled for tomorrow at 3pm'; await engine.setConfig('facts.capture_filter', mode);
  const result = await run(managed);
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
    const mixed = await writeFactsToFence(engine, target, [
      { ...fact('Replacement synthetic claim'), replacesExisting: true }, fact('Refused extra append')]);
    expect(mixed.inserted).toBe(1); expect(mixed.capped).toBe(1);
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
  expect(checkPageCap(await readPageCap(engine), 5000).refuse).toBe(false);
  await engine.setConfig('facts.page_cap.warn_rows', '10'); await engine.setConfig('facts.page_cap.max_rows', '5');
  await expect(readPageCap(engine)).rejects.toThrow('at least');
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

test('locked validation detects a tightened cap without policy log side effects', async () => {
  const { installFaultHook } = await import('../src/core/persistence/fault-points.ts');
  await engine.setConfig('facts.page_cap.max_rows', '2');
  claim = 'Acme Example has an annual planning process';
  await run(true);
  let tightened = false;
  installFaultHook(async (point, detail) => {
    if (point === 'consumer:prepared' && detail.operation === 'extract_facts' && !tightened) {
      tightened = true;
      await engine.setConfig('facts.page_cap.max_rows', '1');
    }
  });
  try {
    claim = 'Acme Example has a quarterly review process';
    await expect(run()).rejects.toThrow('cap changed');
  } finally { installFaultHook(undefined); }
  expect(tightened).toBe(true);
  expect(await engine.executeRaw('SELECT id FROM facts WHERE entity_slug=$1', [company])).toHaveLength(1);
  expect(await engine.executeRaw("SELECT id FROM ingest_log WHERE source_type='facts:policy'")).toHaveLength(0);
}, 60_000);

test('policy-only ingest rows do not affect extraction health', async () => {
  const { writeFactsAbsorbLog } = await import('../src/core/facts/absorb-log.ts');
  const { factsExtractionEntry } = await import('../src/commands/doctor/checks/knowledge-health.ts');
  const { createProgress } = await import('../src/core/progress.ts');
  await writeFactsAbsorbLog(engine, company, 'capture_policy', 'filtered=100', 'default');
  await writeFactsAbsorbLog(engine, company, 'page_cap', 'capped=100', 'default');
  const checks = await factsExtractionEntry.run({ engine, args: [], progress: createProgress({ mode: 'quiet' }) } as unknown as import('../src/commands/doctor/context.ts').DoctorContext);
  expect(Array.isArray(checks) && checks.find(check => check.name === 'facts_extraction_health')?.status).toBe('ok');
});

for (const managed of [false, true]) test(`conversation policy counts preserve raw extraction totals, managed=${managed}`, async () => {
  const { runExtractConversationFactsCore } = await import('../src/commands/extract-conversation-facts.ts');
  await engine.setConfig('facts.capture_filter', 'shadow');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  const slug = 'conversations/capture-example';
  await engine.putPage(slug, { type: 'conversation', title: 'Synthetic chat', compiled_truth: [
    '**Alice Example** (2026-06-02 9:00 AM): Can we arrange a call?',
    '**Bob Example** (2026-06-02 9:01 AM): Yes, send the invitation.',
    '**Alice Example** (2026-06-02 9:02 AM): Tomorrow at noon works.',
    '**Bob Example** (2026-06-02 9:03 AM): Thank you, see you then.',
  ].join('\n') }, { sourceId: 'default' });
  if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug, sleepMs: 0,
      overrideDisabled: true, extractor: async () => [{ fact: 'Call scheduled for tomorrow at noon',
        kind: 'fact', notability: 'medium', entity_slug: null, confidence: 1, source: 'test' }] });
    expect(result.facts_extracted).toBe(1);
    expect(result.facts_inserted).toBe(1);
    expect(result.capture_counts?.would_filter).toBe(1);
    expect(await engine.executeRaw("SELECT id FROM ingest_log WHERE source_type='facts:policy'")).toHaveLength(1);
  });
}, 60_000);

test('relink intentionally fences existing knowledge beyond the admission cap', async () => {
  const { runFactsRelink } = await import('../src/core/facts/relink.ts');
  await engine.setConfig('facts.page_cap.max_rows', '1');
  await engine.setConfig('sync.write_through', 'false');
  await engine.insertFact({ fact: 'Acme Example opened a second office', kind: 'fact',
    entity_slug: null, visibility: 'private', source: 'test' }, { source_id: 'default' });
  await engine.insertFact({ fact: 'Acme Example hired an operations manager', kind: 'fact',
    entity_slug: null, visibility: 'private', source: 'test' }, { source_id: 'default' });
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const result = await runFactsRelink(engine, { sourceId: 'default', config: { engine: 'pglite', embedding_disabled: true }, llm: false });
    expect(result.linked).toBe(2);
    const page = await engine.getPage(company, { sourceId: 'default' });
    expect(parseFactsFence(page!.compiled_truth).facts).toHaveLength(2);
  });
}, 60_000);

test('original-subject withdrawal is rechecked beneath the managed publication guard', async () => {
  const { installFaultHook } = await import('../src/core/persistence/fault-points.ts');
  await engine.setConfig('facts.capture_routing', 'on');
  claim = 'Alice Example prefers quarterly written updates';
  let withdrawn = false;
  installFaultHook(async (point, detail) => {
    if (point === 'consumer:prepared' && detail.operation === 'extract_facts' && !withdrawn) {
      withdrawn = true;
      await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES('default','private',$1,gbrain_fact_fingerprint($2))", [company, claim]);
    }
  });
  try { await expect(run(true)).rejects.toThrow('original subject was withdrawn'); }
  finally { installFaultHook(undefined); }
  expect(withdrawn).toBe(true);
  expect(await engine.executeRaw('SELECT id FROM facts')).toHaveLength(0);
}, 60_000);

test('lower-tier explicit replacement remains allowed at the cap as contested knowledge', async () => {
  const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');
  await engine.setConfig('facts.page_cap.max_rows', '1');
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const call = async (fact: string, replaces?: number) => {
      const response = await dispatchToolCall(engine, 'remember', { fact, entity: person,
        provenance: 'synthetic fixture', ...(replaces ? { replaces } : {}) }, { remote: false });
      return { error: response.isError, body: JSON.parse(response.content[0]!.text!) };
    };
    const first = await call('Alice Example prefers annual planning');
    expect(first.error).not.toBe(true);
    const { withTrustPromotion } = await import('../src/core/persistence/context.ts');
    await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed',
      () => tx.executeRaw("UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1", [first.body.id])));
    const replacement = await call('Alice Example prefers monthly planning', first.body.id);
    expect(replacement.error).not.toBe(true);
    expect(replacement.body.status).toBe('inserted');
    const [old] = await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id=$1', [first.body.id]);
    expect(old.expired_at).toBeNull();
    const page = await engine.getPage(person, { sourceId: 'default' });
    expect(parseFactsFence(page!.compiled_truth).facts).toHaveLength(2);
  });
});

test('routing reads index-only aliases and normalizes their punctuation', async () => {
  await engine.putPage(company, { type: 'company', title: 'Holding Example', compiled_truth: 'Synthetic entity.' }, { sourceId: 'default' });
  await engine.setPageAliases(company, 'default', ['acme, inc.']);
  await engine.setConfig('facts.capture_routing', 'on');
  claim = 'Alice Example said Acme Inc is still interested in the models';
  const result = await run();
  expect(result.rerouted ?? 0).toBe(0);
  const [fact] = await engine.executeRaw<{ entity_slug: string }>('SELECT entity_slug FROM facts WHERE id=$1', [result.fact_ids[0]]);
  expect(fact.entity_slug).toBe(company);
  expect(await engine.getPageAliases(company, { sourceId: 'default' })).toEqual(['acme, inc.']);
  expect(await engine.getPageAliases(company, { sourceId: 'another-source' })).toEqual([]);
});

for (const managed of [false, true]) test(`notability threshold composes before regex shadow, managed=${managed}`, async () => {
  await engine.setConfig('facts.page_write_notability_filter', 'high-only');
  await engine.setConfig('facts.capture_filter', 'shadow');
  claim = 'Acme Example approved its annual strategy';
  // The fixture extractor labels this substantive claim medium: notability is
  // a separate threshold, while substance only vetoes the regex categories.
  const result = await run(managed);
  expect(result.inserted).toBe(0);
  expect(result.filtered).toBe(1);
  expect(result.would_filter ?? 0).toBe(0);
});
