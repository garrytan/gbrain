/**
 * Snapshot-bound segmented reads must not pair old metadata with a newer live body.
 * Protects real revision/generation changes through import and read-only file comparisons.
 * Fails if materialization follows the live generation rather than the captured snapshot.
 * PGLite always; PostgreSQL through the E2E importer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { materializedSnapshot } from '../../src/core/persistence/segmented-apply.ts';
import { fileMatchesSnapshot, prepareSegmentedTagMutation } from '../../src/core/persistence/page-prepare.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { streamingContentHash } from '../../src/core/page-body/content-hash-stream.ts';
import { randomUUID } from 'node:crypto';
import { parseMarkdown } from '../../src/core/markdown.ts';

const content = (label: string) => `---\ntitle: Snapshot ${label}\ntype: note\n---\n\n` +
  Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\n` + `Evidence ${label} for section ${i}. `.repeat(900) + '\n\n').join('') +
  `\n<!-- timeline -->\n- **2026-11-01** | manual — ${label}\n`;

for (const kind of testBackends()) describe(`snapshot generation (${kind})`, () => {
  let brain: AppendBrain;
  beforeAll(async () => { brain = await openAppendBrain(kind); }, 120_000);
  afterAll(async () => { await brain.close(); }, 120_000);

  test('materialization and file drift compare the captured generation, not the live replacement', async () => {
    const slug = 'notes/snapshot-generation';
    const original = content('original');
    await brain.seed(slug, original);
    const snapshot = (await brain.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(snapshot.bodyGeneration).toBe(1);
    await brain.engine.createVersion(slug, { sourceId: 'default' });
    await brain.seed(slug, content('replacement'));
    const current = (await brain.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    expect(current.bodyGeneration).toBe(2);
    expect(current.revision).not.toBe(snapshot.revision);
    const stored = (await materializedSnapshot(brain.engine, snapshot))!;
    const parsed = parseMarkdown(original, slug);
    expect(stored.page.compiled_truth === parsed.compiled_truth).toBe(true);
    expect(stored.page.timeline).toBe(parsed.timeline);
    expect(stored.page.title).toBe(snapshot.page.title);
    expect(stored.revision).toBe(snapshot.revision);
    expect(await fileMatchesSnapshot(brain.engine, slug, original, snapshot, `${slug}.md`)).toBe(true);
    expect(await fileMatchesSnapshot(brain.engine, slug, original, current, `${slug}.md`)).toBe(false);
  }, 120_000);

  test('a retained segmented snapshot stays readable after demotion to an inline body', async () => {
    const slug = 'notes/snapshot-demoted';
    const original = content('demotion');
    await brain.seed(slug, original);
    const snapshot = (await brain.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    await brain.engine.createVersion(slug, { sourceId: 'default' });
    await brain.seed(slug, '---\ntitle: Inline replacement\ntype: note\n---\n\nSmall replacement.\n');
    expect((await brain.body(slug)).storage).toBe('inline');
    expect((await materializedSnapshot(brain.engine, snapshot))!.page.compiled_truth === parseMarkdown(original, slug).compiled_truth).toBe(true);
    expect(await fileMatchesSnapshot(brain.engine, slug, original, snapshot, `${slug}.md`)).toBe(true);
  }, 120_000);

  test('missing retained rows refuse instead of silently adopting the current body', async () => {
    const slug = 'notes/snapshot-gone';
    await brain.seed(slug, content('gone'));
    const snapshot = (await brain.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    await brain.engine.createVersion(slug, { sourceId: 'default' });
    await brain.seed(slug, content('survivor'));
    await brain.engine.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NOT NULL', [snapshot.page.id]);
    await expect(materializedSnapshot(brain.engine, snapshot)).rejects.toMatchObject({ code: 'page_body_rows_unreadable' });
    expect((await brain.body(slug)).truth === parseMarkdown(content('survivor'), slug).compiled_truth).toBe(true);
  }, 120_000);

  test('tag hash fallback uses the captured body after the live generation changes', async () => {
    const slug = 'notes/snapshot-tag-hash';
    const original = content('original');
    await brain.seed(slug, original);
    const requestId = randomUUID();
    const local = await registerLocalWriter(brain.engine, 'cli');
    const snapshot = (await brain.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const principal = { kind: 'local_cli' as const, id: local.id };
    const row = await admitWrite(brain.engine, { principal, operation: 'add_tag', sourceId: 'default',
      sourceIncarnation: snapshot.sourceIncarnation, slug, pageId: snapshot.page.id, requestId,
      callerIntent: { tag: 'second' }, intent: { tag: 'second' },
      authority: { version: 1, principal, remote: false, sourceId: 'default', sourceIncarnation: snapshot.sourceIncarnation,
        scopes: ['read', 'write'], operations: null, slugPrefixes: null } });
    await brain.engine.createVersion(slug, { sourceId: 'default' });
    await brain.seed(slug, content('replacement'));
    // A legacy/missing midstate forces a stream. Nothing in this probe is published:
    // the prepared mutation's hash is inspected inside an intentionally rolled-back transaction.
    const parsed = parseMarkdown(original, slug);
    const tags = ['second'];
    const expected = streamingContentHash({ ...parsed, frontmatter: snapshot.page.frontmatter, tags });
    const originalRead = brain.engine.readManifest;
    brain.engine.readManifest = async function (...args) {
      return (await originalRead.call(this, ...args)).map(row => ({ ...row, hashState: null! }));
    };
    let observed: string | undefined;
    const rollback = new Error('rollback hash probe');
    try {
      const prepared = (await prepareSegmentedTagMutation(brain.engine, row, snapshot, tags))!;
      await expect(brain.engine.transaction(async tx => {
        await prepared.apply(tx);
        observed = (await tx.executeRaw<{ content_hash: string }>('SELECT content_hash FROM pages WHERE id=$1', [snapshot.page.id]))[0]!.content_hash;
        throw rollback;
      })).rejects.toBe(rollback);
    } finally { brain.engine.readManifest = originalRead; }
    expect(observed).toBe(expected);
  }, 120_000);
});
