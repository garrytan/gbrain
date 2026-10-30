/**
 * GBRA-161 PR 5 (T-2, L-6): the fence-only derived writers. Timeline orphan retraction (pruneTimelineOrphans and the
 * extract paths that read the page from the database) and the by-mention rebuild sweep delete rows the page text no longer
 * produces; each now deletes only while the page is still at the revision it read. A page edited between the read and the
 * delete keeps its rows. No ledger: these kinds take the revision fence only (plan line 8). Real engines, PGLite and Postgres.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { pruneTimelineOrphans } from '../../src/core/timeline-extract.ts';
import { runExtract } from '../../src/commands/extract.ts';
import { setCliOptions } from '../../src/core/cli-options.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { pathologicalArms } from './harness.ts';

/** The engine as a writer sees it, with a person's page edit landing at the first call \`when\` picks. */
function editingAt(engine: BrainEngine, when: (method: string, args: unknown[], armed: boolean) => boolean, arm: (method: string, args: unknown[]) => boolean,
  edit: () => Promise<unknown>): BrainEngine {
  let armed = false, edited = false;
  return new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      if (arm(String(prop), args)) armed = true;
      if (!edited && when(String(prop), args, armed)) { edited = true; await edit(); }
      return value.apply(target, args);
    };
  } }) as BrainEngine;
}

const timeline = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ d: string; s: string }>(
  "SELECT to_char(t.date, 'YYYY-MM-DD') AS d, t.summary AS s FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 ORDER BY t.date", [slug])).map(r => `${r.d} ${r.s}`);
const person = (bullets: string) => ({ type: 'person' as const, title: 'Erin Example', compiled_truth: 'Erin is an engineer.', timeline: bullets, frontmatter: {} });

const mentions = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ to_slug: string }>(
  "SELECT tp.slug AS to_slug FROM links l JOIN pages fp ON fp.id=l.from_page_id JOIN pages tp ON tp.id=l.to_page_id WHERE fp.slug=$1 AND l.link_source='mentions' ORDER BY tp.slug", [slug])).map(r => r.to_slug);
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const [out, err, log, error] = [process.stdout.write, process.stderr.write, console.log, console.error];
  process.stdout.write = (() => true) as never; process.stderr.write = (() => true) as never; console.log = () => {}; console.error = () => {};
  try { return await run(); } finally { process.stdout.write = out; process.stderr.write = err; console.log = log; console.error = error; }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-161 PR 5 fence-only writers (${backend})`, () => {
    test('T-2: a timeline row the page re-gained between the read and the delete is kept', async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const slug = 'people/erin-example';
        await engine.putPage(slug, person('- **2024-01-01** | first'));
        await engine.addTimelineEntry(slug, { date: '2024-01-01', source: 'markdown', summary: 'first' });
        await engine.createVersion(slug);
        await engine.putPage(slug, person('- **2024-02-01** | second'));
        await engine.addTimelineEntry(slug, { date: '2024-02-01', source: 'markdown', summary: 'second' });
        expect((await pruneTimelineOrphans(engine, { dryRun: true })).orphans).toBe(1);

        const racing = editingAt(engine, (method, args) => method === 'executeRaw' && String(args[0]).includes('FROM page_versions v JOIN pages p'), () => false,
          () => engine.putPage(slug, person('- **2024-01-01** | first\n- **2024-02-01** | second')));
        const applied = await pruneTimelineOrphans(racing, { dryRun: false });
        expect(applied.removed).toBe(0);
        expect(await timeline(engine, slug)).toEqual(['2024-01-01 first', '2024-02-01 second']);
      } finally { await close(); }
    }, 120_000);

    test('L-6: a mention the page re-gained between the scan and the rebuild sweep is kept', async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
      try {
        await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'acme body', timeline: '', frontmatter: {} });
        await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'alice body', timeline: '', frontmatter: {} });
        const note = (body: string) => engine.putPage('writing/post-1', { type: 'note', title: 'post', compiled_truth: body, timeline: '', frontmatter: {} }, { allowEmptyOverwrite: true });
        await note('We met with Acme Example yesterday.');
        await quietly(() => runExtract(engine, ['links', '--by-mention', '--source', 'db']));
        expect(await mentions(engine, 'writing/post-1')).toEqual(['companies/acme-example']);
        await note('Alice Example joined the call.');

        const racing = editingAt(engine, (method, _args, armed) => armed && method === 'transaction',
          (method, args) => method === 'getPage' && args[0] === 'writing/post-1',
          () => note('Alice Example joined the call, and Acme Example sent the notes.'));
        await quietly(() => runExtract(racing, ['links', '--by-mention', '--rebuild', '--source', 'db']).catch(() => undefined));
        expect(await mentions(engine, 'writing/post-1')).toContain('companies/acme-example');
      } finally { await close(); }
    }, 120_000);
  });
}
