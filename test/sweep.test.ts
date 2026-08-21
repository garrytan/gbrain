/**
 * Maintenance sweep tests [CX-P0.1, CX-P0.3, CX2-4, CX2-5, ENG-5].
 *
 * Hermetic in-memory PGLite for the sweep passes (the turn-context.test.ts
 * fixture pattern); injected timer/stdin seams for the serve wiring (the
 * serve-stdio-lifecycle.test.ts harness pattern — no real serves spawned).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  runMaintenanceSweep,
  armStartupSweep,
  CORPUS_INGESTED_SUFFIX,
  CORPUS_CLAIM_SUFFIX,
  STARTUP_SWEEP_DELAY_MS,
  type SweepReport,
} from '../src/core/sweep.ts';
import { isTotalFailure, runSweep, SWEEP_HELP } from '../src/commands/sweep.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { _resetStdoutRedirectForTests } from '../src/core/console-prefix.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runServe, type ServeOptions } from '../src/commands/serve.ts';

const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};
const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let corpusDir: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links').catch(() => {});
  await engine.executeRaw('DELETE FROM timeline_entries').catch(() => {});
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  await engine.executeRaw('DELETE FROM pages').catch(() => {});
  // Isolate the corpus pass to a fresh empty dir every test — the default
  // (~/.gbrain/transcripts/corpus) may exist with real files on a dev box.
  corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-corpus-'));
  tmpDirs.push(corpusDir);
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
});

afterEach(() => {
  __setChatTransportForTests(null);
  // The ENG-5 harness drives the real runServe(), whose stdio path flips
  // console-prefix's module-global stdout→stderr redirect (#3844). bun runs
  // every test file in one process, so without this reset the flag stays on
  // and poisons any later file that pins slog's stdout routing
  // (test/sync-all-parallel.test.ts, test/console-prefix.test.ts) — whether
  // it bites depends on CI shard composition. Same reset the donor harness
  // (test/serve-stdio-lifecycle.test.ts) already carries.
  _resetStdoutRedirectForTests();
});

async function seedPage(slug: string, type: string, body: string, timeline = '') {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, 'default', $2, $3, $4, $5)`,
    [slug, type, slug, body, timeline],
  );
}

const FENCE_BODY = [
  '# Alice Example',
  '',
  'Alice Example is a founder at acme-example.',
  '',
  '## Facts',
  '',
  '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | Founded acme-example in 2017 | fact | 1.0 | world | high | 2017-01-01 |  | test |  |',
  '| 2 | Prefers async updates | preference | 0.9 | private | medium |  |  | test |  |',
  '<!--- gbrain:facts:end -->',
  '',
].join('\n');

describe('runMaintenanceSweep — facts-fence reconciliation [CX2-4]', () => {
  test('fence rows land in the facts index; per-row visibility respected; dedup on re-run', async () => {
    await seedPage('people/alice-example', 'person', FENCE_BODY);

    const r1 = await runMaintenanceSweep(engine, {
      sourceId: 'default',
      capabilities: KEYLESS,
    });
    expect(r1.factsReconciled).toBe(2);

    const facts = await engine.executeRaw<{ fact: string; visibility: string }>(
      `SELECT fact, visibility FROM facts
        WHERE source_id = 'default' AND source_markdown_slug = 'people/alice-example'
        ORDER BY row_num ASC`,
    );
    expect(facts.length).toBe(2);
    // Fence rows carry EXPLICIT per-row visibility — authored values win
    // over any config default (the [ENG-8] resolver only fills unset).
    expect(facts[0].visibility).toBe('world');
    expect(facts[1].visibility).toBe('private');

    // Re-run: reconcile is idempotent — no new inserts, no duplicates.
    const r2 = await runMaintenanceSweep(engine, {
      sourceId: 'default',
      capabilities: KEYLESS,
    });
    expect(r2.factsReconciled).toBe(0);
    const recount = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*) AS n FROM facts WHERE source_markdown_slug = 'people/alice-example'`,
    );
    expect(parseInt(recount[0].n, 10)).toBe(2);
  });

  test('pages without a fence are untouched (no destructive wipe)', async () => {
    await seedPage('people/bob-example', 'person', 'Bob has no facts fence.');
    const r = await runMaintenanceSweep(engine, {
      sourceId: 'default',
      capabilities: KEYLESS,
    });
    expect(r.factsReconciled).toBe(0);
  });
});

describe('runMaintenanceSweep — link/timeline extraction [CX-P0.3]', () => {
  test('markdown ref + timeline line produce rows via the real extractors', async () => {
    await seedPage('people/alice-example', 'person', 'Alice Example founder profile.');
    await seedPage(
      'notes/meeting-example',
      'note',
      [
        '# Meeting',
        '',
        'Talked with [Alice](people/alice-example) about the roadmap.',
        '',
        '## Timeline',
        '',
        '- **2026-01-02** | Kickoff meeting with alice-example',
        '',
      ].join('\n'),
    );

    const r = await runMaintenanceSweep(engine, {
      sourceId: 'default',
      capabilities: KEYLESS,
    });
    expect(r.linksExtracted).toBeGreaterThanOrEqual(1);
    expect(r.timelineExtracted).toBeGreaterThanOrEqual(1);

    const links = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*) AS n FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
        WHERE pf.slug = 'notes/meeting-example' AND pt.slug = 'people/alice-example'`,
    );
    expect(parseInt(links[0].n, 10)).toBeGreaterThanOrEqual(1);

    const tl = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*) AS n FROM timeline_entries t
         JOIN pages p ON p.id = t.page_id
        WHERE p.slug = 'notes/meeting-example' AND t.date = '2026-01-02'`,
    );
    expect(parseInt(tl[0].n, 10)).toBe(1);
  });

  test('auto_link/auto_timeline kill switches are honored', async () => {
    await engine.setConfig('auto_link', 'false');
    await engine.setConfig('auto_timeline', 'false');
    try {
      await seedPage(
        'notes/gated-example', 'note',
        'See [Alice](people/alice-example).\n- **2026-02-03** | gated entry',
      );
      const r = await runMaintenanceSweep(engine, {
        sourceId: 'default',
        capabilities: KEYLESS,
      });
      expect(r.linksExtracted).toBe(0);
      expect(r.timelineExtracted).toBe(0);
      const reasons = r.skipped.map(s => s.reason);
      expect(reasons).toContain('auto_link_disabled');
      expect(reasons).toContain('auto_timeline_disabled');
    } finally {
      await engine.setConfig('auto_link', 'true');
      await engine.setConfig('auto_timeline', 'true');
    }
  });
});

describe('runMaintenanceSweep — watermark progress + link reconciliation (#4196)', () => {
  // Seed with an explicit updated_at so batch-selection order is deterministic.
  async function seedPageAt(slug: string, body: string, updatedAtIso: string) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, updated_at)
       VALUES ($1, 'default', 'note', $1, $2, $3::timestamptz)`,
      [slug, body, updatedAtIso],
    );
  }
  const minsAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

  test('repeated bounded sweeps make forward progress past batchLimit', async () => {
    // Newest two pages fill a batchLimit=2 selection; the oldest writer is
    // starved unless the selection honors links_extracted_at.
    await seedPageAt('prog/target', 'Target page.', minsAgo(1));
    await seedPageAt('prog/w-new', 'See [T](prog/target).', minsAgo(2));
    await seedPageAt('prog/w-old', 'Also see [T](prog/target).', minsAgo(3));

    const sweep = () => runMaintenanceSweep(engine, {
      sourceId: 'default', capabilities: KEYLESS, batchLimit: 2, budgetMs: 30_000,
    });
    await sweep();
    await sweep();

    const oldEdge = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*) AS n FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
        WHERE pf.slug = 'prog/w-old'`,
    );
    expect(parseInt(oldEdge[0].n, 10)).toBeGreaterThanOrEqual(1);

    // Every swept page is stamped at its own updated_at (extract.ts D4/#1768
    // discipline), so the engines' shared stale predicate clears fully.
    const stale = await engine.countStalePagesForExtraction({ sourceId: 'default' });
    expect(stale).toBe(0);
  });

  test('a link removed via the remote put_page path is reconciled away', async () => {
    const page = (t: string, b: string) => `---\ntitle: ${t}\ntype: note\n---\n\n${b}\n`;
    const write = (slug: string, c: string) =>
      importFromContent(engine, slug, c, { noEmbed: true, sourceId: 'default' });
    const sweep = () => runMaintenanceSweep(engine, {
      sourceId: 'default', capabilities: KEYLESS, budgetMs: 30_000,
    });
    const edges = async (slug: string) => engine.executeRaw<{ to_slug: string; link_source: string | null }>(
      `SELECT pt.slug AS to_slug, l.link_source FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
        WHERE pf.slug = $1 ORDER BY pt.slug`,
      [slug],
    );

    await write('concepts/target-a', page('Target A', 'Target page.'));
    await write('concepts/writer-a', page('Writer A', 'References [Target A](concepts/target-a).'));
    await sweep();
    expect((await edges('concepts/writer-a')).map(e => e.to_slug)).toEqual(['concepts/target-a']);

    // Non-sweep-owned provenances on the same page must survive reconciliation.
    await engine.addLink('concepts/writer-a', 'concepts/target-a', '', 'manual-ref', 'manual');
    await engine.addLink('concepts/writer-a', 'concepts/target-a', '', 'mention', 'mentions');

    await write('concepts/writer-a', page('Writer A', 'The reference is gone.'));
    await sweep();

    const after = await edges('concepts/writer-a');
    expect(after.map(e => e.link_source).sort()).toEqual(['manual', 'mentions']);
  });

  test('reconciliation never touches pages outside the sweep batch', async () => {
    // A page last updated outside the recentDays window keeps its edges even
    // though the sweep runs over the same source.
    await seedPageAt('cold/target', 'Cold target.', minsAgo(1));
    await seedPageAt('cold/writer', 'See [T](cold/target).', minsAgo(2));
    await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYLESS, budgetMs: 30_000 });
    await engine.executeRaw(
      `UPDATE pages SET updated_at = now() - interval '30 days',
                        links_extracted_at = now() - interval '30 days'
        WHERE slug = 'cold/writer'`,
    );
    // Rewrite the page body so the edge would be stale IF the page were swept.
    await engine.executeRaw(
      `UPDATE pages SET compiled_truth = 'Reference removed.' WHERE slug = 'cold/writer'`,
    );
    await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYLESS, budgetMs: 30_000 });
    const n = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*) AS n FROM links l JOIN pages pf ON pf.id = l.from_page_id
        WHERE pf.slug = 'cold/writer'`,
    );
    expect(parseInt(n[0].n, 10)).toBe(1);
  });
});

describe('runMaintenanceSweep — corpus ingest [CX-P0.1, CX-P0.5]', () => {
  test('keyless: skipped with reason keyless, sidecar NOT written', async () => {
    writeFileSync(join(corpusDir, 'session-1.txt'), 'User said something notable.\n');

    const r = await runMaintenanceSweep(engine, {
      sourceId: 'default',
      capabilities: KEYLESS,
    });
    expect(r.corpusIngested).toBe(0);
    expect(r.skipped).toContainEqual({ reason: 'keyless', count: 1 });
    expect(existsSync(join(corpusDir, 'session-1.txt' + CORPUS_INGESTED_SUFFIX))).toBe(false);
  });

  test('keyed: transcript runs through the real pipeline; sidecar written AFTER success; exactly-once', async () => {
    // The [ENG-8] resolver: visibility left unset by the sweep resolves the
    // operator-set default inside the shared pipeline.
    await engine.setConfig('facts.default_visibility', 'world');
    writeFileSync(
      join(corpusDir, 'fresh.txt'),
      'Alice committed to shipping the beta in March.\n',
    );

    let chatCalls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls += 1;
      return {
        text: JSON.stringify({
          facts: [{
            fact: 'Alice committed to shipping the beta in March',
            kind: 'commitment',
            entity: null,
            confidence: 0.9,
            notability: 'high',
          }],
        }),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:test-stub',
        providerId: 'anthropic',
      };
    });

    try {
      const r1 = await runMaintenanceSweep(engine, {
        sourceId: 'default',
        capabilities: KEYED,
      });
      expect(r1.corpusIngested).toBe(1);
      expect(chatCalls).toBe(1);
      expect(existsSync(join(corpusDir, 'fresh.txt' + CORPUS_INGESTED_SUFFIX))).toBe(true);

      const facts = await engine.executeRaw<{ fact: string; visibility: string; source: string }>(
        `SELECT fact, visibility, source FROM facts WHERE source = 'sweep:corpus'`,
      );
      expect(facts.length).toBe(1);
      expect(facts[0].fact).toContain('shipping the beta');
      expect(facts[0].visibility).toBe('world');

      // Exactly-once: the sidecar makes the second sweep a no-op.
      const r2 = await runMaintenanceSweep(engine, {
        sourceId: 'default',
        capabilities: KEYED,
      });
      expect(r2.corpusIngested).toBe(0);
      expect(chatCalls).toBe(1);
      expect(r2.skipped).toContainEqual({ reason: 'already_ingested', count: 1 });
    } finally {
      await engine.setConfig('facts.default_visibility', 'private');
    }
  });

  test('pre-existing sidecar marker → file never touches the pipeline', async () => {
    writeFileSync(join(corpusDir, 'done.txt'), 'Already processed content.\n');
    writeFileSync(join(corpusDir, 'done.txt' + CORPUS_INGESTED_SUFFIX), '{}\n');

    let chatCalls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls += 1;
      throw new Error('must not be called');
    });

    const r = await runMaintenanceSweep(engine, {
      sourceId: 'default',
      capabilities: KEYED,
    });
    expect(r.corpusIngested).toBe(0);
    expect(chatCalls).toBe(0);
    expect(r.skipped).toContainEqual({ reason: 'already_ingested', count: 1 });
  });

  test('extraction_enabled=false spend gate skips without sidecars', async () => {
    await engine.setConfig('facts.extraction_enabled', 'false');
    try {
      writeFileSync(join(corpusDir, 'gated.txt'), 'Gated content.\n');
      const r = await runMaintenanceSweep(engine, {
        sourceId: 'default',
        capabilities: KEYED,
      });
      expect(r.corpusIngested).toBe(0);
      expect(r.skipped).toContainEqual({ reason: 'extraction_disabled', count: 1 });
      expect(existsSync(join(corpusDir, 'gated.txt' + CORPUS_INGESTED_SUFFIX))).toBe(false);
    } finally {
      await engine.setConfig('facts.extraction_enabled', 'true');
    }
  });
});

describe('runMaintenanceSweep — corpus claim fencing (concurrent sweeps)', () => {
  const stubChatResult = (fact: string): ChatResult => ({
    text: JSON.stringify({
      facts: [{ fact, kind: 'fact', entity: null, confidence: 0.9, notability: 'medium' }],
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:test-stub',
    providerId: 'anthropic',
  });

  test('two concurrent sweeps on one corpus dir ingest each file exactly once', async () => {
    writeFileSync(join(corpusDir, 'race-a.txt'), 'Alice will demo the widget on Monday.\n');
    writeFileSync(join(corpusDir, 'race-b.txt'), 'Bob owns the acme-example follow-up.\n');

    let chatCalls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls += 1;
      // Hold the call open so the two sweeps genuinely overlap in pass 3.
      await new Promise((r) => setTimeout(r, 50));
      return stubChatResult(`extracted fact ${chatCalls}`);
    });

    const [r1, r2] = await Promise.all([
      runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED }),
      runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED }),
    ]);

    // The whole point: one LLM call per FILE, never per (file × sweep).
    expect(chatCalls).toBe(2);
    expect(r1.corpusIngested + r2.corpusIngested).toBe(2);
    expect(existsSync(join(corpusDir, 'race-a.txt' + CORPUS_INGESTED_SUFFIX))).toBe(true);
    expect(existsSync(join(corpusDir, 'race-b.txt' + CORPUS_INGESTED_SUFFIX))).toBe(true);
    // No claim leftovers — success replaces the claim with the .ingested sidecar.
    expect(existsSync(join(corpusDir, 'race-a.txt' + CORPUS_CLAIM_SUFFIX))).toBe(false);
    expect(existsSync(join(corpusDir, 'race-b.txt' + CORPUS_CLAIM_SUFFIX))).toBe(false);
  });

  test('a fresh claim held by another sweep skips the file — zero LLM spend, claim untouched', async () => {
    writeFileSync(join(corpusDir, 'claimed.txt'), 'Claimed elsewhere.\n');
    const claim = join(corpusDir, 'claimed.txt' + CORPUS_CLAIM_SUFFIX);
    writeFileSync(claim, '{}\n');

    let chatCalls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls += 1;
      throw new Error('must not be called');
    });

    const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED });
    expect(r.corpusIngested).toBe(0);
    expect(chatCalls).toBe(0);
    expect(r.skipped).toContainEqual({ reason: 'corpus_in_progress', count: 1 });
    // The live claim belongs to the other sweep — this run must not release it.
    expect(existsSync(claim)).toBe(true);
    expect(existsSync(join(corpusDir, 'claimed.txt' + CORPUS_INGESTED_SUFFIX))).toBe(false);
  });

  test('a stale claim (>1h, dead sweep) is reclaimed and the file ingested', async () => {
    writeFileSync(join(corpusDir, 'stale-claim.txt'), 'Left behind by a crashed sweep.\n');
    const claim = join(corpusDir, 'stale-claim.txt' + CORPUS_CLAIM_SUFFIX);
    writeFileSync(claim, '{}\n');
    const old = (Date.now() - 2 * 3600 * 1000) / 1000;
    utimesSync(claim, old, old);

    let chatCalls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls += 1;
      return stubChatResult('reclaimed fact');
    });

    const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED });
    expect(r.corpusIngested).toBe(1);
    expect(chatCalls).toBe(1);
    expect(existsSync(join(corpusDir, 'stale-claim.txt' + CORPUS_INGESTED_SUFFIX))).toBe(true);
    expect(existsSync(claim)).toBe(false);
  });

  test('claim removed after a failed ingest so the next sweep retries', async () => {
    // A directory named like a corpus file: readFile throws EISDIR after the
    // claim is acquired — a deterministic mid-ingest failure (runFactsPipeline
    // itself absorbs provider errors, so a throwing transport won't do).
    mkdirSync(join(corpusDir, 'flaky.txt'));
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      throw new Error('must not be reached');
    });

    const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED });
    expect(r.corpusIngested).toBe(0);
    expect(r.skipped).toContainEqual({ reason: 'corpus_file_error', count: 1 });
    // Neither sidecar remains: no .ingested (it failed), no claim (released).
    expect(existsSync(join(corpusDir, 'flaky.txt' + CORPUS_CLAIM_SUFFIX))).toBe(false);
    expect(existsSync(join(corpusDir, 'flaky.txt' + CORPUS_INGESTED_SUFFIX))).toBe(false);
  });
});

describe('runMaintenanceSweep — bounded link resolution (no listAllPageRefs)', () => {
  /** Proxy over the real engine recording every METHOD CALL by name. */
  function loggingEngine(target: BrainEngine, log: string[]): BrainEngine {
    return new Proxy(target as unknown as Record<string | symbol, unknown>, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv);
        if (typeof v === 'function') {
          return (...args: unknown[]) => {
            log.push(String(prop));
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        return v;
      },
    }) as unknown as BrainEngine;
  }

  test('directly-resolving candidates never touch listAllPageRefs; links still extracted', async () => {
    await seedPage('people/alice-example', 'person', 'Alice Example founder profile.');
    await seedPage(
      'notes/bounded-example',
      'note',
      'Talked with [Alice](people/alice-example) about the roadmap.',
    );

    const log: string[] = [];
    const r = await runMaintenanceSweep(loggingEngine(engine, log), {
      sourceId: 'default',
      capabilities: KEYLESS,
    });
    expect(r.linksExtracted).toBeGreaterThanOrEqual(1);
    // The bounded resolver path: endpoint refs come from a candidate-scoped
    // lookup, never the whole-brain (slug, source_id) enumeration.
    expect(log).not.toContain('listAllPageRefs');
    expect(log).toContain('getPage');
  });

  test('timeline-only sweep (zero link candidates) skips the ref lookup entirely', async () => {
    await seedPage(
      'notes/tl-only-example',
      'note',
      ['# TL', '', '## Timeline', '', '- **2026-03-04** | timeline only entry', ''].join('\n'),
    );
    const log: string[] = [];
    const r = await runMaintenanceSweep(loggingEngine(engine, log), {
      sourceId: 'default',
      capabilities: KEYLESS,
    });
    expect(r.timelineExtracted).toBe(1);
    expect(log).not.toContain('listAllPageRefs');
    // Exactly two raw queries: the pass-1 fence scan and the pass-2 recency
    // scan. No candidates ⇒ no third (ref-lookup) query.
    expect(log.filter((m) => m === 'executeRaw').length).toBe(2);
  });
});

describe('runMaintenanceSweep — budget + never-throw', () => {
  test('zero budget → every pass reports partial, nothing throws', async () => {
    await seedPage('people/budget-example', 'person', FENCE_BODY);
    const r = await runMaintenanceSweep(engine, {
      sourceId: 'default',
      budgetMs: 0,
      capabilities: KEYLESS,
    });
    expect(r.factsReconciled).toBe(0);
    expect(r.linksExtracted).toBe(0);
    expect(r.corpusIngested).toBe(0);
    const reasons = r.skipped.map(s => s.reason);
    expect(reasons.some(x => x.startsWith('budget_exhausted'))).toBe(true);
    expect(typeof r.durationMs).toBe('number');
  });

  test('engine that throws everywhere → skips with error reasons, never throws', async () => {
    const boom = async () => { throw new Error('boom'); };
    const fake = {
      executeRaw: boom,
      getConfig: boom,
      getPage: boom,
      listAllPageRefs: boom,
      addLinksBatch: boom,
      addTimelineEntriesBatch: boom,
    } as unknown as BrainEngine;

    const r = await runMaintenanceSweep(fake, { capabilities: KEYLESS });
    const reasons = r.skipped.map(s => s.reason);
    expect(reasons).toContain('facts_fence_error');
    expect(reasons).toContain('links_timeline_error');
    expect(reasons).toContain('corpus_error');
    expect(isTotalFailure(r)).toBe(true);
  });

  test('partial failure is NOT a total failure (CX2-5 exit-code contract)', () => {
    const partial: SweepReport = {
      corpusIngested: 0,
      factsReconciled: 3,
      linksExtracted: 1,
      linksRemoved: 0,
      timelineExtracted: 0,
      skipped: [{ reason: 'budget_exhausted:corpus', count: 2 }],
      durationMs: 10,
    };
    expect(isTotalFailure(partial)).toBe(false);
  });
});

// ── Serve wiring [ENG-5] ─────────────────────────────────────────────────

interface Handle { id: number; unrefCalled: boolean; unref: () => void }

function makeIntervalStub() {
  const registered: Array<{ handle: Handle; fn: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  let next = 1;
  return {
    registered,
    cleared,
    setInterval(fn: () => void, ms: number): unknown {
      const handle: Handle = {
        id: next++,
        unrefCalled: false,
        unref() { this.unrefCalled = true; },
      };
      registered.push({ handle, fn, ms });
      return handle;
    },
    clearInterval(h: unknown): void {
      cleared.push(h);
    },
  };
}

function makeServeHarness(opts: { sweepEnabled?: boolean; sweep?: (e: BrainEngine) => Promise<unknown> } = {}) {
  const stdin = new EventEmitter() as EventEmitter & { isTTY?: boolean };
  const signals = new EventEmitter();
  const logs: string[] = [];
  const timers = makeIntervalStub();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(r => { resolveExit = r; });
  let exitCalled = false;
  const engineStub = {
    disconnect: async () => {},
  } as unknown as BrainEngine;

  const serveOpts: ServeOptions = {
    stdin: stdin as never,
    signals: signals as never,
    exit: (code?: number) => {
      if (exitCalled) return;
      exitCalled = true;
      resolveExit(code ?? 0);
    },
    log: (m: string) => { logs.push(m); },
    startMcpServer: async () => {},
    // Parent PID 1 → watchdog interval skipped entirely, so the ONLY
    // deps.setInterval registration is the idle sweep's.
    getParentPid: () => 1,
    probeWatchdog: () => true,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    mcpStdio: false,
    bootTimeoutMs: 0,
    ...(opts.sweep ? { sweep: opts.sweep } : {}),
    ...(opts.sweepEnabled !== undefined ? { sweepEnabled: opts.sweepEnabled } : {}),
  };

  return { stdin, signals, logs, timers, exited, engineStub, serveOpts };
}

const settle = () => new Promise<void>(r => setTimeout(r, 0));

describe('serve.ts idle sweep wiring [ENG-5]', () => {
  test('interval registered at 10min through the deps seam, unref\'d; idle ticks sweep; data re-arms; shutdown clears', async () => {
    const sweepCalls: BrainEngine[] = [];
    const h = makeServeHarness({
      sweepEnabled: true,
      sweep: async (e) => { sweepCalls.push(e); },
    });
    await runServe(h.engineStub, [], h.serveOpts);

    expect(h.timers.registered.length).toBe(1);
    const { handle, fn, ms } = h.timers.registered[0];
    expect(ms).toBe(10 * 60_000);
    expect(handle.unrefCalled).toBe(true);

    // Tick 1: lazily attaches the stdin activity listener (the transport
    // is live by now); no activity signal yet → treated as active.
    fn();
    await settle();
    expect(sweepCalls.length).toBe(0);

    // Tick 2: a full interval with no stdin data → sweep fires with the engine.
    fn();
    await settle();
    expect(sweepCalls.length).toBe(1);
    expect(sweepCalls[0]).toBe(h.engineStub);

    // Data during the window → next tick skips (re-armed).
    h.stdin.emit('data', Buffer.from('{}'));
    fn();
    await settle();
    expect(sweepCalls.length).toBe(1);

    // Quiet window again → sweeps again.
    fn();
    await settle();
    expect(sweepCalls.length).toBe(2);

    // stdin EOF → beginShutdown clears the idle-sweep interval.
    h.stdin.emit('end');
    const code = await h.exited;
    expect(code).toBe(0);
    expect(h.timers.cleared).toContain(handle);
  });

  test('a rejecting sweep never kills the serve', async () => {
    const h = makeServeHarness({
      sweepEnabled: true,
      sweep: async () => { throw new Error('sweep exploded'); },
    });
    await runServe(h.engineStub, [], h.serveOpts);
    const { fn } = h.timers.registered[0];
    fn(); // attach listener
    fn(); // sweep fires and rejects — absorbed
    await settle();
    h.stdin.emit('end');
    expect(await h.exited).toBe(0);
  });

  test('GBRAIN_SWEEP=0 kill switch (sweepEnabled:false seam) → no timer at all', async () => {
    const h = makeServeHarness({ sweepEnabled: false });
    await runServe(h.engineStub, [], h.serveOpts);
    expect(h.timers.registered.length).toBe(0);
    h.stdin.emit('end');
    await h.exited;
  });
});

describe('armStartupSweep [ENG-5]', () => {
  test('arms a 3s unref\'d one-shot; firing runs the sweep; cancel clears', async () => {
    const engineStub = { disconnect: async () => {} } as unknown as BrainEngine;
    const captured: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    let unrefCalled = false;
    const sweepCalls: BrainEngine[] = [];

    const arm = armStartupSweep(engineStub, {
      env: {},
      setTimeoutFn: (fn, ms) => {
        captured.push({ fn, ms });
        return { unref: () => { unrefCalled = true; } };
      },
      clearTimeoutFn: (hh) => { cleared.push(hh); },
      sweep: async (e) => { sweepCalls.push(e); },
    });

    expect(arm).not.toBeNull();
    expect(captured.length).toBe(1);
    expect(captured[0].ms).toBe(STARTUP_SWEEP_DELAY_MS);
    expect(unrefCalled).toBe(true);

    captured[0].fn();
    await settle();
    expect(sweepCalls.length).toBe(1);
    expect(sweepCalls[0]).toBe(engineStub);

    arm!.cancel();
    expect(cleared.length).toBe(1);
  });

  test('GBRAIN_SWEEP=0 → null (nothing armed)', () => {
    const engineStub = {} as unknown as BrainEngine;
    let armedTimers = 0;
    const arm = armStartupSweep(engineStub, {
      env: { GBRAIN_SWEEP: '0' },
      setTimeoutFn: () => { armedTimers += 1; return {}; },
    });
    expect(arm).toBeNull();
    expect(armedTimers).toBe(0);
  });

  test('a rejecting sweep is swallowed (best-effort contract)', async () => {
    const engineStub = {} as unknown as BrainEngine;
    const captured: Array<() => void> = [];
    armStartupSweep(engineStub, {
      env: {},
      setTimeoutFn: (fn) => { captured.push(fn); return {}; },
      sweep: async () => { throw new Error('startup sweep exploded'); },
    });
    captured[0]();
    await settle(); // an unhandled rejection here would fail the test run
  });
});

// ── runSweep CLI wrapper — arg parsing + output modes [CX2-5] ───────────────
//
// No engine needed: usage errors return before any engine touch, and a
// --budget-ms 0 run budget-skips all three passes before the first query
// (proven with a recording proxy). Exit verdicts go through the gbrain-owned
// setCliExitVerdict channel — read via currentExitCode(), reset per run.

describe('runSweep CLI arg parsing [CX2-5]', () => {
  /** Engine proxy that records every property touch (0 touches expected). */
  function recordingEngine(touches: string[]): BrainEngine {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          touches.push(String(prop));
          return () => Promise.resolve([]);
        },
      },
    ) as unknown as BrainEngine;
  }

  interface SweepCliRun {
    verdict: number;
    stdout: string[];
    stderr: string[];
  }

  async function runSweepCli(engine: BrainEngine, args: string[]): Promise<SweepCliRun> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const savedExitCode = process.exitCode;
    _resetCliExitVerdictForTests();
    console.log = (...a: unknown[]) => { stdout.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
    try {
      await runSweep(engine, args);
      return { verdict: currentExitCode(), stdout, stderr };
    } finally {
      console.log = origLog;
      console.error = origErr;
      _resetCliExitVerdictForTests();
      process.exitCode = savedExitCode; // setCliExitVerdict mirrors here — undo
    }
  }

  test('--help prints the help text and never touches the engine', async () => {
    const touches: string[] = [];
    const r = await runSweepCli(recordingEngine(touches), ['--help']);
    expect(r.verdict).toBe(0);
    expect(r.stdout.join('\n')).toContain(SWEEP_HELP.trim().split('\n')[0]);
    expect(touches).toEqual([]);
  });

  test('missing --once → verdict 2 with the usage hint; engine untouched', async () => {
    const touches: string[] = [];
    const r = await runSweepCli(recordingEngine(touches), []);
    expect(r.verdict).toBe(2);
    expect(r.stderr.join('\n')).toContain('--once is required');
    expect(touches).toEqual([]);
  });

  test('--budget-ms rejects a non-integer → verdict 2 naming the flag', async () => {
    const r = await runSweepCli(recordingEngine([]), ['--once', '--budget-ms', 'abc']);
    expect(r.verdict).toBe(2);
    expect(r.stderr.join('\n')).toContain('--budget-ms requires a non-negative integer');
    expect(r.stderr.join('\n')).toContain('"abc"');
  });

  test('--budget-ms rejects a negative value → verdict 2', async () => {
    const r = await runSweepCli(recordingEngine([]), ['--once', '--budget-ms', '-5']);
    expect(r.verdict).toBe(2);
    expect(r.stderr.join('\n')).toContain('--budget-ms');
  });

  test('--budget-ms with a MISSING value → verdict 2 (not a crash)', async () => {
    const r = await runSweepCli(recordingEngine([]), ['--once', '--budget-ms']);
    expect(r.verdict).toBe(2);
    expect(r.stderr.join('\n')).toContain('(missing)');
  });

  test('--batch-limit shares the integer validation → verdict 2', async () => {
    const r = await runSweepCli(recordingEngine([]), ['--once', '--batch-limit', '1.5']);
    expect(r.verdict).toBe(2);
    expect(r.stderr.join('\n')).toContain('--batch-limit');
  });

  test('--budget-ms 0 --json → machine-readable report on stdout, verdict 0, zero engine touches', async () => {
    const touches: string[] = [];
    const r = await runSweepCli(recordingEngine(touches), ['--once', '--budget-ms', '0', '--json']);
    expect(r.verdict).toBe(0); // budget-skip is partial, NOT total failure
    expect(r.stdout.length).toBe(1); // exactly the JSON blob
    const report = JSON.parse(r.stdout[0]) as SweepReport;
    const reasons = report.skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual([
      'budget_exhausted:corpus',
      'budget_exhausted:facts_fence',
      'budget_exhausted:links_timeline',
    ]);
    expect(touches).toEqual([]); // budget gate fires before the first query
  });

  test('--source threads into the human summary line', async () => {
    const r = await runSweepCli(recordingEngine([]), ['--once', '--budget-ms', '0', '--source', 'my-src']);
    expect(r.verdict).toBe(0);
    const out = r.stdout.join('\n');
    expect(out).toContain('Sweep complete');
    expect(out).toContain('source=my-src');
    expect(out).toContain('budget_exhausted:facts_fence');
  });
});
