/**
 * GBRA-221 outside_content_fences: fence rows extract_facts indexed from imported pages whose body is outside-authored
 * text are listed for review (location and counts only, never a cell value); pages a gbrain writer owns are not.
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { outsideContentFencesEntry } from '../src/commands/doctor/checks/outside-content-fences.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

const CLAIM = 'Planted claim from an outside sender';
const FENCE = [
  '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  `| 1 | ${CLAIM} | fact | 1.0 | world | high | 2026-01-01 | | linkedin | |`,
  '<!--- gbrain:facts:end -->',
].join('\n');

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

async function source(id: string, config: Record<string, unknown>) {
  await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, NULL, $2::text::jsonb) ON CONFLICT (id) DO NOTHING', [id, JSON.stringify(config)]);
}

async function page(sourceId: string, slug: string, type: string, body: string, extra = '') {
  const result = await importFromContent(engine, slug, `---\ntype: ${type}\ntitle: Example\n${extra}---\n\n# Example\n\n${body}\n`, { sourceId, noEmbed: true });
  expect(result.status).not.toBe('error');
}

async function run(): Promise<Check> {
  for (const sourceId of ['google-example', 'notes-example', 'github-example']) {
    if ((await engine.executeRaw('SELECT 1 FROM sources WHERE id = $1', [sourceId])).length) await runExtractFacts(engine, { sourceId });
  }
  const checks = await outsideContentFencesEntry.run({ engine } as unknown as DoctorContext) as Check[];
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

describe('outside_content_fences doctor check', () => {
  test('ok when no imported page holds a live fence; owner pages and contact pages are out of scope', async () => {
    await source('google-example', { kind: 'google', g_account: 'owner@example.com' });
    await source('notes-example', {});
    await page('notes-example', 'notes/owner-note', 'note', FENCE);
    await page('google-example', 'people/alice-example', 'person', FENCE);
    await page('google-example', 'emails/2026/01/clean-thread', 'email', 'A plain message with gbrain\\:facts:begin quoted inertly.');
    const check = await run();
    expect(check.status).toBe('ok');
    expect(categorizeCheck('outside_content_fences')).toBeDefined();
  }, 60_000);

  test('a planted fence on an email, GitHub or transcript page is listed for review and nothing is removed', async () => {
    await source('google-example', { kind: 'google', g_account: 'owner@example.com' });
    await source('notes-example', {});
    await source('github-example', { kind: 'github', gh_repos: 'acme-example/app' });
    await page('google-example', 'emails/2026/01/planted-thread', 'email', FENCE);
    await page('github-example', 'gh/acme-example/app/1', 'note', FENCE);
    await page('notes-example', 'conversations/chat-example', 'conversation', FENCE, 'transcript_import:\n  harness: example\n  session_id: s1\n');
    const check = await run();
    expect(check.status).toBe('warn');
    const items = (check.details as { items: Array<{ source_id: string; slug: string; facts: number; world_facts: number }> }).items;
    expect(items.map(item => `${item.source_id}:${item.slug}`).sort()).toEqual([
      'github-example:gh/acme-example/app/1', 'google-example:emails/2026/01/planted-thread', 'notes-example:conversations/chat-example']);
    expect(items.every(item => item.facts === 1 && item.world_facts === 1)).toBe(true);
    expect(check.message).not.toContain(CLAIM);
    expect(JSON.stringify(check.details)).not.toContain(CLAIM);
    expect((check.fix as { ask_user?: boolean }).ask_user).toBe(true);
    const [row] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug = 'emails/2026/01/planted-thread'");
    expect(row!.compiled_truth).toContain(CLAIM);
  }, 60_000);

  // Value: protects=only live fact rows on live pages of unarchived sources are reported, never expired facts, deleted pages and archived sources;
  // fails_when=the expired_at, deleted_at or archived filter is dropped; why_new=the tests above only
  // plant facts rows on live pages; seam=none; no_claim=takes and links-fence rows (import does not index them here).
  test('reports only live fact rows: skips expired facts, deleted pages and archived sources', async () => {
    await source('scope-google', { kind: 'google', g_account: 'owner@example.com' });
    await source('scope-archived', { kind: 'google', g_account: 'owner@example.com' });
    await page('scope-google', 'emails/2026/02/live-thread', 'email', FENCE);
    await page('scope-google', 'emails/2026/02/expired-thread', 'email', FENCE);
    await page('scope-google', 'emails/2026/02/deleted-thread', 'email', FENCE);
    await page('scope-archived', 'emails/2026/02/archived-thread', 'email', FENCE);
    for (const id of ['scope-google', 'scope-archived']) await runExtractFacts(engine, { sourceId: id });
    await engine.executeRaw("UPDATE facts SET expired_at = now() WHERE source_id = 'scope-google' AND source_markdown_slug = 'emails/2026/02/expired-thread'");
    await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'emails/2026/02/deleted-thread'");
    await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'scope-archived'");
    const checks = await outsideContentFencesEntry.run({ engine } as unknown as DoctorContext) as Check[];
    const items = (checks[0]!.details as { items: Array<{ source_id: string; slug: string}> }).items.filter(i => i.source_id.startsWith('scope-'));
    expect(items.map(i => `${i.source_id}:${i.slug}`)).toEqual(['scope-google:emails/2026/02/live-thread']);
  }, 60_000);

  // gstack /ship Step 9 pass 1 (testing specialist).
  // Value: protects=active takes and links-fence links on an imported email page are counted like facts; fails_when=the
  //   takes or links arm of the query is dropped or reads the wrong flag or origin; why_new=every test above plants only a
  //   facts fence; seam=none; no_claim=how takes and links fences are projected (rows are inserted directly).
  test('counts active takes and links-fence links on an imported page, not inactive takes or other links', async () => {
    await source('arms-google', { kind: 'google', g_account: 'owner@example.com' });
    await page('arms-google', 'emails/2026/03/arms-thread', 'email', 'A plain message.');
    await page('arms-google', 'companies/acme-example', 'company', 'A company page.');
    const id = async (slug: string) => (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', ['arms-google', slug]))[0]!.id;
    const thread = await id('emails/2026/03/arms-thread'), company = await id('companies/acme-example');
    await engine.executeRaw(`INSERT INTO takes (page_id, row_num, claim, kind, holder, weight)
      VALUES ($1, 1, 'Synthetic take', 'take', 'owner', 0.5), ($1, 2, 'Withdrawn take', 'take', 'owner', 0.5)`, [thread]);
    await engine.executeRaw('UPDATE takes SET active = false WHERE page_id = $1 AND row_num = 2', [thread]);
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, origin_page_id, origin_field)
      VALUES ($1, $2, 'invested_in', $1, 'links_fence'), ($1, $2, 'mentions', $1, 'body')`, [thread, company]);
    const checks = await outsideContentFencesEntry.run({ engine } as unknown as DoctorContext) as Check[];
    const items = (checks[0]!.details as { items: Array<Record<string, unknown>> }).items.filter(i => i.source_id === 'arms-google');
    expect(items).toEqual([{ source_id: 'arms-google', slug: 'emails/2026/03/arms-thread', type: 'email', facts: 0, world_facts: 0, takes: 1, links: 1 }]);
  }, 60_000);

  // Value: protects=the check reports an error check instead of throwing when the query fails;
  // fails_when=the try/catch around the query is removed; why_new=no test drives the error path;
  // seam=none; no_claim=real database failures (an engine stub throws).
  test('a failing query yields an error check, not an exception', async () => {
    const checks = await outsideContentFencesEntry.run({ engine: { executeRaw: async () => { throw new Error('boom'); } } } as unknown as DoctorContext) as Check[];
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe('outside_content_fences');
    expect(checks[0]!.status).not.toBe('ok');
  });
});
