/**
 * #6259 follow-up (quarantine leaks, item 3): a page the content-quality gate
 * hid as junk projects no facts or takes from its fences. The unmanaged
 * reconcilers (`runExtractFacts`, `extractTakesFromDb`, `extractTakesFromFs`)
 * skip it; rows projected before it was quarantined are left as they are.
 * The managed canonical projection is pinned in test/quarantine-override.serial.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { extractTakesFromDb, extractTakesFromFs } from '../src/core/cycle/extract-takes.ts';
import { isQuarantined } from '../src/core/quarantine.ts';
import { FACTS_FENCE_BEGIN as FB, FACTS_FENCE_END as FE } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN as TB, TAKES_FENCE_END as TE } from '../src/core/takes-fence.ts';
import { withEnv } from './helpers/with-env.ts';

const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const fences = `${FB}\n${FH}\n| 1 | Example claim from the page | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |\n${FE}\n\n${TB}\n${TH}\n| 1 | Example take from the page | take | brain | 0.7 | 2026-01 | chat |\n${TE}`;
const JUNK = 'Scraped wall text: Cloudflare Ray ID: 8f2a. Please wait.';
const page = (title: string, lead: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${lead}\n\n${fences}\n`;

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-q-fences-'));
const env = { GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined };
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const counts = async (slug: string) => {
  const [facts] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug=$1 AND expired_at IS NULL", [slug]);
  const [takes] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.slug=$1', [slug]);
  return { facts: Number(facts!.n), takes: Number(takes!.n) };
};

test('the fence reconcilers project a clean page but skip a quarantined one', () => withEnv(env, async () => {
  await importFromContent(engine, 'notes/clean', page('Clean', 'Ordinary prose about the project.'), { noEmbed: true });
  await importFromContent(engine, 'notes/junk', page('Junk', JUNK), { noEmbed: true });
  expect(isQuarantined((await engine.getPage('notes/junk', { sourceId: 'default' }))!.frontmatter as Record<string, unknown>)).toBe(true);
  await runExtractFacts(engine, { slugs: ['notes/clean', 'notes/junk'] });
  await extractTakesFromDb(engine, { slugs: ['notes/clean', 'notes/junk'] });
  expect(await counts('notes/clean')).toEqual({ facts: 1, takes: 1 });
  expect(await counts('notes/junk')).toEqual({ facts: 0, takes: 0 });
}), 60_000);

test('a page quarantined after its fences projected keeps those rows (only new projection stops)', () => withEnv(env, async () => {
  await importFromContent(engine, 'notes/later-junk', page('Later', 'Ordinary prose first.'), { noEmbed: true });
  await runExtractFacts(engine, { slugs: ['notes/later-junk'] });
  await extractTakesFromDb(engine, { slugs: ['notes/later-junk'] });
  expect(await counts('notes/later-junk')).toEqual({ facts: 1, takes: 1 });
  await importFromContent(engine, 'notes/later-junk', page('Later', JUNK), { noEmbed: true });
  await runExtractFacts(engine, { slugs: ['notes/later-junk'] });
  await extractTakesFromDb(engine, { slugs: ['notes/later-junk'] });
  expect(await counts('notes/later-junk')).toEqual({ facts: 1, takes: 1 });
}), 60_000);

test('the file-walk takes reconciler skips a page the database holds as quarantined', () => withEnv(env, async () => {
  const repo = join(home, 'repo'); mkdirSync(join(repo, 'notes'), { recursive: true });
  writeFileSync(join(repo, 'notes', 'fs-junk.md'), page('Fs junk', JUNK));
  await importFromContent(engine, 'notes/fs-junk', page('Fs junk', JUNK), { noEmbed: true });
  await extractTakesFromFs(engine, { repoPath: repo, slugs: ['notes/fs-junk'] });
  expect((await counts('notes/fs-junk')).takes).toBe(0);
}), 60_000);
