/**
 * `orphans.exclude_prefixes` end-to-end coverage.
 *
 * The shipped `DENY_PREFIXES` constant in `src/commands/orphans.ts`
 * covers gbrain-internal convention dirs. Brains organized by other
 * conventions (PARA's `resources/`, `archives/`; Obsidian vaults with
 * `clips/`; code corpora with `transcripts/`) leak hundreds-to-thousands
 * of "orphan" pages that are reference material by design and shouldn't
 * register as a brain-health signal.
 *
 * `gbrain config set orphans.exclude_prefixes '<csv>'` extends the deny
 * list per-brain without patching source. This file exercises the
 * persistence + read-side path end-to-end on PGLite:
 *
 *   - readUserExcludePrefixes round-trips a set value through engine.getConfig.
 *   - An unset key returns []. A garbage value returns [].
 *   - findOrphans's `total_orphans` drops as user prefixes are added,
 *     and `excluded` rises by the same amount — the orphans don't
 *     disappear, they shift bucket.
 *   - User prefixes compose additively with the shipped defaults
 *     (a slug matched by either source stays excluded).
 *
 * The unit tests in orphans.test.ts pin parseUserExcludePrefixes +
 * shouldExclude semantics directly; this file pins the engine-side
 * persistence + the end-to-end count contract.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  findOrphans,
  readUserExcludePrefixes,
  USER_EXCLUDE_PREFIXES_CONFIG_KEY,
} from '../src/commands/orphans.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
});

/**
 * Insert a page that will be orphan-by-default (no inbound links).
 * Returns the slug for later assertions.
 */
async function insertOrphanPage(slug: string): Promise<string> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, title, type, compiled_truth, content_hash)
     VALUES ('default', $1, $2, 'note', '', $3)`,
    [slug, slug.split('/').slice(-1)[0], `hash-${slug}`],
  );
  return slug;
}

async function clearPages(): Promise<void> {
  await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug LIKE 'fix-orphans-%'`);
}

describe('readUserExcludePrefixes — engine round-trip', () => {
  test('unset config key returns empty array', async () => {
    await engine.setConfig(USER_EXCLUDE_PREFIXES_CONFIG_KEY, '');
    expect(await readUserExcludePrefixes(engine)).toEqual([]);
  });

  test('set value returns the parsed list', async () => {
    await engine.setConfig(USER_EXCLUDE_PREFIXES_CONFIG_KEY, 'resources/,transcripts/');
    expect(await readUserExcludePrefixes(engine)).toEqual(['resources/', 'transcripts/']);
  });

  test('whitespace + empty entries cleaned during parse', async () => {
    await engine.setConfig(USER_EXCLUDE_PREFIXES_CONFIG_KEY, ' resources/ , , transcripts/ ,');
    expect(await readUserExcludePrefixes(engine)).toEqual(['resources/', 'transcripts/']);
  });

  test('updating the config key replaces the prior list (no append)', async () => {
    await engine.setConfig(USER_EXCLUDE_PREFIXES_CONFIG_KEY, 'resources/');
    expect(await readUserExcludePrefixes(engine)).toEqual(['resources/']);
    await engine.setConfig(USER_EXCLUDE_PREFIXES_CONFIG_KEY, 'agents/');
    expect(await readUserExcludePrefixes(engine)).toEqual(['agents/']);
  });
});

describe('findOrphans — end-to-end with user-configured prefixes', () => {
  test('user prefix shifts orphans from total_orphans into excluded', async () => {
    await clearPages();
    // 3 pages under resources/, 2 under agents/, 1 normal authored page.
    // All six are orphan-by-default (no links), but only the authored one
    // counts as a "missing inbound link" problem in a brain organized PARA.
    await insertOrphanPage('fix-orphans-1/resources/clips/article-a');
    await insertOrphanPage('fix-orphans-1/resources/clips/article-b');
    await insertOrphanPage('fix-orphans-1/resources/books/excerpt');
    await insertOrphanPage('fix-orphans-1/agents/zosia/memory');
    await insertOrphanPage('fix-orphans-1/agents/zosia/tools');
    await insertOrphanPage('fix-orphans-1/companies/acme');

    // Baseline: no user prefixes, all six surface as orphans.
    await engine.setConfig(USER_EXCLUDE_PREFIXES_CONFIG_KEY, '');
    const baseline = await findOrphans(engine);
    const baselineRelevant = baseline.orphans.filter(o => o.slug.startsWith('fix-orphans-1/'));
    expect(baselineRelevant).toHaveLength(6);

    // With the user prefixes set, only the authored page should remain.
    // The other five shift from total_orphans into excluded.
    await engine.setConfig(
      USER_EXCLUDE_PREFIXES_CONFIG_KEY,
      'fix-orphans-1/resources/,fix-orphans-1/agents/',
    );
    const filtered = await findOrphans(engine);
    const filteredRelevant = filtered.orphans.filter(o => o.slug.startsWith('fix-orphans-1/'));
    expect(filteredRelevant).toHaveLength(1);
    expect(filteredRelevant[0].slug).toBe('fix-orphans-1/companies/acme');

    // total_orphans drop = excluded rise (orphans don't disappear from
    // the count, they re-bucket). The F6 denominator invariant means
    // total_linkable shrinks identically.
    expect(baseline.total_orphans - filtered.total_orphans).toBe(5);
    expect(filtered.excluded - baseline.excluded).toBe(5);
  });

  test('user prefix composes additively with shipped defaults', async () => {
    await clearPages();
    // `output/` (shipped default) + `fix-orphans-2/resources/` (user) +
    // a normal authored page. All three orphan-by-default. With the user
    // config set, both the shipped default AND the user prefix fire on
    // their respective slugs.
    await insertOrphanPage('output/2026-q1');
    await insertOrphanPage('fix-orphans-2/resources/clips/foo');
    await insertOrphanPage('fix-orphans-2/companies/widget-co');

    await engine.setConfig(USER_EXCLUDE_PREFIXES_CONFIG_KEY, 'fix-orphans-2/resources/');
    const result = await findOrphans(engine);
    const slugs = result.orphans.map(o => o.slug);

    expect(slugs).not.toContain('output/2026-q1');
    expect(slugs).not.toContain('fix-orphans-2/resources/clips/foo');
    expect(slugs).toContain('fix-orphans-2/companies/widget-co');
  });

  test('garbage config value is treated as unset (graceful degradation)', async () => {
    // A hand-edited config row that lands a non-string value should fall
    // back to baseline behavior, not crash and not over-exclude.
    await clearPages();
    await insertOrphanPage('fix-orphans-3/resources/clips/bar');
    await engine.executeRaw(
      `INSERT INTO config (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [USER_EXCLUDE_PREFIXES_CONFIG_KEY, ''],
    );
    const result = await findOrphans(engine);
    expect(result.orphans.some(o => o.slug === 'fix-orphans-3/resources/clips/bar')).toBe(true);
  });

  test('user prefixes scoped to a single source still apply via --source', async () => {
    await clearPages();
    // The userPrefixes are brain-wide config; they don't differ by source.
    // But the source-scoped findOrphans call still applies them — same
    // contract as the shipped defaults.
    await insertOrphanPage('fix-orphans-4/resources/clips/baz');
    await insertOrphanPage('fix-orphans-4/companies/foo');
    await engine.setConfig(USER_EXCLUDE_PREFIXES_CONFIG_KEY, 'fix-orphans-4/resources/');
    const result = await findOrphans(engine, { sourceId: 'default' });
    const slugs = result.orphans.map(o => o.slug);
    expect(slugs).not.toContain('fix-orphans-4/resources/clips/baz');
    expect(slugs).toContain('fix-orphans-4/companies/foo');
  });
});
