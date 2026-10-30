/**
 * G6 (git-canonical memory): `gbrain brainstorm --save` and `gbrain lsd --save` on a strict (canonical: git) managed
 * source are door-only.
 *
 * Both save through persistSavedIdea (commands/brainstorm.ts), with the page content the CLI builds after the run
 * (serializeMarkdown of the run's frontmatter and body, so no model call is involved, as in test/brainstorm/save.test.ts).
 * After three saves every idea page is at HEAD with the bytes on disk, the tree is clean, the git-gap census reports no
 * gap, and the saves make at most one commit per publication group.
 * PGLite here; Postgres in test/e2e/g6-brainstorm-strict-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { buildIdeaSlug, formatSaveOutcome, persistSavedIdea } from '../src/commands/brainstorm.ts';
import { PENDING_WRITE_EXIT_CODE } from '../src/core/exit-codes.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { waitForWrite } from '../src/core/persistence/service.ts';
import { WRITE_WAIT_ENV } from '../src/core/persistence/write-wait.ts';
import { withEnv } from './helpers/with-env.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { git } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { describeMeasure, expectDoorOnly, head, initStrictCheckout, measureBatch, strictSource } from './helpers/strict-door-census.ts';

const runs: Array<{ label: 'brainstorm' | 'lsd'; question: string }> = [
  { label: 'brainstorm', question: 'How could alice-example grow acme-example' },
  { label: 'brainstorm', question: 'What would bob-example build next' },
  { label: 'lsd', question: 'Why does acme-example ship weekly' },
];
const saved = (label: string, question: string) => serializeMarkdown({ mode: label, question, source_kind: label }, `# ${question}\n\nIdea body.`, '',
  { type: 'note', title: `${label === 'lsd' ? 'LSD' : 'Brainstorm'}: ${question}`, tags: [] });

for (const backend of testBackends()) describe(`[${backend}] G6: brainstorm and lsd --save on a strict source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('three saves: every idea page at HEAD, clean tree, no census gap, one commit per group', () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    const base = head(root);
    const slugs = runs.map((run, i) => buildIdeaSlug(run.question, run.label, `g6000${i}`));
    const outcomes = [];
    for (const [i, run] of runs.entries()) outcomes.push(await persistSavedIdea(engine, { slug: slugs[i]!, content: saved(run.label, run.question), provenanceVia: run.label }));
    console.log(`[G6 brainstorm/${backend}] outcomes=${JSON.stringify(outcomes.map(o => ({ dbSaved: o.dbSaved, dbError: o.dbError?.slice(0, 120), held: o.held, written: o.writeThrough.written, skipped: o.writeThrough.skipped })))}`);
    const m = await measureBatch(engine, 'default', root, base, slugs);
    console.log(describeMeasure(`brainstorm/${backend}`, m));
    expect(outcomes.map(o => o.dbSaved)).toEqual(slugs.map(() => true));
    expectDoorOnly(m, expect);
  }, { databaseUrl, setup: ({ root }) => initStrictCheckout(root) }), 120_000);

  test('a --resume save overwrites the same idea page through the door, bound to the revision it read', () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    const slug = buildIdeaSlug(runs[0]!.question, 'brainstorm', 'g6resume');
    const first = await persistSavedIdea(engine, { slug, content: saved('brainstorm', runs[0]!.question), provenanceVia: 'brainstorm' });
    const base = head(root);
    const resumed = serializeMarkdown({ mode: 'brainstorm', question: runs[0]!.question, source_kind: 'brainstorm' }, `# ${runs[0]!.question}\n\nRe-scored idea body.`, '',
      { type: 'note', title: `Brainstorm: ${runs[0]!.question}`, tags: [] });
    const second = await persistSavedIdea(engine, { slug, content: resumed, provenanceVia: 'brainstorm' });
    expect([first.dbSaved, second.dbSaved, second.writeThrough.written]).toEqual([true, true, true]);
    expect(second.writeThrough.path).toBe(`${root}/${slug}.md`);
    const m = await measureBatch(engine, 'default', root, base, [slug]);
    console.log(describeMeasure(`brainstorm-resume/${backend}`, m));
    expect(m.commits).toHaveLength(1);
    expectDoorOnly(m, expect);
    expect(git(root, 'show', `HEAD:${slug}.md`)).toContain('Re-scored idea body.');
  }, { databaseUrl, setup: ({ root }) => initStrictCheckout(root) }), 120_000);

  test('a save still pending when the CLI write wait ends reports accepted and pending, exit 10, and later commits', () => managedBrain(async ({ engine, root }) => {
    await strictSource(engine);
    const slug = buildIdeaSlug(runs[1]!.question, 'brainstorm', 'g6pending');
    const outcome = await withEnv({ [WRITE_WAIT_ENV]: '0' }, () => persistSavedIdea(engine, { slug, content: saved('brainstorm', runs[1]!.question), provenanceVia: 'brainstorm' }));
    console.log(`[G6 brainstorm-pending/${backend}] ${JSON.stringify(outcome)}`);
    expect(outcome.pending?.requestId).toBeString();
    expect(outcome.dbError).toBeUndefined();
    const msg = formatSaveOutcome(outcome, { profileLabel: 'brainstorm', slug });
    expect(msg.exitCode).toBe(PENDING_WRITE_EXIT_CODE);
    expect(msg.stdout).toContain('accepted and still pending');
    expect(msg.stdout).toContain(outcome.pending!.requestId);
    expect(msg.stderr.join('\n')).not.toContain('NOT persisted');
    expect(formatSaveOutcome({ ...outcome, pending: { ...outcome.pending!, acceptPending: true } }, { profileLabel: 'brainstorm', slug }).exitCode).toBe(0);
    const [row] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id=$1', [outcome.pending!.requestId]);
    expect((await waitForWrite(engine, row!, { engine: engine.kind } as never, 30_000)).state).toBe('committed');
    expect(git(root, 'show', `HEAD:${slug}.md`)).toContain('Idea body.');
  }, { databaseUrl, setup: ({ root }) => initStrictCheckout(root) }), 120_000);
});
