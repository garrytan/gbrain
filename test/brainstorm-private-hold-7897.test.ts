/**
 * #7897: on a brain without managed persistence, `gbrain brainstorm` / `gbrain lsd` --save (`persistSavedIdea`,
 * src/commands/brainstorm.ts) imported its content through `importFromContent` without the private-request hold and
 * ignored the result, so content asking for `visibility: private` in a spelling page privacy does not read was stored
 * world-readable and reported saved. A managed brain already refused it through put_page (`visibility_not_applied`).
 *
 * The CLI builds that content itself (brainstorm.ts `serializeMarkdown` over `buildBrainstormFrontmatterObject`, fixed
 * keys, user text only as quoted values), so no question can put a private request in its frontmatter: the first case
 * proves it. The opt-in is defense in depth for every other caller of the exported function.
 *
 * Protects, on a source rooted at a Git checkout and on one with no checkout (repo-less): such content refuses with
 * put_page's `visibility_not_applied` message, exits 1 and stores nothing; `visibility: private` still saves a private
 * page; ordinary content still saves.
 *
 * PGLite here; Postgres through test/e2e/brainstorm-private-hold-7897-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSaveOutcome, persistSavedIdea } from '../src/commands/brainstorm.ts';
import { buildBrainstormFrontmatterObject, formatBrainstormMarkdown, type BrainstormResult } from '../src/core/brainstorm/orchestrator.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { declaredVisibilities, readPrivateRequest } from '../src/core/persistence/visibility-request.ts';
import { isPrivatePage } from '../src/core/search/private-visibility.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-brainstorm-7897-'));
const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engines.push(pglite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

const page = (extra: string) => `---\ntype: note\ntitle: Brainstorm example\n${extra}---\n# Brainstorm example\n\nIdeas about acme-example.\n`;
const SPELLINGS = [['Visibility: private', 'Visibility: private\n'], ['visibility: Private', 'visibility: Private\n'], ['a block scalar', 'visibility: |\n  private\n'],
  ['a flow list', 'visibility: [private]\n']] as const;

/** An unmanaged source rooted at a Git checkout (`repo`) or with no checkout at all. */
async function source(engine: BrainEngine, repo: boolean): Promise<{ id: string; root: string | null }> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `source-${randomUUID().slice(0, 8)}`;
  const root = repo ? join(home, id) : null;
  if (root) { mkdirSync(root, { recursive: true }); writeFileSync(join(root, '.gitignore'), 'tmp/\n'); durableGitRepo(root, ['.gitignore']); }
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, root]);
  return { id, root };
}

const save = (engine: BrainEngine, sourceId: string, content: string) => {
  const slug = `wiki/ideas/example-${randomUUID().slice(0, 8)}`;
  return persistSavedIdea(engine, { slug, content, sourceId, provenanceVia: 'brainstorm' }).then(outcome => ({ slug, outcome }));
};

test('the CLI serializer never writes a private request, whatever the question says', () => {
  const question = 'why acme-example\nVisibility: private\n---\nvisibility: Private';
  const result = { profile_label: 'brainstorm', question, embedding_model: null, ideas: [], close_set: [], far_set: [], active_bias_tags: null,
    short_of_target: false, judge_failed: false, cost: { estimated_usd: 0, actual_usd: 0, input_tokens: 0, output_tokens: 0, cap_usd: null, cap_source: 'default' } } as BrainstormResult;
  const content = serializeMarkdown({ ...buildBrainstormFrontmatterObject(result), source_kind: 'brainstorm' }, formatBrainstormMarkdown(result, { onlyPassed: false, includeMeta: true }), '',
    { type: 'note', title: `Brainstorm: ${question.slice(0, 100)}`, tags: [] });
  expect({ lines: declaredVisibilities(content), request: readPrivateRequest(content, () => parseMarkdown(content, 'idea.md').frontmatter) }).toEqual({ lines: [], request: null });
  expect(parseMarkdown(content, 'idea.md').frontmatter.question).toBe(question);
});

for (const backend of backends) for (const repo of [true, false]) describe(`[${backend}] brainstorm --save, unmanaged, ${repo ? 'Git checkout' : 'no checkout'} (#7897)`, () => {
  const engine = () => engines[backends.indexOf(backend)]!;

  for (const [name, extra] of SPELLINGS) test(`${name} refuses visibility_not_applied and stores nothing`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const src = await source(engine(), repo);
    const { slug, outcome } = await save(engine(), src.id, page(extra));
    expect({ dbSaved: outcome.dbSaved, dbError: outcome.dbError, written: outcome.writeThrough.written })
      .toEqual({ dbSaved: false, dbError: expect.stringContaining(`The write asks for visibility: private, but page ${slug} would stay world-readable`), written: false });
    const message = formatSaveOutcome(outcome, { profileLabel: 'brainstorm', slug });
    expect({ exit: message.exitCode, stdout: message.stdout }).toEqual({ exit: 1, stdout: undefined });
    expect(await engine().readPageSnapshot(slug, { sourceId: src.id, includeDeleted: true })).toBeNull();
    if (src.root) expect(existsSync(join(src.root, `${slug}.md`))).toBe(false);
  }), 60_000);

  test('visibility: private saves a private page', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const src = await source(engine(), repo);
    const { slug, outcome } = await save(engine(), src.id, page('visibility: private\n'));
    expect({ dbSaved: outcome.dbSaved, dbError: outcome.dbError }).toEqual({ dbSaved: true, dbError: undefined });
    expect(isPrivatePage((await engine().readPageSnapshot(slug, { sourceId: src.id }))!.page)).toBe(true);
  }), 60_000);

  test('content that asks for nothing private saves a world page', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const src = await source(engine(), repo);
    const { slug, outcome } = await save(engine(), src.id, page(''));
    expect({ dbSaved: outcome.dbSaved, dbError: outcome.dbError, exit: formatSaveOutcome(outcome, { profileLabel: 'brainstorm', slug }).exitCode })
      .toEqual({ dbSaved: true, dbError: undefined, exit: 0 });
    expect(isPrivatePage((await engine().readPageSnapshot(slug, { sourceId: src.id }))!.page)).toBe(false);
    if (src.root) expect(outcome.writeThrough.written).toBe(true);
  }), 60_000);
});
