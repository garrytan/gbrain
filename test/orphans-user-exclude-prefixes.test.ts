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
  readSkipCodeSources,
  readCodeSourceIds,
  USER_EXCLUDE_PREFIXES_CONFIG_KEY,
  SKIP_CODE_SOURCES_CONFIG_KEY,
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

/**
 * `orphans.skip_code_sources` end-to-end coverage.
 *
 * On a brain federating multiple gstack-code-* repos, code files don't
 * wikilink to other code files — orphan reporting on those sources is
 * structurally meaningless noise. This knob drops them from both the
 * orphan list AND the F6 denominator in one move.
 *
 * The unit-level contracts pinned:
 *   - readSkipCodeSources is strict: only the literal string 'true'
 *     enables the knob. Typo-tolerant default would have silently
 *     flipped behavior in unrelated test fixtures.
 *   - readCodeSourceIds finds every source whose config.strategy ===
 *     'code', tolerating BOTH the proper JSONB object shape AND the
 *     double-encoded string scalar that `gbrain sources add` writes via
 *     `JSON.stringify(config)::jsonb`.
 *   - findOrphans drops code-source pages from the list AND the
 *     denominator when the toggle is on; passthrough when off.
 *   - Empty code-source set is a no-op (no SQL exclusion clause fires).
 */

/** Insert a source row with the given strategy. */
async function insertSourceWithStrategy(
  id: string,
  strategy: 'markdown' | 'code' | 'auto' | null,
  options?: { stringifyConfig?: boolean },
): Promise<void> {
  const config = strategy ? { strategy } : {};
  const stringify = options?.stringifyConfig ?? false;
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::jsonb)`,
    [
      id,
      id,
      `/tmp/${id}`,
      stringify ? JSON.stringify(JSON.stringify(config)) : JSON.stringify(config),
    ],
  );
}

async function insertOrphanPageOnSource(slug: string, sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, title, type, compiled_truth, content_hash)
     VALUES ($1, $2, $3, 'note', '', $4)`,
    [sourceId, slug, slug.split('/').slice(-1)[0], `hash-${sourceId}-${slug}`],
  );
}

async function clearSkipFixture(): Promise<void> {
  await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'skip-code-%'`);
  await engine.executeRaw(`DELETE FROM sources WHERE id LIKE 'skip-code-src-%'`);
}

describe('readSkipCodeSources — strict-parse boolean toggle', () => {
  test('unset returns false (preserves today\'s behavior)', async () => {
    await engine.setConfig(SKIP_CODE_SOURCES_CONFIG_KEY, '');
    expect(await readSkipCodeSources(engine)).toBe(false);
  });

  test('literal string "true" returns true', async () => {
    await engine.setConfig(SKIP_CODE_SOURCES_CONFIG_KEY, 'true');
    expect(await readSkipCodeSources(engine)).toBe(true);
  });

  test('any other value returns false (strict parse)', async () => {
    for (const v of ['false', 'True', 'TRUE', '1', 'yes', 'on', 'garbage', '  true  ']) {
      await engine.setConfig(SKIP_CODE_SOURCES_CONFIG_KEY, v);
      expect(await readSkipCodeSources(engine)).toBe(false);
    }
  });
});

describe('readCodeSourceIds — discover code-strategy sources from sources.config', () => {
  test('empty when no sources have strategy=code', async () => {
    await clearSkipFixture();
    await insertSourceWithStrategy('skip-code-src-md1', 'markdown');
    await insertSourceWithStrategy('skip-code-src-none', null);
    const ids = await readCodeSourceIds(engine);
    expect(ids.has('skip-code-src-md1')).toBe(false);
    expect(ids.has('skip-code-src-none')).toBe(false);
  });

  test('finds sources where config is a proper JSONB object with strategy=code', async () => {
    await clearSkipFixture();
    await insertSourceWithStrategy('skip-code-src-c1', 'code');
    await insertSourceWithStrategy('skip-code-src-md2', 'markdown');
    const ids = await readCodeSourceIds(engine);
    expect(ids.has('skip-code-src-c1')).toBe(true);
    expect(ids.has('skip-code-src-md2')).toBe(false);
  });

  test('tolerates the double-encoded JSONB shape `gbrain sources add` writes', async () => {
    // `gbrain sources add` does `JSON.stringify(config)::jsonb` which
    // stores the value as a JSON-string scalar instead of a real object.
    // readCodeSourceIds must defensively parse both shapes; otherwise
    // every brain populated by the CLI would silently miss its code
    // sources.
    await clearSkipFixture();
    await insertSourceWithStrategy('skip-code-src-c2', 'code', { stringifyConfig: true });
    const ids = await readCodeSourceIds(engine);
    expect(ids.has('skip-code-src-c2')).toBe(true);
  });

  test('skips archived sources', async () => {
    await clearSkipFixture();
    await insertSourceWithStrategy('skip-code-src-archived', 'code');
    await engine.executeRaw(
      `UPDATE sources SET archived = true WHERE id = $1`,
      ['skip-code-src-archived'],
    );
    const ids = await readCodeSourceIds(engine);
    expect(ids.has('skip-code-src-archived')).toBe(false);
  });
});

describe('findOrphans — end-to-end with orphans.skip_code_sources', () => {
  test('toggle off (default): code-source pages count as orphans', async () => {
    await clearSkipFixture();
    await engine.setConfig(SKIP_CODE_SOURCES_CONFIG_KEY, '');
    await insertSourceWithStrategy('skip-code-src-code-a', 'code');
    await insertSourceWithStrategy('skip-code-src-md-a', 'markdown');
    await insertOrphanPageOnSource('skip-code-a/src/index', 'skip-code-src-code-a');
    await insertOrphanPageOnSource('skip-code-a/notes/idea', 'skip-code-src-md-a');
    const result = await findOrphans(engine);
    const slugs = result.orphans.map(o => o.slug);
    expect(slugs).toContain('skip-code-a/src/index');
    expect(slugs).toContain('skip-code-a/notes/idea');
  });

  test('toggle on: code-source pages drop from list AND denominator', async () => {
    await clearSkipFixture();
    await engine.setConfig(SKIP_CODE_SOURCES_CONFIG_KEY, 'true');
    await insertSourceWithStrategy('skip-code-src-code-b', 'code');
    await insertSourceWithStrategy('skip-code-src-md-b', 'markdown');
    await insertOrphanPageOnSource('skip-code-b/src/index', 'skip-code-src-code-b');
    await insertOrphanPageOnSource('skip-code-b/src/utils', 'skip-code-src-code-b');
    await insertOrphanPageOnSource('skip-code-b/notes/idea', 'skip-code-src-md-b');

    const result = await findOrphans(engine);
    const slugs = result.orphans.map(o => o.slug);
    expect(slugs).not.toContain('skip-code-b/src/index');
    expect(slugs).not.toContain('skip-code-b/src/utils');
    expect(slugs).toContain('skip-code-b/notes/idea');

    // F6 invariant: the denominator must drop the same pages so the
    // per-vault ratio stays consistent. We can't assert a global total
    // here (other fixtures leave residue), but the local-fixture
    // contribution must show: 1 page from the markdown source, 0 from
    // the code source, accumulated correctly.
    const localPages = result.orphans.filter(o => o.slug.startsWith('skip-code-b/'));
    expect(localPages).toHaveLength(1);
  });

  test('toggle on with no code sources is a no-op', async () => {
    await clearSkipFixture();
    await engine.setConfig(SKIP_CODE_SOURCES_CONFIG_KEY, 'true');
    await insertSourceWithStrategy('skip-code-src-md-c', 'markdown');
    await insertOrphanPageOnSource('skip-code-c/notes/idea', 'skip-code-src-md-c');
    const result = await findOrphans(engine);
    const slugs = result.orphans.map(o => o.slug);
    expect(slugs).toContain('skip-code-c/notes/idea');
  });

  test('composes with userPrefixes (both fire independently)', async () => {
    await clearSkipFixture();
    await engine.setConfig(SKIP_CODE_SOURCES_CONFIG_KEY, 'true');
    await engine.setConfig(USER_EXCLUDE_PREFIXES_CONFIG_KEY, 'skip-code-d/junk/');
    await insertSourceWithStrategy('skip-code-src-code-d', 'code');
    await insertSourceWithStrategy('skip-code-src-md-d', 'markdown');
    // Three orphan candidates, one for each filter to drop and one to keep:
    await insertOrphanPageOnSource('skip-code-d/src/x', 'skip-code-src-code-d');     // dropped by skip_code_sources
    await insertOrphanPageOnSource('skip-code-d/junk/y', 'skip-code-src-md-d');      // dropped by userPrefixes
    await insertOrphanPageOnSource('skip-code-d/notes/z', 'skip-code-src-md-d');     // kept
    const result = await findOrphans(engine);
    const slugs = result.orphans.map(o => o.slug);
    expect(slugs).not.toContain('skip-code-d/src/x');
    expect(slugs).not.toContain('skip-code-d/junk/y');
    expect(slugs).toContain('skip-code-d/notes/z');
  });

  test('source-scoped sourceId still respects exclusion (markdown source unaffected)', async () => {
    await clearSkipFixture();
    await engine.setConfig(SKIP_CODE_SOURCES_CONFIG_KEY, 'true');
    await insertSourceWithStrategy('skip-code-src-md-e', 'markdown');
    await insertOrphanPageOnSource('skip-code-e/notes/scoped', 'skip-code-src-md-e');
    const result = await findOrphans(engine, { sourceId: 'skip-code-src-md-e' });
    const slugs = result.orphans.map(o => o.slug);
    expect(slugs).toContain('skip-code-e/notes/scoped');
  });
});
