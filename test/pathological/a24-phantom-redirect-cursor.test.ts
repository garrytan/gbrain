/**
 * GBRA-130 A-24: the extract_facts phantom-redirect pass
 * (src/core/cycle/phantom-redirect.ts) selected the first `limit` live root
 * pages by slug every run, with no cursor. A root page that is not a phantom
 * (any root note with prose) stays live and unprefixed, so a flat vault with
 * 50+ root notes filled the window forever and a phantom sorting after them
 * was never examined.
 *
 * Authoring gate: (1) protects "every live root page is examined within
 * ceil(n / limit) passes": the pass resumes after the last slug it examined
 * and wraps at the end; one phantom whose redirect throws is reported with a
 * typed code and fix while the rest of the pass continues; a run-scoped error
 * stops the pass and leaves the cursor where it was; a systemic pass (most
 * examined phantoms failing) stops without moving the cursor. (2) Reverting
 * the cursor makes the 60-note case red (`zed` is never redirected);
 * reverting the ItemRun adoption makes the run cases red (the old catch
 * turned a lost connection into `drift` and kept going). (3)
 * test/phantom-redirect.test.ts covers the predicate and single redirects,
 * never more root pages than the cap. (4) No production seam: failures are
 * injected by wrapping the engine.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PHANTOM_REDIRECT_CURSOR_OP, runPhantomRedirectPass } from '../../src/core/cycle/phantom-redirect.ts';
import { rotationAfter } from '../../src/core/repair/rotation.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'default';
const NOTES = Array.from({ length: 60 }, (_, i) => `aaa-note-${String(i + 1).padStart(2, '0')}`);
const fence = (claim: string) => `## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |
<!--- gbrain:facts:end -->
`;

interface Brain { engine: BrainEngine; brainDir: string; put(slug: string, body: string, type?: string): Promise<void> }

function brain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-a24-'));
  const brainDir = join(root, 'brain');
  mkdirSync(brainDir, { recursive: true });
  return withEnv({ GBRAIN_AUDIT_DIR: join(root, 'audit'), GBRAIN_HOME: join(root, 'home'), GBRAIN_PHANTOM_REDIRECT_LIMIT: '50' }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      const put = async (slug: string, body: string, type = 'note') => {
        await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: body, timeline: '', frontmatter: {} });
        const file = join(brainDir, `${slug}.md`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, body);
      };
      await run({ engine, brainDir, put });
    } finally { await close(); rmSync(root, { recursive: true, force: true }); }
  });
}

async function phantom(b: Brain, slug: string) {
  await b.put(`people/${slug}-example`, `# ${slug}-example\n`, 'person');
  await b.put(slug, `# ${slug}\n\n${fence(`Founded acme-example (${slug})`)}`, 'person');
}

async function live(engine: BrainEngine, slug: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ deleted: boolean }>('SELECT deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
  return row ? !row.deleted : false;
}

/** The engine whose residue check (the first query a phantom-shaped page reaches) throws `error()` for the listed page ids, or for every page when none are listed. */
function failingResidue(engine: BrainEngine, error: () => unknown, pageIds?: Set<number>): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop);
    if (prop === 'executeRaw' && typeof value === 'function') {
      return (sql: string, params?: unknown[]) => /FROM timeline_entries WHERE page_id/.test(sql) && (!pageIds || pageIds.has(Number(params?.[0])))
        ? Promise.reject(error()) : (value as Function).call(target, sql, params);
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
}

const pass = (engine: BrainEngine, brainDir: string) => runPhantomRedirectPass(engine, brainDir, SOURCE, false);
const cursor = (engine: BrainEngine) => rotationAfter(engine, PHANTOM_REDIRECT_CURSOR_OP, SOURCE);
const contentError = () => Object.assign(new Error('value too long for type character varying(64)'), { code: '22001' });

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-24 phantom redirect: the pass resumes after the last slug it examined (${backend})`, () => {
    test('A-24 item: a phantom after 60 root prose notes is redirected by the second pass, and no note changes', () => brain(databaseUrl, async b => {
      for (const slug of NOTES) await b.put(slug, `# ${slug}\n\nA root note with real prose.\n`);
      await phantom(b, 'zed');
      const before = await snapshotItems(b.engine, SOURCE);

      const first = await expectUnitNotAborted(() => pass(b.engine, b.brainDir));
      const afterFirst = await cursor(b.engine);
      const second = await expectUnitNotAborted(() => pass(b.engine, b.brainDir));
      const afterSecond = await cursor(b.engine);
      const third = await expectUnitNotAborted(() => pass(b.engine, b.brainDir));
      expect({ zedLive: await live(b.engine, 'zed'), redirected: [first.redirected, second.redirected, third.redirected] })
        .toEqual({ zedLive: false, redirected: [0, 1, 0] });
      expect({ scanned: first.scanned, not_phantom: first.not_phantom, more_pending: first.more_pending, cursor: afterFirst })
        .toEqual({ scanned: 50, not_phantom: 50, more_pending: true, cursor: 'aaa-note-50' });
      expect({ scanned: second.scanned, more_pending: second.more_pending, cursor: afterSecond }).toEqual({ scanned: 11, more_pending: false, cursor: '' });
      expect(third.scanned).toBe(50);
      expectOthersUnchanged(before, await snapshotItems(b.engine, SOURCE), { expectProgress: ['zed', 'people/zed-example'], progressFields: ['deleted_at', 'content_hash'] });
    }), 180_000);

    test('A-24 item: a phantom whose redirect throws is reported with its code and fix, and the phantom after it still redirects', () => brain(databaseUrl, async b => {
      for (const slug of NOTES.slice(0, 3)) await b.put(slug, `# ${slug}\n\nA root note with real prose.\n`);
      await phantom(b, 'bbb-bad');
      await phantom(b, 'zed');
      const [bad] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, 'bbb-bad']);
      const before = await snapshotItems(b.engine, SOURCE);

      const result = await expectUnitNotAborted(() => pass(failingResidue(b.engine, contentError, new Set([Number(bad!.id)])), b.brainDir));
      expect(result.redirected).toBe(1);
      expect(result.failures.length).toBe(1);
      expectItemFailure(result.failures[0], { key: 'bbb-bad', code: 'invalid_data', fix: /gbrain dream --phase extract_facts --source default/ });
      expect(await live(b.engine, 'bbb-bad')).toBe(true);
      expectOthersUnchanged(before, await snapshotItems(b.engine, SOURCE), { expectProgress: ['zed', 'people/zed-example'], progressFields: ['deleted_at', 'content_hash'] });
    }), 120_000);

    test('A-24 recovery: once the cause clears, the next pass redirects the phantom that failed', () => brain(databaseUrl, async b => {
      await phantom(b, 'bbb-bad');
      const [bad] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, 'bbb-bad']);
      const failed = await expectUnitNotAborted(() => pass(failingResidue(b.engine, contentError, new Set([Number(bad!.id)])), b.brainDir));
      expect(failed.failures.map(f => f.key)).toEqual(['bbb-bad']);
      const before = await snapshotItems(b.engine, SOURCE);
      const result = await expectUnitNotAborted(() => pass(b.engine, b.brainDir));
      expect({ redirected: result.redirected, failures: result.failures }).toEqual({ redirected: 1, failures: [] });
      expectOthersUnchanged(before, await snapshotItems(b.engine, SOURCE), { expectProgress: ['bbb-bad', 'people/bbb-bad-example'], progressFields: ['deleted_at', 'content_hash'] });
    }), 120_000);

    for (const { name, error } of runScopedErrors()) {
      test(`A-24 run: a run-scoped ${name} at a phantom stops the pass and leaves the cursor where it was`, () => brain(databaseUrl, async b => {
        for (const slug of NOTES.slice(0, 3)) await b.put(slug, `# ${slug}\n\nA root note with real prose.\n`);
        await phantom(b, 'bbb-bad');
        await phantom(b, 'zed');
        const before = await snapshotItems(b.engine, SOURCE);
        const injected = error();
        let thrown: unknown;
        await pass(failingResidue(b.engine, () => injected), b.brainDir).catch(e => { thrown = e; });
        expect(thrown).toBe(injected);
        expect(await cursor(b.engine)).toBeNull();
        expect(await live(b.engine, 'zed')).toBe(true);
        expectOthersUnchanged(before, await snapshotItems(b.engine, SOURCE));
      }), 120_000);
    }

    test('A-24 breaker: when most examined phantoms fail the pass stops item_failures_systemic and the cursor does not move', () => brain(databaseUrl, async b => {
      for (const slug of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await phantom(b, slug);
      const before = await snapshotItems(b.engine, SOURCE);
      const result = await expectUnitNotAborted(() => pass(failingResidue(b.engine, contentError), b.brainDir));
      expect(result.stopped?.code).toBe('item_failures_systemic');
      expect(result.redirected).toBe(0);
      expect(await cursor(b.engine)).toBeNull();
      expectOthersUnchanged(before, await snapshotItems(b.engine, SOURCE));
    }), 120_000);
  });
}
