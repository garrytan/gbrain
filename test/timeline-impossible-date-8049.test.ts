/**
 * #8049: a timeline bullet or heading whose date has the YYYY-MM-DD shape but is not a calendar date (`2026-02-30`,
 * month 13) used to reach `r.date::date` in the canonical timeline insert, so the page's publication threw
 * `date/time field value out of range` (a managed sync blocked, a file-drift preview aborted its batch). The
 * extractor now skips such dates, as parseTimelineEntries already did; the text stays in the page body.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { extractTimelineFromContent } from '../src/core/timeline-extract.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'gbrain-8049-'));
let engine: PGLiteEngine;
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('the extractor skips bullet and heading dates that are not calendar dates and keeps real ones', () => {
  const body = ['- **2026-02-30** | Source — impossible day', '- **2026-13-01** | impossible month', '### 2025-02-29 — not a leap year',
    '- **2024-02-29** | Source — a real leap day', '### 2026-01-05 — Kickoff'].join('\n');
  expect(extractTimelineFromContent(body, 'notes/a').map(e => e.date)).toEqual(['2024-02-29', '2026-01-05']);
});

// Value: protects=one page with an impossible timeline date neither blocks a managed sync nor fails its own publication (#8049);
// fails_when=extractTimelineFromContent hands a shape-valid, calendar-invalid date to the timeline_entries ::date cast;
// why_new=no test fed an impossible date through the canonical projection insert; seam=performManagedSync on PGLite;
// no_claim=engine-level add_timeline_entry callers that pass their own date.
test('a managed sync imports a page whose timeline holds an impossible date, and the page beside it', async () =>
  withEnv({ GBRAIN_HOME: home }, async () => {
    const sourceId = `t${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const root = join(home, sourceId);
    mkdirSync(join(root, 'notes'), { recursive: true });
    git(root, 'init', '-q');
    writeFileSync(join(root, 'notes', 'a.md'), '---\ntype: note\ntitle: A\n---\nBody.\n\n## Timeline\n\n- **2026-02-30** | Source — impossible day\n- **2026-01-05** | Source — kickoff\n');
    writeFileSync(join(root, 'notes', 'b.md'), '---\ntype: note\ntitle: B\n---\nOther page.\n');
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'pages');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

    const result = await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true, noExtract: true });
    expect(result.failedFiles ?? 0).toBe(0);
    expect(result).toMatchObject({ status: 'first_sync', added: 2 });
    const rows = await engine.executeRaw<{ slug: string; date: string; timeline: string }>(
      `SELECT p.slug, te.date::text AS date, p.timeline FROM pages p JOIN timeline_entries te ON te.page_id=p.id WHERE p.source_id=$1 ORDER BY te.date`, [sourceId]);
    expect(rows.map(r => [r.slug, r.date])).toEqual([['notes/a', '2026-01-05']]);
    expect(rows[0]!.timeline).toContain('2026-02-30');
  }), 120_000);
