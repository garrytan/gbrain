/**
 * #1503 — the cycle's extract phase threads the resolved per-source id.
 *
 * Pre-fix, runPhaseExtract called runExtractCore with no sourceId, so on a
 * federated brain (content in a non-'default' source) the fs-walk batch rows
 * mapped to source_id='default', the pages JOIN dropped every row, and every
 * dream/autopilot cycle logged "Links: created 0 from N pages" while
 * persisting nothing. This pins that the cycle resolves the source from the
 * brain dir (resolveSourceForDir — same seam runPhaseSync uses) and that the
 * extracted link/timeline rows land in that source.
 *
 * GBRAIN_HOME is isolated per test because the PGLite cycle path takes a
 * file lock at ~/.gbrain/cycle.lock (see cycle-last-full-cycle-at.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCycle } from '../src/core/cycle.ts';

let engine: PGLiteEngine;
let brainDir: string;
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-cycle-extract-src-'));
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-cycle-extract-src-home-'));
  mkdirSync(join(brainDir, 'people'), { recursive: true });
  writeFileSync(
    join(brainDir, 'people', 'alice.md'),
    '# Alice\n\nMet [[people/bob]] today.\n\n## Timeline\n\n- **2026-01-05** | meeting — Discussed the wiki\n',
  );
  writeFileSync(join(brainDir, 'people', 'bob.md'), '# Bob\n\nFriend of [[people/alice]].\n');

  // Federated shape: the brain checkout is a registered non-default source
  // and its pages live ONLY under that source.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', $1)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [brainDir],
  );
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES
       ('people/alice', 'wiki', 'person', 'Alice', '', ''),
       ('people/bob', 'wiki', 'person', 'Bob', '', '')`,
  );
});

afterEach(() => {
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(gbrainHome, { recursive: true, force: true });
});

describe('cycle extract phase on a federated brain (#1503)', () => {
  test('extract phase resolves the source from brainDir and writes links + timeline there', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const report = await runCycle(engine, {
        brainDir,
        phases: ['extract'],
      });
      const extractPhase = report.phases.find(p => p.phase === 'extract');
      expect(extractPhase?.status).toBe('ok');
      // The #1503 symptom was exactly linksCreated: 0 on federated brains.
      expect(Number(extractPhase?.details?.linksCreated ?? 0)).toBeGreaterThanOrEqual(2);
      expect(Number(extractPhase?.details?.timelineCreated ?? 0)).toBeGreaterThanOrEqual(1);
    });

    const links = await engine.executeRaw<{ from_src: string; to_src: string }>(
      `SELECT pf.source_id AS from_src, pt.source_id AS to_src
       FROM links l
       JOIN pages pf ON pf.id = l.from_page_id
       JOIN pages pt ON pt.id = l.to_page_id`,
    );
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const l of links) {
      expect(l.from_src).toBe('wiki');
      expect(l.to_src).toBe('wiki');
    }

    const tl = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM timeline_entries t
       JOIN pages p ON p.id = t.page_id AND p.source_id = 'wiki'`,
    );
    expect(Number(tl[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
  });

  test('explicit opts.sourceId wins (checkout-less --source shape)', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      const report = await runCycle(engine, {
        brainDir,
        sourceId: 'wiki',
        phases: ['extract'],
      });
      const extractPhase = report.phases.find(p => p.phase === 'extract');
      expect(extractPhase?.status).toBe('ok');
      expect(Number(extractPhase?.details?.linksCreated ?? 0)).toBeGreaterThanOrEqual(2);
    });
  });
});
