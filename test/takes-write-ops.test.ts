/**
 * CLI→MCP gap-closure wave — takes_add / takes_update / takes_resolve /
 * takes_supersede ops over dispatchToolCall (real PGLite engine + a temp
 * markdown repo as sync.repo_path).
 *
 * Pins the load-bearing trust + md-canonical semantics:
 *   - mirror-mandatory refusal (takes_mirror_unavailable) when sync.repo_path
 *     is unset [EV1]
 *   - holder WRITE fence: hit/miss/[] deny-all/undefined→['world'] default,
 *     threaded through dispatchToolCall (the wiring, not just the handler)
 *     [CEO-F8]
 *   - fenced rows present as not_found — same shape as a missing row [CEO-F4]
 *   - fence round-trip: md written first, DB mirrored with the reconcile
 *     primitive; fence-create-if-absent on a page's first take [CEO-F6]
 *   - resolved_by server-stamped mcp:<client> for remote callers +
 *     mcp_resolved surfacing on takes_scorecard [OV8/EV5]
 *   - immutability: resolved rows refuse update/supersede
 *   - concurrent adds serialize under the page lock: loser gets the
 *     retryable error, retry lands the next sequential row [ENG-E4/EV11]
 *   - dry_run short-circuits
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __takesWriteTesting } from '../src/core/takes-write.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { parseTakesFence, TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
let repo: string;

const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
/** stdio's hardcoded default allow-list (server.ts) — world-held writes only. */
const STDIO_WORLD = { ...STDIO, takesHoldersAllowList: ['world'] };
const LOCAL = { remote: false as const, sourceId: 'default' };

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function pageMd(slug: string): string {
  return readFileSync(join(repo, `${slug}.md`), 'utf-8');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gbrain-takes-ops-repo-'));
  await engine.setConfig('sync.repo_path', repo);
  for (const slug of ['people/alice-example', 'companies/acme-example', 'notes/lockrace']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `about ${slug}` });
    mkdirSync(join(repo, slug.split('/')[0]), { recursive: true });
    writeFileSync(join(repo, `${slug}.md`), `# ${slug}\n\nabout ${slug}\n`, 'utf-8');
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('takes_add', () => {
  test('creates the fence on first take [CEO-F6], mirrors to DB, returns the fence row number', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: 'people/alice-example', claim: 'Ships weekly', kind: 'take', holder: 'world', weight: 0.7,
    }, { ...STDIO_WORLD });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.row_num).toBe(1);
    expect(body.mirror_written).toBe(true);
    // md-first: the fence exists on disk with the row.
    const fence = parseTakesFence(pageMd('people/alice-example'));
    expect(fence.takes.length).toBe(1);
    expect(fence.takes[0].claim).toBe('Ships weekly');
    // DB mirror carries the same row.
    const rows = await engine.listTakes({ page_slug: 'people/alice-example', active: true });
    expect(rows.length).toBe(1);
    expect(rows[0].row_num).toBe(1);
    expect(rows[0].holder).toBe('world');
  });

  test('holder fence: outside-allow-list holder denies with machine-readable detail', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: 'people/alice-example', claim: 'Private hunch', kind: 'hunch', holder: 'people/garry-example',
    }, { ...STDIO_WORLD });
    expect(res.isError).toBe(true);
    const body = parsed(res);
    expect(body.error).toBe('permission_denied');
    expect(body.detail).toBe('holder_not_in_allowlist');
  });

  test('empty allow-list = deny-all; missing allow-list defaults to world [CEO-F8 wiring]', async () => {
    const denyAll = await dispatchToolCall(engine, 'takes_add', {
      slug: 'people/alice-example', claim: 'x', kind: 'fact', holder: 'world',
    }, { ...STDIO, takesHoldersAllowList: [] });
    expect(parsed(denyAll).error).toBe('permission_denied');

    // No list threaded at all (remote) → the ['world'] fail-closed default.
    const defaulted = await dispatchToolCall(engine, 'takes_add', {
      slug: 'companies/acme-example', claim: 'Raised a round', kind: 'fact', holder: 'world',
    }, { ...STDIO });
    expect(parsed(defaulted).row_num).toBe(1);
    const nonWorld = await dispatchToolCall(engine, 'takes_add', {
      slug: 'companies/acme-example', claim: 'y', kind: 'fact', holder: 'brain',
    }, { ...STDIO });
    expect(parsed(nonWorld).error).toBe('permission_denied');
  });

  test('trusted local caller is unfenced', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: 'people/alice-example', claim: 'Owner-held view', kind: 'bet', holder: 'people/garry-example', weight: 0.8,
    }, { ...LOCAL });
    expect(parsed(res).row_num).toBe(2);
  });

  test('mirror-mandatory: unset sync.repo_path refuses with takes_mirror_unavailable [EV1]', async () => {
    await engine.unsetConfig('sync.repo_path');
    try {
      const res = await dispatchToolCall(engine, 'takes_add', {
        slug: 'people/alice-example', claim: 'z', kind: 'fact', holder: 'world',
      }, { ...STDIO_WORLD });
      expect(res.isError).toBe(true);
      const body = parsed(res);
      expect(body.error).toBe('unavailable');
      expect(body.detail).toBe('takes_mirror_unavailable');
    } finally {
      await engine.setConfig('sync.repo_path', repo);
    }
  });

  test('dry_run short-circuits before any write', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: 'people/alice-example', claim: 'dry', kind: 'fact', holder: 'world', dry_run: true,
    }, { ...STDIO_WORLD });
    expect(parsed(res).dry_run).toBe(true);
    const fence = parseTakesFence(pageMd('people/alice-example'));
    expect(fence.takes.some(t => t.claim === 'dry')).toBe(false);
  });

  test('unknown page → page_not_found', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: 'missing/page', claim: 'x', kind: 'fact', holder: 'world',
    }, { ...STDIO_WORLD });
    expect(parsed(res).error).toBe('page_not_found');
  });
});

describe('takes_update + holder row fence', () => {
  test('updates mutable fields md-first and mirrors', async () => {
    const res = await dispatchToolCall(engine, 'takes_update', {
      slug: 'people/alice-example', row_num: 1, weight: 0.9, source: 'quarterly report',
    }, { ...STDIO_WORLD });
    expect(res.isError ?? false).toBe(false);
    const fence = parseTakesFence(pageMd('people/alice-example'));
    const row = fence.takes.find(t => t.rowNum === 1);
    expect(row?.weight).toBe(0.9);
    expect(row?.source).toBe('quarterly report');
    const db = (await engine.listTakes({ page_slug: 'people/alice-example', active: true })).find(t => t.row_num === 1);
    expect(Number(db?.weight)).toBe(0.9);
  });

  test('[CEO-F4] fenced row and missing row share the not_found shape (no existence leak)', async () => {
    // Row 2 is holder people/garry-example — outside the world allow-list.
    const fenced = await dispatchToolCall(engine, 'takes_update', {
      slug: 'people/alice-example', row_num: 2, weight: 0.1,
    }, { ...STDIO_WORLD });
    const missing = await dispatchToolCall(engine, 'takes_update', {
      slug: 'people/alice-example', row_num: 99, weight: 0.1,
    }, { ...STDIO_WORLD });
    const fencedBody = parsed(fenced);
    const missingBody = parsed(missing);
    expect(fencedBody.error).toBe('not_found');
    expect(missingBody.error).toBe('not_found');
    // Same shape: identical keys, and messages differing only by row number.
    expect(Object.keys(fencedBody).sort()).toEqual(Object.keys(missingBody).sort());
    expect(fencedBody.message.replace('#2', '#N')).toBe(missingBody.message.replace('#99', '#N'));
  });

  test('zero mutable fields → invalid_params', async () => {
    const res = await dispatchToolCall(engine, 'takes_update', {
      slug: 'people/alice-example', row_num: 1,
    }, { ...STDIO_WORLD });
    expect(parsed(res).error).toBe('invalid_params');
  });
});

describe('takes_resolve', () => {
  test('remote resolution is server-stamped mcp:<client> and ignores resolved_by [OV8]', async () => {
    const res = await dispatchToolCall(engine, 'takes_resolve', {
      slug: 'people/alice-example', row_num: 1, quality: 'correct',
      evidence: 'shipped 12 weeks straight', resolved_by: 'people/spoofed-owner',
    }, { ...STDIO_WORLD });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.resolved_by).toBe('mcp:stdio');
    const db = (await engine.listTakes({ page_slug: 'people/alice-example', active: true })).find(t => t.row_num === 1);
    expect(db?.resolved_quality).toBe('correct');
    expect(db?.resolved_by).toBe('mcp:stdio');
    // Markdown mirror carries the resolution too (13-col fence).
    expect(pageMd('people/alice-example')).toContain('mcp:stdio');
  });

  test('mcp_resolved surfaces on takes_scorecard [EV5]', async () => {
    const card = parsed(await dispatchToolCall(engine, 'takes_scorecard', {}, { ...STDIO_WORLD }));
    expect(card.mcp_resolved).toBeGreaterThanOrEqual(1);
  });

  test('resolved rows are immutable: update and supersede refuse, re-resolve refuses', async () => {
    for (const [op, args] of [
      ['takes_update', { slug: 'people/alice-example', row_num: 1, weight: 0.2 }],
      ['takes_supersede', { slug: 'people/alice-example', row_num: 1, claim: 'replacement' }],
      ['takes_resolve', { slug: 'people/alice-example', row_num: 1, quality: 'incorrect' }],
    ] as const) {
      const res = await dispatchToolCall(engine, op, args as Record<string, unknown>, { ...STDIO_WORLD });
      expect(parsed(res).error).toBe('invalid_params');
    }
  });

  test('#2955: resolveTakesFilePath heals a Git Bash /c/... local_path before join/containment (win32)', async () => {
    // Raw, an msys-recorded local_path join-resolves to a phantom
    // C:\c\Users\... on Windows — the take file lands nowhere real.
    const msysEngine = {
      executeRaw: async () => [{ local_path: '/c/Users/Tiger/Vault', source_path: null, source_uri: null }],
    } as unknown as PGLiteEngine;
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const { path, writeRoot } = await __takesWriteTesting.resolveTakesFilePath(
        msysEngine, '/unused-brain-dir', 'notes/msys-heal',
      );
      expect(writeRoot).toBe('C:\\Users\\Tiger\\Vault'); // healed, NOT the raw /c/... shape
      expect(path.startsWith('C:\\Users\\Tiger\\Vault')).toBe(true);
      expect(path).toContain('notes/msys-heal');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  test('#2955: identity on POSIX — a legitimate /c/... directory name is preserved', async () => {
    const posixEngine = {
      executeRaw: async () => [{ local_path: '/c/legit-posix-dir', source_path: null, source_uri: null }],
    } as unknown as PGLiteEngine;
    const { writeRoot } = await __takesWriteTesting.resolveTakesFilePath(
      posixEngine, '/unused-brain-dir', 'notes/msys-heal',
    );
    expect(writeRoot).toBe('/c/legit-posix-dir');
  });

  test('resolves a Git-root source_path when local_path is a repo subdirectory', async () => {
    const gitRoot = mkdtempSync(join(tmpdir(), 'gbrain-takes-scoped-source-'));
    mkdirSync(join(gitRoot, '.git'));
    const sourceRoot = join(gitRoot, 'public', 'changelog');
    const slug = 'public/changelog/posts/scoped-take';
    const sourcePath = `${slug}.md`;
    const filePath = join(sourceRoot, 'posts', 'scoped-take.md');
    mkdirSync(join(sourceRoot, 'posts'), { recursive: true });
    writeFileSync(filePath, [
      '# Scoped take',
      '',
      TAKES_FENCE_BEGIN,
      '| # | claim | kind | who | weight | since | source |',
      '|---|-------|------|-----|--------|-------|--------|',
      '| 1 | The scoped path resolves | take | world | 0.8 | 2026-08 | test |',
      TAKES_FENCE_END,
      '',
    ].join('\n'));
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Scoped take' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = $1 WHERE source_id = 'default' AND slug = $2`,
      [sourcePath, slug],
    );
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [sourceRoot]);

    try {
      const res = await dispatchToolCall(engine, 'takes_resolve', {
        slug, row_num: 1, quality: 'correct', evidence: 'verified',
      }, { ...STDIO_WORLD });

      expect(res.isError ?? false).toBe(false);
      expect(readFileSync(filePath, 'utf-8')).toContain('| correct |');
      expect(existsSync(join(sourceRoot, `${slug}.md`))).toBe(false);
    } finally {
      await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
      rmSync(gitRoot, { recursive: true, force: true });
    }
  });
});

describe('takes_supersede', () => {
  test('inherits kind/holder from the fence row, strikes old, appends next row, mirrors both', async () => {
    const add = parsed(await dispatchToolCall(engine, 'takes_add', {
      slug: 'companies/acme-example', claim: 'Old thesis', kind: 'take', holder: 'world', weight: 0.6,
    }, { ...STDIO_WORLD }));
    const res = parsed(await dispatchToolCall(engine, 'takes_supersede', {
      slug: 'companies/acme-example', row_num: add.row_num, claim: 'New thesis',
    }, { ...STDIO_WORLD }));
    expect(res.old_row).toBe(add.row_num);
    expect(res.new_row).toBeGreaterThan(add.row_num);
    const fence = parseTakesFence(pageMd('companies/acme-example'));
    const oldRow = fence.takes.find(t => t.rowNum === res.old_row);
    const newRow = fence.takes.find(t => t.rowNum === res.new_row);
    expect(oldRow?.active).toBe(false);
    expect(newRow?.active).toBe(true);
    expect(newRow?.kind).toBe('take');       // inherited
    expect(newRow?.holder).toBe('world');    // inherited
    expect(newRow?.weight).toBeCloseTo(0.5); // 0.6 - 0.1 decay
    // DB mirror: old row carries the supersession pointer.
    const db = await engine.listTakes({ page_slug: 'companies/acme-example', active: false });
    const dbOld = db.find(t => t.row_num === res.old_row);
    expect(dbOld?.superseded_by).toBe(res.new_row);
  });

  test('an explicit override holder must clear the fence too', async () => {
    const add = parsed(await dispatchToolCall(engine, 'takes_add', {
      slug: 'companies/acme-example', claim: 'World view', kind: 'take', holder: 'world',
    }, { ...STDIO_WORLD }));
    const res = await dispatchToolCall(engine, 'takes_supersede', {
      slug: 'companies/acme-example', row_num: add.row_num, claim: 'Now private', holder: 'brain',
    }, { ...STDIO_WORLD });
    expect(parsed(res).error).toBe('permission_denied');
  });
});

// Guard-coverage batch — fresh slugs only (earlier describes create takes on
// the shared fixtures, so row numbers there are order-dependent; these pages
// are created here and touched by no other describe).
describe('takes-write guards (invalid_input / row_inactive / md-absent / mcp_resolved scoping)', () => {
  beforeAll(async () => {
    for (const slug of ['notes/guards-input', 'notes/guards-inactive']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `about ${slug}` });
      mkdirSync(join(repo, slug.split('/')[0]), { recursive: true });
      writeFileSync(join(repo, `${slug}.md`), `# ${slug}\n\nabout ${slug}\n`, 'utf-8');
    }
    // DB row but NO .md file — the md-file-absent refusal fixture.
    await engine.putPage('notes/md-absent', { type: 'note', title: 'md-absent', compiled_truth: 'db only' });
  });

  test('invalid_input guards over dispatchToolCall → invalid_params', async () => {
    const cases: Array<Record<string, unknown>> = [
      // Newline in the claim: fence cells are single-line.
      { slug: 'notes/guards-input', claim: 'line one\nline two', kind: 'fact', holder: 'world' },
      // Fence-marker text in the claim: fence-injection refusal.
      { slug: 'notes/guards-input', claim: 'contains gbrain:takes marker', kind: 'fact', holder: 'world' },
      // Out-of-range weight (docs promise 0..1; DB would clamp → md/DB divergence).
      { slug: 'notes/guards-input', claim: 'ok claim', kind: 'fact', holder: 'world', weight: 7 },
      // Malformed since date (must be YYYY-MM or YYYY-MM-DD).
      { slug: 'notes/guards-input', claim: 'ok claim', kind: 'fact', holder: 'world', since: '2026/01/01' },
    ];
    for (const args of cases) {
      const res = await dispatchToolCall(engine, 'takes_add', args, { ...STDIO_WORLD });
      expect(res.isError).toBe(true);
      expect(parsed(res).error).toBe('invalid_params');
    }
    // None of the refused adds touched the fence.
    const fence = parseTakesFence(pageMd('notes/guards-input'));
    expect(fence.takes.length).toBe(0);
  });

  test('row_inactive: update and resolve on a superseded row both refuse, naming the supersession', async () => {
    const add = parsed(await dispatchToolCall(engine, 'takes_add', {
      slug: 'notes/guards-inactive', claim: 'Original claim', kind: 'take', holder: 'world', weight: 0.6,
    }, { ...STDIO_WORLD }));
    const sup = parsed(await dispatchToolCall(engine, 'takes_supersede', {
      slug: 'notes/guards-inactive', row_num: add.row_num, claim: 'Replacement claim',
    }, { ...STDIO_WORLD }));
    expect(sup.old_row).toBe(add.row_num);

    const upd = parsed(await dispatchToolCall(engine, 'takes_update', {
      slug: 'notes/guards-inactive', row_num: add.row_num, weight: 0.1,
    }, { ...STDIO_WORLD }));
    expect(upd.error).toBe('invalid_params');
    expect(upd.message).toContain('superseded');

    const resv = parsed(await dispatchToolCall(engine, 'takes_resolve', {
      slug: 'notes/guards-inactive', row_num: add.row_num, quality: 'correct',
    }, { ...STDIO_WORLD }));
    expect(resv.error).toBe('invalid_params');
    expect(resv.message).toContain('superseded');
  });

  test('md-file-absent: DB row without a page file refuses with takes_mirror_unavailable', async () => {
    const res = await dispatchToolCall(engine, 'takes_update', {
      slug: 'notes/md-absent', row_num: 1, weight: 0.5,
    }, { ...STDIO_WORLD });
    expect(res.isError).toBe(true);
    const body = parsed(res);
    expect(body.error).toBe('unavailable');
    expect(body.detail).toBe('takes_mirror_unavailable');
  });

  test('countMcpResolved is source-scoped: a foreign sourceId sees mcp_resolved 0', async () => {
    // Control: the default source carries at least one mcp:stdio resolution
    // (the takes_resolve describe above), so a zero under a foreign scope is
    // the scoping working — not a dead counter.
    const home = parsed(await dispatchToolCall(engine, 'takes_scorecard', {}, { ...STDIO_WORLD }));
    expect(home.mcp_resolved).toBeGreaterThanOrEqual(1);
    const foreign = parsed(await dispatchToolCall(engine, 'takes_scorecard', {}, {
      ...STDIO_WORLD, sourceId: 'foreign-scope-src',
    }));
    expect(foreign.mcp_resolved).toBe(0);
  });
});

// Adversarial-fix regression batch (garrytan/cli-mcp-parity-audit). Fresh
// slugs + md fixtures written directly here — earlier describes are
// order-sensitive on the shared fixtures, so nothing below touches them.
describe('takes-write adversarial regressions (F1 cross-holder / P1-2 containment / P1-4 mirror-nonfatal / F2 strikethrough / P1-1 per-source)', () => {
  const F1_SLUG = 'people/f1-crosshold';
  const F2_SLUG = 'notes/f2-strike';
  const P14_SLUG = 'notes/p1-4-mirror';
  const P11_SLUG = 'notes/p1-1-persource';
  const P12_SLUG = 'escape-link/pwned';

  // Exact fence header/separator renderTakesFence emits, so the fixture round-
  // trips through parseTakesFence identically to a real extract.
  const FENCE_HEADER = '| # | claim | kind | who | weight | since | source |';
  const FENCE_SEP = '|---|-------|------|-----|--------|-------|--------|';

  beforeAll(async () => {
    for (const slug of [F1_SLUG, F2_SLUG, P14_SLUG, P11_SLUG, P12_SLUG]) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `about ${slug}` });
      // P12's `escape-link/` dir is a symlink the P1-2 test plants itself — do
      // NOT pre-create it as a real directory here (that would EEXIST the symlink).
      if (slug !== P12_SLUG) mkdirSync(join(repo, slug.split('/')[0]), { recursive: true });
    }
    // F1 fixture: a VALID world row (row 1) + a row parseTakesFence SKIPS
    // (kind 'finding' is outside {fact,take,bet,hunch}) held by an identity a
    // world-fenced caller can't see. Written directly so the fence carries a
    // parse warning the way a schema-pack-extended brain would.
    writeFileSync(
      join(repo, `${F1_SLUG}.md`),
      [
        `# ${F1_SLUG}`, '', 'Bio.', '', '## Takes', '',
        TAKES_FENCE_BEGIN,
        FENCE_HEADER,
        FENCE_SEP,
        '| 1 | Ships consensus fact | fact | world | 0.8 | 2026-01 | public |',
        '| 2 | Private cross-holder finding | finding | people/garry-example | 0.6 | 2026-02 | owner note |',
        TAKES_FENCE_END,
        '',
      ].join('\n'),
      'utf-8',
    );
    // F2 + P1-4 start as fence-less pages (add appends the fence).
    for (const slug of [F2_SLUG, P14_SLUG]) {
      writeFileSync(join(repo, `${slug}.md`), `# ${slug}\n\nabout ${slug}\n`, 'utf-8');
    }
  });

  test('F1: a world takes_update on the valid row refuses (fence_unparsed→invalid_params) and the skipped cross-holder row survives on disk', async () => {
    const res = await dispatchToolCall(engine, 'takes_update', {
      slug: F1_SLUG, row_num: 1, weight: 0.3,
    }, { ...STDIO_WORLD });
    expect(res.isError).toBe(true);
    expect(parsed(res).error).toBe('invalid_params');
    // Load-bearing: the write was refused BEFORE any whole-fence re-render, so
    // the row the parser skipped (a private, cross-holder finding) is still on
    // disk. Without the F1 guard the re-render would have deleted it silently.
    const onDisk = readFileSync(join(repo, `${F1_SLUG}.md`), 'utf-8');
    expect(onDisk).toContain('Private cross-holder finding');
    expect(onDisk).toContain('| finding |'); // the skipped row's kind cell intact
    expect(onDisk).toContain('people/garry-example');
    // And the valid row was NOT mutated (weight untouched).
    expect(onDisk).toContain('| 1 | Ships consensus fact | fact | world | 0.8 |');
  });

  test('P1-2: a symlinked page dir that escapes the repo root is refused; nothing is written outside the tree', async () => {
    const external = mkdtempSync(join(tmpdir(), 'gbrain-takes-external-'));
    // repo/escape-link → external (a sibling tree outside the repo root).
    symlinkSync(external, join(repo, 'escape-link'), 'dir');
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: P12_SLUG, claim: 'evil', kind: 'fact', holder: 'world',
    }, { ...STDIO_WORLD });
    expect(res.isError).toBe(true);
    const body = parsed(res);
    // isWriteTargetContained refuses; the op surfaces the mirror-unavailable envelope.
    expect(body.error).toBe('unavailable');
    expect(body.detail).toBe('takes_mirror_unavailable');
    // The containment check fired BEFORE any write — the escaping target is empty.
    expect(existsSync(join(external, 'pwned.md'))).toBe(false);
  });

  test('P1-4: a DB addTakesBatch failure is non-fatal — the row is durable in markdown and the result carries a mirror_warning', async () => {
    const throwingEngine = new Proxy(engine, {
      get(target, prop) {
        if (prop === 'addTakesBatch') {
          return async () => { throw new Error('simulated DB mirror failure'); };
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await dispatchToolCall(throwingEngine, 'takes_add', {
      slug: P14_SLUG, claim: 'md wins even when the DB mirror fails', kind: 'fact', holder: 'world',
    }, { ...STDIO_WORLD });
    // No throw, no error envelope — md is canonical and it was written.
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.mirror_written).toBe(true);
    expect(typeof body.mirror_warning).toBe('string');
    expect(body.mirror_warning).toContain('simulated DB mirror failure');
    // The durable row is on disk.
    const fence = parseTakesFence(pageMd(P14_SLUG));
    expect(fence.takes.some(t => t.claim === 'md wins even when the DB mirror fails')).toBe(true);
  });

  test('F2: a wholly-strikethrough claim (~~struck~~) is refused (invalid_params) — it would round-trip as inactive', async () => {
    const res = await dispatchToolCall(engine, 'takes_add', {
      slug: F2_SLUG, claim: '~~struck~~', kind: 'fact', holder: 'world',
    }, { ...STDIO_WORLD });
    expect(res.isError).toBe(true);
    expect(parsed(res).error).toBe('invalid_params');
    // Nothing landed — the guard fired before any I/O.
    expect(parseTakesFence(pageMd(F2_SLUG)).takes.length).toBe(0);
  });

  test('P1-1: a source with its own local_path files the take under THAT root, not the global sync.repo_path root', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'gbrain-takes-source-root-'));
    // Mock the per-source SELECT so the write resolves to sourceRoot; every
    // other query (getPageId, the DB mirror) delegates to the real engine.
    const perSourceEngine = new Proxy(engine, {
      get(target, prop) {
        if (prop === 'executeRaw') {
          return async (sql: unknown, params: unknown) => {
            if (typeof sql === 'string' && /SELECT\s+(?:s\.)?local_path[\s\S]+FROM sources/i.test(sql)) {
              return [{ local_path: sourceRoot, source_path: null }];
            }
            return (target as unknown as { executeRaw: (s: unknown, p: unknown) => Promise<unknown> })
              .executeRaw(sql, params);
          };
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await dispatchToolCall(perSourceEngine, 'takes_add', {
      slug: P11_SLUG, claim: 'lands under the source local_path', kind: 'fact', holder: 'world',
    }, { ...STDIO_WORLD });
    expect(res.isError ?? false).toBe(false);
    // The take file is at the source's own working tree (default layout = root),
    // NOT the global repo root.
    const underSourceRoot = join(sourceRoot, `${P11_SLUG}.md`);
    expect(existsSync(underSourceRoot)).toBe(true);
    expect(existsSync(join(repo, `${P11_SLUG}.md`))).toBe(false);
    expect(parseTakesFence(readFileSync(underSourceRoot, 'utf-8')).takes.some(
      t => t.claim === 'lands under the source local_path',
    )).toBe(true);
  });
});

describe('concurrency [ENG-E4/EV11]', () => {
  test('concurrent adds to one page: both eventually land with sequential rows, no silent overwrite', async () => {
    const call = () => dispatchToolCall(engine, 'takes_add', {
      slug: 'notes/lockrace', claim: `claim-${Math.random()}`, kind: 'fact', holder: 'world',
    }, { ...STDIO_WORLD });
    const [a, b] = await Promise.all([call(), call()]);
    const bodies = [parsed(a), parsed(b)];
    const oks = bodies.filter(x => typeof x.row_num === 'number');
    const errs = bodies.filter(x => x.error);
    // The 2s lock timeout usually lets both serialize; a loser (if any) is
    // the retryable shape and its retry lands the next row.
    for (const e of errs) {
      expect(e.error).toBe('unavailable');
      expect(e.detail).toBe('retryable');
      const retry = parsed(await call());
      oks.push(retry);
    }
    const rows = oks.map(x => x.row_num).sort((x, y) => x - y);
    expect(new Set(rows).size).toBe(rows.length); // sequential, never overwritten
    const fence = parseTakesFence(pageMd('notes/lockrace'));
    expect(fence.takes.length).toBe(rows.length);
  });
});

// #3605: shared-repo pages whose on-disk file name differs from the slug.
// The recorded `source_path` (or a contained `file://` `source_uri` from
// `gbrain capture --file`) is the file of record; the slug-derived path
// minted a stray twin on add and refused update/resolve with
// takes_mirror_unavailable even though the page's file was right there.
describe('takes-write recorded source_path routing (#3605)', () => {
  test('add/update/resolve hit the recorded source_path file; no slug-derived stray', async () => {
    const slug = 'people/jane-doe-3605';
    const recorded = 'people/Jane Doe 3605.md';
    const filePath = join(repo, recorded);
    mkdirSync(join(repo, 'people'), { recursive: true });
    writeFileSync(filePath, '# Jane Doe\n\nabout jane\n', 'utf-8');
    await engine.putPage(slug, { type: 'person', title: 'Jane Doe', compiled_truth: 'about jane' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = $1 WHERE source_id = 'default' AND slug = $2`,
      [recorded, slug],
    );

    const add = parsed(await dispatchToolCall(engine, 'takes_add', {
      slug, claim: 'Jane ships weekly', kind: 'take', holder: 'world', weight: 0.6,
    }, { ...STDIO_WORLD }));
    expect(add.row_num).toBe(1);
    // The fence landed in the recorded file, not a slug-derived twin.
    expect(readFileSync(filePath, 'utf-8')).toContain('Jane ships weekly');
    expect(existsSync(join(repo, `${slug}.md`))).toBe(false);

    // update + resolve read the SAME file instead of refusing mirror_unavailable.
    const upd = await dispatchToolCall(engine, 'takes_update', {
      slug, row_num: add.row_num, weight: 0.9,
    }, { ...STDIO_WORLD });
    expect(upd.isError ?? false).toBe(false);
    const fence = parseTakesFence(readFileSync(filePath, 'utf-8'));
    expect(fence.takes[0].weight).toBeCloseTo(0.9);

    const res = await dispatchToolCall(engine, 'takes_resolve', {
      slug, row_num: add.row_num, quality: 'correct', evidence: 'verified',
    }, { ...STDIO_WORLD });
    expect(res.isError ?? false).toBe(false);
    expect(readFileSync(filePath, 'utf-8')).toContain('| correct |');
    expect(existsSync(join(repo, `${slug}.md`))).toBe(false);
  });

  test('a hostile recorded source_path is ignored — slug-derived fallback, nothing escapes', async () => {
    const slug = 'notes/hostile-3605';
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = $1 WHERE source_id = 'default' AND slug = $2`,
      ['../outside-3605.md', slug],
    );
    const add = parsed(await dispatchToolCall(engine, 'takes_add', {
      slug, claim: 'falls back safely', kind: 'take', holder: 'world',
    }, { ...STDIO_WORLD }));
    expect(add.row_num).toBe(1);
    expect(readFileSync(join(repo, `${slug}.md`), 'utf-8')).toContain('falls back safely');
    expect(existsSync(join(repo, '..', 'outside-3605.md'))).toBe(false);
  });

  test('a captured page (file:// source_uri, no source_path) appends to the captured file', async () => {
    const slug = 'notes/captured-3605';
    const capturedAbs = join(repo, 'notes', 'Captured Note 3605.md');
    mkdirSync(join(repo, 'notes'), { recursive: true });
    writeFileSync(capturedAbs, '# Captured\n\nbody\n', 'utf-8');
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body' });
    await engine.executeRaw(
      `UPDATE pages SET source_uri = $1 WHERE source_id = 'default' AND slug = $2`,
      [`file://${capturedAbs}`, slug],
    );
    const add = parsed(await dispatchToolCall(engine, 'takes_add', {
      slug, claim: 'captured file is the file of record', kind: 'take', holder: 'world',
    }, { ...STDIO_WORLD }));
    expect(add.row_num).toBe(1);
    expect(readFileSync(capturedAbs, 'utf-8')).toContain('captured file is the file of record');
    expect(existsSync(join(repo, `${slug}.md`))).toBe(false);
  });
});
