// v0.41 T5+T6 — extract_atoms + synthesize_concepts minimal-viable bodies.
//
// Tests the LLM-driven extraction + synthesis paths with a stubbed
// chat function so no real Haiku/Sonnet calls fire in CI. Pins:
//   - extract_atoms parses Haiku JSON output, writes atom-typed pages
//   - parseAtomsResponse tolerates markdown fences + trailing prose
//   - extract_atoms skips invalid atom_type values
//   - extract_atoms budget cap halts mid-run
//   - synthesize_concepts groups atoms by concept frontmatter ref
//   - tier assignment by count (T1 ≥10, T2 ≥5, T3 ≥2)
//   - T1/T2 use LLM narrative; T3 falls back deterministic
//   - dry-run mode counts but doesn't write

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms, parseAtomsResponse } from '../../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function stubChat(text: string, opts: { input_tokens?: number; output_tokens?: number } = {}): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => ({
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: {
      input_tokens: opts.input_tokens ?? 500,
      output_tokens: opts.output_tokens ?? 200,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });
}

describe('v0.41 T5: parseAtomsResponse', () => {
  test('parses well-formed JSON array', () => {
    const raw = `[{"title":"Test","atom_type":"insight","body":"body text"}]`;
    const atoms = parseAtomsResponse(raw);
    expect(atoms.length).toBe(1);
    expect(atoms[0].title).toBe('Test');
    expect(atoms[0].atom_type).toBe('insight');
  });

  test('strips markdown code fences', () => {
    const raw = '```json\n[{"title":"T","atom_type":"quote","body":"b"}]\n```';
    expect(parseAtomsResponse(raw).length).toBe(1);
  });

  test('tolerates trailing prose after JSON', () => {
    const raw = `[{"title":"T","atom_type":"framework","body":"b"}]\n\nThanks!`;
    expect(parseAtomsResponse(raw).length).toBe(1);
  });

  test('rejects atoms with invalid atom_type', () => {
    const raw = `[{"title":"T","atom_type":"made_up_type","body":"b"}]`;
    expect(parseAtomsResponse(raw).length).toBe(0);
  });

  test('rejects atoms missing required fields', () => {
    const raw = `[{"title":"T","atom_type":"insight"}]`; // no body
    expect(parseAtomsResponse(raw).length).toBe(0);
  });

  test('returns [] on garbage input', () => {
    expect(parseAtomsResponse('not json')).toEqual([]);
    expect(parseAtomsResponse('')).toEqual([]);
  });

  test('accepts all 11 declared atom_type values', () => {
    const types = ['insight', 'anecdote', 'quote', 'framework', 'statistic',
                   'story_angle', 'strategy_angle', 'strategy', 'endorsement',
                   'critique', 'collection'];
    for (const t of types) {
      const raw = `[{"title":"x","atom_type":"${t}","body":"b"}]`;
      const atoms = parseAtomsResponse(raw);
      expect(atoms.length).toBe(1);
      expect(atoms[0].atom_type as string).toBe(t);
    }
  });

  test('clamps virality_score to [0, 100]', () => {
    expect(parseAtomsResponse(`[{"title":"a","atom_type":"insight","body":"b","virality_score":150}]`)[0].virality_score).toBeUndefined();
    expect(parseAtomsResponse(`[{"title":"a","atom_type":"insight","body":"b","virality_score":-5}]`)[0].virality_score).toBeUndefined();
    expect(parseAtomsResponse(`[{"title":"a","atom_type":"insight","body":"b","virality_score":75}]`)[0].virality_score).toBe(75);
  });
});

describe('v0.41 T5: runPhaseExtractAtoms via stubbed chat', () => {
  test('no-op when no transcripts AND no pages provided', async () => {
    // v0.41.2.1: _pages:[] suppresses page-discovery so this matches the
    // pre-v0.41.2.1 "transcript-only no-op" path. Reason changed from
    // 'no_transcripts' to 'no_work' to reflect the dual-source design.
    const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [] });
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_work');
  });

  test('extracts atoms from transcript via stub chat', async () => {
    const chat = stubChat(`[
      {"title":"Renders vs physical proof","atom_type":"insight","body":"Enterprise buyers want tangible prototypes."},
      {"title":"Founder lesson","atom_type":"anecdote","body":"Story about a founder."}
    ]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/fake/meeting.txt', content: 'content', contentHash: 'abc123def' }],
      _pages: [], // suppress page discovery — transcript-only test
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(2);
    expect(result.details?.transcripts_processed).toBe(1);

    // Verify pages were written
    const rows = await engine.executeRaw<{ slug: string; type: string }>(
      `SELECT slug, type FROM pages WHERE type = 'atom'`,
    );
    expect(rows.length).toBe(2);
  });

  test('dry-run counts but does NOT write', async () => {
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/x.txt', content: 'c', contentHash: 'h' }],
      _pages: [],
      _chat: chat,
      dryRun: true,
    });
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.dry_run).toBe(true);
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(rows[0].count).toBe(0);
  });

  test('failures tracked per-transcript without halting', async () => {
    let callCount = 0;
    const chat = async (_o: ChatOpts) => {
      callCount++;
      if (callCount === 1) throw new Error('rate limit');
      return {
        text: `[{"title":"t","atom_type":"insight","body":"b"}]`,
        blocks: [],
        stopReason: 'end' as const,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    };
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [
        { filePath: '/a.txt', content: 'a', contentHash: 'ha' },
        { filePath: '/b.txt', content: 'b', contentHash: 'hb' },
      ],
      _pages: [],
      _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat,
    });
    expect(result.status).toBe('warn');
    expect(result.details?.atoms_extracted).toBe(1);
    expect((result.details?.failures as unknown[]).length).toBe(1);
  });

  test('caller deadline aborts a hung chat before processing the next item', async () => {
    let calls = 0;
    const chat = async (opts: ChatOpts) => {
      calls++;
      return await new Promise<never>((_resolve, reject) => {
        const signal = opts.abortSignal;
        if (!signal) return reject(new Error('missing abort signal'));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const started = Date.now();
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [
        { filePath: '/hung.txt', content: 'a', contentHash: 'hung-a' },
        { filePath: '/never.txt', content: 'b', contentHash: 'hung-b' },
      ],
      _pages: [],
      _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat,
      abortSignal: AbortSignal.timeout(25),
    });
    expect(Date.now() - started).toBeLessThan(250);
    expect(calls).toBe(1);
    expect(result.status).toBe('ok');
    expect(result.details?.deadline_aborted).toBe(true);
    expect(result.details?.atoms_extracted).toBe(0);
    expect(result.details?.failures).toEqual([]);
  });

  test('billable chat usage is counted when deadline fires as the response resolves', async () => {
    const controller = new AbortController();
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      controller.abort(new DOMException('deadline', 'TimeoutError'));
      return stubChat(`[{"title":"late","atom_type":"insight","body":"b"}]`, {
        input_tokens: 1_000,
        output_tokens: 500,
      })(opts);
    };
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/late.txt', content: 'a', contentHash: 'late' }],
      _pages: [],
      _chat: chat,
      abortSignal: controller.signal,
    });
    expect(result.details?.deadline_aborted).toBe(true);
    expect(Number(result.details?.estimated_spend_usd)).toBeGreaterThan(0);
    expect(result.details?.atoms_extracted).toBe(0);
  });

  test('caller deadline cancels a hung atom write and stops the phase', async () => {
    const controller = new AbortController();
    let notifyWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { notifyWriteStarted = resolve; });
    let writeCalls = 0;
    const signalAwareEngine = {
      executeRaw: async (sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => {
        if (!sql.includes('INSERT INTO pages')) return [];
        writeCalls++;
        notifyWriteStarted();
        return await new Promise<never>((_resolve, reject) => {
          const signal = opts?.signal;
          if (!signal) return reject(new Error('missing abort signal'));
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    } as unknown as BrainEngine;

    const pending = runPhaseExtractAtoms(signalAwareEngine, {
      _transcripts: [{ filePath: '/hung-write.txt', content: 'a', contentHash: 'hung-write' }],
      _pages: [],
      _chat: stubChat(`[{
        "title":"hung write","atom_type":"insight","body":"b"
      }]`),
      abortSignal: controller.signal,
    });
    await writeStarted;
    controller.abort(new DOMException('deadline', 'TimeoutError'));
    const result = await pending;

    expect(writeCalls).toBe(1);
    expect(result.details?.deadline_aborted).toBe(true);
    expect(result.details?.atoms_extracted).toBe(0);
  });

  test('deadline after partial progress still writes receipt and incomplete rollup', async () => {
    const controller = new AbortController();
    let calls = 0;
    let notifySecondChat!: () => void;
    const secondChatStarted = new Promise<void>((resolve) => { notifySecondChat = resolve; });
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      calls++;
      if (calls === 1) {
        return stubChat(`[{"title":"committed","atom_type":"insight","body":"b"}]`)(opts);
      }
      notifySecondChat();
      return await new Promise<never>((_resolve, reject) => {
        const signal = opts.abortSignal;
        if (!signal) return reject(new Error('missing abort signal'));
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };

    const pending = runPhaseExtractAtoms(engine, {
      _transcripts: [
        { filePath: '/committed.txt', content: 'a', contentHash: 'committed-a' },
        { filePath: '/hung.txt', content: 'b', contentHash: 'hung-b' },
      ],
      _pages: [],
      _chat: chat,
      abortSignal: controller.signal,
    });
    await secondChatStarted;
    controller.abort(new DOMException('deadline', 'TimeoutError'));
    const result = await pending;

    const atoms = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE type = 'atom'`,
    );
    const receipts = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE type = 'extract_receipt'`,
    );
    const rollups = await engine.executeRaw<{
      cost_usd: string | number;
      round_completed_count: string | number;
    }>(
      `SELECT cost_usd, round_completed_count
         FROM extract_rollup_7d
        WHERE kind = 'atoms' AND source_id = 'default'`,
    );
    expect(result.details?.deadline_aborted).toBe(true);
    expect(atoms[0].n).toBe(1);
    expect(receipts[0].n).toBe(1);
    expect(Number(rollups[0].cost_usd)).toBeGreaterThan(0);
    expect(Number(rollups[0].round_completed_count)).toBe(0);
  });

  test('work deadline firing during receipt does not cancel bookkeeping grace', async () => {
    const controller = new AbortController();
    let putCalls = 0;
    let receiptSignal: AbortSignal | undefined;
    let rollupSignal: AbortSignal | undefined;
    const signalAwareEngine = {
      executeRaw: async (sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => {
        if (sql.includes('INSERT INTO extract_rollup_7d')) rollupSignal = opts?.signal;
        return [];
      },
      putPage: async (_slug: string, _page: unknown, opts?: { signal?: AbortSignal }) => {
        putCalls++;
        if (putCalls === 1) {
          receiptSignal = opts?.signal;
          controller.abort(new DOMException('work deadline', 'TimeoutError'));
        }
        return {};
      },
    } as unknown as BrainEngine;

    const result = await runPhaseExtractAtoms(signalAwareEngine, {
      _transcripts: [{ filePath: '/one.txt', content: 'a', contentHash: 'one' }],
      _pages: [],
      _chat: stubChat(`[{"title":"one","atom_type":"insight","body":"b"}]`),
      abortSignal: controller.signal,
    });

    expect(result.details?.atoms_extracted).toBe(1);
    expect(putCalls).toBe(1);
    expect(receiptSignal).toBeDefined();
    expect(receiptSignal).not.toBe(controller.signal);
    expect(receiptSignal?.aborted).toBe(false);
    expect(rollupSignal).toBe(receiptSignal);
  });

  test('deadline cancels the one atomic statement without partial atom commits', async () => {
    const controller = new AbortController();
    let atomicCalls = 0;
    let batchRows = 0;
    const atomicEngine = {
      executeRaw: async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO pages')) {
          atomicCalls++;
          batchRows = JSON.parse(String(params?.[0])).length;
          controller.abort(new DOMException('deadline', 'TimeoutError'));
          throw controller.signal.reason;
        }
        return [];
      },
    } as unknown as BrainEngine;

    const result = await runPhaseExtractAtoms(atomicEngine, {
      _transcripts: [{ filePath: '/two-atoms.txt', content: 'a', contentHash: 'two-atoms' }],
      _pages: [],
      _chat: stubChat(`[
        {"title":"one","atom_type":"insight","body":"b"},
        {"title":"two","atom_type":"insight","body":"b"}
      ]`),
      abortSignal: controller.signal,
    });

    expect(result.details?.deadline_aborted).toBe(true);
    expect(result.details?.atoms_extracted).toBe(0);
    expect(atomicCalls).toBe(1);
    expect(batchRows).toBe(2);
  });

  test('slug-colliding atom titles commit as distinct stable rows', async () => {
    const chat = stubChat(`[
      {"title":"Same!","atom_type":"insight","body":"first body"},
      {"title":"same","atom_type":"insight","body":"second body"}
    ]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/collide.txt', content: 'a', contentHash: 'collide' }],
      _pages: [],
      _chat: chat,
    });
    const firstRows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE type = 'atom' ORDER BY slug`,
    );
    expect(result.details?.atoms_extracted).toBe(2);
    expect(firstRows.length).toBe(2);
    expect(new Set(firstRows.map((r) => r.slug)).size).toBe(2);

    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/collide.txt', content: 'changed', contentHash: 'collide-v2' }],
      _pages: [],
      _chat: chat,
    });
    const secondRows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE type = 'atom' ORDER BY slug`,
    );
    expect(secondRows.map((r) => r.slug)).toEqual(firstRows.map((r) => r.slug));
  });

  test('same atom title from two origins stays distinct and both become idempotent', async () => {
    let chatCalls = 0;
    const chat = async (opts: ChatOpts) => {
      chatCalls++;
      return stubChat(`[{"title":"Shared title","atom_type":"insight","body":"same body"}]`)(opts);
    };
    const transcripts = [
      { filePath: '/origin-a.txt', content: 'a', contentHash: 'origin-a-hash' },
      { filePath: '/origin-b.txt', content: 'b', contentHash: 'origin-b-hash' },
    ];
    const first = await runPhaseExtractAtoms(engine, {
      _transcripts: transcripts,
      _pages: [],
      _chat: chat,
    });
    const firstRows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE type = 'atom' ORDER BY slug`,
    );
    expect(first.details?.atoms_extracted).toBe(2);
    expect(firstRows.length).toBe(2);
    expect(new Set(firstRows.map((r) => r.slug)).size).toBe(2);

    chatCalls = 0;
    const second = await runPhaseExtractAtoms(engine, {
      _transcripts: transcripts,
      _pages: [],
      _chat: chat,
    });
    expect(second.details?.atoms_extracted).toBe(0);
    expect(second.details?.duplicates_skipped).toBe(2);
    expect(chatCalls).toBe(0);
  });

  test('bulk JSONB path sanitizes NUL and lone surrogates in LLM prose', async () => {
    const raw = JSON.stringify([{
      title: 'bad\0\ud800 title',
      atom_type: 'insight',
      body: 'body\0\ud800 text',
      source_quote: 'quote\0\ud800',
      lesson: 'lesson\0\ud800',
    }]);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/poison.txt', content: 'a', contentHash: 'poison' }],
      _pages: [],
      _chat: stubChat(raw),
    });
    const rows = await engine.executeRaw<{
      title: string;
      compiled_truth: string;
      frontmatter: Record<string, unknown>;
    }>(`SELECT title, compiled_truth, frontmatter FROM pages WHERE type = 'atom'`);
    const serialized = JSON.stringify(rows);
    expect(result.details?.atoms_extracted).toBe(1);
    expect(serialized.includes('\0')).toBe(false);
    expect(serialized.includes('\ud800')).toBe(false);
    expect(serialized.includes('�')).toBe(true);
  });

  // v0.41.2.1 regression case (D9 #14 wording): with _pages:[] and same
  // _transcripts, all PRE-EXISTING PhaseResult.details fields match
  // pre-fix values byte-for-byte. The new fields (pages_processed,
  // pages_total, pages_skipped_budget, duplicates_skipped) exist but
  // are zeros. Closes the "transcript path silently regresses" risk.
  test('legacy transcript-only fields unchanged when _pages:[] (regression guard)', async () => {
    const chat = stubChat(`[{"title":"r","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/regression.txt', content: 'c', contentHash: 'rH' }],
      _pages: [],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    // Pre-existing fields — must keep their pre-fix values verbatim
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.transcripts_processed).toBe(1);
    expect(result.details?.transcripts_total).toBe(1);
    expect(result.details?.transcripts_skipped_budget).toBe(0);
    expect(result.details?.failures).toEqual([]);
    expect(result.details?.budget_usd).toBe(0.3);
    expect(result.details?.source_id).toBe('default');
    expect(result.details?.dry_run).toBe(false);
    // New additive fields — zero when no page work
    expect(result.details?.pages_processed).toBe(0);
    expect(result.details?.pages_total).toBe(0);
    expect(result.details?.pages_skipped_budget).toBe(0);
    expect(result.details?.duplicates_skipped).toBe(0);
  });
});

describe('v0.41 T6: runPhaseSynthesizeConcepts via stubbed chat', () => {
  test('no-op when no atoms have concept refs', async () => {
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: [] });
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_atoms');
  });

  test('groups atoms by concept and assigns tier by count', async () => {
    const atoms: Array<{ slug: string; title: string; body: string; concept_refs: string[] }> = [];
    for (let i = 0; i < 12; i++) {
      atoms.push({
        slug: `atoms/2026-05-24/atom-${i}`,
        title: `Atom ${i}`,
        body: `Body of atom ${i}.`,
        concept_refs: ['ai-agents'],
      });
    }
    for (let i = 0; i < 6; i++) {
      atoms.push({
        slug: `atoms/2026-05-24/founder-${i}`,
        title: `Founder ${i}`,
        body: `Founder body ${i}.`,
        concept_refs: ['founder-psychology'],
      });
    }
    for (let i = 0; i < 3; i++) {
      atoms.push({
        slug: `atoms/2026-05-24/hw-${i}`,
        title: `HW ${i}`,
        body: `HW body ${i}.`,
        concept_refs: ['hardware-renaissance'],
      });
    }

    const chat = stubChat('AI agents are software factories.');
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat });
    expect(result.status).toBe('ok');
    expect(result.details?.concepts_written).toBe(3);
    const tiers = result.details?.tier_counts as Record<string, number>;
    expect(tiers.T1).toBe(1); // ai-agents (12)
    expect(tiers.T2).toBe(1); // founder-psychology (6)
    expect(tiers.T3).toBe(1); // hardware-renaissance (3)
  });

  test('atoms with no concept refs are filtered out', async () => {
    const atoms = [
      { slug: 's1', title: 't1', body: 'b1', concept_refs: [] },
      { slug: 's2', title: 't2', body: 'b2', concept_refs: [] },
    ];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms });
    expect(result.status).toBe('skipped');
  });

  test('concept count below T3 threshold (2) is filtered out', async () => {
    const atoms = [{ slug: 's', title: 't', body: 'b', concept_refs: ['only-one-mention'] }];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms });
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_groups_above_threshold');
  });

  test('T3 concepts use deterministic narrative (no LLM call)', async () => {
    const atoms = [
      { slug: 'a1', title: 'A1', body: 'b1', concept_refs: ['theme'] },
      { slug: 'a2', title: 'A2', body: 'b2', concept_refs: ['theme'] },
    ];
    let chatCalled = false;
    const chat = async (_o: ChatOpts) => {
      chatCalled = true;
      return stubChat('should not be called')(_o);
    };
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat as typeof import('../../src/core/ai/gateway.ts').chat });
    expect(chatCalled).toBe(false);
  });

  test('dry-run counts but does NOT write', async () => {
    const atoms = Array.from({ length: 6 }, (_, i) => ({
      slug: `s${i}`,
      title: `T${i}`,
      body: `b${i}`,
      concept_refs: ['theme'],
    }));
    const chat = stubChat('synthesized narrative');
    const result = await runPhaseSynthesizeConcepts(engine, {
      _atoms: atoms,
      _chat: chat,
      dryRun: true,
    });
    expect(result.details?.concepts_written).toBe(1);
    expect(result.details?.dry_run).toBe(true);
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'concept' AND slug LIKE 'concepts/%'`,
    );
    expect(rows[0].count).toBe(0);
  });

  test('T1 concept gets LLM-synthesized narrative', async () => {
    const atoms = Array.from({ length: 12 }, (_, i) => ({
      slug: `a${i}`,
      title: `T${i}`,
      body: `b${i}`,
      concept_refs: ['theme'],
    }));
    const chat = stubChat('Custom synthesized narrative from LLM.');
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, _chat: chat });
    const rows = await engine.executeRaw<{ compiled_truth: string }>(
      `SELECT compiled_truth FROM pages WHERE slug = 'concepts/theme'`,
    );
    expect(rows[0].compiled_truth).toContain('Custom synthesized narrative');
  });
});
