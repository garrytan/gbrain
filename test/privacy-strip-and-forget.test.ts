/**
 * v0.32.2 commit 8 — 3-layer privacy strip + forget-as-fence tests.
 *
 * Three layers under test:
 *   - Layer A (chunker): chunkText strips private fact rows so private
 *     text never reaches content_chunks (Codex R2-#1 P0)
 *   - Layer B (get_page privacy trigger): stripFactsFence + stripTakesFence
 *     fire when ctx.remote === true (Codex R2-#5 closes the subagent hole)
 *   - Forget-as-fence: forgetFactInFence rewrites the fence row instead of
 *     the DB-only expire path so forgets survive gbrain rebuild (Codex R2-#3)
 *
 * Real PGLite + tempdir filesystem.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { chunkText } from '../src/core/chunkers/recursive.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../src/core/facts-fence.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'privacy-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
});

const FENCE_BODY = (rows: string): string => `# Page

Some text.

## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
${FACTS_FENCE_END}
`;

// ─────────────────────────────────────────────────────────────────
// Layer A: chunker strip — private fact text NEVER reaches chunks
// ─────────────────────────────────────────────────────────────────

describe('Layer A — chunker strips private fact rows (Codex R2-#1)', () => {
  test('chunkText drops private fact text from output', () => {
    const body = FENCE_BODY(
      `| 1 | PUBLIC_FACT_PROOF | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_FACT_PROOF | fact | 1.0 | private | high | 2026-01-01 |  | s |  |`,
    );
    const chunks = chunkText(body);
    const allText = chunks.map(c => c.text).join('\n');

    expect(allText).toContain('PUBLIC_FACT_PROOF');     // world fact survives
    expect(allText).not.toContain('PRIVATE_FACT_PROOF'); // private fact dropped
  });

  test('private-only fence still produces chunks (the prose around it survives)', () => {
    const body = FENCE_BODY(
      `| 1 | SECRET | fact | 1.0 | private | high | 2026-01-01 |  | s |  |`,
    );
    const chunks = chunkText(body);
    const allText = chunks.map(c => c.text).join('\n');

    expect(allText).not.toContain('SECRET');
    // The prose ("Some text.") is preserved.
    expect(allText).toContain('Some text.');
  });

  test('no fence at all → chunker behavior unchanged', () => {
    const body = '# Just a page\n\nNo fence here.\n';
    const chunks = chunkText(body);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('Just a page');
  });

  test('private takes fence ALSO stripped (regression — v0.28 behavior preserved)', () => {
    const body = `# Page

<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | PRIVATE_TAKE | take | brain | 0.9 | 2026-01-01 |  |
<!--- gbrain:takes:end -->

Body text.`;
    const chunks = chunkText(body);
    const allText = chunks.map(c => c.text).join('\n');
    expect(allText).not.toContain('PRIVATE_TAKE');
    expect(allText).toContain('Body text');
  });
});

// ─────────────────────────────────────────────────────────────────
// Layer B: get_page strip trigger — ctx.remote drives the filter
// ─────────────────────────────────────────────────────────────────
//
// The trigger logic lives in src/core/operations.ts (the get_page
// handler) and is unit-tested via direct stripFactsFence + the
// `ctx.remote === true` check pattern. Full operations-dispatch
// integration test for get_page over MCP lives in
// test/e2e/system-of-record-invariant.test.ts (commit 10).

describe('Layer B — get_page strip trigger (Codex R2-#5)', () => {
  test('stripFactsFence({keepVisibility:["world"]}) drops private rows in body', async () => {
    // Use the fence's own stripFactsFence helper to verify the
    // shape that operations.ts will call. The trigger lives in
    // operations.ts:413 (now `ctx.remote === true`); we test the
    // helper here, and the trigger plumbing E2E in commit 10.
    const { stripFactsFence } = await import('../src/core/facts-fence.ts');
    const body = FENCE_BODY(
      `| 1 | WORLD_ROW | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_ROW | fact | 1.0 | private | high | 2026-01-01 |  | s |  |`,
    );
    const stripped = stripFactsFence(body, { keepVisibility: ['world'] });
    expect(stripped).toContain('WORLD_ROW');
    expect(stripped).not.toContain('PRIVATE_ROW');
  });

  // #3625 Codex review Critical finding: get_page/fetch_page only ever
  // stripped compiled_truth. A `## Facts` fence written below the
  // `<!-- timeline -->` sentinel (splitBody's split boundary) lands in the
  // `timeline` column instead — pre-existing, independent of the #3625
  // reconciliation guard — and was returned to remote/untrusted callers
  // completely unstripped, leaking private fact rows through both the
  // `timeline` field and the serialized `content` round-trip field.
  describe('#3625 Critical: get_page/fetch_page must ALSO strip the timeline column', () => {
    function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
      return {
        engine,
        config: { engine: 'pglite' as const },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        dryRun: false,
        remote: false,
        sourceId: 'default',
        // Cross-file gateway-state hermeticity (see put-page-provenance.test.ts's
        // beforeAll comment): put_page's noEmbed = ctx.deferEmbeds === true ||
        // !isAvailable('embedding') — relying on the ambient isAvailable() check
        // means a sibling file sharing this shard's process that configured a
        // live embedding provider makes put_page attempt a real embed call here,
        // which hangs without a stubbed transport. Force it off explicitly.
        deferEmbeds: true,
        ...opts,
      };
    }

    const MISPLACED_FENCE_CONTENT = `---
title: alice
type: person
---

Some body content.

<!-- timeline -->

## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | PUBLIC_TIMELINE_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_TIMELINE_FACT | fact | 1.0 | private | high | 2026-01-01 |  | s |  |
${FACTS_FENCE_END}
`;

    test('get_page: remote caller sees the world row but never the private row, in timeline OR content', async () => {
      const putPageOp = operations.find((o) => o.name === 'put_page')!;
      const getPageOp = operations.find((o) => o.name === 'get_page')!;
      await putPageOp.handler(makeCtx({ remote: false }), {
        slug: 'people/alice-timeline-leak',
        content: MISPLACED_FENCE_CONTENT,
      });

      // Sanity: confirm the fence really landed in timeline, not
      // compiled_truth — otherwise this test would pass for the wrong
      // reason (the pre-existing compiled_truth strip would cover it).
      const raw = await engine.getPage('people/alice-timeline-leak');
      expect(parseFactsFence(raw!.compiled_truth ?? '').facts).toHaveLength(0);
      expect((raw!.timeline ?? '')).toContain('PRIVATE_TIMELINE_FACT');

      const remote = await getPageOp.handler(makeCtx({ remote: true }), {
        slug: 'people/alice-timeline-leak',
        include_content: true,
      }) as { timeline?: string; content?: string };
      expect(remote.timeline).toContain('PUBLIC_TIMELINE_FACT');
      expect(remote.timeline).not.toContain('PRIVATE_TIMELINE_FACT');
      expect(remote.content).not.toContain('PRIVATE_TIMELINE_FACT');

      // Control: a trusted local caller still sees everything, unstripped.
      const local = await getPageOp.handler(makeCtx({ remote: false }), {
        slug: 'people/alice-timeline-leak',
      }) as { timeline?: string };
      expect(local.timeline).toContain('PRIVATE_TIMELINE_FACT');
    });

    test('fetch_page: remote caller\'s serialized text never contains the private timeline row', async () => {
      const putPageOp = operations.find((o) => o.name === 'put_page')!;
      const fetchPageOp = operations.find((o) => o.name === 'fetch')!;
      await putPageOp.handler(makeCtx({ remote: false }), {
        slug: 'people/bob-timeline-leak',
        content: MISPLACED_FENCE_CONTENT.replace('alice', 'bob'),
      });

      const remote = await fetchPageOp.handler(makeCtx({ remote: true }), {
        id: 'people/bob-timeline-leak',
      }) as { text?: string };
      expect(remote.text).toContain('PUBLIC_TIMELINE_FACT');
      expect(remote.text).not.toContain('PRIVATE_TIMELINE_FACT');
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// #2044 / #4548 row-level visibility-aware fence merge on remote
// write-back. A remote get_page strips non-'world' rows before the caller
// ever sees them, so those rows being absent from a put_page write-back is
// NOT an intentional delete — they are restored row-by-row. World-visible
// rows the caller could see are never restored: their edits/deletions are
// the caller's, honored as written (#4554). Trusted local callers see the
// full fence, so the merge never fires for them.
// ─────────────────────────────────────────────────────────────────

describe('#4548 row-level visibility-aware fence merge (remote write-back)', () => {
  function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
    return {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
      deferEmbeds: true,
      ...opts,
    };
  }
  const putPageOp = () => operations.find((o) => o.name === 'put_page')!;
  const getPageOp = () => operations.find((o) => o.name === 'get_page')!;

  async function remoteRoundTrip(slug: string, edit: (content: string) => string): Promise<void> {
    const remote = await getPageOp().handler(makeCtx({ remote: true }), {
      slug,
      include_content: true,
    }) as { content?: string };
    await putPageOp().handler(makeCtx({ remote: true }), { slug, content: edit(remote.content ?? '') });
  }

  test('P1 (#4548): mixed world+private fence — the hidden private row is RESTORED on a remote prose-edit round-trip', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/p1-mixed-merge';
      const fence = FENCE_BODY(
        `| 1 | PUBLIC_P1_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_P1_FACT | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
      warnSpy.mockClear();
      await remoteRoundTrip(slug, (c) => c.replace('Some text.', 'Some text edited.'));

      const raw = await engine.getPage(slug, { sourceId: 'default' });
      const parsed = parseFactsFence(raw?.compiled_truth ?? '');
      expect(raw?.compiled_truth ?? '').toContain('Some text edited.');
      expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
        [1, 'PUBLIC_P1_FACT'],
        [2, 'PRIVATE_P1_FACT'],
      ]);
      // The gap is CLOSED — no "#2044 gap" data-loss warning fires anymore.
      const warnedGap = warnSpy.mock.calls.some((c) => String(c[0]).includes('#2044 gap'));
      expect(warnedGap).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('mixed adds+edits+deletes: world-row edit + world-row delete honored, hidden row restored, caller add kept', async () => {
    const slug = 'people/mixed-adds-edits-deletes';
    const fence = FENCE_BODY(
      `| 1 | PUBLIC_A | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | SECRET_B | fact | 1.0 | private | high | 2026-01-02 |  | s |  |
| 3 | PUBLIC_C | fact | 1.0 | world | high | 2026-01-03 |  | s |  |`,
    );
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
    await remoteRoundTrip(slug, (c) => c
      .replace('PUBLIC_A', 'PUBLIC_A_EDITED')                        // edit visible row 1
      .split('\n').filter((l) => !l.includes('PUBLIC_C')).join('\n') // delete visible row 3
      .replace(FACTS_FENCE_END,
        `| 4 | CALLER_ADDED_FACT | fact | 0.9 | world | medium | 2026-02-01 |  | s |  |\n${FACTS_FENCE_END}`),
    );

    const raw = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(raw?.compiled_truth ?? '');
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [1, 'PUBLIC_A_EDITED'],   // caller's edit of a visible row respected
      [2, 'SECRET_B'],          // hidden row restored at its stable rowNum
      [4, 'CALLER_ADDED_FACT'], // caller's addition kept
    ]);
    expect(raw?.compiled_truth ?? '').not.toContain('PUBLIC_C'); // visible deletion honored
  });

  test('caller add colliding with a hidden rowNum: hidden row keeps its stable number, the add is renumbered', async () => {
    const slug = 'people/collision-renumber';
    const fence = FENCE_BODY(
      `| 1 | PUBLIC_COLLIDE | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | SECRET_COLLIDE | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
    );
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
    // The remote caller only sees row 1, so a naive append lands on #2 —
    // the hidden private row's number.
    await remoteRoundTrip(slug, (c) => c.replace(FACTS_FENCE_END,
      `| 2 | CALLER_COLLIDING_ADD | fact | 0.9 | world | medium | 2026-02-01 |  | s |  |\n${FACTS_FENCE_END}`,
    ));

    const raw = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(raw?.compiled_truth ?? '');
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [1, 'PUBLIC_COLLIDE'],
      [2, 'SECRET_COLLIDE'],        // stable rowNum preserved (cross-page #F<N> refs)
      [3, 'CALLER_COLLIDING_ADD'],  // caller's add renumbered onto a fresh number
    ]);
  });

  test('pure-private fence round-trip: full restoration still works (the original #2044 path), silently', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/no-warn-allprivate';
      const fence = FENCE_BODY(
        '| 1 | PRIVATE_NOWARN_FACT | fact | 1.0 | private | high | 2026-01-01 |  | s |  |',
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
      warnSpy.mockClear();
      await remoteRoundTrip(slug, (c) => c.replace('Some text.', 'Some text edited.'));

      const anyWarning = warnSpy.mock.calls.some((c) => String(c[0]).includes('#2044'));
      expect(anyWarning).toBe(false);
      const raw = await engine.getPage(slug, { sourceId: 'default' });
      expect((raw?.compiled_truth ?? '')).toContain('PRIVATE_NOWARN_FACT');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('idempotence: a remote write that already carries the hidden rows (same rowNum + claim) does not duplicate them', async () => {
    const slug = 'people/full-content-writeback';
    const fence = FENCE_BODY(
      `| 1 | PUBLIC_FULL | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | SECRET_FULL | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
    );
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
    // A remote writer that got the full content out-of-band writes it back
    // verbatim (plus a prose edit so the import isn't a hash-match skip).
    await putPageOp().handler(makeCtx({ remote: true }), {
      slug,
      content: fence.replace('Some text.', 'Some text edited.'),
    });

    const raw = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(raw?.compiled_truth ?? '');
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [1, 'PUBLIC_FULL'],
      [2, 'SECRET_FULL'],
    ]);
  });

  test('residual gap warn: a malformed incoming fence blocks the merge and the #2044 gap warning still fires', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/malformed-residual';
      const fence = FENCE_BODY(
        `| 1 | PUBLIC_MAL | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | SECRET_MAL | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
      warnSpy.mockClear();
      // The caller mangles the visible row's kind — the incoming fence now
      // parses with warnings, so the merge refuses to rewrite it (it can't
      // re-render rows it couldn't parse without losing caller content).
      // The hidden row is lost; the gap warning surfaces exactly that.
      await remoteRoundTrip(slug, (c) => c.replace('| fact |', '| banana |'));

      const warnedGap = warnSpy.mock.calls.some(
        (c) => String(c[0]).includes('#2044 gap') && String(c[0]).includes(slug),
      );
      expect(warnedGap).toBe(true);
      const raw = await engine.getPage(slug, { sourceId: 'default' });
      expect((raw?.compiled_truth ?? '')).not.toContain('SECRET_MAL');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('no merge, no warning: a normal local (non-remote) edit sees the full fence and its deletions are honored', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/no-warn-local';
      const fence = FENCE_BODY(
        `| 1 | LOCAL_WORLD_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | LOCAL_PRIVATE_FACT | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });
      warnSpy.mockClear();
      // Local write that drops both rows -- fully-informed, no merge, no diagnostic.
      await putPageOp().handler(makeCtx({ remote: false }), {
        slug,
        content: '# Page\n\nSome text edited.\n',
      });

      const anyWarning = warnSpy.mock.calls.some((c) => String(c[0]).includes('#2044'));
      expect(anyWarning).toBe(false);
      const raw = await engine.getPage(slug, { sourceId: 'default' });
      expect((raw?.compiled_truth ?? '')).not.toContain('LOCAL_PRIVATE_FACT');
      expect((raw?.compiled_truth ?? '')).not.toContain('LOCAL_WORLD_FACT');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// #4554: a fully-visible world-only fence deletion is a legitimate edit —
// under the row-level merge it stays deleted (no whole-block resurrection),
// and the old "#2044 restoration ... may have genuinely deleted" warn
// (#4555) no longer misfires: nothing world-visible is ever restored.
// ─────────────────────────────────────────────────────────────────

describe('#4554 world-only fence deletion honored (no resurrection, no misfiring warn)', () => {
  function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
    return {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
      deferEmbeds: true,
      ...opts,
    };
  }
  const putPageOp = () => operations.find((o) => o.name === 'put_page')!;
  const getPageOp = () => operations.find((o) => o.name === 'get_page')!;

  test('deleting a world-only fence over remote round-trip: deletion sticks, no restoration warn fires', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/p2-worldonly-honored';
      const fence = FENCE_BODY(
        '| 1 | WORLD_ONLY_P2_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |',
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });

      const remote = await getPageOp().handler(makeCtx({ remote: true }), {
        slug,
        include_content: true,
      }) as { content?: string };
      const body = remote.content ?? '';
      const factsHeadingIdx = body.indexOf('## Facts');
      const fenceEndIdx = body.indexOf(FACTS_FENCE_END) + FACTS_FENCE_END.length;
      const edited = body.slice(0, factsHeadingIdx).replace('Some text.', 'Some text, fence removed.')
        + body.slice(fenceEndIdx);
      warnSpy.mockClear();
      await putPageOp().handler(makeCtx({ remote: true }), { slug, content: edited });

      // The caller saw the whole fence and chose to remove it — honored.
      const raw = await engine.getPage(slug, { sourceId: 'default' });
      expect((raw?.compiled_truth ?? '')).not.toContain('WORLD_ONLY_P2_FACT');
      // And no "#2044 restoration"/"#2044" warn misfires about it.
      const anyWarning = warnSpy.mock.calls.some((c) => String(c[0]).includes('#2044'));
      expect(anyWarning).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('deleting only the WORLD rows of a mixed fence: world deletion sticks while hidden rows are restored', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const slug = 'people/p2-mixed-world-delete';
      const fence = FENCE_BODY(
        `| 1 | WORLD_DELETE_ME | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | PRIVATE_KEEP_ME | fact | 1.0 | private | high | 2026-01-02 |  | s |  |`,
      );
      await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });

      const remote = await getPageOp().handler(makeCtx({ remote: true }), {
        slug,
        include_content: true,
      }) as { content?: string };
      // Delete the (visible) world row but keep the fence itself.
      const edited = (remote.content ?? '')
        .split('\n').filter((l) => !l.includes('WORLD_DELETE_ME')).join('\n');
      warnSpy.mockClear();
      await putPageOp().handler(makeCtx({ remote: true }), { slug, content: edited });

      const raw = await engine.getPage(slug, { sourceId: 'default' });
      const parsed = parseFactsFence(raw?.compiled_truth ?? '');
      expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
        [2, 'PRIVATE_KEEP_ME'], // restored — the caller never saw it
      ]);
      expect((raw?.compiled_truth ?? '')).not.toContain('WORLD_DELETE_ME');
      // Restoring hidden rows is correct-by-design now — not at-risk, no warn.
      const anyWarning = warnSpy.mock.calls.some((c) => String(c[0]).includes('#2044'));
      expect(anyWarning).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('partial deletion of a world-only fence: exactly the kept rows remain, deleted ones stay deleted', async () => {
    const slug = 'people/p2-worldonly-partial';
    const fence = FENCE_BODY(
      `| 1 | WORLD_KEEP_A | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | WORLD_DROP_B | fact | 1.0 | world | high | 2026-01-02 |  | s |  |
| 3 | WORLD_KEEP_C | fact | 1.0 | world | high | 2026-01-03 |  | s |  |`,
    );
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });

    const remote = await getPageOp().handler(makeCtx({ remote: true }), {
      slug,
      include_content: true,
    }) as { content?: string };
    const edited = (remote.content ?? '')
      .split('\n').filter((l) => !l.includes('WORLD_DROP_B')).join('\n');
    await putPageOp().handler(makeCtx({ remote: true }), { slug, content: edited });

    const raw = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(raw?.compiled_truth ?? '');
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [1, 'WORLD_KEEP_A'],
      [3, 'WORLD_KEEP_C'],
    ]);
  });

  test('restoration preserves forget history: an inactive (struck, forgotten) private row round-trips intact', async () => {
    const slug = 'people/p2-forgotten-roundtrip';
    const fence = FENCE_BODY(
      `| 1 | WORLD_VISIBLE_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | ~~FORGOTTEN_SECRET~~ | fact | 0.9 | private | low | 2026-01-02 | 2026-02-01 | s | forgotten: user asked to remove |`,
    );
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: fence });

    const remote = await getPageOp().handler(makeCtx({ remote: true }), {
      slug,
      include_content: true,
    }) as { content?: string };
    expect(remote.content ?? '').not.toContain('FORGOTTEN_SECRET'); // stripped for remote readers
    await putPageOp().handler(makeCtx({ remote: true }), {
      slug,
      content: (remote.content ?? '').replace('Some text.', 'Some text edited.'),
    });

    const raw = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(raw?.compiled_truth ?? '');
    const restoredRow = parsed.facts.find((f) => f.rowNum === 2);
    expect(restoredRow?.claim).toBe('FORGOTTEN_SECRET');
    expect(restoredRow?.active).toBe(false);       // strikethrough survives the merge
    expect(restoredRow?.forgotten).toBe(true);     // forget-as-fence history survives
    expect(restoredRow?.validUntil).toBe('2026-02-01');
  });
});

// ─────────────────────────────────────────────────────────────────
// #4546 round-trip hazard: #4547 strips takes/facts fences from the
// `timeline` column for remote readers, so a remote get_page -> edit ->
// put_page round-trip arrives with the timeline fence's non-'world' rows
// missing too. The same row-level merge that protects compiled_truth
// (#4548) must cover the timeline-embedded fence, or the write-back
// silently drops the private timeline rows.
// ─────────────────────────────────────────────────────────────────

describe('#4546 timeline-embedded fence survives a remote round-trip', () => {
  function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
    return {
      engine,
      config: { engine: 'pglite' as const },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
      deferEmbeds: true,
      ...opts,
    };
  }
  const putPageOp = () => operations.find((o) => o.name === 'put_page')!;
  const getPageOp = () => operations.find((o) => o.name === 'get_page')!;

  const TIMELINE_FENCE_CONTENT = (slug: string) => `---
title: ${slug}
type: person
---

Body content.

<!-- timeline -->

## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | TL_PUBLIC_FACT | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | TL_SECRET_FACT | fact | 1.0 | private | high | 2026-01-02 |  | s |  |
${FACTS_FENCE_END}
`;

  test('remote prose-edit round-trip restores the hidden private row into the timeline column', async () => {
    const slug = 'people/tl-roundtrip-restore';
    await putPageOp().handler(makeCtx({ remote: false }), {
      slug,
      content: TIMELINE_FENCE_CONTENT(slug),
    });
    // Sanity: the fence really lives in timeline, and the remote reader
    // never sees the private row (#4547's read-side strip).
    const raw = await engine.getPage(slug, { sourceId: 'default' });
    expect(parseFactsFence(raw!.compiled_truth ?? '').facts).toHaveLength(0);
    expect(raw!.timeline ?? '').toContain('TL_SECRET_FACT');
    const remote = await getPageOp().handler(makeCtx({ remote: true }), {
      slug,
      include_content: true,
    }) as { content?: string };
    expect(remote.content ?? '').not.toContain('TL_SECRET_FACT');

    await putPageOp().handler(makeCtx({ remote: true }), {
      slug,
      content: (remote.content ?? '').replace('Body content.', 'Body content, edited remotely.'),
    });

    const after = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(after?.timeline ?? '');
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [1, 'TL_PUBLIC_FACT'],
      [2, 'TL_SECRET_FACT'], // restored into timeline, not lost, not moved
    ]);
    // The restored row stays in the timeline column; compiled_truth gains no fence.
    expect(parseFactsFence(after?.compiled_truth ?? '').facts).toHaveLength(0);
    expect(after?.compiled_truth ?? '').toContain('Body content, edited remotely.');
  });

  test('deleting the visible world row of the timeline fence sticks; the hidden row is still restored', async () => {
    const slug = 'people/tl-roundtrip-world-delete';
    await putPageOp().handler(makeCtx({ remote: false }), {
      slug,
      content: TIMELINE_FENCE_CONTENT(slug),
    });
    const remote = await getPageOp().handler(makeCtx({ remote: true }), {
      slug,
      include_content: true,
    }) as { content?: string };
    const edited = (remote.content ?? '')
      .split('\n').filter((l) => !l.includes('TL_PUBLIC_FACT')).join('\n');
    await putPageOp().handler(makeCtx({ remote: true }), { slug, content: edited });

    const after = await engine.getPage(slug, { sourceId: 'default' });
    const parsed = parseFactsFence(after?.timeline ?? '');
    expect(parsed.facts.map((f) => [f.rowNum, f.claim])).toEqual([
      [2, 'TL_SECRET_FACT'],
    ]);
    expect(after?.timeline ?? '').not.toContain('TL_PUBLIC_FACT');
  });

  test('local trusted round-trip of a timeline fence is untouched by the merge', async () => {
    const slug = 'people/tl-local-untouched';
    await putPageOp().handler(makeCtx({ remote: false }), {
      slug,
      content: TIMELINE_FENCE_CONTENT(slug),
    });
    // Local caller deletes the ENTIRE timeline fence — fully informed, honored.
    const local = await getPageOp().handler(makeCtx({ remote: false }), {
      slug,
      include_content: true,
    }) as { content?: string };
    const fenceBegin = (local.content ?? '').indexOf('## Facts');
    const fenceEnd = (local.content ?? '').indexOf(FACTS_FENCE_END) + FACTS_FENCE_END.length;
    const edited = (local.content ?? '').slice(0, fenceBegin) + (local.content ?? '').slice(fenceEnd);
    await putPageOp().handler(makeCtx({ remote: false }), { slug, content: edited });

    const after = await engine.getPage(slug, { sourceId: 'default' });
    expect(after?.timeline ?? '').not.toContain('TL_SECRET_FACT');
    expect(after?.timeline ?? '').not.toContain('TL_PUBLIC_FACT');
  });
});

// ─────────────────────────────────────────────────────────────────
// Forget-as-fence (Codex R2-#3)
// ─────────────────────────────────────────────────────────────────

async function seedV51Fact(opts: {
  entity_slug: string;
  source_markdown_slug: string;
  row_num: number;
  fact: string;
  source?: string;
}): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence, row_num, source_markdown_slug)
     VALUES ('default', $1, $2, 'fact', 'world', 'medium', now(), $3, 1.0, $4, $5)
     RETURNING id`,
    [opts.entity_slug, opts.fact, opts.source ?? 's', opts.row_num, opts.source_markdown_slug],
  );
  return r.rows[0].id;
}

function seedFile(slug: string, rows: string): void {
  const filePath = join(brainDir, `${slug}.md`);
  mkdirSync(join(brainDir, slug.split('/')[0]), { recursive: true });
  writeFileSync(filePath, FENCE_BODY(rows), 'utf-8');
}

describe('forgetFactInFence — fence path (happy)', () => {
  test('rewrites the fence row with strikethrough + valid_until + forgotten context', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'I will hit $10M by Q4',
    });
    seedFile('people/alice', `| 1 | I will hit $10M by Q4 | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    const r = await forgetFactInFence(engine, id, { reason: 'changed my mind' });
    expect(r.ok).toBe(true);
    expect(r.path).toBe('fence');

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('~~I will hit $10M by Q4~~');
    expect(body).toContain('forgotten: changed my mind');

    // DB row expired_at is now non-null + valid_until set to today.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbRow = await (engine as any).db.query(
      'SELECT expired_at, valid_until FROM facts WHERE id = $1', [id],
    );
    expect(dbRow.rows[0].expired_at).not.toBeNull();
    expect(dbRow.rows[0].valid_until).not.toBeNull();
  });

  test('re-parsing the rewritten fence sees forgotten=true + active=false', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F1',
    });
    seedFile('people/alice', `| 1 | F1 | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    await forgetFactInFence(engine, id, { reason: 'test' });

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    const parsed = parseFactsFence(body);
    expect(parsed.facts[0]).toMatchObject({
      claim: 'F1',
      active: false,
      forgotten: true,
    });
  });

  test('default reason is "forgotten" when caller omits it', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });
    seedFile('people/alice', `| 1 | F | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    const r = await forgetFactInFence(engine, id);
    expect(r.reason).toBe('forgotten');

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('forgotten: forgotten');
  });

  test('preserves existing context cell (appends rather than overwriting)', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });
    seedFile(
      'people/alice',
      `| 1 | F | fact | 1.0 | world | medium | 2026-01-01 |  | s | important note |`,
    );

    await forgetFactInFence(engine, id, { reason: 'r' });

    const body = readFileSync(join(brainDir, 'people/alice.md'), 'utf-8');
    expect(body).toContain('important note');
    expect(body).toContain('forgotten: r');
  });
});

describe('forgetFactInFence — fallback paths', () => {
  test('legacy NULL-row_num fact falls back to DB-only expire', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence)
       VALUES ('default', 'people/alice', 'legacy', 'fact', 'world', 'medium',
               now(), 's', 1.0) RETURNING id`,
    );
    const id = r.rows[0].id;

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = await (engine as any).db.query(
      'SELECT expired_at FROM facts WHERE id = $1', [id],
    );
    expect(after.rows[0].expired_at).not.toBeNull();
  });

  test('missing local_path on source falls back to DB-only', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');
  });

  test('missing entity page file falls back to DB-only (file deleted out from under us)', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/ghost', source_markdown_slug: 'people/ghost',
      row_num: 1, fact: 'F',
    });
    // No file created — page exists in DB but not on disk.
    expect(existsSync(join(brainDir, 'people/ghost.md'))).toBe(false);

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');
  });

  test('row_num drift (DB has v51 cols but fence missing the row) falls back to DB-only', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 99, fact: 'F',  // row_num 99 in DB but only row 1 in fence
    });
    seedFile('people/alice', `| 1 | Different fact | fact | 1.0 | world | medium | 2026-01-01 |  | s |  |`);

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(true);
    expect(result.path).toBe('legacy_db');
  });

  test('unknown id returns ok:false path:not_found', async () => {
    const result = await forgetFactInFence(engine, 999999);
    expect(result.ok).toBe(false);
    expect(result.path).toBe('not_found');
  });

  test('already-expired id returns ok:false path:already_expired', async () => {
    const id = await seedV51Fact({
      entity_slug: 'people/alice', source_markdown_slug: 'people/alice',
      row_num: 1, fact: 'F',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE facts SET expired_at = now() WHERE id = $1`, [id]);

    const result = await forgetFactInFence(engine, id);
    expect(result.ok).toBe(false);
    expect(result.path).toBe('already_expired');
  });
});

afterAll(() => {
  try { if (brainDir) rmSync(brainDir, { recursive: true, force: true }); }
  catch { /* best-effort */ }
});
