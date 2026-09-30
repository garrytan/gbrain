/**
 * Dream output ownership (write-path audit C-8, #5685 follow-up).
 *
 * A page is the run's own only when a child created it. The provenance stamp
 * (`dream_generated`) and whole-page grounding apply to the run's own pages;
 * a human page a child edited, or a page another writer created while the
 * child ran, keeps its identity and is verified only on the child's new units.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __testing } from '../src/core/cycle/synthesize.ts';
import { readVerifyEpoch, verifyAndRepairDreamPages } from '../src/core/cycle/synthesize-verify.ts';
import { importFromContent } from '../src/core/import-file.ts';

const { collectChildPutPageSlugs, stampDreamProvenance, reverseWriteRefs } = __testing;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO minion_jobs (submission_authority, id, queue, name, data, status)
    VALUES ('{"version":1,"kind":"application"}'::jsonb, 4001, 'default', 'subagent', '{}'::jsonb, 'completed')`);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

async function recordChildPut(slug: string, ordinal: number): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, status, input, ordinal)
     VALUES (4001, $1, $2, 'brain_put_page', 'complete', $3::jsonb, $1)`,
    [ordinal, `tool_${ordinal}`, JSON.stringify({ slug })],
  );
}

describe('dream output ownership', () => {
  test('refs carry the time of the child\'s first write to each slug', async () => {
    await recordChildPut('wiki/people/first-write-example', 0);
    await tick();
    await recordChildPut('wiki/people/first-write-example', 1);
    const refs = await collectChildPutPageSlugs(engine as never, [4001], new Map());
    const ref = refs.find((r: { slug: string }) => r.slug === 'wiki/people/first-write-example') as { first_write_at?: Date };
    const [row] = await engine.executeRaw<{ at: string }>(
      `SELECT MIN(started_at) AS at FROM subagent_tool_executions WHERE job_id = 4001`);
    expect(ref.first_write_at?.getTime()).toBe(new Date(row.at).getTime());
  });

  test('the provenance stamp skips a human page a child edited and stamps pages the child created', async () => {
    const human = 'wiki/people/alice-example';
    await importFromContent(engine, human, '---\ntype: person\ntitle: Alice\n---\nHand-written notes about Alice.', { noEmbed: true, remote: false, sourceId: 'default' });
    await tick();
    const firstWriteAt = await readVerifyEpoch(engine);
    await importFromContent(engine, human, '---\ntype: person\ntitle: Alice\n---\nHand-written notes about Alice.\n\nA dream edit.', { noEmbed: true, remote: false, sourceId: 'default' });
    const created = 'wiki/personal/reflections/2026-09-20-created-abc123';
    await importFromContent(engine, created, '---\ntype: note\n---\nA reflection.', { noEmbed: true, remote: false, sourceId: 'default' });

    const refs = [
      { slug: human, source_id: 'default', raw_source: '/t/a.txt', first_write_at: firstWriteAt },
      { slug: created, source_id: 'default', raw_source: '/t/a.txt', first_write_at: firstWriteAt },
    ];
    await stampDreamProvenance(engine as never, refs, '2026-09-20');

    const humanPage = await engine.getPage(human, { sourceId: 'default' });
    expect(humanPage!.frontmatter.dream_generated).toBeUndefined();
    expect(humanPage!.frontmatter.raw_source).toBeUndefined();
    expect((await engine.getPage(created, { sourceId: 'default' }))!.frontmatter.dream_generated).toBe(true);

    // The reverse-written file of the human page carries no dream marker either,
    // so the next sync cannot import one.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-dream-ownership-'));
    try {
      await reverseWriteRefs(engine as never, dir, refs, 'default');
      expect(readFileSync(join(dir, `${human}.md`), 'utf8')).not.toContain('dream_generated');
      expect(readFileSync(join(dir, `${created}.md`), 'utf8')).toContain('dream_generated: true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a page another writer created while the child ran is verified on the child\'s new units only', async () => {
    const transcript = 'user: The verdict was "ship the repair pass now, measure later." That is the plan.';
    const since = await readVerifyEpoch(engine);
    await tick();
    const slug = 'wiki/people/carol-example';
    const human = 'Carol said "a quote from an entirely different conversation last spring".';
    await importFromContent(engine, slug, `---\ntype: person\n---\n${human}`, { noEmbed: true, remote: false, sourceId: 'default' });
    await tick();
    const firstWriteAt = await readVerifyEpoch(engine);
    await importFromContent(engine, slug, `---\ntype: person\n---\n${human}\n\nThe user said "ship the repair pass now, measure later."\n\nThe user said "we are shutting down the company next quarter".`,
      { noEmbed: true, remote: false, sourceId: 'default' });

    const stats = await verifyAndRepairDreamPages(engine, [
      { slug, source_id: 'default', raw_source: '/t/session.md', first_write_at: firstWriteAt },
    ], new Map([['/t/session.md', { content: transcript }]]), { since, checkedAt: '2026-09-20' });

    expect(stats.preexisting_diffed).toBe(1);
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth).toBe(`${human}\n\nThe user said "ship the repair pass now, measure later."`);
    expect((page!.frontmatter.unverified_claims as unknown[])).toHaveLength(1);
  }, 30_000);
});
