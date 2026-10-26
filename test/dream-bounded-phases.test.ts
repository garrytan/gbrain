import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { runCycle, SOURCE_FRESHNESS_PHASES } from '../src/core/cycle.ts';
import { runDream } from '../src/commands/dream.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { withEnv } from './helpers/with-env.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

// Adapted from the bounded-phase ports: deterministic clocks and real PGLite writes.
// Spies on transaction methods must preserve `this`, never bind the outer engine.
let engine: PGLiteEngine;
const scratch = mkdtempSync(join(tmpdir(), 'dream-bounded-'));
const vector = `[${[1, ...Array(1535).fill(0)].join(',')}]`;
const consolidateCursor = 'dream.consolidate.cursor.default';
const extractCursor = 'dream.extract_facts.cursor.default';
const completedKey = 'dream.extract_facts.completed_at.default';
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
});
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); resetGateway(); rmSync(scratch, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('other','Other')");
});
async function page(slug: string, source = 'default', body = '') {
  await engine.putPage(slug, { title: slug, type: 'concept', compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId: source });
}
async function bucket(slug: string, embedded = 3, source = 'default', identity = true) {
  await page(slug, source);
  for (const [i, word] of ['alpha', 'beta', 'gamma'].entries()) {
    await engine.executeRaw(`INSERT INTO facts (source_id,entity_slug,fact,kind,source,visibility,valid_from,confidence,embedding,embedding_model,embedded_text_hash)
      VALUES ($1,$2,$3,'fact','test','world','2020-01-01',$4,$5::vector,$6,CASE WHEN $7 THEN md5($3) ELSE NULL END)`,
    [source, slug, `${slug} claim ${word}`, 1 - i / 10, i < embedded ? vector : null,
      identity ? 'openai:text-embedding-3-large' : null, identity]);
  }
}

describe('bounded consolidate', () => {
  test('requires usable model/hash identity; the opt-in filter preserves takes', async () => {
    await bucket('none', 0); await bucket('one', 1); await bucket('bare', 3, 'default', false);
    await bucket('stale'); await engine.executeRaw("UPDATE facts SET embedded_text_hash='stale' WHERE entity_slug='stale'");
    await bucket('cluster', 2);
    const read = spyOn(engine, 'listFactsByEntity');
    try {
      const preview = await runPhaseConsolidate(engine, { dryRun: true, remote: false });
      expect(read.mock.calls).toHaveLength(5); read.mockClear();
      const bounded = await runPhaseConsolidate(engine, { maxMs: 60_000, remote: false });
      expect(read.mock.calls.map(c => c[1])).toEqual(['cluster']);
      expect(bounded.details.takes_written).toBe(preview.details.takes_written);
      expect(bounded.details.facts_consolidated).toBe(2);
      expect(await engine.executeRaw('SELECT id FROM takes')).toHaveLength(1);
    } finally { read.mockRestore(); }
  });
  test('model-less and stale hashes never satisfy the two-vector filter', async () => {
    await bucket('mixed');
    await engine.executeRaw("UPDATE facts SET embedding_model=NULL WHERE confidence < 1");
    const report = await runPhaseConsolidate(engine, { maxMs: 60_000 });
    expect(report.details.buckets_total).toBe(0);
  });
  test('source cursors stop before a cluster, resume, wrap, and clear without touching other cursors', async () => {
    await bucket('a'); await bucket('b'); await bucket('same', 3, 'other');
    await engine.setConfig('dream.consolidate.cursor.other', 'sentinel');
    let now = 0;
    const original = engine.listFactsByEntity;
    const read = spyOn(engine, 'listFactsByEntity').mockImplementation(async function (this: PGLiteEngine, ...args) {
      const rows = await original.apply(this, args); now = 1000; return rows;
    });
    try {
      const first = await runPhaseConsolidate(engine, { sourceId: 'default', maxMs: 1000, now: () => now });
      expect(first.details).toMatchObject({ buckets_remaining: 2, budget_exhausted: true, takes_written: 0 });
      expect(JSON.parse((await engine.getConfig(consolidateCursor))!)).toEqual({ source_id: 'default', entity_slug: 'a' });
    } finally { read.mockRestore(); }
    await engine.setConfig(consolidateCursor, JSON.stringify({ source_id: 'default', entity_slug: 'b' }));
    const order = spyOn(engine, 'listFactsByEntity');
    try {
      const next = await runPhaseConsolidate(engine, { sourceId: 'default', maxMs: 60_000 });
      expect(order.mock.calls.map(c => c[1])).toEqual(['b', 'a']);
      expect(next.details).toMatchObject({ takes_written: 2, buckets_remaining: 0 });
    } finally { order.mockRestore(); }
    expect(await engine.getConfig(consolidateCursor)).toBe('');
    expect(await engine.getConfig('dream.consolidate.cursor.other')).toBe('sentinel');
    expect(await engine.executeRaw("SELECT id FROM facts WHERE source_id='other' AND consolidated_at IS NOT NULL")).toHaveLength(0);
  });
  test('unbounded calls ignore cursors; bounded dry runs preserve them', async () => {
    await bucket('a');
    await engine.setConfig(consolidateCursor, '{invalid');
    const write = spyOn(engine, 'setConfig');
    try {
      const dry = await runPhaseConsolidate(engine, { sourceId: 'default', maxMs: 0, dryRun: true });
      expect(dry.details.resumed_from).toBeNull(); expect(dry.details.budget_exhausted).toBe(true);
      await runPhaseConsolidate(engine, { dryRun: true });
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
});

describe('bounded extract_facts', () => {
  test('candidate reconciliation inserts fence facts and preserves absent fences until an explicit empty fence', async () => {
    const fence = `## Facts
<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Prefers async | preference | 1 | world | medium | 2020-01-01 | | test | |
<!--- gbrain:facts:end -->`;
    await page('fenced', 'default', fence);
    const inserted = await runExtractFacts(engine, { maxMs: 60_000 });
    expect(inserted.factsInserted).toBe(1);
    // Upstream's belief projection can bump the revision after the index write.
    // Reconcile that newer revision before asserting the candidate set is empty.
    expect((await runExtractFacts(engine, { maxMs: 60_000 })).factsInserted).toBe(0);
    expect((await runExtractFacts(engine, { maxMs: 60_000 })).pagesScanned).toBe(0);
    await page('fenced', 'default', 'Fence removed');
    const removed = await runExtractFacts(engine, { maxMs: 60_000 });
    expect(removed.factsDeleted).toBe(0);
    expect(removed.warnings).toContainEqual(expect.stringContaining('FACTS_FENCE_HELD: fence_absent'));
    await page('fenced', 'default', '## Facts\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n<!--- gbrain:facts:end -->');
    expect((await runExtractFacts(engine, { maxMs: 60_000 })).factsDeleted).toBe(1);
    expect(await engine.executeRaw('SELECT id FROM facts WHERE expired_at IS NULL')).toHaveLength(0);
  });
  test('failed pages retry without repeating settled pages or advancing the completed stamp', async () => {
    await page('a'); await page('b');
    const original = engine.getPage;
    const read = spyOn(engine, 'getPage').mockImplementation(async function (this: PGLiteEngine, ...args) {
      if (args[0] === 'a') throw new Error('injected page read failure');
      return original.apply(this, args);
    });
    try {
      const failed = await runExtractFacts(engine, { maxMs: 60_000 });
      expect(failed.pagesFailed).toBe(1);
      expect(await engine.getConfig(completedKey)).toBeNull();
    } finally { read.mockRestore(); }
    expect((await runExtractFacts(engine, { maxMs: 60_000 })).pagesScanned).toBe(1);
    expect(await engine.getConfig(completedKey)).toBeTruthy();
  });

  test('an invalid fence retries only after its page revision changes', async () => {
    await page('malformed', 'default', '## Facts\n<!--- gbrain:facts:begin -->\n| # | claim |\n|---|---|\n| x | invalid row |\n<!--- gbrain:facts:end -->');
    expect((await runExtractFacts(engine, { maxMs: 60_000 })).pagesScanned).toBe(1);
    expect((await runExtractFacts(engine, { maxMs: 60_000 })).pagesScanned).toBe(0);
    await page('malformed', 'default', 'Corrected prose');
    expect((await runExtractFacts(engine, { maxMs: 60_000 })).pagesScanned).toBe(1);
  });

  test('walks changed and never-processed pages in this source; defaults still use the full walk', async () => {
    await page('old'); await page('foreign', 'other');
    const all = spyOn(engine, 'getAllSlugs');
    try {
      expect((await runExtractFacts(engine, { maxMs: 60_000 })).pagesScanned).toBe(1);
      expect(all).not.toHaveBeenCalled();
      expect(await engine.getConfig(completedKey)).toBeTruthy();
      expect((await runExtractFacts(engine, { maxMs: 60_000 })).pagesScanned).toBe(0);
      await page('new'); await page('old', 'default', 'Changed body');
      const read = spyOn(engine, 'getPage');
      try {
        const result = await runExtractFacts(engine, { maxMs: 60_000 });
        expect(result.pagesScanned).toBe(2);
        expect(read.mock.calls.map(c => c[0])).toEqual(['new', 'old']);
      } finally { read.mockRestore(); }
      await runExtractFacts(engine); expect(all).toHaveBeenCalledTimes(1);
    } finally { all.mockRestore(); }
  });
  test('budget cursor resumes without starving earlier new pages; completed stamp waits for completion', async () => {
    await page('a'); await page('b');
    let now = 0;
    const original = engine.getPage;
    const read = spyOn(engine, 'getPage').mockImplementation(async function (this: PGLiteEngine, ...args) {
      const result = await original.apply(this, args); now = 1000; return result;
    });
    try {
      const first = await runExtractFacts(engine, { maxMs: 1000, now: () => now });
      expect(first).toMatchObject({ pagesScanned: 1, pages_remaining: 1, budget_exhausted: true });
      expect(await engine.getConfig(extractCursor)).toBe('b');
      expect(await engine.getConfig(completedKey)).toBeNull();
    } finally { read.mockRestore(); }
    await page('aa');
    const order = spyOn(engine, 'getPage');
    try {
      const second = await runExtractFacts(engine, { maxMs: 60_000 });
      expect(second).toMatchObject({ pagesScanned: 2, pages_remaining: 0, resumed_from: 'b' });
      expect(order.mock.calls.map(c => c[0])).toEqual(['b', 'aa']);
    } finally { order.mockRestore(); }
    expect(await engine.getConfig(extractCursor)).toBe('');
    expect(await engine.getConfig(completedKey)).toBeTruthy();
  });
  test('dry-run, zero budget, and unbounded empty incremental calls do not advance completion', async () => {
    await page('a'); await engine.setConfig(extractCursor, 'a');
    const write = spyOn(engine, 'setConfig');
    try {
      const result = await runExtractFacts(engine, { maxMs: 0, dryRun: true });
      expect(result).toMatchObject({ pages_remaining: 1, budget_exhausted: true });
      expect((await runExtractFacts(engine, { slugs: [] })).pagesScanned).toBe(0);
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
    expect(await engine.getConfig(completedKey)).toBeNull();
  });
});

describe('cycle wiring and freshness', () => {
  test('a failed sync still prevents a destructive candidate walk under a budget', async () => {
    await page('a');
    const brokenRepo = mkdtempSync(join(scratch, 'broken-repo-'));
    // A broken gitlink is a real sync error; upstream correctly refuses to auto-initialize it.
    writeFileSync(join(brokenRepo, '.git'), 'gitdir: ./missing-git-directory\n');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [brokenRepo]);
    const result = await withEnv({ GBRAIN_HOME: scratch }, () => runCycle(engine, {
      brainDir: brokenRepo, sourceId: 'default', phases: ['sync', 'extract_facts'], phaseBudgetSeconds: 60,
    }));
    expect(result.phases.find(p => p.phase === 'sync')!.status).toBe('fail');
    expect(result.phases.find(p => p.phase === 'extract_facts')!.details.pagesScanned).toBe(0);
    expect(await engine.getConfig(completedKey)).toBeNull();
  });
  test('selected phases that skip do not certify full freshness', async () => {
    const result = await withEnv({ GBRAIN_HOME: scratch }, () => runCycle(engine, {
      brainDir: null, sourceId: 'default', phases: SOURCE_FRESHNESS_PHASES,
    }));
    expect(result.freshness_stamp).toBe('skipped_incomplete');
    expect((await engine.listAllSources()).find(s => s.id === 'default')!.config.last_full_cycle_at).toBeUndefined();
  });

  test('a subset never stamps full freshness, even with fullImplicitSourceCycle set', async () => {
    await withEnv({ GBRAIN_HOME: scratch }, async () => {
      const result = await runCycle(engine, { brainDir: null, sourceId: 'default', phases: ['lint'], fullImplicitSourceCycle: true });
      expect(result.freshness_stamp).toBe('skipped_phase_subset');
      expect((await engine.listAllSources()).find(s => s.id === 'default')!.config.last_full_cycle_at).toBeUndefined();
    });
  });
  test('budget-limited freshness phases do not stamp and surface progress', async () => {
    await page('a');
    const result = await withEnv({ GBRAIN_HOME: scratch }, () => runCycle(engine, {
      brainDir: null, sourceId: 'default', phases: SOURCE_FRESHNESS_PHASES, phaseBudgetSeconds: 0,
    }));
    expect(result.phases.find(p => p.phase === 'extract_facts')!.details.budget_exhausted).toBe(true);
    expect(result.freshness_stamp).toBe('skipped_incomplete');
    expect((await engine.listAllSources()).find(s => s.id === 'default')!.config.last_full_cycle_at).toBeUndefined();
  });
  test('dream passes its budget through and never stamps an implicit source with an explicit subset', async () => {
    await bucket('a');
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const report = await withEnv({ GBRAIN_HOME: scratch }, () => runDream(engine, [
        '--source', 'default', '--phase', 'consolidate', '--max-seconds', '1', '--json',
      ]));
      expect(report?.phases[0].details.max_seconds).toBe(1);
      expect(report?.freshness_stamp).toBe('skipped_phase_subset');
    } finally { output.mockRestore(); }
  });
});

describe('dream --max-seconds', () => {
  for (const value of [undefined, '0', '-1', '1.5', 'NaN', 'Infinity', '2x', '--json', '9007199254740992']) {
    test(`rejects ${String(value)} with a usage error`, async () => {
      const exit = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
      const error = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(runDream(null, ['--max-seconds', ...(value === undefined ? [] : [value]), '--json'])).rejects.toThrow('exit:2');
        expect(error.mock.calls.flat().join(' ')).toContain('--max-seconds');
      } finally { exit.mockRestore(); error.mockRestore(); }
    });
  }
  test('real CLI registers the flag and advertises the engine-free help path', async () => {
    expect(CLI_FLAG_REGISTRY.dream).toContain('--max-seconds');
    const child = Bun.spawn([process.execPath, 'src/cli.ts', 'dream', '--help', '--max-seconds', '1'], {
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: '' }); expect(out).toContain('--max-seconds N');
  });
});

async function managedFixture(run: (root: string) => Promise<void>) {
  const dir = mkdtempSync(join(scratch, 'managed-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await claimWorktree(engine, 'default', root);
    await engine.setConfig('sync.write_through', 'true');
    try { await run(root); } finally { await disposePersistenceConsumer(engine); }
  });
}
async function managedPage(slug: string) {
  await submitPageMutation({ engine, sourceId: 'default', remote: false, dryRun: false,
    config: { engine: engine.kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } },
  { operation: 'put_page', params: { slug, content: `---\ntitle: Example\ntype: concept\n---\nEvidence for ${slug}.` } });
}

describe('bounded managed phases', () => {
  test('checks between coordinated clusters in one bucket and resumes publication exactly once', async () => {
    await managedFixture(async () => {
      await managedPage('clusters');
      const orthogonal = `[${[0, 1, ...Array(1534).fill(0)].join(',')}]`;
      for (const [group, embedding] of [['first', vector], ['second', orthogonal]]) {
        for (const word of ['alpha', 'beta', 'gamma']) await engine.executeRaw(
          `INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,confidence,valid_from,embedding,embedding_model,embedded_text_hash)
           VALUES('default','clusters',$1,'fact','test','world',0.9,'2020-01-02',$2::vector,'openai:text-embedding-3-large',md5($1))`,
          [`${group} claim ${word}`, embedding]);
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      // Initial read, bucket check and first cluster start are within budget;
      // the next clock observation is past the deadline after publication.
      let checks = 0;
      const first = await runPhaseConsolidate(engine, { sourceId: 'default', maxMs: 1000,
        now: () => checks++ >= 3 ? 1000 : 0 });
      expect(first.details).toMatchObject({ facts_consolidated: 3, takes_written: 1, budget_exhausted: true, buckets_remaining: 1 });
      expect(JSON.parse((await engine.getConfig(consolidateCursor))!).entity_slug).toBe('clusters');
      const next = await runPhaseConsolidate(engine, { sourceId: 'default', maxMs: 60_000 });
      expect(next.details.facts_consolidated).toBe(3);
      expect(await engine.executeRaw('SELECT id FROM takes')).toHaveLength(2);
      expect(await engine.getConfig(consolidateCursor)).toBe('');
      expect((await runPhaseConsolidate(engine, { sourceId: 'default', maxMs: 60_000 })).details.takes_written).toBe(0);
    });
  });
  test('managed candidate walks record only completed revisions and leave dry runs untouched', async () => {
    await managedFixture(async () => {
      await managedPage('a'); await managedPage('b');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const first = await runExtractFacts(engine, { maxMs: 60_000 });
      expect(first.pagesScanned).toBe(2);
      expect((await runExtractFacts(engine, { maxMs: 60_000 })).pagesScanned).toBe(0);
      const before = await engine.executeRaw('SELECT * FROM page_facts_reconcile ORDER BY page_id');
      await runExtractFacts(engine, { maxMs: 60_000, dryRun: true });
      expect(await engine.executeRaw('SELECT * FROM page_facts_reconcile ORDER BY page_id')).toEqual(before);
    });
  });
});
