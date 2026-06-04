/**
 * E2E test for v0.42.0.0 migration #1 (auto-link orphan reduction).
 *
 * Pins the design-doc claim SHAPE — "material reduction in orphan
 * pages" — without committing to a specific %, per TODO-4=C (soften
 * the 88%→<30% promise to "material reduction, exact figure TBD via
 * post-merge measurement on representative brain").
 *
 * 3 cases:
 *   1. Seed brain with known orphan ratio. Run --by-mention. Assert
 *      orphan count drops materially.
 *   2. Cross-check: gbrain orphans --count and doctor JSON orphan_ratio
 *      report the same underlying number (D1 single-source contract).
 *   3. Re-run --by-mention: 0 new links, no double-counting (idempotency
 *      end-to-end across runs).
 *
 * Hermetic via PGLite. No DATABASE_URL needed.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runExtract } from '../../src/commands/extract.ts';
import { runOrphans, getOrphansData } from '../../src/commands/orphans.ts';
import { runDoctor } from '../../src/commands/doctor.ts';
import { setCliOptions } from '../../src/core/cli-options.ts';

let engine: PGLiteEngine;
const origLog = console.log;
const origErr = console.error;
const origExit = process.exit;
let stdoutBuffer: string[];

function captureCli(): void {
  stdoutBuffer = [];
  console.log = (msg?: unknown) => { stdoutBuffer.push(typeof msg === 'string' ? msg : String(msg)); };
  console.error = () => {};
  (process as { exit: unknown }).exit = (() => { throw new Error('__exit'); }) as unknown as typeof process.exit;
}

function restoreCli(): void {
  console.log = origLog;
  console.error = origErr;
  (process as { exit: unknown }).exit = origExit;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  restoreCli();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
});

/**
 * Seed brain with N entity pages (0..N-1) and M content pages whose
 * body mentions a deterministic subset of the entities. Returns the
 * expected post-mention-pass non-orphan entity count.
 */
async function seedBrain(entityCount: number, contentCount: number, mentionsPerContent: number): Promise<{
  expectedNonOrphans: number;
}> {
  // Entities — give each a unique multi-token title so phrase-match exercise fires.
  for (let i = 0; i < entityCount; i++) {
    await engine.putPage(`people/person-${i}`, {
      type: 'person',
      title: `Persona Number ${i}`,
      compiled_truth: 'p body',
      timeline: '',
      frontmatter: {},
    });
  }

  // Content pages — each mentions `mentionsPerContent` entities by title.
  const mentionedEntities = new Set<number>();
  for (let j = 0; j < contentCount; j++) {
    const mentions: string[] = [];
    for (let k = 0; k < mentionsPerContent; k++) {
      const idx = (j * mentionsPerContent + k) % entityCount;
      mentions.push(`Persona Number ${idx} did something noteworthy.`);
      mentionedEntities.add(idx);
    }
    await engine.putPage(`writing/post-${j}`, {
      type: 'note',
      title: `Post ${j}`,
      compiled_truth: mentions.join(' '),
      timeline: '',
      frontmatter: {},
    });
  }
  return { expectedNonOrphans: mentionedEntities.size };
}

describe('v0.42.0.0 e2e — orphan reduction via --by-mention', () => {
  test('1. seeding 20 entities + 5 content pages → mentioning 15 → orphan count drops materially', async () => {
    await seedBrain(20, 5, 3); // 5 posts × 3 mentions each = 15 unique entities mentioned
    const before = await getOrphansData(engine, { includePseudo: false });
    captureCli();
    try { await runExtract(engine, ['links', '--by-mention', '--source', 'db']); }
    catch (e) { if (!(e instanceof Error && e.message === '__exit')) throw e; }
    finally { restoreCli(); }
    const after = await getOrphansData(engine, { includePseudo: false });
    // Material reduction — at least 10 entities should have moved from
    // orphan to non-orphan (we mentioned 15 of 20 unique entities).
    expect(before.total_orphans).toBeGreaterThan(after.total_orphans);
    const delta = before.total_orphans - after.total_orphans;
    expect(delta).toBeGreaterThanOrEqual(10);
  });

  test('2. cross-check — gbrain orphans count matches doctor JSON orphan_ratio numerator', async () => {
    await seedBrain(100, 10, 5); // 100 entities, 50 mentioned
    captureCli();
    try { await runExtract(engine, ['links', '--by-mention', '--source', 'db']); }
    catch (e) { if (!(e instanceof Error && e.message === '__exit')) throw e; }
    finally { restoreCli(); }
    // Direct pure-fn call.
    const direct = await getOrphansData(engine, { includePseudo: false });
    // CLI `gbrain orphans --count` output.
    captureCli();
    try { await runOrphans(engine, ['--count']); }
    catch (e) { if (!(e instanceof Error && e.message === '__exit')) throw e; }
    finally { restoreCli(); }
    const cliCount = Number(stdoutBuffer.find(l => /^\d+$/.test(l)) ?? '-1');
    expect(cliCount).toBe(direct.total_orphans);
    // Doctor JSON path.
    captureCli();
    try { await runDoctor(engine, ['--json']); }
    catch (e) { if (!(e instanceof Error && e.message === '__exit')) throw e; }
    finally { restoreCli(); }
    let doctorJson: any = null;
    for (let i = stdoutBuffer.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(stdoutBuffer[i]!);
        if (parsed && typeof parsed === 'object' && 'checks' in parsed) {
          doctorJson = parsed;
          break;
        }
      } catch {/* skip */}
    }
    expect(doctorJson).not.toBeNull();
    const orphanCheck = doctorJson.checks.find((c: any) => c.name === 'orphan_ratio');
    expect(orphanCheck).toBeDefined();
    // Doctor message includes the numerator/denominator string.
    expect(orphanCheck.message).toContain(`${direct.total_orphans}/${direct.total_linkable}`);
  });

  test('3. re-run idempotency — second --by-mention produces 0 new mention rows', async () => {
    await seedBrain(30, 6, 4);
    captureCli();
    try { await runExtract(engine, ['links', '--by-mention', '--source', 'db']); }
    catch (e) { if (!(e instanceof Error && e.message === '__exit')) throw e; }
    finally { restoreCli(); }
    const firstCount = Number((await engine.executeRaw<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM links WHERE link_source = 'mentions'`, [],
    ))[0]!.c);
    captureCli();
    try { await runExtract(engine, ['links', '--by-mention', '--source', 'db']); }
    catch (e) { if (!(e instanceof Error && e.message === '__exit')) throw e; }
    finally { restoreCli(); }
    const secondCount = Number((await engine.executeRaw<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM links WHERE link_source = 'mentions'`, [],
    ))[0]!.c);
    expect(secondCount).toBe(firstCount);
    expect(secondCount).toBeGreaterThan(0); // sanity: we did create SOME links on first pass
  });
});
