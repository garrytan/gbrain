/**
 * #6712 PR 4b (GBRA-108, S-47 follow-up): a page whose stored bytes are a YAML alias bomb that an older, validating gbrain
 * imported is held alone when it is re-screened, never treated as a parser regression. #7018 bounds alias expansion on
 * purpose, so this release refusing those bytes is intended: the refusal carries a structured marker (`intended:
 * 'yaml_alias_limit'`, set where `YamlAliasBoundError` becomes the `invalid_frontmatter` refusal), and the provenance
 * check holds that page under `frontmatter_alias_limit` while the rest of the source syncs.
 *
 * Protects:
 * - an alias bomb whose provenance says a validating older gbrain imported those exact bytes, re-screened on a full
 *   listing: held `frontmatter_alias_limit` alone, the other files import, the run is not stopped, nothing is expanded;
 * - the alias hold takes precedence over the parser-regression policy: held the same way under the default and under
 *   `GBRAIN_SYNC_PARSER_REGRESSION=stop`;
 * - regression guard: an ordinary `invalid_frontmatter` refusal (no marker, still refused when screened without a schema
 *   pack) under a provenance from a different gbrain version still stops the run with `sync_parser_regression` under
 *   `GBRAIN_SYNC_PARSER_REGRESSION=stop`, and (GBRA-108 default flip) is held `parser_regression` alone with nothing set,
 *   while the rest syncs.
 *
 * Six-level bomb only (~530k nodes once expanded, refused before anything walks it); never build a nine-level value.
 * PGLite here; Postgres through test/e2e/sync-alias-limit-hold-6712-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { screenImportContent } from '../src/core/import-screen.ts';
import { readGitSourceHolds, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, extra = '') => `---\ntitle: ${title}\ntype: note\n${extra ? `${extra}\n` : ''}---\n# ${title}\n\nBody of ${title}.\n`;
/** `levels` nested anchors, each a flow sequence of nine aliases to the one before: 9^levels leaves once expanded. */
const aliasBomb = (levels: number) => ['a0: &a0 [leaf]', ...Array.from({ length: levels }, (_, i) => `a${i + 1}: &a${i + 1} [${Array(9).fill(`*a${i}`).join(', ')}]`)].join('\n');
const BOMB_6 = note('Bomb note', aliasBomb(6));
/** An ordinary refusal with no marker: a key whose value runs onto an unquoted second line. */
const FOLDED = '---\ntitle: first line\nsecond line\n---\nA synthetic post.\n';
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/target.md'), note('Target')); writeFileSync(join(root, 'notes/ok.md'), note('Ok'));
  commit(root, 'notes');
};

/** The page's import provenance now claims an older, validating gbrain imported `content` exactly. */
async function provenanceClaims(engine: BrainEngine, slug: string, content: string): Promise<void> {
  const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
  const updated = await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(jsonb_set(completed_keys,'{0,raw_sha256}',to_jsonb($3::text)),'{0,gbrain_version}','"0.60.100.0"'::jsonb)
    WHERE op=$1 AND fingerprint LIKE $2 AND (completed_keys->0->>'validated')::boolean RETURNING 1`, [SYNC_IMPORT_PROVENANCE_OP, `default:%:${page.id}`, sha256(content)]);
  expect(updated).toHaveLength(1);
}
const lastCommit = async (engine: BrainEngine) => (await engine.executeRaw<{ c: string | null }>("SELECT last_commit AS c FROM sources WHERE id='default'"))[0]!.c;
const holds = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []).map(hold => ({ path: hold.path, code: hold.code }));
const largestFrontmatter = async (engine: BrainEngine) => (await engine.executeRaw<{ n: number | null }>("SELECT max(length(frontmatter::text))::int AS n FROM pages WHERE source_id='default'"))[0]?.n ?? 0;

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  describe(`#6712 PR 4b alias-limit refusals of validated bytes (${backend})`, () => {
    for (const policy of [undefined, 'stop'] as const) test(`a stored alias bomb a validating older gbrain imported is held frontmatter_alias_limit alone on a full re-screen; the rest syncs${policy ? ` (GBRAIN_SYNC_PARSER_REGRESSION=${policy})` : ''}`, () => brain(async ({ engine, root }) => withEnv({ GBRAIN_SYNC_PARSER_REGRESSION: policy }, async () => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writeFileSync(join(root, 'notes/target.md'), BOMB_6); writeFileSync(join(root, 'notes/new.md'), note('New')); commit(root, 'bomb and new');
      await provenanceClaims(engine, 'notes/target', BOMB_6);
      const result = await performManagedSync(engine, { ...OPTS, full: true });
      expect(result.held?.map(hold => ({ path: hold.path, code: hold.code }))).toEqual([{ path: 'notes/target.md', code: 'frontmatter_alias_limit' }]);
      expect(await holds(engine)).toEqual([{ path: 'notes/target.md', code: 'frontmatter_alias_limit' }]);
      expect(await lastCommit(engine)).toBe(git(root, 'rev-parse', 'HEAD'));
      expect((await engine.getPage('notes/new', { sourceId: 'default' }))?.compiled_truth).toContain('Body of New.');
      expect((await engine.getPage('notes/target', { sourceId: 'default' }))?.compiled_truth).toContain('Body of Target.');
      expect(await largestFrontmatter(engine)).toBeLessThan(10_000);
    })), 180_000);

    test('regression guard (a different version, no marker, refused without the pack): validated bytes refused invalid_frontmatter still stop the run with sync_parser_regression under GBRAIN_SYNC_PARSER_REGRESSION=stop', () => brain(async ({ engine, root }) => withEnv({ GBRAIN_SYNC_PARSER_REGRESSION: 'stop' }, async () => {
      const bare = screenImportContent({ content: FOLDED, path: 'notes/target.md' });
      expect(bare.status === 'refused' ? { code: bare.refusal.code, intended: bare.refusal.intended ?? null } : bare).toEqual({ code: 'invalid_frontmatter', intended: null });
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writeFileSync(join(root, 'notes/target.md'), FOLDED); commit(root, 'fold target');
      await provenanceClaims(engine, 'notes/target', FOLDED);
      const before = await lastCommit(engine);
      await expect(performManagedSync(engine, { ...OPTS, full: true })).rejects.toMatchObject({ code: 'sync_parser_regression' });
      expect(await lastCommit(engine)).toBe(before);
    })), 180_000);

    test('GBRA-108 default flip: with GBRAIN_SYNC_PARSER_REGRESSION unset, the same regression is held parser_regression alone and the rest syncs', () => brain(async ({ engine, root }) => withEnv({ GBRAIN_SYNC_PARSER_REGRESSION: undefined }, async () => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writeFileSync(join(root, 'notes/target.md'), FOLDED); writeFileSync(join(root, 'notes/new.md'), note('New')); commit(root, 'fold target and new');
      await provenanceClaims(engine, 'notes/target', FOLDED);
      const result = await performManagedSync(engine, { ...OPTS, full: true });
      expect(result.held?.map(hold => ({ path: hold.path, code: hold.code }))).toEqual([{ path: 'notes/target.md', code: 'parser_regression' }]);
      expect(await holds(engine)).toEqual([{ path: 'notes/target.md', code: 'parser_regression' }]);
      expect(await lastCommit(engine)).toBe(git(root, 'rev-parse', 'HEAD'));
      expect((await engine.getPage('notes/new', { sourceId: 'default' }))?.compiled_truth).toContain('Body of New.');
      expect((await engine.getPage('notes/target', { sourceId: 'default' }))?.compiled_truth).toContain('Body of Target.');
    })), 180_000);
  });
}
