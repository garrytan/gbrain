/**
 * #3674 — `gbrain extract links --by-mention --rebuild`.
 *
 * The by-mention write path is purely additive, so a mentions row outlives
 * its own justification (body rewritten, entity deleted, tokenizer changed).
 * --rebuild reconciles: per page, ONE transaction deletes the page's
 * link_source='mentions' rows and re-inserts the current mention set.
 * typed_ner rows whose target is still derivable survive (extract-ner owns
 * their verbs; the mention scan cannot regenerate them); stale typed_ner
 * rows (target no longer derivable) die with the rest.
 *
 * Hermetic PGLite, driven through runExtract like the CLI.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract } from '../src/commands/extract.ts';
import { setCliOptions } from '../src/core/cli-options.ts';

let engine: PGLiteEngine;

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
  setCliOptions({ quiet: false, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  restoreCli();
}, 30_000);

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM op_checkpoints');
  await engine.executeRaw('DELETE FROM pages');
});

async function seedEntities(): Promise<void> {
  await engine.putPage('companies/acme', { type: 'company', title: 'Acme Corp', compiled_truth: 'acme body', timeline: '', frontmatter: {} });
  await engine.putPage('people/alice', { type: 'person', title: 'Alice Example', compiled_truth: 'alice body', timeline: '', frontmatter: {} });
}

async function seedContentPage(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: {} }, { allowEmptyOverwrite: true });
}

async function runCli(args: string[]): Promise<void> {
  captureCli();
  try {
    await runExtract(engine, args);
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('__test_exit:'))) throw e;
  } finally {
    restoreCli();
  }
}

async function mentionTargets(fromSlug: string): Promise<Array<{ to: string; kind: string | null }>> {
  const rows = await engine.executeRaw<{ to_slug: string; link_kind: string | null }>(
    `SELECT tp.slug AS to_slug, l.link_kind
     FROM links l
     JOIN pages fp ON fp.id = l.from_page_id
     JOIN pages tp ON tp.id = l.to_page_id
     WHERE fp.slug = $1 AND l.link_source = 'mentions'
     ORDER BY tp.slug`,
    [fromSlug],
  );
  return rows.map((r) => ({ to: r.to_slug, kind: r.link_kind }));
}

describe('extract links --by-mention --rebuild (#3674)', () => {
  test('rebuild removes the stale mention the additive path leaves behind', async () => {
    await seedEntities();
    await seedContentPage('writing/post-1', 'We met with Acme Corp yesterday.');
    await runCli(['links', '--by-mention', '--source', 'db']);
    expect((await mentionTargets('writing/post-1')).map((t) => t.to)).toEqual(['companies/acme']);

    // Body rewritten: now mentions Alice, no longer Acme.
    await seedContentPage('writing/post-1', 'Alice Example joined the call.');

    // The additive path accretes — the stale Acme row survives (the bug).
    await runCli(['links', '--by-mention', '--source', 'db']);
    expect((await mentionTargets('writing/post-1')).map((t) => t.to)).toEqual(
      ['companies/acme', 'people/alice'],
    );

    // --rebuild reconciles: stale row dies, current mention stays.
    await runCli(['links', '--by-mention', '--rebuild', '--source', 'db']);
    expect((await mentionTargets('writing/post-1')).map((t) => t.to)).toEqual(['people/alice']);
  });

  test('rebuild sweeps a page whose body no longer mentions anything', async () => {
    await seedEntities();
    await seedContentPage('writing/post-2', 'Acme Corp everywhere.');
    await runCli(['links', '--by-mention', '--source', 'db']);
    expect((await mentionTargets('writing/post-2')).length).toBe(1);

    await seedContentPage('writing/post-2', 'Nothing to see here anymore.');
    await runCli(['links', '--by-mention', '--rebuild', '--source', 'db']);
    expect(await mentionTargets('writing/post-2')).toEqual([]);
  });

  test('still-valid typed_ner rows survive; stale typed_ner rows die', async () => {
    await seedEntities();
    await seedContentPage('writing/post-3', 'Acme Corp and Alice Example.');
    await runCli(['links', '--by-mention', '--source', 'db']);
    // extract-ner style verb rows on the SAME link_source, keyed link_kind.
    await engine.addLinksBatch([
      { from_slug: 'writing/post-3', to_slug: 'people/alice', link_type: 'works_at', link_source: 'mentions', link_kind: 'typed_ner', context: '', from_source_id: 'default', to_source_id: 'default' },
      { from_slug: 'writing/post-3', to_slug: 'companies/acme', link_type: 'invested_in', link_source: 'mentions', link_kind: 'typed_ner', context: '', from_source_id: 'default', to_source_id: 'default' },
    ]);

    // Body rewritten: Alice still mentioned, Acme gone.
    await seedContentPage('writing/post-3', 'Alice Example runs the show now.');
    await runCli(['links', '--by-mention', '--rebuild', '--source', 'db']);

    const rows = await mentionTargets('writing/post-3');
    // Alice: plain mention re-inserted + typed_ner verb row preserved.
    expect(rows.filter((r) => r.to === 'people/alice' && r.kind === 'typed_ner').length).toBe(1);
    expect(rows.filter((r) => r.to === 'people/alice' && r.kind !== 'typed_ner').length).toBe(1);
    // Acme: both the plain row AND the stale typed_ner row are gone.
    expect(rows.filter((r) => r.to === 'companies/acme')).toEqual([]);
  });

  test('other link_sources are untouched by the rebuild sweep', async () => {
    await seedEntities();
    await seedContentPage('writing/post-4', 'No entities named in the new body.');
    await engine.addLinksBatch([
      { from_slug: 'writing/post-4', to_slug: 'companies/acme', link_type: 'references', link_source: 'markdown', context: '', from_source_id: 'default', to_source_id: 'default' },
    ]);
    await runCli(['links', '--by-mention', '--rebuild', '--source', 'db']);
    const rows = await engine.executeRaw<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM links WHERE link_source = 'markdown'`, [],
    );
    expect(Number(rows[0]!.c)).toBe(1);
  });

  test('--rebuild without --by-mention is rejected with exit 2', async () => {
    await runCli(['links', '--rebuild', '--source', 'db']);
    expect(exitedWith).toBe(2);
    expect(stderrBuffer.join('\n')).toContain('--rebuild only applies to the by-mention pass');
  });

  test('summary reports removed count', async () => {
    await seedEntities();
    await seedContentPage('writing/post-5', 'Acme Corp again.');
    await runCli(['links', '--by-mention', '--source', 'db']);
    await seedContentPage('writing/post-5', 'no mentions now');
    await runCli(['links', '--by-mention', '--rebuild', '--source', 'db']);
    expect(stdoutBuffer.join('\n')).toMatch(/removed 1 stale mention link/);
  });

  test('removeLinksByPagesAndSource: empty page list is a no-op', async () => {
    expect(await engine.removeLinksByPagesAndSource([], { linkSource: 'mentions' })).toBe(0);
  });
});
