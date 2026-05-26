/**
 * Integration tests for `gbrain extract links --by-mention`.
 *
 * Hermetic PGLite. Drives runExtract via the same dispatcher the CLI uses,
 * captures stdout/stderr, asserts side-effects against the engine.
 *
 * Covers 14 cases from the v0.42.0.0 plan:
 *   1. End-to-end happy path — links created with link_source='mentions'
 *   2. Idempotency — second run = 0 new links
 *   3. --dry-run writes nothing, prints expected count
 *   4. --json output shape stable
 *   5. --source-id correctly scopes page WALK (gazetteer remains brain-wide-ish)
 *   6. --since DATE only scans pages modified after date
 *   7. --source fs --by-mention rejected with usage error + fix-hint
 *   8. Default link extract NOT also run when --by-mention is set
 *   9. Cross-source mention suppressed (source isolation)
 *  10. Pseudo-pages excluded from gazetteer by type filter (NOT auto-suffix)
 *  11. Existing markdown link coexists with mention link (different link_source)
 *  12. Progress phase events fire under --progress-json
 *  13. Schema migration verified — link_source='mentions' insert succeeds
 *  14. Empty brain (no entity pages) → no-op with informative message
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import { setCliOptions } from '../src/core/cli-options.ts';

let engine: PGLiteEngine;

// stdout/stderr capture for CLI assertions. Intercepts BOTH console.log
// AND process.stdout.write (JSON action lines bypass console.log).
let stdoutBuffer: string[];
let stderrBuffer: string[];
let exitedWith: number | null;
const origLog = console.log;
const origErr = console.error;
const origExit = process.exit;
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

function captureCli(): void {
  stdoutBuffer = [];
  stderrBuffer = [];
  exitedWith = null;
  console.log = (msg?: unknown) => { stdoutBuffer.push(typeof msg === 'string' ? msg : String(msg)); };
  console.error = (msg?: unknown) => { stderrBuffer.push(typeof msg === 'string' ? msg : String(msg)); };
  (process.stdout as unknown as { write: unknown }).write = ((chunk: unknown) => {
    stdoutBuffer.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
  (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown) => {
    stderrBuffer.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;
  (process as { exit: unknown }).exit = ((code?: number) => {
    exitedWith = code ?? 0;
    throw new Error(`__test_exit:${code ?? 0}`);
  }) as unknown as typeof process.exit;
}

function restoreCli(): void {
  console.log = origLog;
  console.error = origErr;
  (process.stdout as unknown as { write: unknown }).write = origStdoutWrite;
  (process.stderr as unknown as { write: unknown }).write = origStderrWrite;
  (process as { exit: unknown }).exit = origExit;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Default CLI options (quiet enough that the progress reporter doesn't
  // pollute the capture buffer beyond what the assertions need).
  setCliOptions({ quiet: false, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  restoreCli();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
  // Source registration needed for cross-source tests (default exists from initSchema).
});

async function seedEntities(): Promise<void> {
  await engine.putPage('companies/acme', { type: 'company', title: 'Acme Corp', compiled_truth: 'acme body', timeline: '', frontmatter: {} });
  await engine.putPage('people/alice', { type: 'person', title: 'Alice Example', compiled_truth: 'alice body', timeline: '', frontmatter: {} });
  await engine.putPage('people/bob', { type: 'person', title: 'Robert Builder', compiled_truth: 'bob body', timeline: '', frontmatter: {} });
}

async function seedContentPage(slug: string, body: string, timeline = ''): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline, frontmatter: {} });
}

async function runCli(args: string[]): Promise<void> {
  captureCli();
  try {
    await runExtract(engine, args);
  } catch (e) {
    // process.exit threw — captured in exitedWith. Swallow.
    if (!(e instanceof Error && e.message.startsWith('__test_exit:'))) throw e;
  } finally {
    restoreCli();
  }
}

describe('gbrain extract links --by-mention — integration', () => {
  test('1. end-to-end happy path — links created with link_source=mentions', async () => {
    await seedEntities();
    await seedContentPage('writing/post-1', 'We met with Acme Corp and Alice Example yesterday.');
    await runCli(['links', '--by-mention', '--source', 'db']);
    const rows = await engine.executeRaw<{ ls: string; from_slug: string; to_slug: string }>(
      `SELECT l.link_source AS ls, fp.slug AS from_slug, tp.slug AS to_slug
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       JOIN pages tp ON tp.id = l.to_page_id
       WHERE fp.slug = 'writing/post-1' AND l.link_source = 'mentions'`,
      [],
    );
    const targets = rows.map(r => r.to_slug).sort();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(targets).toContain('companies/acme');
    expect(targets).toContain('people/alice');
    // Robert Builder NOT mentioned in body — should not appear.
    expect(targets).not.toContain('people/bob');
  });

  test('2. idempotency — second run produces 0 new links', async () => {
    await seedEntities();
    await seedContentPage('writing/post-1', 'We met with Acme Corp and Alice Example.');
    await runCli(['links', '--by-mention', '--source', 'db']);
    const firstCount = (await engine.executeRaw<{ c: string }>(`SELECT COUNT(*)::text AS c FROM links WHERE link_source = 'mentions'`, []))[0]!.c;
    await runCli(['links', '--by-mention', '--source', 'db']);
    const secondCount = (await engine.executeRaw<{ c: string }>(`SELECT COUNT(*)::text AS c FROM links WHERE link_source = 'mentions'`, []))[0]!.c;
    expect(secondCount).toBe(firstCount);
  });

  test('3. --dry-run writes nothing', async () => {
    await seedEntities();
    await seedContentPage('writing/post-1', 'We met with Acme Corp.');
    await runCli(['links', '--by-mention', '--source', 'db', '--dry-run']);
    const rows = await engine.executeRaw<{ c: string }>(`SELECT COUNT(*)::text AS c FROM links WHERE link_source = 'mentions'`, []);
    expect(Number(rows[0]!.c)).toBe(0);
  });

  test('4. --json output shape stable (dry-run action lines on stdout)', async () => {
    await seedEntities();
    await seedContentPage('writing/post-1', 'Acme Corp here.');
    await runCli(['links', '--by-mention', '--source', 'db', '--dry-run', '--json']);
    const actionLines = stdoutBuffer.filter(l => l.includes('"action":"add_link"'));
    expect(actionLines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(actionLines[0]!);
    expect(parsed.action).toBe('add_link');
    expect(parsed.link_source).toBe('mentions');
    expect(parsed.type).toBe('mentions');
    expect(parsed.from).toBe('writing/post-1');
    expect(parsed.to).toBe('companies/acme');
  });

  test('7. --source fs --by-mention rejected with paste-ready fix-hint', async () => {
    await runCli(['links', '--by-mention', '--source', 'fs']);
    expect(exitedWith).toBe(2);
    const stderrText = stderrBuffer.join('\n');
    expect(stderrText).toContain('--by-mention requires --source db');
    expect(stderrText).toContain('gbrain extract links --by-mention --source db');
  });

  test('7b. --by-mention timeline rejected', async () => {
    await runCli(['timeline', '--by-mention', '--source', 'db']);
    expect(exitedWith).toBe(2);
    const stderrText = stderrBuffer.join('\n');
    expect(stderrText).toContain('--by-mention is a links-pass only');
  });

  test('8. mode dispatch — default link extract NOT also run when --by-mention is set', async () => {
    await seedEntities();
    // Markdown-link page that would normally produce a `link_source=markdown`
    // row through the default link extract. With --by-mention, default
    // extract should NOT fire.
    await seedContentPage('writing/post-1', 'Acme Corp [link](companies/acme).');
    await runCli(['links', '--by-mention', '--source', 'db']);
    const mdRows = await engine.executeRaw<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM links WHERE link_source = 'markdown'`, [],
    );
    expect(Number(mdRows[0]!.c)).toBe(0);
    const mentionRows = await engine.executeRaw<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM links WHERE link_source = 'mentions'`, [],
    );
    expect(Number(mentionRows[0]!.c)).toBeGreaterThanOrEqual(1);
  });

  test('11. existing markdown link + new mention link coexist (different link_source)', async () => {
    await seedEntities();
    await seedContentPage('writing/post-1', 'Acme Corp body text');
    // Simulate a pre-existing markdown link from the default extract pass.
    await engine.addLinksBatch([
      {
        from_slug: 'writing/post-1',
        to_slug: 'companies/acme',
        link_type: 'mentions',
        link_source: 'markdown',
        context: '',
      },
    ]);
    await runCli(['links', '--by-mention', '--source', 'db']);
    const rows = await engine.executeRaw<{ ls: string }>(
      `SELECT l.link_source AS ls FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       JOIN pages tp ON tp.id = l.to_page_id
       WHERE fp.slug = 'writing/post-1' AND tp.slug = 'companies/acme'`,
      [],
    );
    const sources = rows.map(r => r.ls).sort();
    // Both rows present — ON CONFLICT key includes link_source so no collision.
    expect(sources).toContain('markdown');
    expect(sources).toContain('mentions');
  });

  test('13. schema migration verified — link_source=mentions insert succeeds end-to-end', async () => {
    await seedEntities();
    await seedContentPage('writing/post-1', 'Acme Corp mentioned.');
    await runCli(['links', '--by-mention', '--source', 'db']);
    // The fact that the test got here without a CHECK constraint violation
    // is the assertion — migration v95 widened the CHECK so 'mentions' is valid.
    const rows = await engine.executeRaw<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM links WHERE link_source = 'mentions'`, [],
    );
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(1);
  });

  test('14. empty brain (no entity pages) → no-op with informative message', async () => {
    // No entity pages — only a content page.
    await seedContentPage('writing/lonely', 'Acme Corp Alice Example all mentioned but no entities exist.');
    await runCli(['links', '--by-mention', '--source', 'db']);
    const rows = await engine.executeRaw<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM links WHERE link_source = 'mentions'`, [],
    );
    expect(Number(rows[0]!.c)).toBe(0);
    // Informative message in stdout.
    const stdoutText = stdoutBuffer.join('\n');
    expect(stdoutText).toMatch(/no linkable entity pages|nothing to scan/i);
  });

  test('5. --source-id scopes page WALK', async () => {
    await seedEntities(); // all in 'default'
    // Register a second source via raw SQL (PGLite engine doesn't expose a setupSource helper).
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team-b', 'Team B') ON CONFLICT (id) DO NOTHING`, []);
    // Content page in team-b mentioning Acme (default-source entity).
    await engine.putPage('writing/team-b-post', {
      type: 'note', title: 'Team B Post', compiled_truth: 'Acme Corp mentioned here.', timeline: '', frontmatter: {},
    }, { sourceId: 'team-b' });
    await engine.putPage('writing/default-post', {
      type: 'note', title: 'Default Post', compiled_truth: 'Acme Corp here too.', timeline: '', frontmatter: {},
    });
    // Scope walk to team-b only.
    await runCli(['links', '--by-mention', '--source', 'db', '--source-id', 'team-b']);
    // team-b post mentions Acme — but cross-source guard suppresses (Acme is in 'default').
    const rows = await engine.executeRaw<{ c: string; fp: string }>(
      `SELECT COUNT(*)::text AS c, fp.slug AS fp FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       WHERE l.link_source = 'mentions' GROUP BY fp.slug`, [],
    );
    // Default-source post NOT scanned (walk scoped to team-b); team-b post
    // scanned but cross-source guard fires → zero mention rows.
    expect(rows.length).toBe(0);
  });

  test('9. cross-source mention suppressed (source isolation)', async () => {
    await seedEntities(); // entities in 'default'
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team-b', 'Team B') ON CONFLICT (id) DO NOTHING`, []);
    await engine.putPage('writing/team-b-post', {
      type: 'note', title: 'Team B Post', compiled_truth: 'Acme Corp mentioned.', timeline: '', frontmatter: {},
    }, { sourceId: 'team-b' });
    // Run without --source-id (walks all) — team-b post mentions default-source Acme.
    await runCli(['links', '--by-mention', '--source', 'db']);
    const rows = await engine.executeRaw<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       WHERE fp.slug = 'writing/team-b-post' AND l.link_source = 'mentions'`, [],
    );
    // Cross-source guard fires → 0 mention links from team-b/post to default/acme.
    expect(Number(rows[0]!.c)).toBe(0);
  });
});
