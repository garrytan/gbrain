import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { withdrawalFenceBlocks } from '../src/core/facts/withdrawal-overlay.ts';
import { renderFactsTable, parseFactsFence, FACTS_FENCE_BEGIN } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, completeWrite } from '../src/core/persistence/journal.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { retryEmbeddingEffect } from '../src/core/persistence/effect-retry.ts';
import { upgradeWithdrawalEffect } from '../src/core/persistence/effect-targets.ts';
import type { PersistenceEffect } from '../src/core/persistence/effect-model.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { PreparedContentImport } from '../src/core/persistence/prepared-import.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

const fence = (claim: string, visibility: 'private' | 'world' = 'world') => renderFactsTable([
  { rowNum: 1, claim, visibility, kind: 'fact', confidence: 1, notability: 'medium', active: true },
]);
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

test('linear marker scanning preserves inline documentation and complete legacy fences', () => {
  const complete = fence('real claim');
  const blocks = withdrawalFenceBlocks(`Use \`${FACTS_FENCE_BEGIN}\` here.\n${complete}\n${complete}`);
  expect(blocks).toHaveLength(2);
  expect(blocks.map(block => block.parsed.facts[0].claim)).toEqual(['real claim', 'real claim']);
  expect(withdrawalFenceBlocks(`\`${complete}\``)[0].parsed.facts[0].claim).toBe('real claim');
});

for (const backend of testBackends()) describe(`bounded withdrawal ${backend}`, () => {
  let engine: BrainEngine, close: () => Promise<void>;
  const roots: string[] = [];
  const hostId = localHostId();
  beforeAll(async () => {
    if (backend === 'postgres') {
      const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = fixture.engine; close = fixture.close;
    } else {
      engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect();
    }
    await registerLocalWriter(engine, 'cli');
    await engine.setConfig('embedding_disabled', 'true');
  }, 120_000);
  afterAll(async () => { await close(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  async function fixture() {
    const sourceId = `withdrawal-${randomUUID()}`, root = mkdtempSync(join(tmpdir(), 'gbrain-withdrawal-bounded-'));
    roots.push(root);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    const binding = await claimWorktree(engine, sourceId, root, hostId);
    for (const [slug, body] of [['affected', fence('uses A | B')], ['unrelated', fence('a different claim')], ['private', fence('uses A | B', 'private')]]) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body }, { sourceId });
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }], { sourceId });
      await engine.setPageEmbeddingSignature(slug, { sourceId, signature: 'synthetic:retained:1536' });
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
    }
    await rebuildPendingPageProjections(engine, 100);
    const repository = await makeGitFixture(root);
    repository.commitAll('Synthetic baseline');
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '# gbrain brain-durability post-commit hook (v0.42.44+)\n');
    const fact = await engine.insertFact({ fact: '  USES  A | B  ', visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
    const snapshot = (await engine.readPageSnapshot('affected', { sourceId }))!;
    const authority = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext, 'forget', sourceId, binding.source_incarnation, 'affected');
    const request = await admitWrite(engine, { principal: authority.principal, authority, operation: 'forget', sourceId,
      sourceIncarnation: binding.source_incarnation, slug: 'affected', pageId: snapshot.page.id, requestId: randomUUID(),
      callerIntent: { id: fact.id }, intent: { id: fact.id }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
    const withdraw = () => engine.transaction(async tx => {
      const result = await recordFactWithdrawal(tx, fact.id, sourceId, false, { requestId: request.id });
      await completeWrite(tx, request, 'committed', { status: 'forgotten' });
      return result;
    });
    return { sourceId, root, fact, request, withdraw };
  }
  const state = (sourceId: string) => engine.executeRaw(`SELECT row_to_json(p) AS page,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM content_chunks c WHERE c.page_id=p.id) AS chunks
    FROM pages p WHERE source_id=$1 AND slug IN ('unrelated','private') ORDER BY slug`, [sourceId]);
  async function drain(requestId: string) {
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE request_id<>$1::uuid", [requestId]);
    await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid', [requestId]);
    await runPersistenceEffects(engine, { engine: backend, embedding_disabled: true }, { hostId, limit: 20 });
  }

  test('exact bytes, chunks, revisions, signatures and unrelated Git staging survive targeted effects', async () => {
    const f = await fixture(), before = await state(f.sourceId);
    const original = readFileSync(join(f.root, 'unrelated.md'));
    writeFileSync(join(f.root, 'local-edit.txt'), 'Unrelated staged edit'); git(f.root, 'add', 'local-edit.txt');
    const result = await f.withdraw();
    expect(result.pages.map(p => p.slug)).toEqual(['affected']);
    expect(await state(f.sourceId)).toEqual(before);
    const effects = await engine.executeRaw<{ data: { version: number; targets: Array<{ slug: string }>; source_scan?: boolean } }>('SELECT data FROM persistence_effects WHERE request_id=$1::uuid', [f.request.id]);
    expect(effects).toHaveLength(3);
    for (const effect of effects) {
      expect(effect.data.version).toBe(2); expect(effect.data.targets.map(t => t.slug)).toEqual(['affected']); expect(effect.data.source_scan).toBeUndefined();
    }
    await rebuildPendingPageProjections(engine, 100);
    await drain(f.request.id);
    expect(await state(f.sourceId)).toEqual(before);
    expect(readFileSync(join(f.root, 'unrelated.md'))).toEqual(original);
    expect(parseFactsFence(readFileSync(join(f.root, 'affected.md'), 'utf8')).facts[0].forgotten).toBe(true);
    expect(git(f.root, 'show', '--pretty=format:', '--name-only', 'HEAD')).toBe('affected.md');
    expect(git(f.root, 'diff', '--cached', '--name-only')).toBe('local-edit.txt');
    const head = git(f.root, 'rev-parse', 'HEAD');
    expect(await recordFactWithdrawal(engine, f.fact.id, f.sourceId)).toEqual({ withdrawn: false, pages: [] });
    await drain(f.request.id); expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('discovery time exhaustion refuses before any withdrawal mutation', async () => {
    const f = await fixture(), before = await state(f.sourceId);
    let now = 0;
    const clock = spyOn(performance, 'now').mockImplementation(() => now += 11_000);
    try { await expect(f.withdraw()).rejects.toMatchObject({ code: 'withdrawal_capacity' }); }
    finally { clock.mockRestore(); }
    expect(await state(f.sourceId)).toEqual(before);
    expect(await engine.executeRaw('SELECT 1 FROM fact_withdrawals WHERE source_id=$1', [f.sourceId])).toEqual([]);
    expect(await engine.executeRaw('SELECT expired_at FROM facts WHERE id=$1', [f.fact.id])).toEqual([{ expired_at: null }]);
    expect(await engine.executeRaw('SELECT 1 FROM persistence_effects WHERE request_id=$1::uuid', [f.request.id])).toEqual([]);
  });

  test('oversized persisted target manifests retain intent without file publication', async () => {
    const f = await fixture(), original = readFileSync(join(f.root, 'affected.md'));
    await f.withdraw();
    await engine.executeRaw(`UPDATE persistence_effects SET data=jsonb_set(data,'{targets,0,slug}',to_jsonb($2::text))
      WHERE request_id=$1::uuid`, [f.request.id, 'x'.repeat(1024 * 1024)]);
    await drain(f.request.id);
    expect(readFileSync(join(f.root, 'affected.md'))).toEqual(original);
    expect(await engine.executeRaw("SELECT state,error_code FROM persistence_effects WHERE request_id=$1::uuid AND kind='withdrawal-mirror'", [f.request.id]))
      .toEqual([{ state: 'queued', error_code: 'withdrawal_provenance' }]);
    expect(await engine.executeRaw('SELECT 1 FROM fact_withdrawals WHERE source_id=$1', [f.sourceId])).toHaveLength(1);
  });

  test('legacy source scan continues safely and mirror crash recovers without touching unrelated pages', async () => {
    const f = await fixture();
    await engine.putPage('z-affected', { type: 'note', title: 'Later affected page', compiled_truth: fence('uses A | B') }, { sourceId: f.sourceId });
    const later = (await engine.readPageSnapshot('z-affected', { sourceId: f.sourceId }))!;
    writeFileSync(join(f.root, 'z-affected.md'), serializePageToMarkdown(later.page, later.tags));
    git(f.root, 'add', 'z-affected.md'); git(f.root, 'commit', '-qm', 'Synthetic second target');
    await f.withdraw();
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE request_id<>$1::uuid", [f.request.id]);
    await runPersistenceEffects(engine, { engine: backend, embedding_disabled: true }, { hostId, limit: 1 });
    const firstPublished = readFileSync(join(f.root, 'affected.md'));
    await engine.executeRaw(`UPDATE persistence_effects SET data='{"source_scan":true}'::jsonb WHERE request_id=$1::uuid`, [f.request.id]);
    await engine.executeRaw(`UPDATE persistence_effects SET data='{"after_slug":"affected"}'::jsonb WHERE request_id=$1::uuid AND kind='withdrawal-mirror'`, [f.request.id]);
    const before = await state(f.sourceId), original = readFileSync(join(f.root, 'unrelated.md'));
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE request_id<>$1::uuid", [f.request.id]);
    let crashed = false;
    await runPersistenceEffects(engine, { engine: backend, embedding_disabled: true }, { hostId, limit: 1, boundary: async name => {
      if (name === 'after_mirror_file') { crashed = true; throw new Error('synthetic interruption'); }
    } });
    expect(crashed).toBe(true);
    expect((await engine.executeRaw<{ slug: string }>("SELECT recovery->>'slug' AS slug FROM persistence_effects WHERE request_id=$1::uuid AND kind='withdrawal-mirror'", [f.request.id]))[0].slug).toBe('z-affected');
    await rebuildPendingPageProjections(engine, 100); await drain(f.request.id); await drain(f.request.id);
    expect(await state(f.sourceId)).toEqual(before); expect(readFileSync(join(f.root, 'unrelated.md'))).toEqual(original);
    expect(parseFactsFence(readFileSync(join(f.root, 'affected.md'), 'utf8')).facts[0].forgotten).toBe(true);
    expect(readFileSync(join(f.root, 'affected.md'))).toEqual(firstPublished);
    expect(parseFactsFence(readFileSync(join(f.root, 'z-affected.md'), 'utf8')).facts[0].forgotten).toBe(true);
    expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND recovery IS NOT NULL', [f.request.id])).toEqual([]);
    expect(git(f.root, 'show', '--pretty=format:', '--name-only', 'HEAD')).toBe('z-affected.md');
  });

  test('malformed matching rows refuse before ledger, expiry, revision or chunk mutation', async () => {
    const f = await fixture();
    await engine.putPage('malformed', { type: 'note', title: 'Malformed', compiled_truth: fence('uses A | B').replace('| fact |', '| invalid |') }, { sourceId: f.sourceId });
    const before = await engine.executeRaw('SELECT row_to_json(p) AS page FROM pages p WHERE source_id=$1 ORDER BY slug', [f.sourceId]);
    await expect(f.withdraw()).rejects.toMatchObject({ code: 'withdrawal_provenance' });
    expect(await engine.executeRaw('SELECT row_to_json(p) AS page FROM pages p WHERE source_id=$1 ORDER BY slug', [f.sourceId])).toEqual(before);
    expect(await engine.executeRaw('SELECT fact_hash FROM fact_withdrawals WHERE source_id=$1', [f.sourceId])).toEqual([]);
    expect((await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id=$1', [f.fact.id]))[0].expired_at).toBeNull();
    await engine.transaction(tx => completeWrite(tx, f.request, 'cancelled', {}));
  });

  test('both prepared writer orderings retain committed withdrawal intent including a new page', async () => {
    for (const first of ['writer', 'withdrawal']) {
      const sourceId = `ordering-${randomUUID()}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const fact = await engine.insertFact({ fact: 'ordering sentinel', visibility: 'world', source: 'synthetic' }, { source_id: sourceId });
      let ready: PreparedContentImport | undefined;
      await importFromContent(engine, 'new-page', `---\ntitle: Ordering\ntype: note\n---\n${fence('ordering sentinel')}`, {
        sourceId, noEmbed: true, prepare: async prepared => { ready = prepared; return prepared.result; },
      });
      expect(ready).toBeDefined();
      if (first === 'writer') {
        await engine.transaction(tx => ready!.apply(tx));
        expect((await recordFactWithdrawal(engine, fact.id, sourceId)).pages.map(p => p.slug)).toEqual(['new-page']);
        expect(parseFactsFence((await engine.readPageSnapshot('new-page', { sourceId }))!.page.compiled_truth).facts[0].forgotten).toBe(true);
      } else {
        expect((await recordFactWithdrawal(engine, fact.id, sourceId)).pages).toEqual([]);
        await expect(engine.transaction(tx => ready!.apply(tx))).rejects.toMatchObject({ code: 'revision_conflict' });
        await expect(engine.transaction(tx => ready!.validate(tx))).rejects.toMatchObject({ code: 'revision_conflict' });
        expect(await engine.getPage('new-page', { sourceId })).toBeNull();
      }
    }
  });

  test('an over-capacity target set refuses atomically instead of partially withdrawing', async () => {
    const sourceId = `capacity-${randomUUID()}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
      SELECT $1,'page-'||n,'note','Synthetic capacity',$2,'','{}'::jsonb FROM generate_series(1,257) n`, [sourceId, fence('capacity sentinel')]);
    const fact = await engine.insertFact({ fact: 'capacity sentinel', source: 'synthetic', visibility: 'world' }, { source_id: sourceId });
    const before = await engine.executeRaw('SELECT slug,knowledge_revision FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId]);
    await expect(recordFactWithdrawal(engine, fact.id, sourceId)).rejects.toMatchObject({ code: 'withdrawal_capacity' });
    expect(await engine.executeRaw('SELECT slug,knowledge_revision FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId])).toEqual(before);
    expect(await engine.executeRaw('SELECT fact_hash FROM fact_withdrawals WHERE source_id=$1', [sourceId])).toEqual([]);
    expect((await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id=$1', [fact.id]))[0].expired_at).toBeNull();
  });

  test('DB-only duplicates expire once without invalidating unrelated content', async () => {
    const f = await fixture(), before = await state(f.sourceId);
    const first = await engine.insertFact({ fact: 'subjectless distinct claim', source: 'synthetic', visibility: 'world' }, { source_id: f.sourceId });
    const duplicate = await engine.insertFact({ fact: ' SUBJECTLESS   DISTINCT CLAIM ', source: 'synthetic', visibility: 'world' }, { source_id: f.sourceId });
    expect(await recordFactWithdrawal(engine, first.id, f.sourceId)).toEqual({ withdrawn: true, pages: [] });
    expect(await recordFactWithdrawal(engine, duplicate.id, f.sourceId)).toEqual({ withdrawn: false, pages: [] });
    expect(await state(f.sourceId)).toEqual(before);
    expect(await engine.executeRaw('SELECT id FROM facts WHERE id=ANY($1::int[]) AND expired_at IS NULL', [[first.id, duplicate.id]])).toEqual([]);
    await engine.transaction(tx => completeWrite(tx, f.request, 'cancelled', {}));
  });

  test('stale-chunk-only evidence invalidates its page and removes a demonstrated retrieval leak', async () => {
    const f = await fixture(), claim = 'stalechunksentinel';
    await engine.putPage('stale-only', { type: 'note', title: 'Current observation', compiled_truth: 'The current canonical body is safe.' }, { sourceId: f.sourceId });
    await rebuildPendingPageProjections(engine, 100);
    const fact = await engine.insertFact({ fact: claim, source: 'synthetic', visibility: 'world' }, { source_id: f.sourceId });
    await engine.executeRaw(`UPDATE content_chunks SET chunk_text=$2,search_vector=to_tsvector('english',$2)
      WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug='stale-only')`, [f.sourceId, claim]);
    expect(await engine.executeRaw('SELECT entity_slug,source_markdown_slug FROM facts WHERE id=$1', [fact.id]))
      .toEqual([{ entity_slug: null, source_markdown_slug: null }]);
    expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND position($2 IN compiled_truth||timeline)>0', [f.sourceId, claim])).toEqual([]);
    expect((await engine.searchKeyword(claim, { sourceId: f.sourceId })).map(page => page.slug)).toEqual(['stale-only']);
    const before = await state(f.sourceId), targetBefore = (await engine.readPageSnapshot('stale-only', { sourceId: f.sourceId }))!;
    const result = await recordFactWithdrawal(engine, fact.id, f.sourceId);
    expect(result.pages.map(page => page.slug)).toEqual(['stale-only']);
    expect((await engine.readPageSnapshot('stale-only', { sourceId: f.sourceId }))!.revision).not.toBe(targetBefore.revision);
    expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1', [targetBefore.page.id])).toEqual([]);
    expect(await engine.searchKeyword(claim, { sourceId: f.sourceId })).toEqual([]);
    expect(await state(f.sourceId)).toEqual(before);
    await rebuildPendingPageProjections(engine, 100);
    expect(await engine.searchKeyword(claim, { sourceId: f.sourceId })).toEqual([]);
    expect((await engine.readPageSnapshot('stale-only', { sourceId: f.sourceId }))!.page.compiled_truth).toBe(targetBefore.page.compiled_truth);
    expect(await state(f.sourceId)).toEqual(before);
    await engine.transaction(tx => completeWrite(tx, f.request, 'cancelled', {}));
  });

  for (const provenance of ['source_markdown_slug', 'entity_slug'] as const) test(`${provenance}-only evidence invalidates its exact page while unrelated state remains unchanged`, async () => {
    const f = await fixture(), claim = `provenance sentinel ${provenance}`;
    await engine.putPage('provenance-only', { type: 'note', title: 'Current evidence', compiled_truth: 'A safe canonical observation without the historical claim.' }, { sourceId: f.sourceId });
    await rebuildPendingPageProjections(engine, 100);
    await engine.setPageEmbeddingSignature('provenance-only', { sourceId: f.sourceId, signature: 'synthetic:retained:1536' });
    const fact = await engine.insertFact({ fact: claim, source: 'synthetic', visibility: 'world',
      entity_slug: provenance === 'entity_slug' ? 'provenance-only' : 'unrelated' }, { source_id: f.sourceId });
    if (provenance === 'source_markdown_slug') await engine.executeRaw('UPDATE facts SET source_markdown_slug=$2 WHERE id=$1', [fact.id, 'provenance-only']);
    expect(await engine.executeRaw('SELECT entity_slug,source_markdown_slug FROM facts WHERE id=$1', [fact.id])).toEqual([
      provenance === 'entity_slug' ? { entity_slug: 'provenance-only', source_markdown_slug: null }
        : { entity_slug: 'unrelated', source_markdown_slug: 'provenance-only' },
    ]);
    expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND position($2 IN compiled_truth||timeline)>0', [f.sourceId, claim])).toEqual([]);
    expect(await engine.executeRaw(`SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id
      WHERE p.source_id=$1 AND position($2 IN c.chunk_text)>0`, [f.sourceId, claim])).toEqual([]);
    const before = await state(f.sourceId), targetBefore = (await engine.readPageSnapshot('provenance-only', { sourceId: f.sourceId }))!;
    const filesBefore = ['unrelated', 'private'].map(slug => readFileSync(join(f.root, `${slug}.md`)));
    expect((await recordFactWithdrawal(engine, fact.id, f.sourceId)).pages.map(page => page.slug)).toEqual(['provenance-only']);
    const targetAfter = (await engine.readPageSnapshot('provenance-only', { sourceId: f.sourceId }))!;
    expect(targetAfter.revision).not.toBe(targetBefore.revision);
    expect(targetAfter.page.compiled_truth).toBe(targetBefore.page.compiled_truth);
    expect(await engine.executeRaw('SELECT text_projection_revision,embedding_signature FROM pages WHERE id=$1', [targetBefore.page.id]))
      .toEqual([{ text_projection_revision: null, embedding_signature: null }]);
    expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1', [targetBefore.page.id])).toEqual([]);
    expect(await state(f.sourceId)).toEqual(before);
    expect(['unrelated', 'private'].map(slug => readFileSync(join(f.root, `${slug}.md`)))).toEqual(filesBefore);
    await engine.transaction(tx => completeWrite(tx, f.request, 'cancelled', {}));
  });

  test('a source over the old 12,000-page inventory ceiling withdraws a claim with a small affected set (#5674)', async () => {
    const f = await fixture();
    try {
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
        SELECT $1,'capacity-page-'||n,'note','Capacity control',$2||' capacity row '||n,'','{}'::jsonb FROM generate_series(1,11998) n`,
      [f.sourceId, fence('an unrelated capacity claim')]);
      const pages = () => engine.executeRaw(`SELECT count(*)::int AS count,md5(string_agg(row_to_json(p)::text,'' ORDER BY id)) AS fingerprint
        FROM pages p WHERE source_id=$1 AND slug<>'affected'`, [f.sourceId]);
      const before = await pages();
      expect((await engine.executeRaw<{ count: number }>('SELECT count(*)::int AS count FROM pages WHERE source_id=$1', [f.sourceId]))[0].count).toBe(12001);
      expect((await f.withdraw()).pages.map(page => page.slug)).toEqual(['affected']);
      expect(await pages()).toEqual(before);
      const effects = await engine.executeRaw<{ data: { targets: Array<{ slug: string }> } }>('SELECT data FROM persistence_effects WHERE request_id=$1::uuid', [f.request.id]);
      expect(effects.map(effect => effect.data.targets.map(t => t.slug))).toEqual([['affected'], ['affected'], ['affected']]);

      await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
        SELECT $1,'world',md5('unrelated withdrawal '||n)||md5(n::text) FROM generate_series(1,300) n`, [f.sourceId]);
      await engine.executeRaw(`UPDATE persistence_effects SET data='{"source_scan":true}'::jsonb WHERE request_id=$1::uuid`, [f.request.id]);
      const [legacy] = await engine.executeRaw<PersistenceEffect>("SELECT * FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [f.request.id]);
      const upgraded = await upgradeWithdrawalEffect(engine, legacy, hostId, false);
      expect(upgraded.data.version).toBe(2);
      expect((upgraded.data.targets as Array<{ slug: string }>).map(t => t.slug)).toEqual(['affected']);
      expect(await pages()).toEqual(before);
    } finally { await engine.executeRaw('DELETE FROM sources WHERE id=$1', [f.sourceId]); }
  }, 120_000);

  test('a claim whose affected set exceeds the bound refuses loudly with the matched count, even in a small source', async () => {
    const sourceId = `capacity-report-${randomUUID()}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    try {
      await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter)
        SELECT $1,'page-'||lpad(n::text,3,'0'),'note','Synthetic capacity',$2,'','{}'::jsonb FROM generate_series(1,300) n`, [sourceId, fence('widely repeated sentinel')]);
      const fact = await engine.insertFact({ fact: 'widely repeated sentinel', source: 'synthetic', visibility: 'world' }, { source_id: sourceId });
      const error = await recordFactWithdrawal(engine, fact.id, sourceId).catch(e => e);
      expect(error).toMatchObject({ code: 'withdrawal_capacity' });
      expect(String(error.message)).toContain('more than 256');
      expect(String(error.suggestion)).toContain('page-001');
      expect(await engine.executeRaw('SELECT 1 FROM fact_withdrawals WHERE source_id=$1', [sourceId])).toEqual([]);
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id=$1 AND expired_at IS NULL', [fact.id])).toHaveLength(1);
    } finally { await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]); }
  });

  test('orphan closing fences block withdrawal and prepared publication of matching claims', async () => {
    const f = await fixture(), malformed = fence('uses A | B').replace(FACTS_FENCE_BEGIN, '');
    await engine.putPage('orphan', { type: 'note', title: 'Orphan', compiled_truth: malformed }, { sourceId: f.sourceId });
    const before = await engine.executeRaw('SELECT row_to_json(p) AS page FROM pages p WHERE source_id=$1 ORDER BY slug', [f.sourceId]);
    await expect(f.withdraw()).rejects.toMatchObject({ code: 'withdrawal_provenance' });
    expect(await engine.executeRaw('SELECT row_to_json(p) AS page FROM pages p WHERE source_id=$1 ORDER BY slug', [f.sourceId])).toEqual(before);
    expect(await engine.executeRaw('SELECT 1 FROM fact_withdrawals WHERE source_id=$1', [f.sourceId])).toEqual([]);
    await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
      SELECT source_id,visibility,gbrain_fact_fingerprint(fact) FROM facts WHERE id=$1`, [f.fact.id]);
    let ready: PreparedContentImport | undefined;
    await importFromContent(engine, 'new-orphan', malformed, { sourceId: f.sourceId, noEmbed: true, prepare: async value => { ready = value; return value.result; } });
    expect(ready).toBeDefined();
    await expect(engine.transaction(tx => ready!.validate(tx))).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(engine.transaction(tx => ready!.apply(tx))).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await engine.getPage('new-orphan', { sourceId: f.sourceId })).toBeNull();
  });

  test('dense malformed markers refuse during parsing before ledger mutation', async () => {
    const f = await fixture();
    await engine.putPage('dense', { type: 'note', title: 'Dense', compiled_truth: `${FACTS_FENCE_BEGIN.repeat(16_385)}\n${fence('uses A | B')}` }, { sourceId: f.sourceId });
    await expect(f.withdraw()).rejects.toMatchObject({ code: 'withdrawal_capacity' });
    expect(await engine.executeRaw('SELECT 1 FROM fact_withdrawals WHERE source_id=$1', [f.sourceId])).toEqual([]);
    expect(await engine.executeRaw('SELECT expired_at FROM facts WHERE id=$1', [f.fact.id])).toEqual([{ expired_at: null }]);
  });

  test('targeted embedding retry skips superseded revisions and reconciles exhausted targets without writes in preview', async () => {
    const f = await fixture();
    await engine.putPage('z-affected', { type: 'note', title: 'Later affected', compiled_truth: fence('uses A | B') }, { sourceId: f.sourceId });
    await f.withdraw(); await rebuildPendingPageProjections(engine, 100);
    await engine.executeRaw(`UPDATE persistence_effects SET state='failed',attempts=5,error_code='embedding_attempts_exhausted'
      WHERE request_id=$1::uuid AND kind='embedding'`, [f.request.id]);
    await engine.putPage('affected', { type: 'note', title: 'Changed', compiled_truth: 'A newer observation.' }, { sourceId: f.sourceId });
    const before = await engine.executeRaw("SELECT data,state,attempts FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [f.request.id]);
    const config = { engine: backend, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 };
    await engine.setConfig('embedding_disabled', 'false');
    try {
      expect(await retryEmbeddingEffect(engine, f.sourceId, f.request.request_id, true, config)).toMatchObject({ action: 'would_retry' });
      expect(await engine.executeRaw("SELECT data,state,attempts FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [f.request.id])).toEqual(before);
      await engine.putPage('z-affected', { type: 'note', title: 'Also changed', compiled_truth: 'Another newer observation.' }, { sourceId: f.sourceId });
      await engine.setConfig('embedding_disabled', 'true');
      expect(await retryEmbeddingEffect(engine, f.sourceId, f.request.request_id, true, config)).toMatchObject({ action: 'would_reconcile', pending_chunks: 0 });
      expect(await engine.executeRaw("SELECT data,state,attempts FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [f.request.id])).toEqual(before);
      expect(await retryEmbeddingEffect(engine, f.sourceId, f.request.request_id, false, config)).toMatchObject({ action: 'reconciled', attempts: 5 });
      expect(await engine.executeRaw("SELECT data,attempts FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [f.request.id]))
        .toEqual(before.map(({ data, attempts }) => ({ data, attempts })));
    } finally { await engine.setConfig('embedding_disabled', 'true'); }
  });

  test('failed legacy embedding preview narrows targets without writes or unrelated projection blockers', async () => {
    const f = await fixture(); await f.withdraw();
    await rebuildPendingPageProjections(engine, 100);
    await engine.executeRaw(`UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1 AND slug='private'`, [f.sourceId]);
    await engine.executeRaw(`UPDATE persistence_effects SET data='{"source_scan":true}'::jsonb,state='failed',attempts=5,error_code='embedding_attempts_exhausted'
      WHERE request_id=$1::uuid AND kind='embedding'`, [f.request.id]);
    const before = await engine.executeRaw("SELECT data,state,attempts FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [f.request.id]);
    await engine.setConfig('embedding_disabled', 'false');
    try {
      const config = { engine: backend, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 };
      expect(await retryEmbeddingEffect(engine, f.sourceId, f.request.request_id, true, config)).toMatchObject({ action: 'would_retry' });
      expect(await engine.executeRaw("SELECT data,state,attempts FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [f.request.id])).toEqual(before);
      expect(await retryEmbeddingEffect(engine, f.sourceId, f.request.request_id, false, config)).toMatchObject({ action: 'retry_queued' });
      const [retried] = await engine.executeRaw<{ data: { version: number; targets: Array<{ slug: string }> }; attempts: number }>("SELECT data,attempts FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [f.request.id]);
      expect(retried.data.version).toBe(2); expect(retried.data.targets.map(t => t.slug)).toEqual(['affected']); expect(retried.attempts).toBe(5);
    } finally { await engine.setConfig('embedding_disabled', 'true'); }
  });
});
