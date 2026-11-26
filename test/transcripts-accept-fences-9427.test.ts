/**
 * #9427 `gbrain transcripts accept-fences`: outside_content_fences asks for one review per imported page, which on a
 * transcript-imported brain is hundreds of identical decisions. The owner now reviews every importer-written transcript
 * in one pass: a preview lists them with a plan_hash, and an apply with that hash records them as reviewed.
 *
 * 1. Protects: only conversation pages whose live revision the transcript importer wrote are ever accepted (an email
 *    page, a GitHub page and a conversation page a remote writer last wrote stay listed); the preview changes nothing;
 *    an apply needs --yes and the preview's hash, and a moved plan refuses preview_changed; an accepted page comes back
 *    when a fence row is added or when a non-importer write replaces it; nothing in a page or its rows changes.
 * 2. Fails when: a non-transcript or remote-written page is accepted, a stale or missing hash applies, or an accepted
 *    page with new rows stays hidden.
 * 3. Repo-less brains on in-memory PGLite, and Postgres when DATABASE_URL is set (the command writes one config row; a
 *    repo-backed brain runs the same path).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { outsideContentFencesEntry } from '../src/commands/doctor/checks/outside-content-fences.ts';
import { runTranscripts } from '../src/commands/transcripts.ts';
import { FENCE_ACCEPTANCE_KEY } from '../src/core/transcripts/fence-acceptance.ts';
import { _resetCliExitVerdictForTests, currentExitCode, setStdoutCapture } from '../src/core/cli-force-exit.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const CLAIM = 'A row from an imported conversation';
const FENCE = [
  '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  `| 1 | ${CLAIM} | fact | 0.8 | private | medium | 2026-01-01 | | conversation | |`,
  '<!--- gbrain:facts:end -->',
].join('\n');
const TRANSCRIPTS = ['conversations/sessions/2026-01-02-example-a', 'conversations/sessions/2026-01-03-example-b', 'conversations/sessions/2026-01-04-example-c'];
const REMOTE = 'conversations/sessions/2026-01-05-remote-example';
const EMAIL = 'emails/2026/01/outside-thread';

for (const kind of testBackends()) describe(`transcripts accept-fences (${kind})`, () => {
let engine: BrainEngine;
let close: () => Promise<void>;
const conversation = (slug: string, via: string | undefined, heading = 'Session') => importFromContent(engine, slug,
  `---\ntype: conversation\ntitle: Session\ntranscript_import:\n  harness: codex\n  session_id: ${slug.slice(-9)}\n---\n\n# ${heading}\n\n${FENCE}\n`,
  { sourceId: 'default', noEmbed: true, ...(via ? { ingested_via: via } : {}) });
beforeAll(async () => {
  if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('google-example', 'google-example', NULL, '{"kind":"google","g_account":"owner@example.com"}'::jsonb)`);
}, 120_000);
// Every test starts from the same five pages and no acceptance, so the tests pass in any order.
beforeEach(async () => {
  for (const table of ['facts', 'takes', 'links', 'pages']) await engine.executeRaw(`DELETE FROM ${table}`);
  await engine.executeRaw('DELETE FROM config WHERE key = $1', [FENCE_ACCEPTANCE_KEY]);
  for (const slug of TRANSCRIPTS) await conversation(slug, 'cli:transcripts-ingest');
  await conversation(REMOTE, 'mcp:put_page');
  await importFromContent(engine, EMAIL, `---\ntype: email\ntitle: Thread\n---\n\n# Thread\n\n${FENCE}\n`, { sourceId: 'google-example', noEmbed: true });
  await runExtractFacts(engine, { sourceId: 'default' });
  await runExtractFacts(engine, { sourceId: 'google-example' });
}, 120_000);
afterAll(async () => { await close(); });

async function check(): Promise<Check> {
  const checks = await outsideContentFencesEntry.run({ engine } as unknown as DoctorContext) as Check[];
  return checks[0]!;
}
const listed = async () => ((await check()).details as { items: Array<{ source_id: string; slug: string }> }).items.map(i => i.slug).sort();

async function cli(args: string[]): Promise<{ doc: Record<string, unknown>; exit: number }> {
  const out: string[] = [];
  _resetCliExitVerdictForTests();
  const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  const err = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  setStdoutCapture(text => { out.push(text); });
  try { await runTranscripts(engine, ['accept-fences', ...args, '--json']); } finally { setStdoutCapture(null); log.mockRestore(); err.mockRestore(); }
  const exit = currentExitCode();
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
  return { doc: JSON.parse(out.join('')) as Record<string, unknown>, exit };
}

{
  test('#9427 repro: every imported transcript is its own warning; the preview lists only importer-written transcripts and changes nothing', async () => {
    const before = await check();
    expect(before.status).toBe('warn');
    expect(await listed()).toEqual([EMAIL, ...TRANSCRIPTS, REMOTE].sort());
    expect(before.message).toContain('gbrain transcripts accept-fences');
    expect((before.fix as { argv: string[] }).argv).toEqual(['gbrain', 'transcripts', 'accept-fences', '--json']);

    const preview = await cli([]);
    expect(preview.exit).toBe(0);
    expect(preview.doc.dry_run).toBe(true);
    expect((preview.doc.pages as Array<{ slug: string }>).map(p => p.slug).sort()).toEqual(TRANSCRIPTS);
    expect((preview.doc.not_eligible as Array<{ slug: string }>).map(p => p.slug).sort()).toEqual([EMAIL, REMOTE].sort());
    expect(String(preview.doc.plan_hash)).toMatch(/^ph_[0-9a-f]{24}$/);
    expect(JSON.stringify(preview.doc)).not.toContain(CLAIM);
    expect(await listed()).toEqual([EMAIL, ...TRANSCRIPTS, REMOTE].sort());
  }, 60_000);

  test('an apply needs --yes and the current plan_hash; then only the transcripts leave the list and their rows stay', async () => {
    const preview = await cli([]);
    const hash = String(preview.doc.plan_hash);
    expect((await cli(['--yes'])).exit).toBe(2);
    expect((await cli(['--expect', hash])).exit).toBe(2);
    const stale = await cli(['--yes', '--expect', 'ph_000000000000000000000000']);
    expect(stale.exit).toBe(1);
    expect(stale.doc).toMatchObject({ error: 'preview_changed', fix: { argv: ['gbrain', 'transcripts', 'accept-fences', '--json'] } });
    expect(await listed()).toHaveLength(5);

    const applied = await cli(['--yes', '--expect', hash]);
    expect(applied.exit).toBe(0);
    expect(applied.doc).toMatchObject({ dry_run: false, accepted: 3, not_eligible: 2 });
    const after = await check();
    expect(after.status).toBe('warn');
    expect(await listed()).toEqual([EMAIL, REMOTE].sort());
    expect((after.details as { accepted_transcripts?: number }).accepted_transcripts).toBe(3);
    expect((after.fix as { argv: string[] }).argv[1]).toBe('get');
    const [facts] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug LIKE 'conversations/sessions/%' AND expired_at IS NULL");
    expect(facts!.n).toBe(4);
    expect((await cli([])).doc).toMatchObject({ pages: [], already_accepted: 3 });
  }, 60_000);

  async function acceptAll(): Promise<void> {
    const preview = await cli([]);
    if ((preview.doc.pages as unknown[]).length) expect((await cli(['--yes', '--expect', String(preview.doc.plan_hash)])).exit).toBe(0);
  }

  test('an accepted page comes back when a fence row is added, or when a non-importer write replaces it', async () => {
    await acceptAll();
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [TRANSCRIPTS[0]]);
    await engine.executeRaw(`INSERT INTO takes (page_id, row_num, claim, kind, holder, weight) VALUES ($1, 9, 'A later take', 'take', 'owner', 0.5)`, [page!.id]);
    expect(await listed()).toEqual([EMAIL, TRANSCRIPTS[0]!, REMOTE].sort());
    expect((await cli([])).doc).toMatchObject({ pages: [expect.objectContaining({ slug: TRANSCRIPTS[0], takes: 1 })] });

    await engine.executeRaw("UPDATE pages SET ingested_via = 'mcp:put_page' WHERE slug = $1", [TRANSCRIPTS[1]]);
    expect(await listed()).toEqual([EMAIL, TRANSCRIPTS[0]!, TRANSCRIPTS[1]!, REMOTE].sort());
    const preview = await cli([]);
    expect((preview.doc.pages as Array<{ slug: string }>).map(p => p.slug)).toEqual([TRANSCRIPTS[0]]);
    expect((preview.doc.not_eligible as Array<{ slug: string }>).map(p => p.slug)).toContain(TRANSCRIPTS[1]);
  }, 60_000);

  test('an accepted page comes back when one of its rows changes in place', async () => {
    await acceptAll();
    expect(await listed()).not.toContain(TRANSCRIPTS[2]);
    await engine.executeRaw("UPDATE facts SET visibility = 'world' WHERE source_markdown_slug = $1", [TRANSCRIPTS[2]]);
    expect(await listed()).toContain(TRANSCRIPTS[2]);
    await acceptAll();
    await engine.executeRaw("UPDATE facts SET source_session = 'another-session' WHERE source_markdown_slug = $1", [TRANSCRIPTS[2]]);
    expect(await listed()).toContain(TRANSCRIPTS[2]);
  }, 60_000);

  test('an acceptance does not depend on the session time zone', async () => {
    await acceptAll();
    const before = await listed();
    if (kind === 'pglite') {
      await engine.executeRaw("SET TimeZone = 'America/Los_Angeles'");
      try { expect(await listed()).toEqual(before); } finally { await engine.executeRaw("SET TimeZone = 'UTC'"); }
    }
  }, 60_000);

  test('a conversation page with no importer stamp stays for per-page review', async () => {
    const slug = 'conversations/sessions/2026-01-06-unstamped-example';
    await conversation(slug, undefined);
    await runExtractFacts(engine, { sourceId: 'default' });
    const preview = await cli([]);
    expect((preview.doc.pages as Array<{ slug: string }>).map(p => p.slug)).not.toContain(slug);
    expect((preview.doc.not_eligible as Array<{ slug: string }>).map(p => p.slug)).toContain(slug);
  }, 60_000);
  test('an acceptance survives maintenance that rewrites a row without changing it (embedding, write attribution)', async () => {
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [TRANSCRIPTS[0]]);
    await engine.executeRaw(`INSERT INTO takes (page_id, row_num, claim, kind, holder, weight) VALUES ($1, 9, 'A take', 'take', 'owner', 0.5)`, [page!.id]);
    await acceptAll();
    const before = await cli([]);
    for (const table of ['facts', 'takes']) {
      await engine.executeRaw(`UPDATE ${table} SET embedding_model = 'model-example', embedded_text_hash = 'hash-example', embedded_at = now(),
        last_written_at = now(), last_write_principal_kind = 'maintenance'`);
    }
    expect(await listed()).toEqual([EMAIL, REMOTE].sort());
    const after = await cli([]);
    expect(after.doc).toMatchObject({ pages: [], already_accepted: 3 });
    expect(after.doc.plan_hash).toBe(before.doc.plan_hash);
  }, 60_000);

  test('a later direct write over an imported transcript takes it out of the batch, and an importer rewrite with the same rows restores its acceptance', async () => {
    await acceptAll();
    await conversation(TRANSCRIPTS[0]!, undefined, 'Session, edited by hand');
    expect(await listed()).toEqual([EMAIL, TRANSCRIPTS[0]!, REMOTE].sort());
    const edited = await cli([]);
    expect((edited.doc.pages as unknown[])).toEqual([]);
    expect((edited.doc.not_eligible as Array<{ slug: string }>).map(p => p.slug)).toContain(TRANSCRIPTS[0]);

    await conversation(TRANSCRIPTS[0]!, 'cli:transcripts-ingest', 'Session, imported again');
    expect(await listed()).toEqual([EMAIL, REMOTE].sort());
    expect((await cli([])).doc).toMatchObject({ pages: [], already_accepted: 3 });
  }, 60_000);
}
});
