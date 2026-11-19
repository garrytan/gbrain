/**
 * #4419 — natively imported conversations reach Dream. A Hermes `state.db`
 * ingested with `foresights transcripts ingest` lands as `type: conversation`
 * pages; the synthesize phase now discovers those pages from the database
 * (source-scoped, date-filtered, keyed by body hash) instead of only walking
 * `dream.synthesize.session_corpus_dir`. When synthesis is not configured
 * but conversation pages exist, the phase warns with the opt-in command
 * instead of returning a clean zero-work skip.
 *
 * Keyless: triage verdicts degrade to "no configured provider", which is
 * enough to prove discovery (every discovered transcript gets a verdict).
 */
import { describe, expect, afterAll, beforeAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keylessDreamTest as test } from './helpers/keyless-dream-test.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { discoverConversationPages } from '../src/core/cycle/transcript-discovery.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

let engine: PGLiteEngine;
const dirs: string[] = [];
const tmp = (label: string) => { const d = mkdtempSync(join(tmpdir(), `gbrain-4419-${label}-`)); dirs.push(d); return d; };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => {
  await engine.disconnect();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function ingestHermes(sourceId: string): Promise<string[]> {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [sourceId]);
  const dbPath = buildHermesFixture(tmp('hermes'));
  const r = await runTranscriptsIngest(engine, { paths: [dbPath], sourceId, format: 'hermes' });
  expect(r.sessionsImported).toBeGreaterThan(0);
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND type = 'conversation' AND deleted_at IS NULL ORDER BY slug`, [sourceId]);
  expect(rows.length).toBeGreaterThan(0);
  return rows.map((r) => r.slug);
}

async function reset(): Promise<void> {
  await resetPgliteState(engine);
  await engine.setConfig('dream.synthesize.min_chars', '0');
}

type Verdicts = Array<{ filePath: string }>;

describe('#4419 Dream discovers imported conversation pages', () => {
  test('state.db -> ingest -> conversation pages -> synthesize triage, scoped to the cycle source', async () => {
    await reset();
    const slugsA = await ingestHermes('src-a');
    await ingestHermes('src-b');
    await engine.setConfig('dream.synthesize.session_corpus_dir', tmp('empty-corpus'));
    const result = await runPhaseSynthesize(engine, { brainDir: tmp('brain'), dryRun: true, sourceId: 'src-a' });
    expect(result.status).toBe('ok');
    const paths = ((result.details as { verdicts: Verdicts }).verdicts).map((v) => v.filePath).sort();
    expect(paths).toEqual(slugsA.map((s) => `gbrain-page://src-a/${s}`).sort());
    expect(paths.some((p) => p.includes('src-b'))).toBe(false);
  }, 60_000);

  test('conversation_pages=true feeds Dream without a corpus dir', async () => {
    expect([...KNOWN_CONFIG_KEYS]).toContain('dream.synthesize.conversation_pages');
    await reset();
    const slugs = await ingestHermes('default');
    await engine.setConfig('dream.synthesize.conversation_pages', 'true');
    const result = await runPhaseSynthesize(engine, { brainDir: tmp('brain'), dryRun: true });
    expect(result.status).toBe('ok');
    expect(((result.details as { verdicts: Verdicts }).verdicts)).toHaveLength(slugs.length);
  }, 60_000);

  test('not configured + conversation pages present -> actionable warn, not a clean skip', async () => {
    await reset();
    await ingestHermes('default');
    const result = await runPhaseSynthesize(engine, { brainDir: tmp('brain'), dryRun: true });
    expect(result.status).toBe('warn');
    expect(result.details).toMatchObject({ code: 'conversation_pages_not_consumed', source_id: 'default' });
    expect(result.summary).toContain('foresights config set dream.synthesize.conversation_pages true');

    await engine.setConfig('dream.synthesize.conversation_pages', 'false');
    const silenced = await runPhaseSynthesize(engine, { brainDir: tmp('brain'), dryRun: true });
    expect(silenced.status).toBe('skipped');
    expect((silenced.details as { reason: string }).reason).toBe('not_configured');
  }, 60_000);

  test('date filter, stable body-hash keys, and the self-consumption guard', async () => {
    await reset();
    const [slug] = await ingestHermes('default');
    const [page] = await engine.executeRaw<{ d: string }>(`SELECT frontmatter->>'date' AS d FROM pages WHERE slug = $1`, [slug]);
    const first = await discoverConversationPages(engine, { sourceId: 'default', minChars: 0, date: page.d });
    expect(first.map((t) => t.filePath)).toContain(`gbrain-page://default/${slug}`);
    expect(await discoverConversationPages(engine, { sourceId: 'default', minChars: 0, date: '1999-01-01' })).toEqual([]);

    const again = await discoverConversationPages(engine, { sourceId: 'default', minChars: 0 });
    const hashOf = (list: typeof first) => list.find((t) => t.filePath.endsWith(slug))!.contentHash;
    expect(hashOf(again)).toBe(hashOf(first));
    await engine.executeRaw(`UPDATE pages SET compiled_truth = compiled_truth || ' edited' WHERE slug = $1`, [slug]);
    expect(hashOf(await discoverConversationPages(engine, { sourceId: 'default', minChars: 0 }))).not.toBe(hashOf(first));

    await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"dream_generated": true}'::jsonb WHERE slug = $1`, [slug]);
    const guarded = await discoverConversationPages(engine, { sourceId: 'default', minChars: 0 });
    expect(guarded.some((t) => t.filePath.endsWith(slug))).toBe(false);
  }, 60_000);
});
